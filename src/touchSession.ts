/** One touch transaction may own one viewport. Crossing viewports cancels the
 * transaction until every finger is lifted, rather than interleaving edits. */
export class TouchSession<Owner extends object>{
  private pointers=new Map<number,Owner|null>();
  private cancelled=false;
  private pen:number|null=null;
  private callbacks=new Map<Owner,()=>void>();
  register(owner:Owner,cancel:()=>void){this.callbacks.set(owner,cancel);return ()=>{this.callbacks.delete(owner);if([...this.pointers.values()].includes(owner)){this.cancelled=true;this.cancelAll();}};}
  touchDown(id:number,owner:Owner|null){
    const previous=[...this.pointers.values()];this.pointers.set(id,owner);
    if(this.pen!==null){this.cancelled=true;return;}
    if(this.cancelled||previous.some(value=>value!==owner)){this.cancelled=true;this.cancelAll();}
  }
  penDown(id:number){this.pen=id;if(this.pointers.size){this.cancelled=true;this.cancelAll();}}
  reset(){for(const cancel of this.callbacks.values())cancel();this.pointers.clear();this.pen=null;this.cancelled=false;}
  end(id:number){this.pointers.delete(id);if(this.pen===id)this.pen=null;if(!this.pointers.size)this.cancelled=false;}
  allows(owner:Owner){return !this.cancelled&&this.pen===null&&[...this.pointers.values()].every(value=>value===owner);}
  private cancelAll(){for(const [owner,cancel]of this.callbacks)if([...this.pointers.values()].includes(owner))cancel();}
}
const session=new TouchSession<HTMLCanvasElement>(),canvases=new Set<HTMLCanvasElement>();
function down(event:PointerEvent){
  const owner=event.target instanceof HTMLCanvasElement&&canvases.has(event.target)?event.target:null;
  if(event.pointerType==='touch')session.touchDown(event.pointerId,owner);
  else if(event.pointerType==='pen')session.penDown(event.pointerId);
}
function reset(){session.reset();}
function visibility(){if(document.visibilityState==='hidden')reset();}
function up(event:PointerEvent){if(event.pointerType==='touch'||event.pointerType==='pen')session.end(event.pointerId);}
export function registerTouchCanvas(canvas:HTMLCanvasElement,cancel:()=>void){
  if(!canvases.size){window.addEventListener('pointerdown',down,true);window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true);window.addEventListener('blur',reset);document.addEventListener('visibilitychange',visibility);}
  canvases.add(canvas);const unregister=session.register(canvas,cancel);
  return ()=>{unregister();canvases.delete(canvas);if(!canvases.size){window.removeEventListener('pointerdown',down,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);window.removeEventListener('blur',reset);document.removeEventListener('visibilitychange',visibility);session.reset();}};
}
export function touchCanvasAllowed(canvas:HTMLCanvasElement){return session.allows(canvas);}
