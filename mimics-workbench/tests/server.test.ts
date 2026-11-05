import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createDatasetServer} from '../server/server.mjs';
import {makeDemo,exportNifti} from '../src/core.ts';

test('server datasets: listing, byte-accurate download, ranges, isolation and live refresh',async t=>{
  const temporary=await mkdtemp(join(tmpdir(),'deepmark-dataset-test-'));
  const root=join(temporary,'datasets'),dist=join(temporary,'dist'),outside=join(temporary,'outside');
  await Promise.all([mkdir(root),mkdir(dist),mkdir(outside)]);
  const server=createDatasetServer({datasetDir:root,distDir:dist});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir())+requireSeparator()));
    await rm(temporary,{recursive:true,force:true});
  });
  const list=async()=>{const response=await fetch(base+'/api/datasets');assert.equal(response.status,200);return (await response.json()).datasets;};
  await t.test('empty library is usable and static hosting only exposes dist',async()=>{
    assert.deepEqual(await list(),[]);await writeFile(join(dist,'index.html'),'<h1>Deepmark</h1>');
    assert.equal(await (await fetch(base+'/')).text(),'<h1>Deepmark</h1>');
    assert.equal((await fetch(base+'/package.json')).status,404);
    assert.equal((await fetch(base+'/server-data/datasets/secret.nii')).status,404);
  });
  const demo=makeDemo(),bytes=Buffer.from(exportNifti(demo,new Uint16Array(demo.data.length))),compressed=gzipSync(bytes);
  await mkdir(join(root,'第一组'));await writeFile(join(root,'第一组','练习.nii.gz'),compressed);
  await writeFile(join(root,'scan.nii'),bytes);await writeFile(join(root,'notes.txt'),'not a dataset');
  await writeFile(join(root,'.hidden.nii'),bytes);await writeFile(join(outside,'private.nii'),bytes);
  await symlink(outside,join(root,'linked-outside'),process.platform==='win32'?'junction':'dir');
  let dataset:any;
  await t.test('only NIfTI files appear; paths, hidden files and symlink directories remain private',async()=>{
    const entries=await list();assert.equal(entries.length,2);dataset=entries.find((e:any)=>e.name==='练习.nii.gz');
    assert.equal(dataset.folder,'第一组');assert.equal(dataset.size,compressed.length);
    assert.match(dataset.id,/^[a-f0-9]{64}$/);assert.equal('file' in dataset,false);
    assert.equal(JSON.stringify(entries).includes(temporary),false);
  });
  await t.test('download is byte accurate with Unicode filename and HEAD metadata',async()=>{
    const response=await fetch(base+dataset.downloadUrl);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(compressed.length));
    assert.ok(response.headers.get('content-disposition')!.includes(encodeURIComponent('练习.nii.gz')));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),compressed);
    const head=await fetch(base+dataset.downloadUrl,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
  });
  await t.test('single byte ranges and suffix ranges work, invalid ranges fail',async()=>{
    const response=await fetch(base+dataset.downloadUrl,{headers:{Range:'bytes=5-20'}});
    assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),compressed.subarray(5,21));
    assert.equal(response.headers.get('content-range'),`bytes 5-20/${compressed.length}`);
    const suffix=await fetch(base+dataset.downloadUrl,{headers:{Range:'bytes=-8'}});
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),compressed.subarray(-8));
    assert.equal((await fetch(base+dataset.downloadUrl,{headers:{Range:'bytes=9999999999-'}})).status,416);
    assert.equal((await fetch(base+dataset.downloadUrl,{headers:{Range:'bytes=0-1,5-6'}})).status,416);
  });
  await t.test('bad ids, traversal and write methods do not expose or modify datasets',async()=>{
    for(const path of ['/api/datasets/not-an-id/download','/api/datasets/'+'0'.repeat(64)+'/download','/api/datasets/%2e%2e%2fprivate.nii/download'])
      assert.equal((await fetch(base+path)).status,404);
    assert.equal((await fetch(base+'/api/datasets',{method:'POST',body:'no write'})).status,405);
  });
  await t.test('new datasets are discovered without restart and deleted datasets return 404',async()=>{
    await writeFile(join(root,'new.nii'),bytes);assert.equal((await list()).length,3);
    await rm(join(root,'第一组','练习.nii.gz'));assert.equal((await list()).length,2);
    assert.equal((await fetch(base+dataset.downloadUrl)).status,404);
  });
});
function requireSeparator(){return process.platform==='win32'?'\\':'/';}
