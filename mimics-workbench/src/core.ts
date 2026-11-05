import {checkedVoxelCount,allocateVolumeData} from './volumeCapacity.ts';
import type {NiftiReference} from './mimics/niftiReference.ts';
export type Volume = {
  name: string; dims: [number, number, number]; spacing: [number, number, number];
  data: Float32Array; header: Uint8Array; little: boolean; min: number; max: number;
  affine: number[][]; oblique: boolean; unit: string;
  /** Optional mm application-world -> standalone NIfTI reference-world mapping. */
  niftiReference?:NiftiReference;
};
export type Axis = 0 | 1 | 2;
export type Change = { indices: Uint32Array; before: Uint16Array; after: Uint16Array };
export type ThresholdRange = { minimum: number; maximum: number; label: number };

// Inclusive scalar range, replacing only the selected segment outside the range.
// Inside the range, use the same overwrite policy as the painting tool.
export function thresholdLabel(gray: number, current: number, range: ThresholdRange): number {
  return gray >= range.minimum && gray <= range.maximum ? range.label : current === range.label ? 0 : current;
}
export function applyThreshold(data: Float32Array, labels: Uint16Array, range: ThresholdRange): { change: Change | null; matched: number } {
  if (data.length !== labels.length) throw new Error('分割尺寸与影像不一致。');
  if (!Number.isFinite(range.minimum) || !Number.isFinite(range.maximum) || range.minimum > range.maximum)
    throw new Error('请输入有效灰度范围，最小值不能大于最大值。');
  if (!Number.isInteger(range.label) || range.label < 1 || range.label > 65535) throw new Error('标签值无效。');
  let count = 0, matched = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] >= range.minimum && data[i] <= range.maximum) matched++;
    if (thresholdLabel(data[i], labels[i], range) !== labels[i]) count++;
  }
  if (!count) return { change: null, matched };
  // Allocate the full undo transaction before modifying any voxel.
  const change: Change = { indices: new Uint32Array(count), before: new Uint16Array(count), after: new Uint16Array(count) };
  for (let i = 0, j = 0; i < data.length; i++) {
    const value = thresholdLabel(data[i], labels[i], range);
    if (value === labels[i]) continue;
    change.indices[j] = i; change.before[j] = labels[i]; change.after[j] = value;
    labels[i] = value; j++;
  }
  return { change, matched };
}
const readers: Record<number, [number, string]> = {
  2: [1, 'getUint8'], 4: [2, 'getInt16'], 8: [4, 'getInt32'],
  16: [4, 'getFloat32'], 64: [8, 'getFloat64'], 256: [1, 'getInt8'],
  512: [2, 'getUint16'], 768: [4, 'getUint32'],
};
export interface NiftiLayout {
  count:number; bytes:number; method:string; offset:number; slope:number; intercept:number; little:boolean;
  volume:Omit<Volume,'data'|'min'|'max'>;
}
export function readNiftiValues(view:DataView, layout:NiftiLayout, data:Float32Array, start:number, count:number):{min:number;max:number} {
  const read=(view[layout.method as keyof DataView] as (offset:number,little:boolean)=>number).bind(view);
  let min=Infinity,max=-Infinity;
  for(let i=0;i<count;i++){
    const value=read(i*layout.bytes,layout.little)*layout.slope+layout.intercept;
    if(!Number.isFinite(value)||Math.abs(value)>3.402823466e38)throw new Error('影像包含无法显示的非有限灰度值。');
    data[start+i]=value;min=Math.min(min,value);max=Math.max(max,value);
  }
  return {min,max};
}
export function parseNifti(buffer:ArrayBuffer,name='volume.nii'):Volume {
  const layout=parseNiftiHeader(buffer,name,buffer.byteLength),data=allocateVolumeData(layout.count);
  const range=readNiftiValues(new DataView(buffer,layout.offset,layout.count*layout.bytes),layout,data,0,layout.count);
  return {...layout.volume,data,...range};
}
export function parseNiftiHeader(buffer: ArrayBuffer, name = 'volume.nii', totalBytes?: number): NiftiLayout {
  if (buffer.byteLength < 352) throw new Error('文件过短，不是完整的 NIfTI-1 文件。');
  const view = new DataView(buffer);
  const little = view.getInt32(0, true) === 348;
  if (view.getInt32(0, little) !== 348) throw new Error('目前支持 NIfTI-1 单文件格式；暂不支持 NIfTI-2 或 Analyze。');
  if (view.getUint8(344) !== 110 || view.getUint8(345) !== 43 || view.getUint8(346) !== 49 || view.getUint8(347) !== 0)
    throw new Error('请使用 .nii 单文件影像，不支持 .hdr/.img 文件对。');
  const rank = view.getInt16(40, little);
  if (rank < 3 || rank > 7) throw new Error('需要三维影像。');
  for (let a = 4; a <= rank; a++) if (view.getInt16(40 + 2 * a, little) !== 1)
    throw new Error('目前只支持单个三维体积，请先将时间序列或多通道影像拆分。');
  const dims = [0, 1, 2].map(a => view.getInt16(42 + a * 2, little)) as Volume['dims'];
  if (dims.some(n => n < 1)) throw new Error('影像尺寸无效。');
  const count = checkedVoxelCount(dims);
  const kind = view.getInt16(70, little);
  const entry = readers[kind];
  if (!entry) throw new Error(`暂不支持 NIfTI 数据类型 ${kind}，请使用整数或浮点灰度影像。`);
  const [bytes, method] = entry;
  if (view.getInt16(72, little) !== bytes * 8) throw new Error('影像数据类型与位深不一致。');
  const offset = view.getFloat32(108, little);
  if (!Number.isInteger(offset) || offset < 352 || !Number.isSafeInteger(offset + count * bytes) || totalBytes !== undefined && offset + count * bytes > totalBytes)
    throw new Error('影像数据不完整或数据偏移无效。');
  let slope = view.getFloat32(112, little);
  let intercept = view.getFloat32(116, little);
  if (slope === 0) { slope = 1; intercept = 0; }
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) throw new Error('影像灰度缩放参数无效。');
  const spacing = [0, 1, 2].map(a => Math.abs(view.getFloat32(80 + a * 4, little))) as Volume['spacing'];
  if (spacing.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('体素间距无效。');
  let affine: number[][] = [[spacing[0], 0, 0, 0], [0, spacing[1], 0, 0], [0, 0, spacing[2], 0]];
  const sform = view.getInt16(254, little), qform = view.getInt16(252, little);
  if (sform > 0) {
    affine = [0, 1, 2].map(r => [0, 1, 2, 3].map(c => view.getFloat32(280 + 16 * r + 4 * c, little)));
  } else if (qform > 0) {
    let b = view.getFloat32(256, little), c = view.getFloat32(260, little), d = view.getFloat32(264, little);
    let aa = 1 - b*b - c*c - d*d;
    if (aa < 1e-7) { const norm = Math.hypot(b, c, d); b /= norm; c /= norm; d /= norm; aa = 0; }
    const a = Math.sqrt(aa), qfac = view.getFloat32(76, little) < 0 ? -1 : 1;
    const rotation = [[a*a+b*b-c*c-d*d, 2*(b*c-a*d), 2*(b*d+a*c)],
      [2*(b*c+a*d), a*a+c*c-b*b-d*d, 2*(c*d-a*b)],
      [2*(b*d-a*c), 2*(c*d+a*b), a*a+d*d-c*c-b*b]];
    affine = rotation.map((row, r) => [...row.map((v, col) => v * spacing[col] * (col === 2 ? qfac : 1)), view.getFloat32(268 + r * 4, little)]);
  }
  if (affine.flat().some(n => !Number.isFinite(n))) throw new Error('影像方向矩阵无效。');
  const det = affine[0][0]*(affine[1][1]*affine[2][2]-affine[1][2]*affine[2][1])
    - affine[0][1]*(affine[1][0]*affine[2][2]-affine[1][2]*affine[2][0])
    + affine[0][2]*(affine[1][0]*affine[2][1]-affine[1][1]*affine[2][0]);
  if (Math.abs(det) < 1e-12) throw new Error('影像方向矩阵不可逆。');
  const oblique = sform === 0 && qform === 0 || [0, 1, 2].some(col => {
    const v = affine.map(row => Math.abs(row[col]));
    return Math.max(...v) / Math.hypot(...v) < 0.9999;
  });
  const units = view.getUint8(123) & 7;
  const factor = units === 1 ? 1000 : units === 3 ? .001 : 1;
  const displaySpacing = [0,1,2].map(col => Math.hypot(...affine.map(row=>row[col])) * factor) as Volume['spacing'];
  return {count,bytes,method,offset,slope,intercept,little,volume:{ name,dims,spacing:displaySpacing,header:new Uint8Array(buffer.slice(0,348)),little,affine,oblique,unit:[1,2,3].includes(units)?'mm':'影像单位'}};
}
export function exportNifti(volume: Volume, labels: Uint16Array): ArrayBuffer {
  if (labels.length !== volume.data.length) throw new Error('分割尺寸与影像不一致。');
  const output = new ArrayBuffer(352 + labels.length * 2);
  new Uint8Array(output).set(volume.header);
  const view = new DataView(output), le = volume.little;
  view.setInt16(70, 512, le); view.setInt16(72, 16, le);
  view.setFloat32(108, 352, le); view.setFloat32(112, 1, le); view.setFloat32(116, 0, le);
  view.setInt16(68, 1002, le); // NIFTI_INTENT_LABEL
  view.setFloat32(124, 0, le); view.setFloat32(128, 0, le);
  for (let i = 0; i < labels.length; i++) view.setUint16(352 + i * 2, labels[i], le);
  return output;
}
export function planeAxes(axis: Axis): [Axis, Axis] { return axis === 2 ? [0, 1] : axis === 1 ? [0, 2] : [1, 2]; }
export function indexOf(point: number[], dims: number[]): number { return point[0] + dims[0] * (point[1] + dims[1] * point[2]); }
export function planePoint(axis: Axis, slice: number, u: number, v: number): [number, number, number] {
  const p: [number, number, number] = [0, 0, 0], [a, b] = planeAxes(axis);
  p[axis] = slice; p[a] = u; p[b] = v; return p;
}
export function paint(labels: Uint16Array, volume: Pick<Volume, 'dims' | 'spacing'>, axis: Axis, slice: number,
  u: number, v: number, diameter: number, value: number, before: Map<number, number>, eraseOnly?: number, recordTouches = false) {
  const [a, b] = planeAxes(axis), radius = diameter / 2;
  const du = radius / volume.spacing[a], dv = radius / volume.spacing[b];
  for (let y = Math.max(0, Math.ceil(v - dv)); y <= Math.min(volume.dims[b] - 1, Math.floor(v + dv)); y++) {
    for (let x = Math.max(0, Math.ceil(u - du)); x <= Math.min(volume.dims[a] - 1, Math.floor(u + du)); x++) {
      if (((x-u)*volume.spacing[a])**2 + ((y-v)*volume.spacing[b])**2 > radius**2) continue;
      const i = indexOf(planePoint(axis, slice, x, y), volume.dims);
      if ((!recordTouches && labels[i] === value) || (eraseOnly !== undefined && labels[i] !== eraseOnly)) continue;
      if (!before.has(i)) before.set(i, labels[i]);
      labels[i] = value;
    }
  }
}
export function makeDemo(): Volume {
  const dims = [96, 96, 64], count = dims[0]*dims[1]*dims[2];
  const buffer = new ArrayBuffer(352 + count * 2), v = new DataView(buffer);
  v.setInt32(0, 348, true); v.setInt16(40, 3, true);
  dims.forEach((n, a) => { v.setInt16(42+a*2, n, true); v.setFloat32(80+a*4, a === 2 ? 1.5 : 1, true); });
  v.setInt16(70, 4, true); v.setInt16(72, 16, true); v.setFloat32(108, 352, true);
  v.setFloat32(112, 1, true); v.setInt16(254, 1, true);
  v.setFloat32(280, 1, true); v.setFloat32(300, 1, true); v.setFloat32(320, 1.5, true);
  v.setUint8(123, 2); new Uint8Array(buffer, 344, 4).set([110,43,49,0]);
  for (let z=0; z<64; z++) for(let y=0; y<96; y++) for(let x=0; x<96; x++) {
    const r = ((x-48)/36)**2 + ((y-48)/30)**2 + ((z-32)/28)**2;
    let value = -1000;
    if (r < 1) value = 40 + Math.round(18*Math.sin(x*.19)*Math.cos(y*.17));
    if (r > .82 && r < 1) value = 650;
    if (((x-38)/9)**2 + ((y-45)/12)**2 + ((z-32)/17)**2 < 1) value = 120;
    v.setInt16(352 + 2*(x+96*(y+96*z)), value, true);
  }
  return parseNifti(buffer, '合成练习影像.nii');
}
