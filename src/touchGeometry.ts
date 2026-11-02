export type TouchPoint={x:number;y:number};

export function touchPair(a:TouchPoint,b:TouchPoint){
  return {center:[(a.x+b.x)/2,(a.y+b.y)/2] as [number,number],distance:Math.hypot(b.x-a.x,b.y-a.y)};
}

/** Scale around the original finger midpoint, then translate it to the current midpoint. */
export function pinchView(initialZoom:number,initialPan:readonly number[],size:readonly number[],initialCenter:readonly number[],initialDistance:number,currentCenter:readonly number[],currentDistance:number){
  const base=Number.isFinite(initialZoom)&&initialZoom>0?initialZoom:1;
  const ratio=Number.isFinite(initialDistance)&&initialDistance>0&&Number.isFinite(currentDistance)?Math.max(0,currentDistance)/initialDistance:1;
  const zoom=Math.max(.25,Math.min(8,base*ratio)),scale=zoom/base;
  const pan:[number,number]=[0,1].map(axis=>currentCenter[axis]-size[axis]/2-scale*(initialCenter[axis]-size[axis]/2-initialPan[axis])) as [number,number];
  return {zoom,pan};
}

/** Swiping up advances through the volume; each gesture starts from a stable slice. */
export function touchSlice(initialSlice:number,startY:number,currentY:number,total:number,pixelsPerSlice=18){
  const step=Number.isFinite(pixelsPerSlice)&&pixelsPerSlice>0?pixelsPerSlice:18;
  return Math.max(0,Math.min(Math.max(0,Math.floor(total)-1),initialSlice+Math.trunc((startY-currentY)/step)));
}

export function touchTap(start:TouchPoint,current:TouchPoint,elapsed:number){
  return elapsed>=0&&elapsed<=500&&Math.hypot(current.x-start.x,current.y-start.y)<=10;
}
