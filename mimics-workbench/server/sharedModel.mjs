import {randomUUID} from 'node:crypto';

export function components(indices,dims){
  const remaining=new Set(indices),groups=[],[nx,ny]=dims,plane=nx*ny;
  while(remaining.size){const first=remaining.values().next().value,group=[],queue=[first];remaining.delete(first);
    for(let n=0;n<queue.length;n++){const i=queue[n],x=i%nx,y=Math.floor(i/nx)%ny;group.push(i);for(const j of [x>0?i-1:-1,x<nx-1?i+1:-1,y>0?i-nx:-1,y<ny-1?i+nx:-1,i-plane,i+plane])if(remaining.delete(j))queue.push(j);}
    groups.push(group.sort((a,b)=>a-b));
  }return groups;
}
export function bounds(indices,dims){const min=[Infinity,Infinity,Infinity],max=[0,0,0];for(const i of indices){const p=[i%dims[0],Math.floor(i/dims[0])%dims[1],Math.floor(i/(dims[0]*dims[1]))];p.forEach((v,a)=>{min[a]=Math.min(min[a],v);max[a]=Math.max(max[a],v);});}return {min,max};}
function authorCode(model,person){let code=model.authors.findIndex(a=>a.id===person.id)+1;if(!code){model.authors.push({id:person.id,name:person.name});code=model.authors.length;}return code;}
function owner(model,i){return model.authors[model.owners[i]-1]||{id:'existing',name:'已有标注'};}
function option(region,person,key=person.id){let row=region.annotations.find(a=>(a.sourceKey||a.author)===key);if(!row){row={id:randomUUID(),author:person.id,name:person.name,sourceKey:key,values:[],created:new Date().toISOString()};region.annotations.push(row);}return row;}
const valueLookups=new WeakMap();
function setValue(row,i,value){let lookup=valueLookups.get(row);if(!lookup){lookup=new Map(row.values.map((pair,n)=>[pair[0],n]));valueLookups.set(row,lookup);}if(lookup.has(i))row.values[lookup.get(i)][1]=value;else{lookup.set(i,row.values.length);row.values.push([i,value]);}}
export function applyShared(model,person,entries,{review=false,agreements=new Map()}={}){
  const code=authorCode(model,person),byVoxel=new Map(),newConflicts=new Map(),applied=[],ownerUpdates=[],removed=new Map(),now=new Date().toISOString();
  for(const region of model.regions)for(const i of region.indices)byVoxel.set(i,region);
  function setPrimary(i,value){if(model.mask[i]!==value){applied.push([i,model.mask[i],value]);model.mask[i]=value;model.owners[i]=code;ownerUpdates.push([i,code]);}else if(review&&model.owners[i]!==code){model.owners[i]=code;ownerUpdates.push([i,code]);}}
  let conflictCount=0;
  for(const [i,before,after]of entries){
    const current=model.mask[i],region=byVoxel.get(i);
    if(review){setPrimary(i,after);if(region){if(!removed.has(region))removed.set(region,new Set());removed.get(region).add(i);}continue;}
    if(region){
      const own=option(region,person);setValue(own,i,after);if(owner(model,i).id===person.id)setPrimary(i,after);region.updated=now;conflictCount++;continue;
    }
    const previousOwner=agreements.get(i)||owner(model,i),differentAuthor=agreements.has(i)||!!model.owners[i]&&previousOwner.id!==person.id;
    if(current!==after&&(current!==before||differentAuthor)){if(agreements.has(i)){model.owners[i]=authorCode(model,previousOwner);ownerUpdates.push([i,model.owners[i]]);}newConflicts.set(i,{current,after,previousOwner});conflictCount++;}
    else setPrimary(i,after);
  }
  for(const [region,indices]of removed){region.indices=region.indices.filter(i=>!indices.has(i));for(const annotation of region.annotations)annotation.values=annotation.values.filter(([i])=>!indices.has(i));}
  for(const indices of components(newConflicts.keys(),model.dims)){
    const region={id:randomUUID(),indices,annotations:[],bounds:bounds(indices,model.dims),created:new Date().toISOString(),updated:new Date().toISOString()};
    for(const i of indices){const c=newConflicts.get(i);setValue(option(region,c.previousOwner),i,c.current);setValue(option(region,person,c.previousOwner.id===person.id?`${person.id}:incoming`:person.id),i,c.after);}
    model.regions.push(region);
  }
  model.regions=model.regions.filter(r=>r.indices.length).map(r=>({...r,bounds:bounds(r.indices,model.dims),annotations:r.annotations.filter(a=>a.values.length)}));
  return {model,applied,ownerUpdates,conflictCount};
}
export function resolveRegion(model,person,{regionId,annotationId,label}){
  const region=model.regions.find(r=>r.id===regionId);if(!region)throw Object.assign(new Error('并列标注区域不存在或已处理。'),{status:404});
  const row=region.annotations.find(a=>a.id===annotationId);
  if(label===undefined&&!row)throw Object.assign(new Error('请选择需要采用的标注。'),{status:400});
  const entries=label===undefined?row.values.map(([i,v])=>[i,model.mask[i],v]):region.indices.map(i=>[i,model.mask[i],label]);
  return applyShared(model,person,entries,{review:true});
}
export function mergeLegacy(mask,variants,dims,authors=[],owners=new Uint32Array(mask.length)){
  const model={mask:mask.slice(),owners,authors:[...authors],regions:[],dims},diffs=new Set();
  for(const variant of variants)variant.mask.forEach((value,i)=>{if(value!==mask[i])diffs.add(i);});
  for(const indices of components(diffs,dims)){
    const region={id:randomUUID(),indices,annotations:[],bounds:bounds(indices,dims),created:new Date().toISOString(),updated:new Date().toISOString()};
    for(const i of indices){setValue(option(region,owner(model,i)),i,mask[i]);for(const variant of variants)if(variant.mask[i]!==mask[i])setValue(option(region,{id:`legacy:${variant.id}`,name:`旧标注 · ${variant.name}`}),i,variant.mask[i]);}
    model.regions.push(region);
  }return model;
}
