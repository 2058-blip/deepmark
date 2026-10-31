import { DatabaseSync } from 'node:sqlite';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { gzipSync,gunzipSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';

const pack=value=>gzipSync(Buffer.from(JSON.stringify(value)));
const unpack=value=>JSON.parse(gunzipSync(value).toString());
const maskPack=mask=>gzipSync(Buffer.from(mask.buffer,mask.byteOffset,mask.byteLength)).toString('base64');
const maskUnpack=value=>{const b=gunzipSync(Buffer.from(value,'base64'));return new Uint16Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));};
const digest=value=>createHash('sha256').update(value).digest('hex');
const validId=value=>typeof value==='string'&&/^[\w-]{1,80}$/.test(value);
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function decodePatch(body,count){
  if(typeof body.patch!=='string'||!Number.isSafeInteger(body.baseRevision)||body.baseRevision<0)fail('编辑数据格式无效。');
  const buffer=Buffer.from(body.patch,'base64');if(!buffer.length||buffer.length%8||buffer.length>32*1024*1024)fail('单次编辑为空或超过 32 MB 上限，请缩小操作范围。');
  const entries=[];let previous=-1;
  for(let n=0;n<buffer.length;n+=8){const i=buffer.readUInt32LE(n),before=buffer.readUInt16LE(n+4),after=buffer.readUInt16LE(n+6);if(i>=count||i<=previous)fail('体素索引越界或重复。');previous=i;entries.push([i,before,after]);}
  return entries;
}
function niftiBytes(header,labels){
  const out=Buffer.alloc(352+labels.length*2);out.set(header);const v=new DataView(out.buffer,out.byteOffset,out.byteLength),le=v.getInt32(0,true)===348;
  v.setInt16(70,512,le);v.setInt16(72,16,le);v.setInt16(68,1002,le);v.setFloat32(108,352,le);v.setFloat32(112,1,le);v.setFloat32(116,0,le);v.setFloat32(124,0,le);v.setFloat32(128,0,le);labels.forEach((n,i)=>v.setUint16(352+2*i,n,le));return out;
}
export function openCollaborationStore(filename){
  if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true});
  const db=new DatabaseSync(filename);db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS people(token TEXT PRIMARY KEY,id TEXT NOT NULL,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,dataset TEXT NOT NULL,fingerprint TEXT NOT NULL,count INTEGER NOT NULL,header BLOB NOT NULL,labels TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS branches(project TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,mask BLOB NOT NULL,PRIMARY KEY(project,id));
    CREATE TABLE IF NOT EXISTS events(project TEXT NOT NULL,revision INTEGER NOT NULL,op TEXT NOT NULL,author TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,time TEXT NOT NULL,details BLOB NOT NULL,PRIMARY KEY(project,revision),UNIQUE(project,op));
    CREATE TABLE IF NOT EXISTS resume_keys(author TEXT PRIMARY KEY,name TEXT NOT NULL,secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS personal(project TEXT NOT NULL,author TEXT NOT NULL,mask BLOB NOT NULL,touched BLOB NOT NULL,touched_count INTEGER NOT NULL,generation INTEGER NOT NULL,revision INTEGER NOT NULL,checkpoint BLOB,updated TEXT NOT NULL,PRIMARY KEY(project,author));`);
  function getProject(id){const p=db.prepare('SELECT * FROM projects WHERE id=?').get(id);if(!p)fail('协同工程不存在。',404);return p;}
  function state(id,revision){
    const p=getProject(id);if(revision!==undefined&&(!Number.isInteger(revision)||revision<0||revision>p.revision))fail('历史版本不存在。',404);
    let branches,labels;
    if(revision===undefined||revision===p.revision){branches=db.prepare('SELECT id,name,mask FROM branches WHERE project=? ORDER BY rowid').all(id).map(b=>({id:b.id,name:b.name,mask:unpack(b.mask)}));labels=JSON.parse(p.labels);}
    else{
      const maps=new Map([['main',{id:'main',name:'主版本',data:new Uint16Array(p.count)}]]);labels=[{id:1,name:'标注 1',color:'#4ed1ad'}];
      for(const row of db.prepare('SELECT details FROM events WHERE project=? AND revision<=? ORDER BY revision').all(id,revision)){
        const event=unpack(row.details);
        if(event.fork){const src=maps.get(event.fork.from);maps.set(event.fork.id,{id:event.fork.id,name:event.fork.name,data:src.data.slice()});}
        for(const patch of event.patches||[]){const mask=maps.get(patch.branch).data;for(const [i,,after]of patch.entries)mask[i]=after;}
        labels=event.labels;
      }
      branches=[...maps.values()].map(({data,...b})=>({...b,mask:maskPack(data)}));
    }
    return {id:p.id,datasetId:p.dataset,revision:revision??p.revision,latestRevision:p.revision,branches,labels};
  }
  function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}
  function saveEvent(p,person,op,kind,details){
    const revision=p.revision+1;
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(p.id,revision,op,person.id,person.name,kind,new Date().toISOString(),pack(details));
    db.prepare('UPDATE projects SET revision=?,labels=? WHERE id=?').run(revision,JSON.stringify(details.labels),p.id);return revision;
  }
  function ensurePersonal(p,person){
    let row=db.prepare('SELECT * FROM personal WHERE project=? AND author=?').get(p.id,person.id);if(row)return row;
    const mask=new Uint16Array(p.count),touched=new Uint8Array(p.count);let count=0,generation=0,revision=0,updated=new Date().toISOString();
    // Backfill existing authors' work when upgrading an older database.
    for(const event of db.prepare('SELECT revision,time,details FROM events WHERE project=? AND author=? ORDER BY revision').all(p.id,person.id)){
      for(const patch of unpack(event.details).patches||[])for(const [i,,after]of patch.entries){mask[i]=after;if(!touched[i]){touched[i]=1;count++;}}
      generation++;revision=event.revision;updated=event.time;
    }
    db.prepare('INSERT INTO personal VALUES(?,?,?,?,?,?,?,?,?)').run(p.id,person.id,gzipSync(Buffer.from(mask.buffer)),gzipSync(touched),count,generation,revision,null,updated);
    return db.prepare('SELECT * FROM personal WHERE project=? AND author=?').get(p.id,person.id);
  }
  function recordPersonal(p,person,entries,revision){
    const row=ensurePersonal(p,person),raw=gunzipSync(row.mask),mask=new Uint16Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength)),touched=gunzipSync(row.touched);let count=row.touched_count;
    for(const [i,,after]of entries){mask[i]=after;if(!touched[i]){touched[i]=1;count++;}}
    db.prepare('UPDATE personal SET mask=?,touched=?,touched_count=?,generation=generation+1,revision=?,updated=? WHERE project=? AND author=?').run(gzipSync(Buffer.from(mask.buffer)),gzipSync(touched),count,revision,new Date().toISOString(),p.id,person.id);
  }
  function workspace(id,person){const row=ensurePersonal(getProject(id),person);return {authorId:person.id,generation:row.generation,revision:row.revision,updated:row.updated,touchedCount:row.touched_count,mask:Buffer.from(row.mask).toString('base64'),touched:Buffer.from(row.touched).toString('base64'),checkpoint:row.checkpoint?unpack(row.checkpoint):null};}
  function resume(person){if(db.prepare('SELECT author FROM resume_keys WHERE author=?').get(person.id))return undefined;const key=randomBytes(32).toString('hex');db.prepare('INSERT INTO resume_keys VALUES(?,?,?)').run(person.id,person.name,digest(key));return key;}
  return {
    close:()=>db.close(),
    person(token){return token?db.prepare('SELECT id,name FROM people WHERE token=?').get(digest(token)):null;},
    session(name,credentials){
      if(typeof name!=='string'||!name.trim()||name.trim().length>40)fail('请输入 1～40 字的协同昵称。');
      let person={id:randomUUID(),name:name.trim()},resumeKey;
      if(credentials){const identity=db.prepare('SELECT * FROM resume_keys WHERE author=?').get(credentials.authorId);if(!identity||typeof credentials.resumeKey!=='string'||identity.secret!==digest(credentials.resumeKey))fail('本地身份恢复失败，请使用原浏览器的有效身份。',401);person={id:identity.author,name:identity.name};resumeKey=credentials.resumeKey;}
      const token=randomBytes(32).toString('hex');db.prepare('INSERT INTO people VALUES(?,?,?)').run(digest(token),person.id,person.name);resumeKey??=resume(person);return {token,person,resumeKey};
    },
    resume,
    logout(token){if(token)db.prepare('DELETE FROM people WHERE token=?').run(digest(token));},
    workspace,
    checkpoint(id,person,body){return transaction(()=>{
      const p=getProject(id),row=ensurePersonal(p,person),previous=row.checkpoint?unpack(row.checkpoint):null;
      if(!validId(body.id))fail('个人成果编号无效。');
      if(previous?.id===body.id)return {generation:row.generation,revision:previous.revision,updated:previous.time,duplicate:true};
      if(body.generation!==row.generation)fail('个人空间已有更新，请重新同步后保存。',409);
      if(!Number.isSafeInteger(body.revision)||body.revision<row.revision||body.revision>p.revision)fail('工作副本版本过旧，请同步后再保存。',409);
      if(typeof body.snapshot!=='string'||body.snapshot.length>44*1024*1024)fail('个人工作副本过大。',413);
      let raw;try{raw=gunzipSync(Buffer.from(body.snapshot,'base64'),{maxOutputLength:p.count*2});}catch{fail('个人工作副本格式无效。');}if(raw.length!==p.count*2)fail('个人工作副本尺寸不一致。');
      if(!db.prepare('SELECT id FROM branches WHERE project=? AND id=?').get(id,body.branch))fail('工作副本分支不存在。');
      const view=body.view,allowed=new Set(JSON.parse(p.labels).map(l=>l.id));
      const header=new DataView(p.header.buffer,p.header.byteOffset,p.header.byteLength),little=header.getInt32(0,true)===348;
      if(!view||!Array.isArray(view.point)||view.point.length!==3||view.point.some((n,a)=>!Number.isInteger(n)||n<0||n>=header.getInt16(42+a*2,little))||!allowed.has(view.selected)||!Number.isFinite(view.center)||!Number.isFinite(view.width)||view.width<1||!Number.isFinite(view.diameter)||view.diameter<=0||!Number.isFinite(view.opacity)||view.opacity<0||view.opacity>1||!['paint','erase','navigate','threshold'].includes(view.tool))fail('继续工作的位置或显示参数无效。');
      if(!Array.isArray(body.labels)||body.labels.length>64||body.labels.some(l=>!allowed.has(l.id)||typeof l.name!=='string'||l.name.length>60||!/^#[a-f0-9]{6}$/i.test(l.color)))fail('工作副本标签无效。');
      const checkpoint={id:body.id,branch:body.branch,revision:body.revision,view,labels:body.labels,snapshot:body.snapshot,time:new Date().toISOString()};
      db.prepare('UPDATE personal SET checkpoint=?,generation=generation+1,updated=? WHERE project=? AND author=?').run(pack(checkpoint),checkpoint.time,id,person.id);
      return {generation:row.generation+1,revision:body.revision,updated:checkpoint.time};
    });},
    join(dataset,bytes,volume){
      const fingerprint=digest(bytes),id=digest(dataset+fingerprint).slice(0,32);
      if(!db.prepare('SELECT id FROM projects WHERE id=?').get(id))transaction(()=>{
        const labels=[{id:1,name:'标注 1',color:'#4ed1ad'}];
        db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,0)').run(id,dataset,fingerprint,volume.data.length,volume.header,JSON.stringify(labels));
        db.prepare('INSERT INTO branches VALUES(?,?,?,?)').run(id,'main','主版本',pack(maskPack(new Uint16Array(volume.data.length))));
      });
      return state(id);
    },
    state,
    history(id){getProject(id);return db.prepare('SELECT revision,op,author,name,kind,time FROM events WHERE project=? ORDER BY revision DESC LIMIT 100').all(id);},
    label(id,person,body){return transaction(()=>{
      if(body.op!==undefined){if(!validId(body.op))fail('操作编号无效。');const previous=db.prepare('SELECT revision,details FROM events WHERE project=? AND op=?').get(id,body.op);if(previous)return {revision:previous.revision,label:unpack(previous.details).labels.find(l=>l.id===body.id),duplicate:true};}
      const p=getProject(id),labels=JSON.parse(p.labels);ensurePersonal(p,person);let label;
      if(body.id!==undefined){label=labels.find(l=>l.id===body.id);if(!label)fail('标签不存在。');}
      else{const next=Math.max(...labels.map(l=>l.id))+1;if(next>65535||labels.length>=64)fail('标签数量已达上限。');label={id:next,name:`标注 ${next}`,color:['#fb9f67','#859dff','#ed78b6','#e5d46f','#74c5f4'][(next-2)%5]};labels.push(label);}
      if(body.name!==undefined){if(typeof body.name!=='string'||!body.name.trim()||body.name.length>60)fail('标签名称无效。');label.name=body.name.trim();}
      if(body.color!==undefined){if(!/^#[a-f0-9]{6}$/i.test(body.color))fail('颜色无效。');label.color=body.color;}
      const revision=saveEvent(p,person,body.op||randomUUID(),'标签设置',{labels,patches:[]});recordPersonal(p,person,[],revision);return {revision,label};
    });},
    apply(id,person,body){return transaction(()=>{
      if(body.key!==undefined&&(typeof body.key!=='string'||!body.key.startsWith(person.id+':'+id+':')))fail('操作属于另一作者，请恢复原作者身份后续传。',401);
      if(!validId(body.op)||!validId(body.branch))fail('操作编号或版本编号无效。');
      const duplicate=db.prepare('SELECT revision,details FROM events WHERE project=? AND op=?').get(id,body.op);
      if(duplicate){const details=unpack(duplicate.details);return {revision:duplicate.revision,forkId:details.fork?.id||null,duplicate:true};}
      const p=getProject(id);if(body.baseRevision>p.revision)fail('客户端版本超前，请重新同步。');ensurePersonal(p,person);
      const entries=decodePatch(body,p.count),labels=JSON.parse(p.labels),allowed=new Set([0,...labels.map(l=>l.id)]);
      if(entries.some(([,before,after])=>!allowed.has(before)||!allowed.has(after)))fail('编辑包含未知标签，请刷新标签列表。');
      const branches=db.prepare('SELECT id,name,mask FROM branches WHERE project=? ORDER BY rowid').all(id).map(b=>({...b,data:maskUnpack(unpack(b.mask))}));
      const source=branches.find(b=>b.id===body.branch);if(!source)fail('源版本不存在。',404);
      const conflicts=new Set(entries.filter(([i,before,after])=>source.data[i]!==before&&source.data[i]!==after).map(([i])=>i));
      let fork=null;
      if(conflicts.size){fork={id:randomUUID(),from:source.id,name:`冲突版本 ${p.revision+1} · ${person.name}`};branches.push({...fork,data:source.data.slice()});}
      const patches=[];
      for(const branch of branches){
        const applied=[];
        for(const [i,,after]of entries){if(conflicts.has(i)&&branch.id!==fork?.id)continue;if(branch.data[i]===after)continue;applied.push([i,branch.data[i],after]);branch.data[i]=after;}
        if(applied.length)patches.push({branch:branch.id,entries:applied});
        db.prepare('INSERT INTO branches VALUES(?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET mask=excluded.mask').run(id,branch.id,branch.name,pack(maskPack(branch.data)));
      }
      const revision=saveEvent(p,person,body.op,body.kind==='undo'?'撤销':body.kind==='redo'?'重做':'编辑',{labels,fork,patches});
      recordPersonal(p,person,entries,revision);
      return {revision,forkId:fork?.id||null,conflicts:conflicts.size};
    });},
    export(id,branchId,revision){const p=getProject(id),s=state(id,revision),b=s.branches.find(b=>b.id===branchId);if(!b)fail('版本不存在。',404);return {bytes:niftiBytes(p.header,maskUnpack(b.mask)),revision:s.revision};},
    exportPersonal(id,person){const p=getProject(id),row=ensurePersonal(p,person),raw=gunzipSync(row.mask),labels=new Uint16Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength));return {bytes:niftiBytes(p.header,labels),revision:row.revision};}
  };
}
function sessionToken(req){return /(?:^|;\s*)deepmark_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];}
function sameOrigin(req){try{return !req.headers.origin||new URL(req.headers.origin).host===req.headers.host;}catch{return false;}}
async function body(req){let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>46*1024*1024)fail('操作数据超过上限。',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{fail('请求格式无效。');}}
export function attachCollaboration(server,{store,resolveDataset,json}){
  const wss=new WebSocketServer({noServer:true,maxPayload:1024});
  function broadcast(id,revision){for(const socket of wss.clients)if(socket.project===id&&socket.readyState===1)socket.send(JSON.stringify({projectId:id,revision}));}
  server.on('upgrade',(req,socket,head)=>{
    socket.on('error',()=>socket.destroy());
    const url=new URL(req.url,'http://localhost');
    if(url.pathname!=='/api/collaboration/socket'||!store.person(sessionToken(req))){socket.destroy();return;}
    if(!sameOrigin(req)){socket.destroy();return;}
    const id=url.searchParams.get('project');try{store.state(id);}catch{socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>{ws.on('error',()=>ws.terminate());ws.project=id;ws.session=digest(sessionToken(req));ws.send(JSON.stringify({projectId:id,ready:true}));});
  });
  server.once('close',()=>{for(const ws of wss.clients)ws.terminate();wss.close();store.close();});
  return async(req,res,url)=>{
    if(!url.pathname.startsWith('/api/collaboration/'))return false;
    try{
      if(!['GET','POST'].includes(req.method))fail('不支持此请求方式。',405);
      if(req.method==='POST'&&(!req.headers['x-deepmark-request']||!sameOrigin(req)))fail('请求来源无效。',403);
      let person=store.person(sessionToken(req));
      const path=url.pathname.slice('/api/collaboration'.length);
      if(path==='/session'){
        let resumeKey;
        if(req.method==='POST'){const data=await body(req),result=store.session(data.name,data.credentials);person=result.person;resumeKey=result.resumeKey;res.setHeader('Set-Cookie',`deepmark_session=${result.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);}
        else if(person)resumeKey=store.resume(person);
        json(res,200,{person,resumeKey});return true;
      }
      if(!person)fail('请先填写协同昵称加入。',401);
      if(req.headers['x-deepmark-author']&&req.headers['x-deepmark-author']!==person.id)fail('当前登录身份已变化，请恢复原作者身份后续传。',401);
      if(path==='/logout'&&req.method==='POST'){const token=sessionToken(req);store.logout(token);for(const ws of wss.clients)if(ws.session===digest(token))ws.close();res.setHeader('Set-Cookie','deepmark_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');json(res,200,{ok:true});return true;}
      if(path==='/projects'&&req.method==='POST'){
        const data=await body(req);const dataset=await resolveDataset(data.datasetId);if(!dataset)fail('数据集不存在。',404);
        json(res,200,store.join(data.datasetId,dataset.bytes,dataset.volume));return true;
      }
      const match=/^\/projects\/([a-f0-9]{32})(?:\/(history|operations|labels|export|workspace|workspace\/export))?$/.exec(path);if(!match)fail('接口不存在。',404);
      const [,id,action]=match;
      if(req.method==='GET'){
        if(action==='history')json(res,200,{events:store.history(id)});
        else if(action==='workspace')json(res,200,store.workspace(id,person));
        else if(action==='workspace/export'){const result=store.exportPersonal(id,person);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':result.bytes.length,'Content-Disposition':`attachment; filename="personal-${person.id}-${id}.nii"`,'Cache-Control':'no-store'});res.end(result.bytes);}
        else if(action==='export'){const revision=url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined,branchId=url.searchParams.get('branch')||'main',result=store.export(id,branchId,revision);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':result.bytes.length,'Content-Disposition':`attachment; filename="deepmark-${id}-${branchId}-r${result.revision}.nii"`,'Cache-Control':'no-store'});res.end(result.bytes);}
        else if(!action)json(res,200,store.state(id,url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined));
        else fail('接口不存在。',404);
      }else if(action==='workspace'){json(res,200,store.checkpoint(id,person,await body(req)));}
      else if(action==='operations'||action==='labels'){
        const result=action==='operations'?store.apply(id,person,await body(req)):store.label(id,person,await body(req));json(res,200,result);broadcast(id,result.revision);
      }else fail('接口不存在。',404);
    }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'协同服务处理失败，请重试。'});else res.destroy();}
    return true;
  };
}
