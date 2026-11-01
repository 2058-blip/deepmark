import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const host=process.env.HOST||'127.0.0.1',apiPort=Number(process.env.API_PORT||8787);
const jar=fileURLToPath(new URL('../backend/target/deepmark-server.jar',import.meta.url));
if(!existsSync(jar))throw new Error('Build the Java backend first: npm run build:server');
const api=spawn(process.env.JAVA||'java',['-jar',jar],{cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:'inherit',env:{...process.env,HOST:'127.0.0.1',PORT:String(apiPort)}});
let vite,stopping=false;
async function stop(code=0){if(stopping)return;stopping=true;await vite?.close();api.kill();process.exitCode=code;}
api.on('error',error=>{console.error(error.message);void stop(1);});
api.on('exit',code=>{if(!stopping)void stop(code||1);});
try {
  vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{host,fs:{deny:['.env*','**/.git/**','**/server-data/**','**/backend/**']},proxy:{'/api':{target:`http://127.0.0.1:${apiPort}`,ws:true}}}});
  await vite.listen();vite.printUrls();console.log(`Dataset API: http://${host}:${apiPort}/api/datasets`);
}catch(error){api.kill();throw error;}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
