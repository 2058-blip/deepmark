import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {annotationArchive} from '../src/exportArchive.ts';
import {exportNifti,makeDemo,parseNifti} from '../src/core.ts';

test('ZIP round trip preserves segmentation geometry and Unicode label definitions',async()=>{
  const volume=makeDemo(),mask=new Uint16Array(volume.data.length);mask[125]=7;mask[50000]=300;
  const nifti=exportNifti(volume,mask),labels=[{id:7,name:'肺部',color:'#123456'},{id:300,name:'病灶',color:'#abcdef'}];
  const archive=await annotationArchive(nifti,labels,{source:volume.name}),files=unzipSync(new Uint8Array(archive));
  assert.ok(archive.byteLength<nifti.byteLength/5);assert.ok(nifti.byteLength>0);
  assert.deepEqual(Object.keys(files).sort(),['README.txt','labels.json','manifest.json','segmentation.nii']);
  const raw=files['segmentation.nii'],restored=parseNifti(raw.slice().buffer);
  assert.deepEqual(restored.data,Float32Array.from(mask));assert.deepEqual(restored.affine,volume.affine);assert.deepEqual(restored.spacing,volume.spacing);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files['labels.json'])).segments,labels);
  assert.equal(JSON.parse(new TextDecoder().decode(files['manifest.json'])).parallelFile,null);
  assert.deepEqual(await annotationArchive(nifti,labels,{source:volume.name}),archive);
});
