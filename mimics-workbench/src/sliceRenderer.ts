import type {Axis,ThresholdRange,Volume} from './core.ts';
import {sliceLayout,extractSlice} from './sliceData.ts';
import type {Segment} from './view.ts';
export function grayPixels(values:Float32Array,center:number,width:number,target:Uint8ClampedArray){
  const low=center-width/2,scale=255/Math.max(width,1);for(let i=0,j=0;i<values.length;i++,j+=4){const gray=(values[i]-low)*scale;target[j]=gray;target[j+1]=gray;target[j+2]=gray;target[j+3]=255;}return target;
}
export type GrayFrame={canvas:HTMLCanvasElement;values:Float32Array;width:number;height:number};
export class SliceRenderer{
  private cache=new Map<number,GrayFrame>();private pool:GrayFrame[]=[];private volume:Volume|null=null;private axis:Axis=2;private window='';private scratch:ImageData|null=null;
  private overlay=document.createElement('canvas');private overlayContext=this.overlay.getContext('2d')!;private overlayImage:ImageData|null=null;
  private palette=new Uint32Array(65536);private paletteKey='';private displayContext:CanvasRenderingContext2D;
  private canvas:HTMLCanvasElement;
  builds=0;draws=0;
  constructor(canvas:HTMLCanvasElement){this.canvas=canvas;this.displayContext=canvas.getContext('2d')!;}
  gray(volume:Volume,axis:Axis,slice:number,center:number,width:number):GrayFrame{
    const window=`${center}:${width}`;if(this.volume!==volume||this.axis!==axis||this.window!==window){for(const frame of this.cache.values())this.pool.push(frame);this.cache.clear();this.volume=volume;this.axis=axis;this.window=window;}
    const cached=this.cache.get(slice);if(cached){this.cache.delete(slice);this.cache.set(slice,cached);return cached;}
    const layout=sliceLayout(volume,axis,slice),bytes=layout.width*layout.height*8,limit=Math.max(1,Math.min(12,Math.floor(20*1024*1024/bytes)));
    if(this.cache.size>=limit){const oldest=this.cache.keys().next().value!;this.pool.push(this.cache.get(oldest)!);this.cache.delete(oldest);}
    const frame=this.pool.pop()||{canvas:document.createElement('canvas'),values:new Float32Array(),width:0,height:0};
    frame.values=extractSlice(volume,axis,slice,frame.values);frame.width=layout.width;frame.height=layout.height;
    if(frame.canvas.width!==frame.width)frame.canvas.width=frame.width;if(frame.canvas.height!==frame.height)frame.canvas.height=frame.height;
    if(!this.scratch||this.scratch.width!==frame.width||this.scratch.height!==frame.height)this.scratch=new ImageData(frame.width,frame.height);
    grayPixels(frame.values,center,width,this.scratch.data);frame.canvas.getContext('2d')!.putImageData(this.scratch,0,0);this.cache.set(slice,frame);this.builds++;
    while(this.pool.length>limit){const old=this.pool.pop()!;old.canvas.width=0;old.canvas.height=0;}return frame;
  }
  labels(volume:Volume,axis:Axis,slice:number,mask:Uint16Array,segments:Segment[],threshold:ThresholdRange|null,parallel?:Map<number,number[]>){
    const l=sliceLayout(volume,axis,slice),key=segments.map(s=>`${s.id}:${s.color}:${s.visible}`).join('|');
    if(key!==this.paletteKey){this.paletteKey=key;this.palette.fill(0);for(const s of segments)if(s.visible){const r=parseInt(s.color.slice(1,3),16),g=parseInt(s.color.slice(3,5),16),b=parseInt(s.color.slice(5,7),16);this.palette[s.id]=(r|(g<<8)|(b<<16)|0xff000000)>>>0;}}
    if(!this.overlayImage||this.overlayImage.width!==l.width||this.overlayImage.height!==l.height){this.overlay.width=l.width;this.overlay.height=l.height;this.overlayImage=this.overlayContext.createImageData(l.width,l.height);}
    const pixels=new Uint32Array(this.overlayImage.data.buffer);pixels.fill(0);const palette=this.palette,hasParallel=!!parallel?.size,data=volume.data;
    for(let y=0,j=0;y<l.height;y++){let index=l.base+(l.height-1-y)*l.stepY;for(let x=0;x<l.width;x++,j++,index+=l.stepX){
      let label=mask[index];if(threshold)label=data[index]>=threshold.minimum&&data[index]<=threshold.maximum?threshold.label:label===threshold.label?0:label;
      const choices=!threshold&&hasParallel?parallel!.get(index):undefined;
      if(choices?.length){let r=0,g=0,b=0,n=0;for(const value of choices){const color=palette[value];if(color){r+=color&255;g+=(color>>>8)&255;b+=(color>>>16)&255;n++;}}if(n)pixels[j]=((Math.round(r/n))|(Math.round(g/n)<<8)|(Math.round(b/n)<<16)|(Math.round(255*n/choices.length)<<24))>>>0;}
      else pixels[j]=palette[label];
    }}this.overlayContext.putImageData(this.overlayImage,0,0);
  }
  draw(frame:GrayFrame,size:number[],box:{ox:number;oy:number;w:number;h:number},point:number[],a:number,b:number,opacity:number){
    const ratio=window.devicePixelRatio||1,width=Math.round(size[0]*ratio),height=Math.round(size[1]*ratio);if(this.canvas.width!==width)this.canvas.width=width;if(this.canvas.height!==height)this.canvas.height=height;
    const ctx=this.displayContext;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.globalAlpha=1;ctx.fillStyle='#080c11';ctx.fillRect(0,0,size[0],size[1]);ctx.imageSmoothingEnabled=false;
    const {ox,oy,w,h}=box;ctx.drawImage(frame.canvas,ox,oy,w,h);if(opacity>0){ctx.globalAlpha=opacity;ctx.drawImage(this.overlay,ox,oy,w,h);ctx.globalAlpha=1;}
    const x=ox+(point[a]+.5)/frame.width*w,y=oy+(frame.height-point[b]-.5)/frame.height*h;ctx.strokeStyle='#ffffff66';ctx.lineWidth=1;ctx.setLineDash([4,5]);ctx.beginPath();ctx.moveTo(x,oy);ctx.lineTo(x,oy+h);ctx.moveTo(ox,y);ctx.lineTo(ox+w,y);ctx.stroke();ctx.setLineDash([]);this.draws++;
  }
  destroy(){for(const frame of [...this.cache.values(),...this.pool]){frame.canvas.width=0;frame.canvas.height=0;}this.cache.clear();this.pool=[];this.overlay.width=0;this.overlay.height=0;}
}
