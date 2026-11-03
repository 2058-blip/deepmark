import type {ParallelRegion} from './collaborationTypes.ts';
export type VoxelOpinion={author:string;label:number;annotationId?:string;sourceKey?:string};
export type SameLabelClaim=[number,string[]];

/** Sparse author information supplements the primary mask. Same-color agreements
 * deliberately remain separate until the current author's opinion is withdrawn. */
export function opinionIndex(regions:readonly ParallelRegion[],claims:readonly SameLabelClaim[],canonical:(index:number)=>number){
  const result=new Map<number,VoxelOpinion[]>();
  for(const region of regions)for(const row of region.annotations)for(const [index,label]of row.values){const list=result.get(index)||[];list.push({author:row.author,label,annotationId:row.id,...(row.sourceKey?{sourceKey:row.sourceKey}:{})});result.set(index,list);}
  for(const [index,authors]of claims)if(!result.has(index))result.set(index,authors.map(author=>({author,label:canonical(index)})));
  return result;
}
export function projectOpinion(author:string,after:number,canonical:number,owned:boolean,opinions?:readonly VoxelOpinion[]){
  const source=opinions?.length?opinions:canonical?[{author:owned?author:'',label:canonical}]:[];
  const own=source.find(row=>row.author===author&&(!row.sourceKey||row.sourceKey===author)),remaining=source.filter(row=>after?row.author!==author||!!row.sourceKey&&row.sourceKey!==author:row.author!==author).map(row=>({...row}));
  if(after)remaining.push({author,label:after,...(own?.sourceKey?{sourceKey:own.sourceKey}:{}),...(own?.annotationId?{annotationId:own.annotationId}:{})});
  let value=0;
  if(after&&owned)value=after;
  else if(!owned&&remaining.some(row=>row.label===canonical))value=canonical;
  else value=remaining.find(row=>row.label!==0)?.label||0;
  return {value,choices:[...new Set(remaining.map(row=>row.label))],opinions:remaining};
}

/** Preserve the currently displayed parallel opinions in a local rescue archive,
 * including conflicts which have not reached the shared server model yet. */
export function projectRegions(regions:readonly ParallelRegion[],intents:ReadonlyMap<number,number>,project:(index:number,after:number)=>ReturnType<typeof projectOpinion>,dims:readonly number[],author:{id:string;name:string},names:ReadonlyMap<string,string>=new Map()):ParallelRegion[]{
  if(!intents.size)return [...regions];
  const result:ParallelRegion[]=[],represented=new Set<number>(),indexed=opinionIndex(regions,[],()=>0);
  const boundsFor=(indices:readonly number[])=>{
    const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
    for(const index of indices){const point=[index%dims[0],Math.floor(index/dims[0])%dims[1],Math.floor(index/(dims[0]*dims[1]))];for(let axis=0;axis<3;axis++){bounds.min[axis]=Math.min(bounds.min[axis],point[axis]);bounds.max[axis]=Math.max(bounds.max[axis],point[axis]);}}
    return bounds;
  };
  const annotation=(opinion:VoxelOpinion,id:string,created:string)=>({id,author:opinion.author||'unknown-primary',name:opinion.author===author.id?author.name:names.get(opinion.author)||'已有标注（作者待查询）',...(opinion.sourceKey?{sourceKey:opinion.sourceKey}:{}),created,values:[] as [number,number][]});
  for(const region of regions){
    const rows=new Map(region.annotations.map(row=>[row.id,{...row,values:[] as [number,number][]}])),indices:number[]=[];
    for(const index of region.indices){
      represented.add(index);
      const existing=indexed.get(index)||[];
      const values=intents.has(index)?project(index,intents.get(index)!).opinions:existing;
      if(!values.length||intents.has(index)&&values.length===1&&values[0].label!==0)continue;
      indices.push(index);
      for(const value of values){const id=value.annotationId||`local:${author.id}:${region.id}`;if(!rows.has(id))rows.set(id,annotation(value,id,region.created));rows.get(id)!.values.push([index,value.label]);}
    }
    if(indices.length)result.push({...region,indices,annotations:[...rows.values()].filter(row=>row.values.length),bounds:boundsFor(indices)});
  }
  for(const [index,after]of intents){
    if(represented.has(index))continue;
    const values=project(index,after);if(values.choices.length<2)continue;
    const id=`local:${author.id}:${index}`,created=new Date().toISOString();
    result.push({id,indices:[index],bounds:boundsFor([index]),created,updated:created,annotations:values.opinions.map((opinion,n)=>({...annotation(opinion,`${id}:${n}`,created),values:[[index,opinion.label]] as [number,number][]}))});
  }
  return result;
}
