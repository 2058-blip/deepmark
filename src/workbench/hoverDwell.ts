export const HOVER_DWELL_MS=500;
export interface HoverPointer {clientX:number;clientY:number}
export interface HoverDwellClock {
  set(callback:()=>void,delayMs:number):unknown;
  clear(token:unknown):void;
}

/** Stationary-pointer delay. Generation checks also reject callbacks that were
 * already queued when a pointer/view change cancelled their timer. */
export function createHoverDwell(options:{show:(point:HoverPointer)=>void;hide:()=>void;clock?:HoverDwellClock}){
  const clock=options.clock||{set:(callback:()=>void,delay:number)=>setTimeout(callback,delay),clear:(token:unknown)=>clearTimeout(token as ReturnType<typeof setTimeout>)};
  let pointer:HoverPointer|null=null,token:unknown,generation=0,disposed=false;
  function clear(){generation++;if(token!==undefined){clock.clear(token);token=undefined;}}
  function arm(){
    clear();options.hide();if(!pointer||disposed)return;
    const current=generation;
    token=clock.set(()=>{
      if(disposed||current!==generation||!pointer)return;
      token=undefined;options.show({...pointer});
    },HOVER_DWELL_MS);
  }
  function cancel(){clear();pointer=null;options.hide();}
  return{
    move(point:HoverPointer){
      if(disposed)return;
      if(!Number.isFinite(point.clientX)||!Number.isFinite(point.clientY)){cancel();return;}
      if(pointer?.clientX===point.clientX&&pointer.clientY===point.clientY)return;
      pointer={clientX:point.clientX,clientY:point.clientY};arm();
    },
    invalidate(){if(!disposed)arm();},
    cancel,
    dispose(){if(disposed)return;disposed=true;cancel();},
  };
}
