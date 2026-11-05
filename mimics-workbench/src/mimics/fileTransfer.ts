export interface SaveFileRequest {name:string;mime:string;extension:string;description:string;delivery?:'save-as'|'download';produce:()=>Promise<Uint8Array>|Uint8Array}
export type SaveFileResult={status:'written'|'download-started'|'cancelled';name:string};
export type SaveFileHandler=(request:SaveFileRequest)=>Promise<SaveFileResult>;
interface WritableFile {write(data:Blob):Promise<void>;close():Promise<void>;abort?():Promise<void>}
interface SaveHandle {name:string;createWritable():Promise<WritableFile>}
type PickerWindow=Window&{showSaveFilePicker?:(options:unknown)=>Promise<SaveHandle>};

export const saveLocalFile:SaveFileHandler=async request=>{
  const requestedDelivery=request.delivery,delivery=requestedDelivery===undefined?'save-as':requestedDelivery;
  if(delivery!=='save-as'&&delivery!=='download')throw new Error('文件输出方式 delivery 必须为 save-as 或 download。');
  const browser=window as PickerWindow;
  if(delivery==='save-as'&&browser.showSaveFilePicker&&window.isSecureContext){
    let handle:SaveHandle;
    try{handle=await browser.showSaveFilePicker({suggestedName:request.name,types:[{description:request.description,accept:{[request.mime]:[request.extension]}}]});}
    catch(error){if(error instanceof DOMException&&error.name==='AbortError')return {status:'cancelled',name:request.name};throw error;}
    const bytes=await request.produce();
    const writable=await handle.createWritable();
    try{await writable.write(new Blob([bytes.slice().buffer as ArrayBuffer],{type:request.mime}));await writable.close();}
    catch(error){try{await writable.abort?.();}catch{}throw error;}
    return {status:'written',name:handle.name};
  }
  const bytes=await request.produce(),blob=new Blob([bytes.slice().buffer as ArrayBuffer],{type:request.mime}),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=request.name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30_000);
  // An anchor click is not a receipt from the filesystem. Keep the project dirty.
  return {status:'download-started',name:request.name};
};
