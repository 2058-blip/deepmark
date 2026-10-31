import { parseNifti } from './core.ts';
import type { Axis, Volume } from './core.ts';
export type Segment = { id: number; name: string; color: string; visible: boolean };
export type Tool = 'paint' | 'erase' | 'navigate' | 'threshold' | 'region';
export const colors = ['#4ed1ad', '#fb9f67', '#859dff', '#ed78b6', '#e5d46f', '#74c5f4'];
export const initialSegments = (): Segment[] => [{ id: 1, name: '标注 1', color: colors[0], visible: true }];
export function download(data: BlobPart, name: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function readFile(file: File) {
  let buffer = await file.arrayBuffer();
  if (new Uint8Array(buffer)[0] === 31 && new Uint8Array(buffer)[1] === 139) {
    if (typeof DecompressionStream === 'undefined') throw new Error('此浏览器不支持 gzip 解压，请使用新版 Chrome/Edge，或先解压为 .nii。');
    buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return parseNifti(buffer, file.name);
}
export function direction(volume: Volume, axis: Axis): string {
  if (volume.oblique) return ['I 轴', 'J 轴', 'K 轴'][axis];
  const col = volume.affine.map(row => Math.abs(row[axis]));
  return ['矢状位', '冠状位', '轴位'][col.indexOf(Math.max(...col))];
}
export function edgeDirection(volume: Volume, axis: Axis, positive: boolean): string {
  if (volume.oblique) return `${positive ? '+' : '−'}${['I', 'J', 'K'][axis]}`;
  const col = volume.affine.map(row => row[axis]), mag = col.map(Math.abs), r = mag.indexOf(Math.max(...mag));
  return (col[r] > 0 === positive ? ['R', 'A', 'S'] : ['L', 'P', 'I'])[r];
}
export function inputValue(event: Event): string { return (event.target as HTMLInputElement).value; }
