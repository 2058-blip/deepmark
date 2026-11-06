/** Drain completed operations without losing edits queued during an upload.
 * A successful send may remain in the outbox until its canonical event arrives;
 * do not send that key again in the same pass while waiting for that event.
 */
export function createQueuePump<T>(options:{
  canRun:()=>boolean;
  read:()=>Promise<T[]>;
  key:(item:T)=>string;
  send:(item:T)=>Promise<void>;
  onBusy?:(busy:boolean)=>void;
  onDrained?:()=>void;
  onError:(reason:unknown)=>void;
  onSettled?:()=>Promise<void>;
  retryMs?:number;
  schedule?:(callback:()=>void,delay:number)=>unknown;
  cancelTimer?:(handle:unknown)=>void;
}){
  const schedule=options.schedule||((callback:()=>void,delay:number)=>setTimeout(callback,delay));
  const cancelTimer=options.cancelTimer||((handle:unknown)=>clearTimeout(handle as ReturnType<typeof setTimeout>));
  let active:Promise<void>|null=null,retry:unknown|undefined,stopped=false,wake=false;
  const allowed=()=>!stopped&&options.canRun();
  function cancelRetry(){if(retry!==undefined){cancelTimer(retry);retry=undefined;}}
  function failed(reason:unknown){
    options.onError(reason);
    if(allowed()&&retry===undefined)retry=schedule(()=>{retry=undefined;void request();},options.retryMs??1500);
  }
  async function run(){
    options.onBusy?.(true);
    const sent=new Set<string>();
    try{
      while(allowed()){
        wake=false;
        const items=(await options.read()).filter(item=>!sent.has(options.key(item)));
        if(!allowed())break;
        if(!items.length){options.onDrained?.();break;}
        for(const item of items){
          if(!allowed())break;
          await options.send(item);sent.add(options.key(item));
        }
      }
    }catch(reason){failed(reason);}
    finally{
      options.onBusy?.(false);
      try{await options.onSettled?.();}catch(reason){failed(reason);}
    }
  }
  function request():Promise<void>{
    if(!allowed())return Promise.resolve();
    wake=true;
    if(active)return active;
    // Additional edits must not bypass the network-failure backoff.
    if(retry!==undefined)return Promise.resolve();
    active=Promise.resolve().then(run).finally(()=>{
      active=null;
      // A producer can finish after the last empty read or during onSettled.
      if(wake&&retry===undefined&&allowed())return request();
    });
    return active;
  }
  function dispose(){stopped=true;wake=false;cancelRetry();}
  return{request,cancelRetry,dispose};
}
