import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const defaultDatasetDir = resolve(projectRoot, 'server-data/datasets');
const isNifti = name => /\.nii(?:\.gz)?$/i.test(name);
function within(root, file) {
  const rel = relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function catalog(directory) {
  const root = await realpath(directory), entries = [];
  async function walk(folder) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
      const file = resolve(folder, item.name);
      if (item.isDirectory()) { await walk(file); continue; }
      if (!item.isFile() || !isNifti(item.name)) continue;
      const actual = await realpath(file);
      if (!within(root, actual)) continue;
      const info = await stat(actual);
      const rel = relative(root, file).split(sep).join('/');
      const id = createHash('sha256').update(rel).digest('hex');
      entries.push({ id, name: item.name, folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
        size: info.size, modified: info.mtime.toISOString(), format: /\.gz$/i.test(item.name) ? 'NIfTI · gzip' : 'NIfTI',
        downloadUrl: `/api/datasets/${id}/download`, file: actual });
    }
  }
  await walk(root);
  return { root, entries: entries.sort((a,b)=>(a.folder+'/'+a.name).localeCompare(b.folder+'/'+b.name, 'zh-CN')) };
}
async function sendFile(req, res, file, type, filename) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) { json(res,404,{error:'文件不存在。'}); return; }
    let start = 0, end = info.size - 1, partial = false;
    const headers = { 'Content-Type': type, 'Content-Length': info.size, 'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': filename ? 'private, no-store' : 'no-cache' };
    if (filename) headers['Content-Disposition'] = `attachment; filename="dataset${/\.gz$/i.test(filename)?'.nii.gz':'.nii'}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return;
      }
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else { start = Number(match[1]); if(match[2])end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return;
      }
      partial = true; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      headers['Content-Length'] = end - start + 1;
    }
    res.writeHead(partial ? 206 : 200, headers);
    if (req.method === 'HEAD' || !info.size) { res.end(); return; }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally { await handle.close(); }
}
export function createDatasetServer({ datasetDir = process.env.DATASET_DIR || defaultDatasetDir,
  distDir = resolve(projectRoot,'dist') } = {}) {
  return createServer(async (req,res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      res.setHeader('X-Content-Type-Options','nosniff');
      if (!['GET','HEAD'].includes(req.method)) {
        res.setHeader('Allow','GET, HEAD'); json(res,405,{error:'此服务仅提供数据集列表和下载。'}); return;
      }
      if (url.pathname === '/api/datasets') {
        const {entries} = await catalog(datasetDir);
        json(res,200,{datasets:entries.map(({file,...entry})=>entry)}); return;
      }
      const match = /^\/api\/datasets\/([a-f0-9]{64})\/download$/.exec(url.pathname);
      if (match) {
        const {root,entries} = await catalog(datasetDir), entry = entries.find(e=>e.id===match[1]);
        if (!entry) { json(res,404,{error:'数据集不存在或已移除，请刷新列表。'}); return; }
        const actual = await realpath(entry.file);
        if(!within(root,actual)){json(res,404,{error:'数据集不存在。'});return;}
        await sendFile(req,res,actual,'application/octet-stream',entry.name); return;
      }
      if (url.pathname.startsWith('/api/')) { json(res,404,{error:'接口不存在。'}); return; }
      // Only built web assets are public; source, datasets and configuration are never served as static files.
      let path;
      try { path=decodeURIComponent(url.pathname); } catch {json(res,400,{error:'网址无效。'});return;}
      if (path === '/') path = '/index.html';
      const root = await realpath(distDir), candidate = resolve(root,'.'+path);
      if (!within(root,candidate) || path.includes('\0')) {json(res,404,{error:'页面不存在。'});return;}
      let actual;
      try {actual=await realpath(candidate);} catch(error) {
        if(error.code==='ENOENT'){json(res,404,{error:'页面不存在。'});return;}throw error;
      }
      if(!within(root,actual)){json(res,404,{error:'页面不存在。'});return;}
      const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
      await sendFile(req,res,actual,types[extname(actual)]||'application/octet-stream');
    } catch(error) {
      if(res.headersSent){res.destroy();return;}
      if(error.code==='ENOENT'){json(res,503,{error:'服务器数据目录或网页文件尚未准备好，请联系管理员。'});return;}
      console.error('Request failed:',error.message);
      json(res,500,{error:'服务器暂时无法提供数据，请稍后重试。'});
    }
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||8787);
  const server=createDatasetServer();server.listen(port,host,()=>console.log(`Deepmark: http://${host}:${port}`));
  server.on('error',error=>{console.error(error.message);process.exitCode=1;});
}
