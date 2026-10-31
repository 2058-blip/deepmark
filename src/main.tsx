import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyThreshold, exportNifti, indexOf, makeDemo, paint, parseNifti, planeAxes, planePoint, thresholdLabel } from './core.ts';
import type { Axis, Change, ThresholdRange, Volume } from './core.ts';
import './style.css';
import './threshold.css';

type Segment = { id: number; name: string; color: string; visible: boolean };
type Tool = 'paint' | 'erase' | 'navigate' | 'threshold';
const colors = ['#4ed1ad', '#fb9f67', '#859dff', '#ed78b6', '#e5d46f', '#74c5f4'];
const initialSegments = (): Segment[] => [{ id: 1, name: '标注 1', color: colors[0], visible: true }];
function download(data: BlobPart, name: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function readFile(file: File) {
  let buffer = await file.arrayBuffer();
  if (new Uint8Array(buffer)[0] === 31 && new Uint8Array(buffer)[1] === 139) {
    if (typeof DecompressionStream === 'undefined') throw new Error('此浏览器不支持 gzip 解压，请使用新版 Chrome/Edge，或先解压为 .nii。');
    buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return parseNifti(buffer, file.name);
}
function direction(volume: Volume, axis: Axis): string {
  if (volume.oblique) return ['I 轴', 'J 轴', 'K 轴'][axis];
  const col = volume.affine.map(row => Math.abs(row[axis]));
  return ['矢状位', '冠状位', '轴位'][col.indexOf(Math.max(...col))];
}
function edgeDirection(volume: Volume, axis: Axis, positive: boolean): string {
  if (volume.oblique) return `${positive ? '+' : '−'}${['I', 'J', 'K'][axis]}`;
  const col = volume.affine.map(row => row[axis]), mag = col.map(Math.abs), r = mag.indexOf(Math.max(...mag));
  return (col[r] > 0 === positive ? ['R', 'A', 'S'] : ['L', 'P', 'I'])[r];
}
type SliceProps = {
  volume: Volume; mask: Uint16Array; axis: Axis; point: number[]; revision: number;
  segments: Segment[]; opacity: number; center: number; width: number; tool: Tool; diameter: number;
  thresholdPreview: ThresholdRange | null;
  onPoint: (p: number[]) => void; onStart: () => void;
  onStroke: (axis: Axis, slice: number, u: number, v: number) => void; onEnd: () => void;
};
function SliceView(p: SliceProps) {
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false), last = useRef<[number, number] | null>(null);
  const [size, setSize] = useState([300, 300]);
  const [a,b] = planeAxes(p.axis), nx = p.volume.dims[a], ny = p.volume.dims[b];
  const pixelWidth = nx*p.volume.spacing[a], pixelHeight = ny*p.volume.spacing[b];
  const scale = Math.min((size[0]-36)/pixelWidth, (size[1]-36)/pixelHeight);
  const w = pixelWidth*scale, h = pixelHeight*scale, ox = (size[0]-w)/2, oy = (size[1]-h)/2;
  useEffect(() => {
    const element = host.current!;
    const ro = new ResizeObserver(entries => setSize([Math.max(80, entries[0].contentRect.width), Math.max(80, entries[0].contentRect.height)]));
    ro.observe(element); return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = canvas.current!, ratio = window.devicePixelRatio || 1;
    c.width = Math.round(size[0]*ratio); c.height = Math.round(size[1]*ratio);
    const ctx = c.getContext('2d')!; ctx.scale(ratio, ratio);
    ctx.fillStyle = '#080c11'; ctx.fillRect(0,0,size[0],size[1]);
    const layer = document.createElement('canvas'); layer.width = nx; layer.height = ny;
    const lc = layer.getContext('2d')!, image = lc.createImageData(nx,ny);
    const palette = new Map(p.segments.filter(s=>s.visible).map(s => [s.id, [1,3,5].map(i=>parseInt(s.color.slice(i,i+2),16))]));
    const low = p.center-p.width/2;
    for (let y=0; y<ny; y++) for(let x=0; x<nx; x++) {
      const i = indexOf(planePoint(p.axis,p.point[p.axis],x,ny-1-y),p.volume.dims);
      const gray = Math.max(0,Math.min(255, (p.volume.data[i]-low)/p.width*255));
      const label = p.thresholdPreview ? thresholdLabel(p.volume.data[i], p.mask[i], p.thresholdPreview) : p.mask[i];
      const rgb = palette.get(label), j = 4*(x+nx*y);
      for(let k=0;k<3;k++) image.data[j+k] = rgb ? gray*(1-p.opacity)+rgb[k]*p.opacity : gray;
      image.data[j+3] = 255;
    }
    lc.putImageData(image,0,0); ctx.imageSmoothingEnabled = false; ctx.drawImage(layer,ox,oy,w,h);
    const cx = ox+(p.point[a]+.5)/nx*w, cy = oy+(ny-p.point[b]-.5)/ny*h;
    ctx.strokeStyle = '#ffffff66'; ctx.lineWidth = 1; ctx.setLineDash([4,5]);
    ctx.beginPath(); ctx.moveTo(cx,oy);ctx.lineTo(cx,oy+h);ctx.moveTo(ox,cy);ctx.lineTo(ox+w,cy);ctx.stroke();
  }, [p.volume,p.mask,p.axis,p.point,p.revision,p.segments,p.opacity,p.center,p.width,p.thresholdPreview,size]);
  function coords(e: React.PointerEvent): [number,number] | null {
    const rect = canvas.current!.getBoundingClientRect();
    const x = e.clientX-rect.left, y = e.clientY-rect.top;
    if (x<ox || x>ox+w || y<oy || y>oy+h) return null;
    return [Math.min(nx-1,Math.max(0,(x-ox)/w*nx-.5)),Math.min(ny-1,Math.max(0,ny-.5-(y-oy)/h*ny))];
  }
  function move(e: React.PointerEvent) {
    if (!drawing.current) return;
    const current = coords(e); if (!current) { last.current = null; return; }
    if(p.tool === 'navigate' || p.tool === 'threshold') {
      const point = [...p.point]; point[a] = Math.round(current[0]); point[b] = Math.round(current[1]);p.onPoint(point); return;
    }
    const previous = last.current || current;
    const steps = Math.max(1, Math.ceil(Math.hypot(current[0]-previous[0],current[1]-previous[1])*2));
    for(let i=1;i<=steps;i++) p.onStroke(p.axis,p.point[p.axis],previous[0]+(current[0]-previous[0])*i/steps,previous[1]+(current[1]-previous[1])*i/steps);
    last.current = current;
  }
  function end() { if(drawing.current) { drawing.current = false;last.current=null;p.onEnd(); } }
  return <section className={`slice slice-${p.axis}`}>
    <header><span className="view-dot"/>{direction(p.volume,p.axis)}{p.thresholdPreview&&<span className="preview-badge">预览</span>}<small>{['I','J','K'][p.axis]} = {p.point[p.axis]+1} / {p.volume.dims[p.axis]}</small></header>
    <div className="canvas-host" ref={host} onWheel={e=>{
      if (drawing.current) return;
      const q=[...p.point];q[p.axis]=Math.max(0,Math.min(p.volume.dims[p.axis]-1,q[p.axis]+(e.deltaY>0?1:-1)));p.onPoint(q);
    }}>
      <canvas ref={canvas} onPointerDown={e=>{
        if(e.button!==0 || !coords(e))return;
        drawing.current=true;canvas.current!.setPointerCapture(e.pointerId);p.onStart();move(e);
      }} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}/>
      <span className="edge top">{edgeDirection(p.volume,b,true)}</span><span className="edge bottom">{edgeDirection(p.volume,b,false)}</span>
      <span className="edge left">{edgeDirection(p.volume,a,false)}</span><span className="edge right">{edgeDirection(p.volume,a,true)}</span>
    </div>
    <footer><span>切片</span><input aria-label={`${direction(p.volume,p.axis)}切片`} type="range" min="0" max={p.volume.dims[p.axis]-1} value={p.point[p.axis]} onChange={e=>{const q=[...p.point];q[p.axis]=+e.target.value;p.onPoint(q);}}/><span>{p.point[p.axis]+1}</span></footer>
  </section>;
}
function App() {
  const [volume,setVolume]=useState<Volume|null>(null), mask=useRef(new Uint16Array());
  const [segments,setSegments]=useState<Segment[]>(initialSegments), [selected,setSelected]=useState(1);
  const [tool,setTool]=useState<Tool>('paint'), [diameter,setDiameter]=useState(8), [opacity,setOpacity]=useState(.45);
  const [point,setPoint]=useState([0,0,0]), [revision,setRevision]=useState(0);
  const [center,setCenter]=useState(40), [width,setWidth]=useState(400);
  const [thresholdMin,setThresholdMin]=useState('0'), [thresholdMax,setThresholdMax]=useState('100');
  const [previewEnabled,setPreviewEnabled]=useState(true);
  const [status,setStatus]=useState('打开 NIfTI 影像，开始分割标注'), [busy,setBusy]=useState(false), [dirty,setDirty]=useState(false);
  const history=useRef<Change[]>([]), future=useRef<Change[]>([]), pending=useRef(new Map<number,number>());
  const fileInput=useRef<HTMLInputElement>(null), segInput=useRef<HTMLInputElement>(null);
  const active=segments.find(s=>s.id===selected)!;
  const minimum=Number(thresholdMin), maximum=Number(thresholdMax);
  const thresholdValid=thresholdMin.trim()!=='' && thresholdMax.trim()!=='' && Number.isFinite(minimum) && Number.isFinite(maximum) && minimum<=maximum;
  const thresholdPreview=tool==='threshold' && thresholdValid && previewEnabled && active.visible ? {minimum,maximum,label:selected} : null;
  function install(v:Volume) {
    mask.current=new Uint16Array(v.data.length);history.current=[];future.current=[];pending.current.clear();
    setVolume(v);setPoint(v.dims.map(n=>Math.floor(n/2)));setSegments(initialSegments());setSelected(1);
    setCenter((v.min+v.max)/2);setWidth(Math.max(1,v.max-v.min));setDirty(false);setRevision(n=>n+1);
    setThresholdMin(String(v.min+(v.max-v.min)*.75));setThresholdMax(String(v.max));setPreviewEnabled(true);setTool('paint');
    setStatus(`已加载 ${v.name} · ${v.dims.join(' × ')} 体素`);
  }
  function canReplace() { return !dirty || window.confirm('当前标注尚未导出。继续将替换当前影像和标注，是否继续？'); }
  async function load(file?:File) {
    if(!file || !canReplace())return;
    setBusy(true);setStatus('正在读取影像…');
    try { await new Promise(r=>setTimeout(r,20));install(await readFile(file)); }
    catch(error) { setStatus(`打开失败：${(error as Error).message}`); }
    finally{setBusy(false);}
  }
  function rememberChange(change:Change) {
    history.current.push(change);
    let bytes=history.current.reduce((sum,c)=>sum+c.indices.byteLength+c.before.byteLength+c.after.byteLength,0);
    while(history.current.length>1 && (bytes>64*1024*1024 || history.current.length>80)) { const c=history.current.shift()!;bytes-=c.indices.byteLength+c.before.byteLength+c.after.byteLength; }
    future.current=[];setDirty(true);setRevision(n=>n+1);
  }
  function endStroke() {
    if(!pending.current.size)return;
    const pairs=[...pending.current].filter(([i,before])=>mask.current[i]!==before);
    pending.current.clear(); if(!pairs.length)return;
    rememberChange({indices:Uint32Array.from(pairs.map(p=>p[0])),before:Uint16Array.from(pairs.map(p=>p[1])),after:Uint16Array.from(pairs.map(p=>mask.current[p[0]]))});
  }
  async function runThreshold() {
    if(!volume || !thresholdValid || !active.visible || busy)return;
    endStroke();setBusy(true);setStatus('正在对整套影像执行阈值分割…');
    try {
      await new Promise(resolve=>setTimeout(resolve,30));
      const {change,matched}=applyThreshold(volume.data,mask.current,{minimum,maximum,label:selected});
      if(change)rememberChange(change);
      setTool('paint');
      setStatus(`阈值分割完成：${minimum}～${maximum}，选中 ${matched.toLocaleString()} 个体素，${change ? '已更新当前标签，可撤销' : '标注无需修改'}。`);
    }catch(error){setStatus(`阈值分割失败：${(error as Error).message}`);}finally{setBusy(false);}
  }
  function undo(redo=false) {
    endStroke();const from=redo?future.current:history.current,to=redo?history.current:future.current;
    const change=from.pop();if(!change)return;
    const values=redo?change.after:change.before;change.indices.forEach((i,k)=>{mask.current[i]=values[k];});to.push(change);
    setDirty(true);setRevision(n=>n+1);
  }
  useEffect(()=>{
    function before(e:BeforeUnloadEvent){if(dirty){e.preventDefault();e.returnValue='';}}
    window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);
  },[dirty]);
  useEffect(()=>{
    function key(e:KeyboardEvent){
      if((e.target as HTMLElement).matches('input,textarea,select') || busy)return;
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo(e.shiftKey);}
      else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();undo(true);}
      else if(e.key.toLowerCase()==='b')setTool('paint');else if(e.key.toLowerCase()==='e')setTool('erase');else if(e.key.toLowerCase()==='v')setTool('navigate');
    }
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  });
  async function loadSegmentation(file?:File){
    if(!file||!volume||!canReplace())return;setBusy(true);
    try{
      const seg=await readFile(file);
      if(seg.dims.some((n,i)=>n!==volume.dims[i]) || seg.affine.some((row,r)=>row.some((n,c)=>Math.abs(n-volume.affine[r][c])>1e-4)))
        throw new Error('标注的尺寸或空间方向与当前影像不同。');
      const next=new Uint16Array(seg.data.length), ids=new Set<number>();
      for(let i=0;i<next.length;i++){const value=seg.data[i];if(!Number.isInteger(value)||value<0||value>65535)throw new Error('标注必须是 0～65535 的整数标签。');next[i]=value;if(value)ids.add(value);}
      if(ids.size>64)throw new Error('此版本最多显示 64 个标签。');
      mask.current=next;history.current=[];future.current=[];pending.current.clear();
      const list=[...ids].sort((a,b)=>a-b).map((id,i)=>({id,name:`标注 ${id}`,color:colors[i%colors.length],visible:true}));
      setSegments(list.length?list:initialSegments());setSelected(list[0]?.id||1);setRevision(n=>n+1);setDirty(false);setStatus('分割标签已载入。');
    }catch(error){setStatus(`导入失败：${(error as Error).message}`);}finally{setBusy(false);}
  }
  function exportMask(){if(!volume)return;endStroke();download(exportNifti(volume,mask.current),volume.name.replace(/\.nii(\.gz)?$/i,'')+'-seg.nii');setDirty(false);setStatus('已请求下载分割 NIfTI；标签名称和颜色可单独导出。');}
  return <div className="app">
    <header className="topbar"><div className="brand"><div className="brand-icon">✚</div><div>医学分割标注<small>SLICER WEB · 本地浏览器版</small></div></div>
      <div className="top-actions"><span className="local-badge">● 影像本地处理</span><button disabled={busy} onClick={()=>fileInput.current?.click()}>打开影像</button><button className="primary" disabled={!volume||busy} onClick={exportMask}>导出标注 ↗</button></div>
    </header>
    <input hidden ref={fileInput} type="file" accept=".nii,.nii.gz" onChange={e=>{void load(e.target.files?.[0]);e.target.value='';}}/>
    <input hidden ref={segInput} type="file" accept=".nii,.nii.gz" onChange={e=>{void loadSegmentation(e.target.files?.[0]);e.target.value='';}}/>
    <div className="workspace"><aside className="sidebar">
      <div className="section-heading">工作空间<span>01</span></div>
      <div className="file-card"><span className="eyebrow">当前影像</span><strong title={volume?.name}>{volume?.name||'尚未加载影像'}</strong><small>{volume?`${volume.dims.join(' × ')} · ${volume.spacing.map(n=>+n.toFixed(3)).join(' / ')} 间距`:'支持 .nii / .nii.gz'}</small></div>
      <div className="section-heading">分割标签 <button aria-label="新增标签" disabled={!volume||busy||segments.length>=64} onClick={()=>{
        const id=Math.max(...segments.map(s=>s.id))+1;if(id>65535)return;setSegments([...segments,{id,name:`标注 ${id}`,color:colors[(id-1)%colors.length],visible:true}]);setSelected(id);
      }}>＋</button></div>
      <div className="segment-list">{segments.map(s=><div key={s.id} className={`segment ${selected===s.id?'selected':''}`} onClick={()=>setSelected(s.id)}>
        <input aria-label={`${s.name}颜色`} type="color" value={s.color} onChange={e=>setSegments(segments.map(x=>x.id===s.id?{...x,color:e.target.value}:x))}/>
        <input aria-label={`标签 ${s.id}名称`} value={s.name} maxLength={60} onChange={e=>setSegments(segments.map(x=>x.id===s.id?{...x,name:e.target.value}:x))}/>
        <button title={s.visible?'隐藏标注':'显示标注'} aria-label={s.visible?'隐藏标注':'显示标注'} onClick={e=>{e.stopPropagation();setSegments(segments.map(x=>x.id===s.id?{...x,visible:!x.visible}:x));}}>{s.visible?'◉':'○'}</button>
      </div>)}</div>
      <label className="range-label">标注透明度 <span>{Math.round(opacity*100)}%</span><input type="range" min="0" max="1" step=".05" value={opacity} onChange={e=>setOpacity(+e.target.value)}/></label>
      <div className="section-heading">标注工具 <small>B / E / V</small></div>
      <div className="tools">{([['paint','✎','画笔'],['erase','▱','橡皮擦'],['navigate','⌖','定位'],['threshold','◒','阈值']] as const).map(([id,icon,label])=><button aria-label={label} disabled={!volume||busy} key={id} className={tool===id?'active':''} onClick={()=>setTool(id)}><b aria-hidden="true">{icon}</b>{label}</button>)}</div>
      {tool==='threshold'&&volume?<div className="threshold-panel">
        <div className="section-heading">灰度阈值 <small>整套三维影像</small></div>
        <p className="hint">影像灰度范围：{volume.min.toLocaleString()} ～ {volume.max.toLocaleString()}。使用原始灰度，与窗宽窗位无关。</p>
        <label htmlFor="threshold-min">最小灰度</label>
        <input id="threshold-min" type="number" step="any" value={thresholdMin} onChange={e=>setThresholdMin(e.target.value)}/>
        <input aria-label="最小灰度滑块" type="range" min={volume.min} max={volume.max} step="any" disabled={volume.min===volume.max} value={Number.isFinite(minimum)?Math.max(volume.min,Math.min(volume.max,minimum)):volume.min} onChange={e=>setThresholdMin(e.target.value)}/>
        <label htmlFor="threshold-max">最大灰度</label>
        <input id="threshold-max" type="number" step="any" value={thresholdMax} onChange={e=>setThresholdMax(e.target.value)}/>
        <input aria-label="最大灰度滑块" type="range" min={volume.min} max={volume.max} step="any" disabled={volume.min===volume.max} value={Number.isFinite(maximum)?Math.max(volume.min,Math.min(volume.max,maximum)):volume.max} onChange={e=>setThresholdMax(e.target.value)}/>
        {!thresholdValid&&<p className="field-error" role="alert">请输入有效范围，最小值不能大于最大值。</p>}
        {!active.visible&&<p className="field-error">请先显示当前标签，再预览或应用。</p>}
        <label className="preview-toggle"><input type="checkbox" checked={previewEnabled} onChange={e=>setPreviewEnabled(e.target.checked)}/>预览选区（尚未写入标注）</label>
        <p className="hint">应用后，以此范围替换当前标签；范围内覆盖其他标签，范围外保留其他标签。包含上下限，可一次撤销。</p>
        <button className="primary" disabled={!thresholdValid||!active.visible||busy} onClick={()=>void runThreshold()}>应用阈值分割</button>
      </div>:<><label className="range-label">画笔直径 <span>{diameter} {volume?.unit||'mm'}</span><input type="range" min="1" max="50" value={diameter} onChange={e=>setDiameter(+e.target.value)}/></label>
      <p className="hint">画笔覆盖其他标签；橡皮擦只擦除当前标签。先显示当前标签，再进行编辑。</p></>}
      <div className="history"><button disabled={!history.current.length||busy} onClick={()=>undo()}>↶ 撤销</button><button disabled={!future.current.length||busy} onClick={()=>undo(true)}>↷ 重做</button></div>
      <div className="section-heading">影像显示</div>
      <div className="window-inputs"><label>窗位<input type="number" disabled={!volume} value={center} onChange={e=>{if(Number.isFinite(e.target.valueAsNumber))setCenter(e.target.valueAsNumber);}}/></label><label>窗宽<input type="number" min="1" disabled={!volume} value={width} onChange={e=>{if(e.target.valueAsNumber>=1)setWidth(e.target.valueAsNumber);}}/></label></div>
      <div className="presets"><button disabled={!volume} onClick={()=>{setCenter(40);setWidth(400);}}>软组织</button><button disabled={!volume} onClick={()=>{setCenter(400);setWidth(1800);}}>骨窗</button><button disabled={!volume} onClick={()=>{setCenter((volume!.min+volume!.max)/2);setWidth(Math.max(1,volume!.max-volume!.min));}}>全范围</button></div>
      <div className="sidebar-bottom"><button disabled={!volume||busy} onClick={()=>segInput.current?.click()}>导入已有分割</button><button disabled={!volume} onClick={()=>download(JSON.stringify({version:1,segments},null,2),'标签说明.json','application/json')}>导出标签说明</button></div>
    </aside><main>
      <div className="main-heading"><div><span className="eyebrow">SEGMENT EDITOR</span><h1>{volume?'三切面标注':'从一份影像开始'}</h1></div><span className="state">{dirty?'● 有未导出的修改':volume?'● 就绪':'等待导入'}</span></div>
      {volume?<><div className="notice">{volume.oblique?'此影像为斜切或方向信息未定义：按原始 I/J/K 体素平面显示，未重采样为标准解剖切面。':'按影像空间方向标注切面与方位，保持原始体素网格。'} 滚轮切片 · 定位工具联动十字线</div>
        {thresholdPreview&&<div className="threshold-notice">正在预览阈值 {minimum.toLocaleString()} ～ {maximum.toLocaleString()} · 点击“应用阈值分割”才会写入标注。导出不包含未应用的预览。</div>}
        <div className="views">{([2,1,0] as Axis[]).map(axis=><SliceView key={axis} volume={volume} mask={mask.current} axis={axis} point={point} revision={revision} segments={segments} opacity={opacity} center={center} width={width} tool={tool} diameter={diameter} thresholdPreview={thresholdPreview} onPoint={setPoint} onStart={()=>pending.current.clear()} onEnd={endStroke} onStroke={(axis,slice,u,v)=>{
          if(!active.visible){setStatus('请先显示当前标签。');return;}
          paint(mask.current,volume,axis,slice,u,v,diameter,tool==='erase'?0:selected,pending.current,tool==='erase'?selected:undefined);setRevision(n=>n+1);
        }}/>)}</div>
        <div className="info-bar"><span>当前标签 <i style={{background:active.color}}/>{active.name} · 值 {selected}</span><span>体素 I {point[0]+1} / J {point[1]+1} / K {point[2]+1}</span><span>灰度 {volume.data[indexOf(point,volume.dims)].toFixed(1)}</span></div>
      </>:<div className="empty"><div className="empty-visual"><div/><div/><span>＋</span></div><h2>让影像成为可编辑的标注</h2><p>导入三维 NIfTI 影像，在三个切面上绘制分割。<br/>文件在本机处理，无需上传。</p><button disabled={busy} className="primary" onClick={()=>fileInput.current?.click()}>选择 NIfTI 文件</button><button disabled={busy} className="text-button" onClick={()=>{if(canReplace())install(makeDemo());}}>先用合成影像体验 →</button><small>支持三维灰度 NIfTI-1 · 不支持时间序列</small></div>}
    </main></div><footer className="statusbar"><span role="status">{busy?'◌ ':''}{status}</span><span>标注原型 · 请核对导出结果</span></footer>
    {busy&&<div className="busy-overlay" aria-live="polite">正在处理文件，请稍候…</div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
