import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { createDatasetServer } from '../server/server.mjs';

const host=process.env.HOST||'127.0.0.1',apiPort=Number(process.env.API_PORT||8787);
const api=createDatasetServer();
await new Promise((resolve,reject)=>{api.once('error',reject);api.listen(apiPort,'127.0.0.1',resolve);});
let vite;
try {
  vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{host,proxy:{'/api':`http://127.0.0.1:${apiPort}`}}});
  await vite.listen();vite.printUrls();console.log(`Dataset API: http://${host}:${apiPort}/api/datasets`);
}catch(error){api.close();throw error;}
async function stop(){await vite.close();api.closeAllConnections();api.close(()=>process.exit(0));}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
