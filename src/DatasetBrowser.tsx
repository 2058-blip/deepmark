import { useEffect, useRef, useState } from 'react';
import './datasets.css';

type Dataset = { id: string; name: string; folder: string; size: number; modified: string; format: string; downloadUrl: string };
type Props = { onClose: () => void; onBeforeOpen: () => boolean; onOpen: (file: File) => Promise<boolean> };
function formatSize(value: number) {
  if(value<1024)return `${value} B`;
  const unit=value<1024**2?'KB':value<1024**3?'MB':'GB';
  return `${(value/(unit==='KB'?1024:unit==='MB'?1024**2:1024**3)).toFixed(1)} ${unit}`;
}
export function DatasetBrowser({onClose,onBeforeOpen,onOpen}:Props) {
  const dialog=useRef<HTMLDialogElement>(null),request=useRef<AbortController|null>(null);
  const [datasets,setDatasets]=useState<Dataset[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [search,setSearch]=useState(''),[downloading,setDownloading]=useState<string|null>(null);
  const [progress,setProgress]=useState({received:0,total:0}),[parsing,setParsing]=useState(false);
  async function refresh(signal?:AbortSignal){
    setLoading(true);setError('');
    try {
      const response=await fetch('/api/datasets',{cache:'no-store',signal});
      if(!response.ok)throw new Error('服务器暂时无法提供数据集列表，请稍后重试。');
      const result=await response.json();
      if(!Array.isArray(result.datasets))throw new Error('服务器返回的数据集列表格式无效。');
      setDatasets(result.datasets);
    }catch(error){if((error as Error).name!=='AbortError')setError((error as Error).message);}
    finally{if(!signal?.aborted)setLoading(false);}
  }
  useEffect(()=>{
    const controller=new AbortController();dialog.current!.showModal();void refresh(controller.signal);
    return()=>{controller.abort();request.current?.abort();};
  },[]);
  async function open(dataset:Dataset){
    if(downloading || !onBeforeOpen())return;
    const controller=new AbortController();request.current=controller;
    setDownloading(dataset.id);setProgress({received:0,total:dataset.size});setError('');
    try {
      const response=await fetch(`/api/datasets/${encodeURIComponent(dataset.id)}/download`,{signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw new Error(response.status===404?'数据集已移除，请刷新列表。':'数据集下载失败，请稍后重试。');
      const total=Number(response.headers.get('Content-Length'))||dataset.size;
      const chunks:ArrayBuffer[]=[];const reader=response.body?.getReader();
      if(!reader)throw new Error('浏览器无法读取下载内容。');
      let received=0;
      while(true){
        const {done,value}=await reader.read();if(done)break;
        chunks.push(value.slice().buffer as ArrayBuffer);received+=value.byteLength;setProgress({received,total});
      }
      if(total && received!==total)throw new Error('数据集下载不完整，请重试。');
      setParsing(true);
      if(await onOpen(new File(chunks,dataset.name,{type:'application/octet-stream'})))onClose();
      else setError('影像未能打开，请检查文件格式。关闭此窗口可查看详细错误。');
    }catch(error){if((error as Error).name!=='AbortError')setError((error as Error).message);}
    finally{request.current=null;setDownloading(null);setParsing(false);}
  }
  const filtered=datasets.filter(item=>(item.name+' '+item.folder).toLowerCase().includes(search.toLowerCase()));
  return <dialog ref={dialog} className="dataset-dialog" aria-labelledby="datasets-title" onCancel={e=>{e.preventDefault();if(!parsing){request.current?.abort();onClose();}}}>
    <header className="datasets-header"><div><span className="eyebrow">DATA LIBRARY</span><h2 id="datasets-title">服务器数据集</h2></div><button aria-label="关闭数据集窗口" disabled={parsing} onClick={()=>{request.current?.abort();onClose();}}>✕</button></header>
    <p className="datasets-description">选择需要标注的影像，下载到浏览器后直接开始工作。也可以将原文件单独下载到电脑。</p>
    <div className="datasets-toolbar"><input aria-label="搜索服务器数据集" placeholder="搜索文件名或分类…" value={search} onChange={e=>setSearch(e.target.value)}/><button disabled={loading||!!downloading} onClick={()=>void refresh()}>刷新列表</button></div>
    {error&&<p className="datasets-error" role="alert">{error}</p>}
    {downloading&&<div className="dataset-progress" role="status"><span>{parsing?'正在解析影像…':`正在下载：${datasets.find(d=>d.id===downloading)?.name}`}</span><progress max={progress.total||1} value={progress.received}/><small>{formatSize(progress.received)} / {formatSize(progress.total)}{!parsing&&<button onClick={()=>request.current?.abort()}>取消下载</button>}</small></div>}
    <div className="datasets-list" aria-busy={loading}>
      {loading?<p className="datasets-empty">正在读取数据集列表…</p>:filtered.length?filtered.map(dataset=><article className="dataset-card" key={dataset.id}>
        <div className="dataset-file-icon">NII</div><div className="dataset-details"><h3>{dataset.name}</h3><p>{dataset.folder&&<span>{dataset.folder} · </span>}{dataset.format} · {formatSize(dataset.size)}</p><small>更新于 {new Date(dataset.modified).toLocaleString('zh-CN')}</small></div>
        <div className="dataset-actions"><button className="primary" disabled={!!downloading} onClick={()=>void open(dataset)}>下载并标注</button>{downloading?<span className="download-disabled">仅下载原文件</span>:<a href={`/api/datasets/${encodeURIComponent(dataset.id)}/download`} download={dataset.name}>仅下载原文件 ↓</a>}</div>
      </article>):<div className="datasets-empty"><strong>{search?'没有匹配的数据集':'暂时没有可下载的数据集'}</strong><p>{search?'尝试其他关键词，或清空搜索。':'管理员添加影像后，点击“刷新列表”即可查看。'}</p></div>}
    </div><footer className="datasets-footer"><span>共 {datasets.length} 份影像{search?` · 匹配 ${filtered.length} 份`:''}</span><span>支持 .nii / .nii.gz</span></footer>
  </dialog>;
}
