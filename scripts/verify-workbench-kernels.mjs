import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
let ts;try{ts=require('typescript');}catch{ts=require('../mimics-workbench/node_modules/typescript');}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const relative=file=>path.relative(root,file).split(path.sep).join('/');
// These exact UI slots expose hover geometry and optionally existing viewport
// navigation. Strip only the explicit bridges; never rebaseline tool code.
const hoverBridges={
  'mimics-workbench/src/mimics/ImageViewport.vue':`    <slot v-if="$slots?.['annotation-hover']" name="annotation-hover" :locate="locate" :grid="grid" :volume="volume" :axis="axis" :point="point" :view="geometry" :size="size" :revision="revision"/>`,
  'mimics-workbench/src/mimics/MprViewport.vue':`    <slot v-if="$slots?.['annotation-hover']" name="annotation-hover" :pixel-at="eventPixel" :grid="grid" :volume="volume" :plane="plane" :view="geometry" :size="size" :revision="revision" :ready="!loading&&!!samples.data&&!samples.error"/>`,
};
function protectedBytes(file){
  const bytes=fs.readFileSync(file),bridge=hoverBridges[relative(file)];if(!bridge)return bytes;
  const navigation=bridge.replace('name="annotation-hover" ','name="annotation-hover" :zoom="zoom" :zoom-wheel="wheel" ');
  const source=bytes.toString('utf8'),lines=[bridge,navigation].flatMap(line=>[line+'\r\n',line+'\n']),count=lines.reduce((sum,line)=>sum+source.split(line).length-1,0);
  if(count>1)throw new Error('Duplicate hover bridge: '+relative(file));
  return count?Buffer.from(lines.reduce((text,line)=>text.replace(line,''),source),'utf8'):bytes;
}
const directory=path.join(root,'mimics-workbench/src/mimics'),files=[];
function walk(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isDirectory())walk(file);else if(/\.(ts|vue)$/.test(item.name)&&item.name!=='Workbench.vue')files.push(file);}}
walk(directory);
for(const name of ['core.ts','view.ts','niftiIO.ts','volumeCapacity.ts'])files.push(path.join(root,'mimics-workbench/src',name));
const entries=Object.fromEntries(files.sort().map(file=>[relative(file),hash(protectedBytes(file))]));
const workbench=fs.readFileSync(path.join(directory,'Workbench.vue'),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
if(!workbench)throw new Error('Workbench script was not found');
const source=ts.createSourceFile('Workbench.ts',workbench,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),functions={};
for(const node of source.statements)if(ts.isFunctionDeclaration(node)&&node.name)functions[node.name.text]=hash(node.getText(source));
const lockPath=path.join(root,'workbench-kernels.lock.json');
if(process.argv.includes('--record')){
  fs.writeFileSync(lockPath,JSON.stringify({format:1,description:'Optimized native workbench algorithms and interaction functions; collaboration must adapt around this baseline.',files:entries,workbenchFunctions:functions},null,2)+'\n');
  console.log('Recorded '+files.length+' protected files and '+Object.keys(functions).length+' Workbench functions.');
}else{
  const expected=JSON.parse(fs.readFileSync(lockPath,'utf8')),failures=[];
  for(const file of new Set([...Object.keys(expected.files),...Object.keys(entries)]))if(entries[file]!==expected.files[file])failures.push(file);
  for(const [name,value] of Object.entries(expected.workbenchFunctions))if(functions[name]!==value)failures.push('Workbench.vue function '+name);
  if(failures.length)throw new Error('Annotation baseline changed:\n'+failures.join('\n'));
  console.log('Annotation baseline unchanged: '+files.length+' files, '+Object.keys(functions).length+' interaction functions.');
}
