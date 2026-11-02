import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const origin=process.env.DEEPMARK_BROWSER_URL;
assert.ok(origin&&new URL(origin).protocol==='http:','Provide the actual LAN HTTP test URL.');
const modulePath=process.argv[2]||process.env.DEEPMARK_PLAYWRIGHT_PATH;
const {chromium}=await import(modulePath?pathToFileURL(modulePath).href:'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true});
try{
 const page=await browser.newPage();await page.goto(origin);
 const capabilities=await page.evaluate(()=>({secure:isSecureContext,subtle:typeof crypto.subtle,randomUUID:typeof crypto.randomUUID}));
 assert.equal(capabilities.secure,false);assert.equal(capabilities.subtle,'undefined');
 const policy=await(await page.request.get(origin+'/api/auth/policy')).json();assert.equal(policy.allowHttp,true);
 console.log(JSON.stringify({httpOrigin:origin,capabilities,allowHttp:policy.allowHttp}));
}finally{await browser.close();}
// Reuse the actual role workflow: encrypted UI auth, image fingerprinting,
// HTTP/WS permissions, live rendering, completion locking and ZIP download.
await import('./role-console-browser.mjs');
