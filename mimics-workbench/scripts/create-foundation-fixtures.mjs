import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {makeDemo,parseNifti,exportNifti} from '../src/core.ts';
import {calculateSurface,exportSTL} from '../src/mimics/geometry.ts';
import {volumeGrid} from '../src/mimics/project.ts';

const out=fileURLToPath(new URL('../work/mimics-vue-reconstruction/fixtures/',import.meta.url));
await mkdir(out,{recursive:true});
const dims=[24,24,24],n=24**3,buffer=new ArrayBuffer(352+n*4),bytes=new Uint8Array(buffer),view=new DataView(buffer);
bytes.set(makeDemo().header);view.setInt16(70,16,true);view.setInt16(72,32,true);view.setFloat32(108,352,true);view.setFloat32(112,1,true);view.setFloat32(116,0,true);
dims.forEach((d,a)=>view.setInt16(42+2*a,d,true));
const labels=new Uint16Array(n),mask=new Uint8Array(n);
for(let z=0;z<24;z++)for(let y=0;y<24;y++)for(let x=0;x<24;x++){
  const i=x+24*(y+24*z),sphere=(x-12)**2+(y-12)**2+((z-12)*1.5)**2<7**2;
  view.setFloat32(352+i*4,sphere?500:-1000,true);mask[i]=sphere?1:0;
  if((x-9)**2+(y-12)**2+((z-12)*1.5)**2<4**2)labels[i]=7;
  if((x-15)**2+(y-12)**2+((z-12)*1.5)**2<4**2)labels[i]=300;
}
const volume=parseNifti(buffer,'foundation-sphere.nii');
await writeFile(out+'/foundation-sphere.nii',bytes);
await writeFile(out+'/foundation-labels.nii',new Uint8Array(exportNifti(volume,labels)));
await writeFile(out+'/invalid.nii',new Uint8Array([1,2,3,4]));
const unknown=bytes.slice();unknown[123]=0;await writeFile(out+'/foundation-unknown-units.nii',unknown);
const mesh=calculateSurface(volumeGrid(volume),mask,{quality:'optimal',topology:'native-table'});
await writeFile(out+'/foundation-sphere.stl',exportSTL(mesh,{binary:true}));
await writeFile(out+'/README.txt','All files are generated synthetic phantoms. No patient data.\nSphere intensity: background=-1000, foreground=500.\nDimensions 24x24x24, spacing 1/1/1.5 mm. Labels7/300 remain distinct.\n');
console.log(out);
