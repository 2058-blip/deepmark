import { planeAxes } from '../core.ts';
import { volumeGeometry, transformVolumePoint } from './volumeRendering.ts';
import type { Axis, Vec3, VolumeGrid } from './types.ts';

type GridGeometry = Pick<VolumeGrid, 'dims' | 'spacing' | 'affine'>;
export type Point2 = [number, number];
const dot = (a: Vec3, b: Vec3) => a.reduce((sum, v, k) => sum + v * b[k]!, 0);

/** A source IJK plane embedded in an orthonormal physical plane. No MPR resampling. */
export function slicePlaneGeometry(grid: GridGeometry, axis: Axis) {
  const geometry = volumeGeometry(grid), [a, b] = planeAxes(axis);
  const u = geometry.voxelToWorld.slice(0, 3).map(row => row[a]!) as Vec3;
  const v = geometry.voxelToWorld.slice(0, 3).map(row => row[b]!) as Vec3;
  const uLength = Math.hypot(...u), vLength = Math.hypot(...v), shear = dot(u, v) / uLength;
  const vHeight = Math.hypot(...v.map((n, k) => n - shear * u[k]! / uLength));
  if (!(vHeight > Number.EPSILON * vLength * 32)) throw new Error('切片平面接近退化，无法显示。');
  const nx = grid.dims[a], ny = grid.dims[b], minX = Math.min(0, ny * shear), maxX = nx * uLength + Math.max(0, ny * shear);
  return { axis, a, b, nx, ny, u, v, uLength, vLength, shear, vHeight, minX, maxX, physicalWidth: maxX - minX, physicalHeight: ny * vHeight };
}

export function isAxisAlignedGrid(grid: GridGeometry, tolerance = 1e-5): boolean {
  const matrix = volumeGeometry(grid).voxelToWorld, rows = new Set<number>();
  for (const k of [0, 1, 2]) {
    const col = matrix.slice(0, 3).map(row => Math.abs(row[k]!)), length = Math.hypot(...col), row = col.indexOf(Math.max(...col));
    if (rows.has(row) || col.some((v, r) => r !== row && v > length * tolerance)) return false;
    rows.add(row);
  }
  return true;
}

/** Canvas CSS pixels: image support is [-.5, dims-.5], voxel coordinates denote centres. */
export function createSliceViewport(grid: GridGeometry, axis: Axis, size: Point2, zoom = 1, pan: Point2 = [0, 0], padding = 16) {
  if (size.some(v => !Number.isFinite(v) || v <= 0) || !Number.isFinite(zoom) || zoom <= 0 || pan.some(v => !Number.isFinite(v))) throw new Error('切片视口尺寸、缩放或平移无效。');
  const plane = slicePlaneGeometry(grid, axis);
  const scale = Math.min(Math.max(1, size[0] - padding * 2) / plane.physicalWidth, Math.max(1, size[1] - padding * 2) / plane.physicalHeight) * zoom;
  const w = plane.physicalWidth * scale, h = plane.physicalHeight * scale, ox = (size[0] - w) / 2 + pan[0], oy = (size[1] - h) / 2 + pan[1];
  // drawImage source x increases I/J; source y decreases J/K. Handles shear without changing the source voxels.
  const transform: [number, number, number, number, number, number] = [plane.uLength * scale, 0, -plane.shear * scale, plane.vHeight * scale, ox + (plane.ny * plane.shear - plane.minX) * scale, oy];
  return { ...plane, scale, w, h, ox, oy, transform };
}
export type SliceViewport = ReturnType<typeof createSliceViewport>;
export function sliceToScreen(view: SliceViewport, point: readonly number[]): Point2 {
  const [a, b, c, d, e, f] = view.transform, x = point[view.a]! + .5, y = view.ny - .5 - point[view.b]!;
  return [a * x + c * y + e, b * x + d * y + f];
}
export function screenToSlice(view: SliceViewport, point: Point2, slice: number): Vec3 | null {
  const [a, , c, d, e, f] = view.transform, y = (point[1] - f) / d, x = (point[0] - e - c * y) / a;
  if (x < -1e-9 || y < -1e-9 || x > view.nx + 1e-9 || y > view.ny + 1e-9) return null;
  const result: Vec3 = [0, 0, 0]; result[view.axis] = slice;
  result[view.a] = Math.max(0, Math.min(view.nx - 1, x - .5));
  result[view.b] = Math.max(0, Math.min(view.ny - 1, view.ny - .5 - y));
  return result;
}

