import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {WebSocketServer} from 'ws';
import {applyShared,mergeLegacy,resolveRegion} from './sharedModel.mjs';
import {zipSync} from 'fflate';
import {annotationFiles,archiveOptions} from '../src/exportArchive.ts';

const pack=value=>gzipSync(Buffer.from(JSON.stringify(value))),unpack=value=>JSON.parse(gunzipSync(value).toString());
const digest=value=>createHash('sha256').update(value).digest('hex');
const zip=values=>gzipSync(Buffer.from(values.buffer,values.byteOffset,values.byteLength));
function unzip(value,Type){const b=gunzipSync(value);return new Type(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));}
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
const validId=value=>typeof value==='string'&&/^[\w-]{1,80}$/.test(value);
function dims(p){const v=new DataView(p.header.buffer,p.header.byteOffset,p.header.byteLength),le=v.getInt32(0,true)===348;return [0,1,2].map(a=>v.getInt16(42+a*2,le));}
function decodePatch(body,count){
  if(typeof body.patch!=='string'||!Number.isSafeInteger(body.baseRevision)||body.baseRevision<0)fail('编辑数据格式无效。');
  const b=Buffer.from(body.patch,'base64');if(!b.length||b.length%8||b.length>32*1024*1024)fail('单次编辑为空或超过同步上限。');
  const rows=[];let previous=-1;for(let n=0;n<b.length;n+=8){const i=b.readUInt32LE(n);if(i>=count||i<=previous)fail('体素索引越界或重复。');previous=i;rows.push([i,b.readUInt16LE(n+4),b.readUInt16LE(n+6)]);}return rows;
}
function encodePatch(entries){const bytes=Buffer.alloc(entries.length*8);entries.forEach(([i,before,after],n)=>{bytes.writeUInt32LE(i,n*8);bytes.writeUInt16LE(before,n*8+4);bytes.writeUInt16LE(after,n*8+6);});return bytes.toString('base64');}
function niftiBytes(header,labels){const out=Buffer.alloc(352+labels.length*2);out.set(header);const v=new DataView(out.buffer,out.byteOffset,out.byteLength),le=v.getInt32(0,true)===348;v.setInt16(70,512,le);v.setInt16(72,16,le);v.setInt16(68,1002,le);v.setFloat32(108,352,le);v.setFloat32(112,1,le);v.setFloat32(116,0,le);v.setFloat32(124,0,le);v.setFloat32(128,0,le);labels.forEach((n,i)=>v.setUint16(352+2*i,n,le));return out;}
export function openCollaborationStore(filename,{adminKey:configuredKey=process.env.DEEPMARK_ADMIN_KEY}={}){
  if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true});
  let adminKey=configuredKey;
  if(!adminKey){if(filename===':memory:')adminKey=randomBytes(32).toString('hex');else{const keyFile=join(dirname(filename),'admin-access.key');if(!existsSync(keyFile))writeFileSync(keyFile,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});adminKey=readFileSync(keyFile,'utf8').trim();}}
  if(adminKey.length<16)throw new Error('管理员密钥至少需要 16 个字符。');
  const db=new DatabaseSync(filename);db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS people(token TEXT PRIMARY KEY,id TEXT NOT NULL,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,dataset TEXT NOT NULL,fingerprint TEXT NOT NULL,count INTEGER NOT NULL,header BLOB NOT NULL,labels TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS events(project TEXT NOT NULL,revision INTEGER NOT NULL,op TEXT NOT NULL,author TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,time TEXT NOT NULL,details BLOB NOT NULL,PRIMARY KEY(project,revision),UNIQUE(project,op));
    CREATE TABLE IF NOT EXISTS resume_keys(author TEXT PRIMARY KEY,name TEXT NOT NULL,secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS roles(author TEXT PRIMARY KEY,role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_data(project TEXT PRIMARY KEY,mask BLOB NOT NULL,owners BLOB NOT NULL,authors TEXT NOT NULL,regions BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_baselines(project TEXT PRIMARY KEY,revision INTEGER NOT NULL,data BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS final_results(project TEXT NOT NULL,revision INTEGER NOT NULL,author TEXT NOT NULL,name TEXT NOT NULL,time TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(project,revision));`);
  const columns=new Set(db.prepare('PRAGMA table_info(projects)').all().map(c=>c.name));
  for(const [name,type]of [['dataset_name',"TEXT NOT NULL DEFAULT ''"],['status',"TEXT NOT NULL DEFAULT 'editing'"],['finalized_by','TEXT'],['finalized_at','TEXT'],['final_revision','INTEGER']])if(!columns.has(name))db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${type}`);
  const hasTable=name=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if(!db.prepare('PRAGMA table_info(shared_data)').all().some(c=>c.name==='revision')){db.exec('ALTER TABLE shared_data ADD COLUMN revision INTEGER NOT NULL DEFAULT 0; UPDATE shared_data SET revision=(SELECT revision FROM projects WHERE projects.id=shared_data.project);');}
  const models=new Map();
  const initialLabels=[{id:1,name:'标注 1',color:'#4ed1ad'}];
  function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');models.clear();throw error;}}
  function getProject(id){const p=db.prepare('SELECT * FROM projects WHERE id=?').get(id);if(!p)fail('共享工程不存在。',404);return p;}
  function trimModels(){let bytes=0;for(const value of models.values())bytes+=value.model.mask.byteLength+value.model.owners.byteLength;while(models.size>1&&(models.size>4||bytes>256*1024*1024)){const id=models.keys().next().value,old=models.get(id);bytes-=old.model.mask.byteLength+old.model.owners.byteLength;models.delete(id);}}
  function readModel(p){
    const cached=models.get(p.id);if(cached?.revision===p.revision){models.delete(p.id);models.set(p.id,cached);trimModels();return cached.model;}
    const row=cached?null:db.prepare('SELECT * FROM shared_data WHERE project=?').get(p.id),model=cached?.model||{mask:unzip(row.mask,Uint16Array),owners:unzip(row.owners,Uint32Array),authors:JSON.parse(row.authors),regions:unpack(row.regions),dims:dims(p)};
    for(const event of db.prepare('SELECT details FROM events WHERE project=? AND revision>? AND revision<=? ORDER BY revision').all(p.id,cached?.revision??row.revision,p.revision)){
      const data=unpack(event.details);if(!data.shared)continue;for(const [i,,value]of data.applied||[])model.mask[i]=value;for(const [i,code]of data.ownerUpdates||[])model.owners[i]=code;model.regions=data.regions;model.authors=data.authors;
    }
    models.delete(p.id);models.set(p.id,{revision:p.revision,model});
    trimModels();
    return model;
  }
  function saveModel(id,m){const revision=getProject(id).revision;db.prepare('INSERT INTO shared_data(project,mask,owners,authors,regions,revision) VALUES(?,?,?,?,?,?) ON CONFLICT(project) DO UPDATE SET mask=excluded.mask,owners=excluded.owners,authors=excluded.authors,regions=excluded.regions,revision=excluded.revision').run(id,zip(m.mask),zip(m.owners),JSON.stringify(m.authors),pack(m.regions),revision);models.set(id,{revision,model:m});trimModels();}
  function modelJSON(m){return {mask:zip(m.mask).toString('base64'),owners:zip(m.owners).toString('base64'),authors:m.authors,regions:m.regions};}
  function fromJSON(data,p){return {mask:unzip(Buffer.from(data.mask,'base64'),Uint16Array),owners:unzip(Buffer.from(data.owners,'base64'),Uint32Array),authors:data.authors,regions:data.regions,dims:dims(p)};}
  function legacyModel(p,revision,live=false){
    const maps=new Map([['main',{id:'main',name:'原标注',mask:new Uint16Array(p.count)}]]),owners=new Uint32Array(p.count),authors=[];let labels=initialLabels;
    for(const row of db.prepare('SELECT * FROM events WHERE project=? AND revision<=? ORDER BY revision').all(p.id,revision)){
      const event=unpack(row.details);if(event.shared)continue;
      if(event.fork&&maps.has(event.fork.from))maps.set(event.fork.id,{id:event.fork.id,name:event.fork.name,mask:maps.get(event.fork.from).mask.slice()});
      let code=authors.findIndex(a=>a.id===row.author)+1;if(!code){authors.push({id:row.author,name:row.name});code=authors.length;}
      for(const patch of event.patches||[]){const target=maps.get(patch.branch);if(target)for(const [i,,value]of patch.entries){target.mask[i]=value;if(patch.branch==='main')owners[i]=code;}}
      labels=event.labels||labels;
    }
    if(live&&hasTable('branches'))for(const row of db.prepare('SELECT * FROM branches WHERE project=?').all(p.id))maps.set(row.id,{id:row.id,name:row.name,mask:unzip(Buffer.from(unpack(row.mask),'base64'),Uint16Array)});
    const first=maps.get('main')||maps.values().next().value;
    return {model:mergeLegacy(first.mask,[...maps.values()].filter(b=>b.id!==first.id),dims(p),authors,owners),labels,status:'editing'};
  }
  if(hasTable('branches')||hasTable('personal')){
    if(filename!==':memory:'){const folder=join(dirname(filename),'migrations');mkdirSync(folder,{recursive:true});const backup=join(folder,'before-single-result.sqlite');if(!existsSync(backup))db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    transaction(()=>{
      for(const p of db.prepare('SELECT * FROM projects').all())if(!db.prepare('SELECT project FROM shared_data WHERE project=?').get(p.id)){
        const {model,labels}=legacyModel(p,p.revision,true);saveModel(p.id,model);db.prepare('INSERT OR REPLACE INTO shared_baselines VALUES(?,?,?)').run(p.id,p.revision,pack({...modelJSON(model),labels,status:'editing'}));
      }
      db.exec('DROP TABLE IF EXISTS branches; DROP TABLE IF EXISTS personal;');
    });
  }
  function state(id,revision){
    const p=getProject(id);if(revision!==undefined&&(!Number.isInteger(revision)||revision<0||revision>p.revision))fail('修订记录不存在。',404);
    let model,labels=JSON.parse(p.labels),status=p.status,finalizedBy=p.finalized_by,finalizedAt=p.finalized_at,finalRevision=p.final_revision;
    if(revision===undefined||revision===p.revision)model=readModel(p);
    else{
      const baseline=db.prepare('SELECT * FROM shared_baselines WHERE project=?').get(id);
      if(revision<baseline.revision){const old=legacyModel(p,revision);model=old.model;labels=old.labels;status=old.status;finalizedBy=null;finalizedAt=null;finalRevision=null;}
      else{const data=unpack(baseline.data);model=fromJSON(data,p);labels=data.labels;status=data.status;finalizedBy=data.finalizedBy||null;finalizedAt=data.finalizedAt||null;finalRevision=data.finalRevision||null;
        for(const row of db.prepare('SELECT details FROM events WHERE project=? AND revision>? AND revision<=? ORDER BY revision').all(id,baseline.revision,revision)){
          const event=unpack(row.details);for(const [i,,value]of event.applied||[])model.mask[i]=value;for(const [i,code]of event.ownerUpdates||[])model.owners[i]=code;
          model.regions=event.regions;model.authors=event.authors;labels=event.labels;status=event.status;
          if(event.finalRevision){finalizedBy=event.finalizedBy;finalizedAt=event.finalizedAt;finalRevision=event.finalRevision;}
        }
      }
    }
    return {id:p.id,datasetId:p.dataset,name:p.dataset_name,revision:revision??p.revision,latestRevision:p.revision,mask:zip(model.mask).toString('base64'),regions:model.regions,labels,status,finalizedBy,finalizedAt,finalRevision};
  }
  function requireAdmin(person){if(person?.role!=='admin')fail('只有管理员可以审定、最终修改和定稿。',403);}
  function editable(p){if(p.status==='finalized')fail('该工程已定稿，请管理员重新开放后再编辑。',423);}
  function exact(p,body){if(body.revision!==p.revision)fail('共享成果已有新操作，请刷新后再审定。',409);}
  function saveEvent(p,person,op,kind,m,labels=JSON.parse(p.labels),status=p.status){
    const revision=p.revision+1;db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(p.id,revision,op,person.id,person.name,kind,new Date().toISOString(),pack({shared:true,...m,labels,status}));
    db.prepare('UPDATE projects SET revision=?,labels=?,status=? WHERE id=?').run(revision,JSON.stringify(labels),status,p.id);if(models.has(p.id))models.get(p.id).revision=revision;return revision;
  }
  function eventDelta(id,row){const data=unpack(row.details);if(!data.shared)return null;return {type:'delta',projectId:id,revision:row.revision,op:row.op,author:row.author,name:row.name,kind:row.kind,time:row.time,patch:data.canonical||encodePatch(data.applied||[]),regions:data.regions,labels:data.labels,status:data.status,finalizedBy:data.finalizedBy,finalizedAt:data.finalizedAt,finalRevision:data.finalRevision};}
  function delta(id,revision){const row=db.prepare('SELECT * FROM events WHERE project=? AND revision=?').get(id,revision);return row?eventDelta(id,row):null;}
  function resume(person){if(db.prepare('SELECT author FROM resume_keys WHERE author=?').get(person.id))return undefined;const key=randomBytes(32).toString('hex');db.prepare('INSERT INTO resume_keys VALUES(?,?,?)').run(person.id,person.name,digest(key));return key;}
  function recentAgreements(p,person,model,entries){
    const regionPoints=new Set(model.regions.flatMap(r=>r.indices)),wanted=new Set(entries.filter(([i,,after])=>model.mask[i]!==after&&model.authors[model.owners[i]-1]?.id===person.id&&!regionPoints.has(i)).map(([i])=>i)),found=new Map();
    if(!wanted.size)return found;
    for(const row of db.prepare('SELECT author,name,details FROM events WHERE project=? ORDER BY revision DESC').all(p.id)){
      const event=unpack(row.details);
      if(row.author!==person.id&&event.intent){const b=Buffer.from(event.intent,'base64');for(let n=0;n<b.length;n+=8){const i=b.readUInt32LE(n);if(wanted.has(i)&&b.readUInt16LE(n+6)===model.mask[i]){found.set(i,{id:row.author,name:row.name});wanted.delete(i);}}}
      if(row.author===person.id)for(const [i,,value]of event.applied||[])if(value===model.mask[i])wanted.delete(i);
      if(!wanted.size)break;
    }return found;
  }
  function session(name,credentials){
    if(typeof name!=='string'||!name.trim()||name.trim().length>40)fail('请输入 1～40 字的昵称。');let person={id:randomUUID(),name:name.trim()},resumeKey;
    if(credentials){const identity=db.prepare('SELECT * FROM resume_keys WHERE author=?').get(credentials.authorId);if(!identity||typeof credentials.resumeKey!=='string'||identity.secret!==digest(credentials.resumeKey))fail('本地身份恢复失败。',401);person={id:identity.author,name:identity.name};resumeKey=credentials.resumeKey;}
    const token=randomBytes(32).toString('hex');db.prepare('INSERT INTO people VALUES(?,?,?)').run(digest(token),person.id,person.name);person.role=db.prepare('SELECT role FROM roles WHERE author=?').get(person.id)?.role||'engineer';resumeKey??=resume(person);return {token,person,resumeKey};
  }
  const store={
    close:()=>{models.clear();db.close();},resume,session,delta,
    updates(id,after){const p=getProject(id);if(!Number.isSafeInteger(after)||after<0||after>p.revision)return {reset:true,revision:p.revision};const baseline=db.prepare('SELECT revision FROM shared_baselines WHERE project=?').get(id);if(after<baseline.revision)return {reset:true,revision:p.revision};const rows=db.prepare('SELECT * FROM events WHERE project=? AND revision>? AND revision<=? ORDER BY revision LIMIT 128').all(id,after,p.revision),events=rows.map(row=>eventDelta(id,row));return events.some(e=>!e)?{reset:true,revision:p.revision}:{revision:p.revision,events,more:rows.length===128&&rows.at(-1).revision<p.revision};},
    person(token){if(!token)return null;const p=db.prepare('SELECT id,name FROM people WHERE token=?').get(digest(token));return p?{...p,role:db.prepare('SELECT role FROM roles WHERE author=?').get(p.id)?.role||'engineer'}:null;},
    adminSession(key){if(typeof key!=='string'||!timingSafeEqual(Buffer.from(digest(key),'hex'),Buffer.from(digest(adminKey),'hex')))fail('管理员密钥不正确。',403);const result=session('管理员');db.prepare('INSERT OR REPLACE INTO roles VALUES(?,?)').run(result.person.id,'admin');result.person.role='admin';return result;},
    logout(token){if(token)db.prepare('DELETE FROM people WHERE token=?').run(digest(token));},
    join(dataset,bytes,volume){const fingerprint=digest(bytes),id=digest(dataset+fingerprint).slice(0,32);
      if(!db.prepare('SELECT id FROM projects WHERE id=?').get(id))transaction(()=>{db.prepare('INSERT INTO projects(id,dataset,fingerprint,count,header,labels,dataset_name) VALUES(?,?,?,?,?,?,?)').run(id,dataset,fingerprint,volume.data.length,volume.header,JSON.stringify(initialLabels),volume.name);const m={mask:new Uint16Array(volume.data.length),owners:new Uint32Array(volume.data.length),authors:[],regions:[],dims:volume.dims};saveModel(id,m);db.prepare('INSERT INTO shared_baselines VALUES(?,?,?)').run(id,0,pack({...modelJSON(m),labels:initialLabels,status:'editing'}));});
      else if(!getProject(id).dataset_name)db.prepare('UPDATE projects SET dataset_name=? WHERE id=?').run(volume.name,id);
      return state(id);
    },state,revision(id){return getProject(id).revision;},
    source(id,person){requireAdmin(person);const p=getProject(id);return {dataset:p.dataset,fingerprint:p.fingerprint,name:p.dataset_name};},
    projects(person){requireAdmin(person);return db.prepare('SELECT id,dataset AS datasetId,dataset_name AS name,revision,status,finalized_by AS finalizedBy,finalized_at AS finalizedAt FROM projects ORDER BY rowid DESC').all().map(p=>({...p,regions:readModel(getProject(p.id)).regions.length,contributors:db.prepare('SELECT author,name,COUNT(*) AS operations FROM events WHERE project=? GROUP BY author ORDER BY operations DESC').all(p.id)}));},
    history(id){getProject(id);return db.prepare('SELECT revision,op,author,name,kind,time FROM events WHERE project=? ORDER BY revision DESC LIMIT 100').all(id);},
    label(id,person,body){return transaction(()=>{const p=getProject(id);editable(p);if(body.op){if(!validId(body.op))fail('操作编号无效。');const old=db.prepare('SELECT revision,details FROM events WHERE project=? AND op=?').get(id,body.op);if(old)return {revision:old.revision,label:unpack(old.details).labels.find(l=>l.id===body.id),duplicate:true};}
      const labels=JSON.parse(p.labels);let label;if(body.id!==undefined){label=labels.find(l=>l.id===body.id);if(!label)fail('标签不存在。');}else{const next=Math.max(...labels.map(l=>l.id))+1;if(next>65535||labels.length>=64)fail('标签数量已达上限。');label={id:next,name:`标注 ${next}`,color:['#fb9f67','#859dff','#ed78b6','#e5d46f','#74c5f4'][(next-2)%5]};labels.push(label);}
      if(body.name!==undefined){if(typeof body.name!=='string'||!body.name.trim()||body.name.length>60)fail('标签名称无效。');label.name=body.name.trim();}if(body.color!==undefined){if(!/^#[a-f0-9]{6}$/i.test(body.color))fail('颜色无效。');label.color=body.color;}
      const m=readModel(p),revision=saveEvent(p,person,body.op||randomUUID(),'标签设置',{applied:[],ownerUpdates:[],regions:m.regions,authors:m.authors},labels);return {revision,label};
    });},
    apply(id,person,body){return transaction(()=>{
      if(body.key!==undefined&&(typeof body.key!=='string'||!body.key.startsWith(person.id+':'+id+':')))fail('操作属于另一作者，请恢复原身份后续传。',401);if(!validId(body.op))fail('操作编号无效。');
      const old=db.prepare('SELECT revision FROM events WHERE project=? AND op=?').get(id,body.op);if(old)return {revision:old.revision,duplicate:true};
      const p=getProject(id);editable(p);if(body.baseRevision>p.revision)fail('客户端修订号无效。');if(body.review)requireAdmin(person);
      const entries=decodePatch(body,p.count),allowed=new Set([0,...JSON.parse(p.labels).map(l=>l.id)]);if(entries.some(([,before,after])=>!allowed.has(before)||!allowed.has(after)))fail('编辑包含未知标签。');
      const model=readModel(p),result=applyShared(model,person,entries,{review:!!body.review,agreements:body.review?new Map():recentAgreements(p,person,model,entries)});
      const revision=saveEvent(p,person,body.op,body.review?'管理员最终修改':body.kind==='undo'?'撤销':body.kind==='redo'?'重做':'标注',{intent:body.patch,canonical:encodePatch(entries.map(([i,before])=>[i,before,model.mask[i]])),applied:result.applied,ownerUpdates:result.ownerUpdates,regions:result.model.regions,authors:result.model.authors});return {revision,parallelCount:result.conflictCount};
    });},
    resolve(id,person,body){requireAdmin(person);return transaction(()=>{const p=getProject(id);editable(p);exact(p,body);if(body.label!==undefined&&![0,...JSON.parse(p.labels).map(l=>l.id)].includes(body.label))fail('标签无效。');const result=resolveRegion(readModel(p),person,body);return {revision:saveEvent(p,person,randomUUID(),'管理员审定并列标注',{applied:result.applied,ownerUpdates:result.ownerUpdates,regions:result.model.regions,authors:result.model.authors})};});},
    finalize(id,person,body){requireAdmin(person);return transaction(()=>{const p=getProject(id);editable(p);exact(p,body);const m=readModel(p);if(m.regions.length)fail('仍有并列标注未审定，暂不能定稿。',409);const time=new Date().toISOString(),revision=saveEvent(p,person,randomUUID(),'管理员定稿',{applied:[],ownerUpdates:[],regions:[],authors:m.authors,finalizedBy:person.name,finalizedAt:time,finalRevision:p.revision+1},JSON.parse(p.labels),'finalized');db.prepare('UPDATE projects SET finalized_by=?,finalized_at=?,final_revision=? WHERE id=?').run(person.name,time,revision,id);db.prepare('INSERT INTO final_results VALUES(?,?,?,?,?,?)').run(id,revision,person.id,person.name,time,niftiBytes(p.header,m.mask));return {revision};});},
    reopen(id,person,body){requireAdmin(person);return transaction(()=>{const p=getProject(id);exact(p,body);if(p.status!=='finalized')fail('工程尚未定稿。');const m=readModel(p);return {revision:saveEvent(p,person,randomUUID(),'管理员重新开放',{applied:[],ownerUpdates:[],regions:m.regions,authors:m.authors},JSON.parse(p.labels),'editing')};});},
    export(id,revision){const p=getProject(id),s=state(id,revision),mask=unzip(Buffer.from(s.mask,'base64'),Uint16Array),nifti=niftiBytes(p.header,mask),files=annotationFiles(nifti,s.labels,{projectId:id,datasetId:p.dataset,revision:s.revision,status:s.status,parallelRegions:s.regions});return {bytes:Buffer.from(zipSync(files,archiveOptions)),revision:s.revision,type:'application/zip',extension:'zip'};}
  };return store;
}
function sessionToken(req){return /(?:^|;\s*)deepmark_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];}
function sameOrigin(req){try{return !req.headers.origin||new URL(req.headers.origin).host===req.headers.host;}catch{return false;}}
async function body(req){let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>46*1024*1024)fail('操作数据超过上限。',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{fail('请求格式无效。');}}
export function attachCollaboration(server,{store,resolveDataset,json}){
  const wss=new WebSocketServer({noServer:true,maxPayload:46*1024*1024});
  function broadcast(id,revision){const event=store.delta(id,revision);if(!event)return;const message=JSON.stringify(event);for(const ws of wss.clients)if(ws.project===id&&ws.readyState===1){if(ws.bufferedAmount>8*1024*1024)ws.close(1013,'Reconnect to catch up');else ws.send(message);}return event;}
  server.on('upgrade',(req,socket,head)=>{socket.on('error',()=>socket.destroy());const url=new URL(req.url,'http://localhost'),token=sessionToken(req),person=store.person(token);if(url.pathname!=='/api/collaboration/socket'||!person||!sameOrigin(req)){socket.destroy();return;}const id=url.searchParams.get('project');let revision;try{revision=store.revision(id);}catch{socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{
    ws.on('error',()=>ws.terminate());ws.project=id;ws.session=digest(token);ws.send(JSON.stringify({type:'ready',projectId:id,revision,ready:true}));
    ws.on('message',raw=>{
      let message;try{message=JSON.parse(raw.toString());}catch{ws.close(1008,'Invalid JSON');return;}
      try{
        const current=store.person(token);if(!current||current.id!==message.author)fail('当前登录身份已变化，请恢复原作者身份。',401);
        if(!['operation','label'].includes(message.type)||!validId(message.requestId)||message.operation?.op!==message.requestId)fail('实时操作格式无效。');
        const started=performance.now(),result=store[message.type==='label'?'label':'apply'](id,current,message.operation),event=result.duplicate?store.delta(id,result.revision):broadcast(id,result.revision);
        ws.send(JSON.stringify({type:'ack',requestId:message.requestId,...result,delta:event,serverMs:performance.now()-started}));
      }catch(error){ws.send(JSON.stringify({type:'error',requestId:message.requestId,status:error.status||500,message:error.status?error.message:'实时同步失败，请重试。'}));}
    });
  });});
  server.once('close',()=>{for(const ws of wss.clients)ws.terminate();wss.close();store.close();});
  return async(req,res,url)=>{
    if(!url.pathname.startsWith('/api/collaboration/'))return false;
    try{
      if(!['GET','POST'].includes(req.method))fail('不支持此请求方式。',405);if(req.method==='POST'&&(!req.headers['x-deepmark-request']||!sameOrigin(req)))fail('请求来源无效。',403);
      let person=store.person(sessionToken(req));const path=url.pathname.slice('/api/collaboration'.length);
      if(path==='/session'||path==='/admin/session'){
        let resumeKey;if(req.method==='POST'){const data=await body(req),result=path==='/admin/session'?store.adminSession(data.key):store.session(data.name,data.credentials);person=result.person;resumeKey=result.resumeKey;res.setHeader('Set-Cookie',`deepmark_session=${result.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);}else if(person)resumeKey=store.resume(person);json(res,200,{person,resumeKey});return true;
      }
      if(!person)fail('请先登录团队。',401);if(req.headers['x-deepmark-author']&&req.headers['x-deepmark-author']!==person.id)fail('当前登录身份已变化，请恢复原作者身份。',401);
      if(path==='/logout'&&req.method==='POST'){const token=sessionToken(req);store.logout(token);for(const ws of wss.clients)if(ws.session===digest(token))ws.close();res.setHeader('Set-Cookie','deepmark_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');json(res,200,{ok:true});return true;}
      if(path==='/projects'&&req.method==='POST'){const data=await body(req),dataset=await resolveDataset(data.datasetId);if(!dataset)fail('数据集不存在。',404);json(res,200,store.join(data.datasetId,dataset.bytes,dataset.volume));return true;}
      if(path==='/admin/projects'&&req.method==='GET'){json(res,200,{projects:store.projects(person)});return true;}
      const source=/^\/admin\/projects\/([a-f0-9]{32})\/source$/.exec(path);
      if(source&&req.method==='GET'){const info=store.source(source[1],person),dataset=await resolveDataset(info.dataset);if(!dataset||digest(dataset.bytes)!==info.fingerprint)fail('原始影像已移除或替换，不能用另一份影像进行审核。',410);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':dataset.bytes.length,'Content-Disposition':`attachment; filename="source.nii"; filename*=UTF-8''${encodeURIComponent(info.name||'source.nii')}`,'Cache-Control':'no-store'});res.end(dataset.bytes);return true;}
      const match=/^\/projects\/([a-f0-9]{32})(?:\/(history|events|operations|labels|export|resolve|finalize|reopen|workspace|workspace\/export))?$/.exec(path);if(!match)fail('接口不存在。',404);const [,id,action]=match;
      if(action?.startsWith('workspace'))fail('作者个人空间已取消，请使用统一共享成果。',410);
      if(req.method==='GET'){
        if(action==='history')json(res,200,{events:store.history(id)});
        else if(action==='events')json(res,200,store.updates(id,Number(url.searchParams.get('after'))));
        else if(action==='export'){const result=store.export(id,url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined);res.writeHead(200,{'Content-Type':result.type,'Content-Length':result.bytes.length,'Content-Disposition':`attachment; filename="deepmark-${id}-r${result.revision}.${result.extension}"`,'Cache-Control':'no-store'});res.end(result.bytes);}
        else if(!action){const current=store.revision(id);if(!url.searchParams.has('revision')&&url.searchParams.has('ifRevision')&&Number(url.searchParams.get('ifRevision'))===current)json(res,200,{unchanged:true,revision:current});else json(res,200,store.state(id,url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined));}else fail('接口不存在。',404);
      }else if(['operations','labels','resolve','finalize','reopen'].includes(action)){const data=await body(req),method={operations:'apply',labels:'label',resolve:'resolve',finalize:'finalize',reopen:'reopen'}[action],result=store[method](id,person,data),event=result.duplicate?store.delta(id,result.revision):broadcast(id,result.revision);json(res,200,{...result,delta:event});}else fail('接口不存在。',404);
    }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'协同服务处理失败，请重试。'});else res.destroy();}return true;
  };
}
