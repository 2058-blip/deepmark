import {parseNifti,type Volume} from '../core.ts';
import type {Vec3} from './types.ts';
function segmentDistance(p:Vec3,a:Vec3,b:Vec3){const d=b.map((v,i)=>v-a[i]),t=Math.max(0,Math.min(1,p.reduce((s,v,i)=>s+(v-a[i])*d[i],0)/d.reduce((s,v)=>s+v*v,0)));return Math.hypot(...p.map((v,i)=>v-a[i]-t*d[i]));}
/** Entirely synthetic branched tube for repeatable centreline/section acceptance. */
export function makeVesselDemo():Volume {
  const dims:Vec3=[64,64,64],spacing:Vec3=[.8,.8,1.2],count=dims[0]*dims[1]*dims[2],buffer=new ArrayBuffer(352+count*4),v=new DataView(buffer);
  v.setInt32(0,348,true);v.setInt16(40,3,true);v.setInt16(70,16,true);v.setInt16(72,32,true);v.setFloat32(108,352,true);v.setFloat32(112,1,true);v.setUint8(123,2);v.setInt16(254,1,true);
  dims.forEach((n,i)=>{v.setInt16(42+2*i,n,true);v.setFloat32(80+4*i,spacing[i],true);v.setFloat32(280+16*i+4*i,spacing[i],true);v.setFloat32(292+16*i,-dims[i]*spacing[i]/2,true);});
  new Uint8Array(buffer,344,4).set([110,43,49,0]);
  const world=(p:Vec3)=>p.map((x,i)=>x*spacing[i]) as Vec3;
  const root=world([32,28,5]),junction=world([32,28,32]),left=world([16,28,55]),right=world([48,28,55]);
  for(let z=0;z<64;z++)for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const p=world([x,y,z]);const d=Math.min(segmentDistance(p,root,junction),segmentDistance(p,junction,left),segmentDistance(p,junction,right));
    const radius=3.8,value=d<=radius?320+80*(1-d/radius)**2:Math.hypot(x-32,(y-32)*1.1,(z-32)*.8)<31?30:-1000;
    v.setFloat32(352+4*(x+64*(y+64*z)),value,true);
  }
  return parseNifti(buffer,'合成Y形血管.nii');
}
