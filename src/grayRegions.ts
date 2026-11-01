export type GrayMode='bands'|'level';
export type Partition={width:number;height:number;labels:Uint32Array;order:Uint32Array;offsets:Uint32Array;count:number;bandWidth:number};
export type RegionOutline={path:string;count:number;minimum:number;maximum:number;truncated:boolean;bounds:{min:number[];max:number[]}};
function validate(data:Float32Array,width:number,height:number){if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||data.length!==width*height)throw new Error('切片尺寸无效。');}
export function partitionGray(data:Float32Array,width:number,height:number,bandWidth:number,excluded?:Uint8Array):Partition{
  validate(data,width,height);if(!Number.isFinite(bandWidth)||bandWidth<=0)throw new Error('灰度区间宽度必须大于 0。');
  const labels=new Uint32Array(data.length),order=new Uint32Array(data.length),offsets=new Uint32Array(data.length+2);let count=0,tail=0;
  for(let seed=0;seed<data.length;seed++){
    if(labels[seed]||excluded?.[seed])continue;const id=++count,band=Math.floor(data[seed]/bandWidth);offsets[id]=tail;let head=tail;order[tail++]=seed;labels[seed]=id;
    while(head<tail){const i=order[head++],x=i%width,y=Math.floor(i/width);
      for(let dy=-1;dy<=1;dy++){const yy=y+dy;if(yy<0||yy>=height)continue;for(let dx=-1;dx<=1;dx++){const xx=x+dx;if((!dx&&!dy)||xx<0||xx>=width)continue;const n=xx+yy*width;if(!labels[n]&&!excluded?.[n]&&Math.floor(data[n]/bandWidth)===band){labels[n]=id;order[tail++]=n;}}}
    }offsets[id+1]=tail;
  }return {width,height,labels,order,offsets,count,bandWidth};
}
export function levelRegion(data:Float32Array,width:number,height:number,seed:number,excluded?:Uint8Array){
  validate(data,width,height);if(!Number.isInteger(seed)||seed<0||seed>=data.length)throw new Error('鼠标位置超出影像范围。');
  const seen=new Uint8Array(data.length),queue=new Uint32Array(data.length),level=data[seed];let head=0,tail=1;queue[0]=seed;seen[seed]=1;
  if(excluded?.[seed])return {pixels:new Uint32Array(),seen:new Uint8Array(data.length),level};
  while(head<tail){const i=queue[head++],x=i%width,y=Math.floor(i/width);for(let dy=-1;dy<=1;dy++){const yy=y+dy;if(yy<0||yy>=height)continue;for(let dx=-1;dx<=1;dx++){const xx=x+dx;if((!dx&&!dy)||xx<0||xx>=width)continue;const n=xx+yy*width;if(!seen[n]&&!excluded?.[n]&&data[n]>=level){seen[n]=1;queue[tail++]=n;}}}}
  return {pixels:queue.subarray(0,tail),seen,level};
}
export function regionOutline(data:Float32Array,width:number,height:number,pixels:Uint32Array,contains:(i:number)=>boolean,maxRuns=30000):RegionOutline{
  let left=width,right=0,top=height,bottom=0,min=Infinity,max=-Infinity;
  for(const i of pixels){const x=i%width,y=Math.floor(i/width);if(x<left)left=x;if(x>right)right=x;if(y<top)top=y;if(y>bottom)bottom=y;if(data[i]<min)min=data[i];if(data[i]>max)max=data[i];}
  const commands:string[]=[];let truncated=false;
  const inside=(x:number,y:number)=>x>=0&&x<width&&y>=0&&y<height&&contains(x+y*width);
  for(let y=top;y<=bottom+1;y++){let start=-1;for(let x=left;x<=right+1;x++){const edge=x<=right&&inside(x,y-1)!==inside(x,y);if(edge&&start<0)start=x;if(!edge&&start>=0){commands.push(`M${start},${y}H${x}`);start=-1;if(commands.length>maxRuns){truncated=true;break;}}}if(truncated)break;}
  if(!truncated)for(let x=left;x<=right+1;x++){let start=-1;for(let y=top;y<=bottom+1;y++){const edge=y<=bottom&&inside(x-1,y)!==inside(x,y);if(edge&&start<0)start=y;if(!edge&&start>=0){commands.push(`M${x},${start}V${y}`);start=-1;if(commands.length>maxRuns){truncated=true;break;}}}if(truncated)break;}
  return {path:truncated?'':commands.join(''),count:pixels.length,minimum:min,maximum:max,truncated,bounds:{min:[left,top],max:[right,bottom]}};
}
