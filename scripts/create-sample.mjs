import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { makeDemo } from '../src/core.ts';
import { defaultDatasetDir } from '../server/server.mjs';

const directory=resolve(process.env.DATASET_DIR||defaultDatasetDir);
const demo=makeDemo(),bytes=new Uint8Array(352+demo.data.length*2);bytes.set(demo.header);
const view=new DataView(bytes.buffer);demo.data.forEach((value,i)=>view.setInt16(352+2*i,value,true));
await mkdir(directory,{recursive:true});
const filename=resolve(directory,'合成练习影像.nii.gz');
await writeFile(filename,gzipSync(bytes),{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
console.log(`Synthetic practice dataset: ${filename}`);
