import type { Point2 } from './viewportGeometry.ts';
import type { AnnotationStyle } from './types.ts';

export type { AnnotationStyle } from './types.ts';
export const DEFAULT_ANNOTATION_STYLE: Readonly<AnnotationStyle> = Object.freeze({arrow:'arrow',rotation:0,align:'left'});
export const ANNOTATION_MAX_VISIBLE_CHARACTERS = 64;
/** Application mode policy, not a recovered native rule for overlapping text and seed targets. */
export function allowsMeasurementLabels(tool='navigate'):boolean {
  return ['navigate','distance','angle','diameter','ellipse','area','density-rectangle','density-ellipse','annotation'].includes(tool);
}
export function allowsMeasurementHandle(tool:string|undefined,kind:string):boolean {
  return allowsMeasurementLabels(tool)||(tool==='surface-distance'&&kind==='surface-distance');
}
/** Shared application layout policy; the native help does not specify its long-text cutoff. */
export function annotationTextWidth(text:string):number {
  return [...text].reduce((sum,char)=>sum+(/[\s.,:;!ilI1]/.test(char)?4:/[MWmw]/.test(char)?11:char.codePointAt(0)!>255?12:7),0);
}
export function annotationDisplayText(text:string,maxWidth=220):string {
  return [...text].length>ANNOTATION_MAX_VISIBLE_CHARACTERS||/[\r\n]/.test(text)||annotationTextWidth(text)>maxWidth?'...':text;
}
export function annotationLayout(anchor:Point2,fullText:string,style?:Partial<AnnotationStyle>,options:{viewport?:Point2;labelPoint?:Point2;maxTextWidth?:number}={}) {
  const actual:AnnotationStyle={...DEFAULT_ANNOTATION_STYLE,...style};
  if(!['none','arrow','dot'].includes(actual.arrow)||!Number.isFinite(actual.rotation)||!['left','center','right'].includes(actual.align))throw new Error('注释样式无效。');
  actual.rotation%=360;
  const viewport=options.viewport??[1000,1000],maxWidth=Math.max(16,Math.min(options.maxTextWidth??220,viewport[0]-32));
  const displayText=annotationDisplayText(fullText,maxWidth),width=Math.max(30,annotationTextWidth(displayText)+14),height=24;
  const left=actual.align==='center'?-width/2:actual.align==='right'?-width:0,top=-18,right=left+width,bottom=top+height;
  const radians=actual.rotation*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians),localCorners:Point2[]=[[left,top],[right,top],[right,bottom],[left,bottom]];
  const rotated=localCorners.map(([x,y])=>[x*c-y*s,x*s+y*c] as Point2),desired=options.labelPoint??[anchor[0]+26,anchor[1]-24];
  const clamp=(value:number,min:number,max:number)=>min>max?(min+max)/2:Math.max(min,Math.min(max,value));
  const x=clamp(desired[0],8-Math.min(...rotated.map(p=>p[0])),viewport[0]-8-Math.max(...rotated.map(p=>p[0]))),y=clamp(desired[1],8-Math.min(...rotated.map(p=>p[1])),viewport[1]-8-Math.max(...rotated.map(p=>p[1])));
  const transform=(p:Point2):Point2=>[x+p[0]*c-p[1]*s,y+p[0]*s+p[1]*c];
  const ax=(anchor[0]-x)*c+(anchor[1]-y)*s,ay=-(anchor[0]-x)*s+(anchor[1]-y)*c;
  const attachment=transform([clamp(ax,left,right),clamp(ay,top,bottom)]),leader:Point2[]=[[...anchor],attachment];
  const dx=attachment[0]-anchor[0],dy=attachment[1]-anchor[1],length=Math.hypot(dx,dy),ux=length?dx/length:0,uy=length?dy/length:0;
  const arrowHead:Point2[]|null=actual.arrow==='arrow'&&length>1e-6?[[...anchor],[anchor[0]+8*ux-4*uy,anchor[1]+8*uy+4*ux],[anchor[0]+8*ux+4*uy,anchor[1]+8*uy-4*ux]]:null;
  return {fullText,displayText,style:actual,x,y,width,height,left,top,right,bottom,textX:actual.align==='left'?left+7:actual.align==='right'?right-7:0,textY:-2,corners:localCorners.map(transform),leader,arrowHead,dot:actual.arrow==='dot'?[...anchor] as Point2:null};
}
export type AnnotationLayout=ReturnType<typeof annotationLayout>;
export function annotationLabelHit(layout:AnnotationLayout,point:Point2,padding=3):boolean {
  const angle=layout.style.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),dx=point[0]-layout.x,dy=point[1]-layout.y,x=dx*c+dy*s,y=-dx*s+dy*c;
  return x>=layout.left-padding&&x<=layout.right+padding&&y>=layout.top-padding&&y<=layout.bottom+padding;
}
export function paintCanvasAnnotation(ctx:CanvasRenderingContext2D,layout:AnnotationLayout,color:string) {
  ctx.save();ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(...layout.leader[0]!);ctx.lineTo(...layout.leader[1]!);ctx.stroke();
  if(layout.arrowHead){ctx.beginPath();layout.arrowHead.forEach((point,index)=>index?ctx.lineTo(...point):ctx.moveTo(...point));ctx.closePath();ctx.fill();}
  if(layout.dot){ctx.beginPath();ctx.arc(...layout.dot,3.5,0,Math.PI*2);ctx.fill();}
  ctx.translate(layout.x,layout.y);ctx.rotate(layout.style.rotation*Math.PI/180);ctx.fillStyle='#101f33ed';ctx.fillRect(layout.left,layout.top,layout.width,layout.height);ctx.strokeRect(layout.left,layout.top,layout.width,layout.height);
  ctx.fillStyle=color;ctx.font='12px Segoe UI,Microsoft YaHei';ctx.textAlign=layout.style.align;ctx.fillText(layout.displayText,layout.textX,layout.textY);ctx.restore();
}