export interface BrushSize { width: number; height: number; shape?: 'circle' | 'square' }
/** Legacy circle/square names also represent independent ellipse/rectangle dimensions. */
export function normalizeBrushSize(size: number | BrushSize): Required<BrushSize> {
  const result = typeof size === 'number' ? { width: size, height: size, shape: 'circle' as const } : { ...size, shape: size.shape ?? 'circle' };
  if (![result.width, result.height].every(v => Number.isFinite(v) && v > 0) || !['circle', 'square'].includes(result.shape)) throw new Error('笔刷宽高/直径必须是有限正数，形状须为椭圆或矩形。');
  return result;
}
/** Width/height lie in the orthonormal physical slice basis, not the possibly sheared IJK basis. */
export function brushFootprint(grid: GridGeometry, axis: Axis, size: number | BrushSize) {
  const { width, height, shape } = normalizeBrushSize(size), p = slicePlaneGeometry(grid, axis), rx = width / 2, ry = height / 2;
  const metric = { xx: p.uLength / rx, xy: p.shear / rx, yy: p.vHeight / ry };
  if (!Object.values(metric).every(Number.isFinite)) throw new Error('笔刷尺寸超出当前物理坐标的数值精度范围。');
  const du = shape === 'square' ? (rx + Math.abs(p.shear) * ry / p.vHeight) / p.uLength : Math.hypot(rx / p.uLength, ry * p.shear / (p.uLength * p.vHeight));
  const dv = ry / p.vHeight;
  const contains = (offsetA: number, offsetB: number) => {
    const x = offsetA * metric.xx + offsetB * metric.xy, y = offsetB * metric.yy;
    return shape === 'square' ? Math.abs(x) <= 1 + 1e-12 && Math.abs(y) <= 1 + 1e-12 : x * x + y * y <= 1 + 1e-12;
  };
  return { a: p.a, b: p.b, du, dv, contains, width, height, shape, metric };
}

/** Independent continuous-brush convention: union of the physical brush translated along a segment. */
export function brushSweepFootprint(grid: GridGeometry, axis: Axis, size: number | BrushSize, from: Vec3, to: Vec3) {
  if ([...from,...to].some(v => !Number.isFinite(v))) throw new Error('笔刷路径无效。');
  const f = brushFootprint(grid,axis,size), {a,b,metric} = f, da = to[a]-from[a], db = to[b]-from[b];
  const dx = da*metric.xx+db*metric.xy, dy = db*metric.yy, length = Math.hypot(dx,dy);
  if (!Number.isFinite(length)) throw new Error('笔刷路径超出当前物理坐标的数值精度范围。');
  const ux = length ? dx/length : 0, uy = length ? dy/length : 0;
  const epsilon = Number.EPSILON*32*Math.max(1,Math.abs(from[a]),Math.abs(from[b]),Math.abs(to[a]),Math.abs(to[b]),f.du,f.dv);
  const minU = Math.max(0,Math.ceil(Math.min(from[a],to[a])-f.du-epsilon)), maxU = Math.min(grid.dims[a]-1,Math.floor(Math.max(from[a],to[a])+f.du+epsilon));
  const minV = Math.max(0,Math.ceil(Math.min(from[b],to[b])-f.dv-epsilon)), maxV = Math.min(grid.dims[b]-1,Math.floor(Math.max(from[b],to[b])+f.dv+epsilon));
  function contains(u:number,v:number):boolean {
    const qa = u-from[a], qb = v-from[b], x = qa*metric.xx+qb*metric.xy, y = qb*metric.yy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('笔刷路径超出当前物理坐标的数值精度范围。');
    if (f.shape==='circle') {
      const projection = x*ux+y*uy;
      if (!Number.isFinite(projection)) throw new Error('笔刷路径超出当前物理坐标的数值精度范围。');
      const t = length ? Math.max(0,Math.min(1,projection/length)) : 0;
      // Subtract in IJK before normalizing so a narrow brush does not lose its centre line.
      const ra = qa-t*da, rb = qb-t*db;
      return Math.hypot(ra*metric.xx+rb*metric.xy,rb*metric.yy)<=1+1e-12;
    }
    let enter=0,exit=1;
    for (let k=0;k<2;k++) {
      const q=k?y:x,d=k?dy:dx;
      if(d===0){if(Math.abs(q)>1+1e-12)return false;}
      else {const t0=(q-1-1e-12)/d,t1=(q+1+1e-12)/d;enter=Math.max(enter,Math.min(t0,t1));exit=Math.min(exit,Math.max(t0,t1));if(enter>exit)return false;}
    }
    return true;
  }
  return {a,b,minU,maxU,minV,maxV,contains,candidateCount:Math.max(0,maxU-minU+1)*Math.max(0,maxV-minV+1)};
}

/** Explicit safety boundary for complicated repeated segment bounding boxes, not a sampling shortcut. */
export const MAX_BRUSH_SCAN_VISITS = 32*1024*1024;

