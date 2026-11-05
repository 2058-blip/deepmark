import {readNiftiFile} from './niftiIO.ts';
import type {NiftiReadOptions} from './niftiIO.ts';
import type { Axis, Volume } from './core.ts';
import {referenceAffineMm,validateReferenceHeader,affineIsOblique} from './mimics/niftiReference.ts';
import {isAxisAlignedGrid} from './mimics/viewportGeometry.ts';
import type {VolumeGrid} from './mimics/types.ts';
export type Segment = { id: number; name: string; color: string; visible: boolean };
export type Tool = 'paint' | 'erase' | 'navigate' | 'threshold' | 'region';
export const colors = ['#4ed1ad', '#fb9f67', '#859dff', '#ed78b6', '#e5d46f', '#74c5f4'];
export const initialSegments = (): Segment[] => [{ id: 1, name: '标注 1', color: colors[0], visible: true }];
export function download(data: BlobPart, name: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function readFile(file:File,options:NiftiReadOptions={}){return readNiftiFile(file,options);}
/** A Ref volume's patient labels belong to its verified file/reference frame,
 * while rendering and editing continue in the separate application frame. */
export function displayedDirectionGrid(volume:Volume):Pick<VolumeGrid,'dims'|'spacing'|'affine'>|null{
  if(volume.niftiReference===undefined)return{dims:[...volume.dims],spacing:[...volume.spacing],affine:volume.affine.map(row=>[...row])};
  try{
    if(validateReferenceHeader(volume)?.frame!=='RAS')return null;
    const affine=referenceAffineMm(volume).slice(0,3),spacing=[0,1,2].map(c=>Math.hypot(...affine.map(row=>row[c]!))) as Volume['spacing'];
    return{dims:[...volume.dims],spacing,affine};
  }catch{return null;}
}
function anatomicalAffine(volume:Volume):number[][]|null{
  // Preserve the established label policy for legacy inputs, including its oblique flag.
  if(volume.niftiReference===undefined)return volume.oblique?null:volume.affine;
  const grid=displayedDirectionGrid(volume);if(!grid?.affine)return null;
  try{return !affineIsOblique(grid.affine)&&isAxisAlignedGrid(grid)?grid.affine:null;}catch{return null;}
}
export function hasAnatomicalDirections(volume:Volume):boolean{return anatomicalAffine(volume)!==null;}
export function direction(volume: Volume, axis: Axis): string {
  const affine=anatomicalAffine(volume);if(!affine)return ['I 轴', 'J 轴', 'K 轴'][axis];
  const col = affine.map(row => Math.abs(row[axis]));
  return ['矢状位', '冠状位', '轴位'][col.indexOf(Math.max(...col))];
}
export function edgeDirection(volume: Volume, axis: Axis, positive: boolean): string {
  const affine=anatomicalAffine(volume);if(!affine)return `${positive ? '+' : '−'}${['I', 'J', 'K'][axis]}`;
  const col = affine.map(row => row[axis]), mag = col.map(Math.abs), r = mag.indexOf(Math.max(...mag));
  return (col[r] > 0 === positive ? ['R', 'A', 'S'] : ['L', 'P', 'I'])[r];
}
export function inputValue(event: Event): string { return (event.target as HTMLInputElement).value; }