/** Allocation limit for the compatibility point sampler, separate from continuous sweep work. */
export const MAX_BRUSH_STROKE_SAMPLES = 65_536;
/** Excludes start and includes end. Axis uses the slice metric; legacy calls use only moving IJK axes. */
export function interpolateBrushStroke(from: Vec3, to: Vec3, grid: GridGeometry, size: number | BrushSize, axis?: Axis): Vec3[] {
  const { width, height } = normalizeBrushSize(size);
  if ([...from, ...to].some(v => !Number.isFinite(v))) throw new Error('笔刷路径无效。');
  const geometry = volumeGeometry(grid), delta = to.map((v, k) => v - from[k]!) as Vec3;
  const distance = Math.hypot(...transformVolumePoint(geometry.voxelToWorld, delta, true));
  const moving = geometry.physicalVoxelSize.filter((_v,k)=>delta[k]!==0);
  const plane = axis===undefined ? null : slicePlaneGeometry(grid,axis);
  const spacing = plane ? Math.min(plane.uLength,plane.vHeight,plane.uLength/plane.vLength*plane.vHeight) : Math.min(...(moving.length?moving:geometry.physicalVoxelSize));
  const step = Math.min(width / 4, height / 4, spacing / 2), count = Math.max(1, Math.ceil(distance / step));
  if (!Number.isSafeInteger(count) || count > MAX_BRUSH_STROKE_SAMPLES) throw new Error(`当前笔刷路径超过 ${MAX_BRUSH_STROKE_SAMPLES} 次采样上限；请增大笔刷宽高或缩短单次拖动。`);
  return Array.from({ length: count }, (_, i) => from.map((v, k) => v + delta[k]! * (i + 1) / count) as Vec3);
}
/** Independent interaction convention: edge motion is twice CSS drag / physical scale. */
export function resizeBrushFromDrag(start: BrushSize, delta: Point2, scale: number, sameWidthHeight: boolean, minimum = .1): { width: number; height: number } {
  normalizeBrushSize(start);
  if (delta.some(v => !Number.isFinite(v)) || !Number.isFinite(scale) || scale <= 0 || !Number.isFinite(minimum) || minimum <= 0) throw new Error('笔刷调整位移或比例无效。');
  const dominant = Math.abs(delta[0]) >= Math.abs(delta[1]) ? delta[0] : delta[1];
  const width = Math.max(minimum, start.width + 2 * (sameWidthHeight ? dominant : delta[0]) / scale);
  const height = sameWidthHeight ? width : Math.max(minimum, start.height + 2 * delta[1] / scale);
  if (![width,height].every(Number.isFinite)) throw new Error('调整后的笔刷宽高超出有限数值范围。');
  return { width: Number(width.toFixed(6)), height: Number(height.toFixed(6)) };
}

/** Column-major Y * X rotation, shared by GL matrices, overlays and picking rays. */
export function cameraRotation(pitch: number, yaw: number): number[] {
  const sx = Math.sin(pitch), cx = Math.cos(pitch), sy = Math.sin(yaw), cy = Math.cos(yaw);
  return [cy, 0, -sy, sy * sx, cx, cy * sx, sy * cx, -sx, cy * cx];
}
export function rotateCameraVector(v: Vec3, r: readonly number[], inverse = false): Vec3 {
  return inverse ? [r[0]! * v[0] + r[1]! * v[1] + r[2]! * v[2], r[3]! * v[0] + r[4]! * v[1] + r[5]! * v[2], r[6]! * v[0] + r[7]! * v[1] + r[8]! * v[2]] : [r[0]! * v[0] + r[3]! * v[1] + r[6]! * v[2], r[1]! * v[0] + r[4]! * v[1] + r[7]! * v[2], r[2]! * v[0] + r[5]! * v[1] + r[8]! * v[2]];
}
export interface OrthoCamera { center: Vec3; rotation: readonly number[]; halfHeight: number; width: number; height: number; pan: Point2 }
export function projectCameraPoint(point: Vec3, camera: OrthoCamera): Point2 {
  const v = rotateCameraVector(point.map((n, k) => n - camera.center[k]!) as Vec3, camera.rotation), scale = camera.height / (2 * camera.halfHeight);
  return [camera.width / 2 + (v[0] + camera.pan[0]) * scale, camera.height / 2 - (v[1] + camera.pan[1]) * scale];
}
/** GPU matrix accepts vertices already translated by -camera.center. */
export function cameraClipMatrix(camera: OrthoCamera, depth: number): Float32Array {
  const r = camera.rotation, sx = camera.height / (camera.halfHeight * camera.width), sy = 1 / camera.halfHeight;
  return new Float32Array([r[0]! * sx, r[1]! * sy, -r[2]! / depth, 0, r[3]! * sx, r[4]! * sy, -r[5]! / depth, 0, r[6]! * sx, r[7]! * sy, -r[8]! / depth, 0, camera.pan[0] * sx, camera.pan[1] * sy, 0, 1]);
}
export function cameraPickRay(point: Point2, camera: OrthoCamera, reach: number): { origin: Vec3; direction: Vec3 } {
  const scale = 2 * camera.halfHeight / camera.height;
  const local = rotateCameraVector([(point[0] - camera.width / 2) * scale - camera.pan[0], (camera.height / 2 - point[1]) * scale - camera.pan[1], reach], camera.rotation, true);
  return { origin: local.map((v, k) => v + camera.center[k]!) as Vec3, direction: rotateCameraVector([0, 0, -1], camera.rotation, true) };
}
export function fitCameraHalfHeight(min: Vec3, max: Vec3, width: number, height: number, margin = 1.12): number {
  const radius = Math.hypot(...max.map((v, k) => v - min[k]!)) / 2 || 1;
  return Math.max(1e-4, radius) * margin / Math.min(1, Math.max(1, width) / Math.max(1, height));
}
