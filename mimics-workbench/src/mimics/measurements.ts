import { physicalPoint, requireGrid, voxelIndex } from './types.ts';
import type { Vec3, VolumeGrid, SlicePlane } from './types.ts';

export type EvaluationKind = 'distance' | 'angle' | '3pointdiameter' | 'diameter' | 'ellipse' | 'planarpolygon' | 'area';
export interface MeasurementOptions {
  /** Default: world-space millimetres. Voxel coordinates require grid. */
  coordinateSpace?: 'world' | 'voxel';
  grid?: VolumeGrid;
  /** Absolute planarity tolerance in mm. Default 1e-5. */
  planarityTolerance?: number;
}
export interface MeasurementResult {
  kind: EvaluationKind;
  valid: boolean;
  value: number;
  unit: 'mm' | 'mm²' | 'degree';
  details: Record<string, number | Vec3 | string>;
  reason?: string;
}
type Vec2 = [number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (v: Vec3, n: number): Vec3 => [v[0] * n, v[1] * n, v[2] * n];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: Vec3): number => Math.hypot(...v);
const EPS = 1e-10;

/** Invert the complete voxel-to-mm affine, including rotation, translation and shear. */
export function worldToVoxel(point: Vec3, grid: Pick<VolumeGrid, 'spacing' | 'affine'>): Vec3 {
  if (point.some(n => !Number.isFinite(n))) throw new Error('空间坐标必须是有限数。');
  if (!grid.affine) {
    if (grid.spacing.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('体素间距无效。');
    return point.map((n, a) => n / grid.spacing[a]!) as Vec3;
  }
  const m = grid.affine;
  if (m.length < 3 || m.slice(0, 3).some(row => row.length < 4 || row.slice(0, 4).some(n => !Number.isFinite(n)))) throw new Error('方向矩阵无效。');
  const a: Vec3 = [m[0]![0]!, m[1]![0]!, m[2]![0]!];
  const b: Vec3 = [m[0]![1]!, m[1]![1]!, m[2]![1]!];
  const c: Vec3 = [m[0]![2]!, m[1]![2]!, m[2]![2]!];
  const determinant = dot(a, cross(b, c));
  if (Math.abs(determinant) <= Number.EPSILON * norm(a) * norm(b) * norm(c) * 16) throw new Error('方向矩阵不可逆。');
  const p = sub(point, [m[0]![3]!, m[1]![3]!, m[2]![3]!]);
  return [dot(p, cross(b, c)), dot(p, cross(c, a)), dot(p, cross(a, b))].map(n => n / determinant) as Vec3;
}

const nearestBits=new DataView(new ArrayBuffer(8));
/** Independent nearest policy: half-integer ties within two binary ULPs round toward +infinity. */
export function nearestVoxelCoordinate(value:number):number{
  // At very large magnitudes representable integers are already too coarse for this tie repair.
  if(!Number.isFinite(value)||Math.abs(value)>=2**50)return Math.round(value);
  const lower=Math.floor(value),half=lower+.5,difference=Math.abs(value-half);
  if(difference===0)return lower+1;
  // Ordinary non-half values take the existing path without a blanket epsilon bias.
  if(difference>4*Number.EPSILON*Math.max(1,Math.abs(half)))return Math.round(value);
  nearestBits.setFloat64(0,Math.abs(half),false);
  const exponent=((nearestBits.getUint32(0,false)>>>20)&0x7ff)-1023,ulp=2**(exponent-52);
  return difference<=2*ulp?lower+1:Math.round(value);
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  return Math.abs(orientation(a, b, p)) < EPS && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
}
function intersects(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const p = orientation(a, b, c), q = orientation(a, b, d), r = orientation(c, d, a), s = orientation(c, d, b);
  return p * q < 0 && r * s < 0 || onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
}
function assertSimplePolygon(p: Vec2[]): void {
  if (p.length < 3 || p.some(a => a.some(n => !Number.isFinite(n)))) throw new Error('多边形需要至少三个有效点。');
  for (let i = 0; i < p.length; i++) {
    if (Math.hypot(p[i]![0] - p[(i + 1) % p.length]![0], p[i]![1] - p[(i + 1) % p.length]![1]) < EPS) throw new Error('多边形包含重复相邻点。');
    for (let j = i + 1; j < p.length; j++) {
      if (j === i + 1 || i === 0 && j === p.length - 1) continue;
      if (intersects(p[i]!, p[(i + 1) % p.length]!, p[j]!, p[(j + 1) % p.length]!)) throw new Error('不支持自交多边形。');
    }
  }
}
function polygonArea(points: Vec2[]): number { return Math.abs(points.reduce((s, p, i) => { const q = points[(i + 1) % points.length]!; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2; }

/** Closed interior intervals of a polygon on a line through c, parameterised by unit d. */
function centroidLineChord(points: Vec2[], c: Vec2, d: Vec2, tolerance: number): [number, number] | null {
  const crossings: number[] = [], intervals: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const at = (a[0] - c[0]) * d[0] + (a[1] - c[1]) * d[1], bt = (b[0] - c[0]) * d[0] + (b[1] - c[1]) * d[1];
    let an = (a[0] - c[0]) * -d[1] + (a[1] - c[1]) * d[0], bn = (b[0] - c[0]) * -d[1] + (b[1] - c[1]) * d[0];
    if (Math.abs(an) <= tolerance) an = 0;
    if (Math.abs(bn) <= tolerance) bn = 0;
    if (an === 0 && bn === 0) { intervals.push([Math.min(at, bt), Math.max(at, bt)]); continue; }
    // Half-open crossings count a transversal vertex once and a tangent vertex twice or zero times.
    if ((an > 0) !== (bn > 0)) crossings.push(at + (bt - at) * an / (an - bn));
  }
  crossings.sort((a, b) => a - b);
  if (crossings.length % 2) return null;
  for (let i = 0; i < crossings.length; i += 2) intervals.push([crossings[i]!, crossings[i + 1]!]);
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1] + tolerance) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  // Do not sum disconnected lobes or bridge an exterior gap. Boundary contact is included.
  return merged.find(([a, b]) => a <= tolerance && b >= -tolerance) ?? null;
}

/** Independent geometric implementation; this is not a claim to reproduce proprietary kernels. */
export function evaluateMeasurement(kind: EvaluationKind, input: Vec3[], options: MeasurementOptions = {}): MeasurementResult {
  const unit = kind === 'angle' ? 'degree' : kind === 'area' || kind === 'planarpolygon' || kind === 'ellipse' ? 'mm²' : 'mm';
  const invalid = (reason: string): MeasurementResult => ({ kind, valid: false, value: NaN, unit, details: {}, reason });
  try {
    if (input.some(p => p.length !== 3 || p.some(n => !Number.isFinite(n)))) return invalid('测量点必须是有限三维坐标。');
    if (options.coordinateSpace === 'voxel' && !options.grid) return invalid('体素坐标测量需要影像方向矩阵。');
    const points = options.coordinateSpace === 'voxel' ? input.map(p => physicalPoint(p, options.grid!)) : input;
    const result = (value: number, details: MeasurementResult['details'] = {}): MeasurementResult => ({ kind, valid: true, value, unit, details });
    if (kind === 'distance') {
      if (points.length !== 2) return invalid('距离需要两个点。');
      return result(norm(sub(points[1]!, points[0]!)));
    }
    if (kind === 'angle') {
      if (points.length !== 3) return invalid('角度需要三个点，第二点是顶点。');
      const u = sub(points[0]!, points[1]!), v = sub(points[2]!, points[1]!);
      if (norm(u) < EPS || norm(v) < EPS) return invalid('角度边长度不能为零。');
      return result(Math.atan2(norm(cross(u, v)), dot(u, v)) * 180 / Math.PI);
    }
    if (kind === '3pointdiameter' || kind === 'diameter') {
      if (points.length !== 3) return invalid('三点直径需要三个点。');
      const u = sub(points[1]!, points[0]!), v = sub(points[2]!, points[0]!), n = cross(u, v);
      const twiceArea = norm(n), a = norm(u), b = norm(v), c = norm(sub(points[2]!, points[1]!));
      if (a < EPS || b < EPS || c < EPS || twiceArea / (a * b) < 1e-8) return invalid('三点重合或近共线，不能稳定确定圆。');
      const diameter = a * b * c / twiceArea;
      const offset = scale(add(scale(cross(v, n), dot(u, u)), scale(cross(n, u), dot(v, v))), 1 / (2 * dot(n, n)));
      return result(diameter, { diameter, radius: diameter / 2, center: add(points[0]!, offset) });
    }
    if (kind === 'ellipse') {
      if (points.length !== 3) return invalid('椭圆需要长轴两端和短轴边界点。');
      const center = scale(add(points[0]!, points[1]!), .5), axis = sub(points[1]!, points[0]!);
      let a = norm(axis) / 2;
      if (a < EPS) return invalid('椭圆长轴不能为零。');
      const direction = scale(axis, 1 / (2 * a)), delta = sub(points[2]!, center);
      let b = norm(sub(delta, scale(direction, dot(delta, direction))));
      if (b < EPS) return invalid('椭圆短轴不能为零。');
      if (b > a) [a, b] = [b, a];
      // Composite Simpson quadrature of the exact arc-length integral.
      const steps = 1024, h = Math.PI / 2 / steps;
      let sum = 0;
      for (let i = 0; i <= steps; i++) { const t = i * h; sum += (i === 0 || i === steps ? 1 : i % 2 ? 4 : 2) * Math.hypot(a * Math.sin(t), b * Math.cos(t)); }
      const perimeter = 4 * h * sum / 3, area = Math.PI * a * b;
      return result(area, { center, D1: 2 * a, D2: 2 * b, E: Math.sqrt(Math.max(0, 1 - b * b / (a * a))), P: perimeter, A: area, DP: perimeter / Math.PI, DA: 2 * Math.sqrt(area / Math.PI), perimeter, area });
    }
    if (kind !== 'planarpolygon' && kind !== 'area') return invalid(`未知测量类型：${kind}`);
    const p = [...points];
    if (p.length > 3 && norm(sub(p[0]!, p[p.length - 1]!)) < EPS) p.pop();
    if (p.length < 3) return invalid('多边形需要至少三个点。');
    const origin = p[0]!, first = p.find(q => norm(sub(q, origin)) > EPS);
    if (!first) return invalid('多边形点全部重合。');
    const u = scale(sub(first, origin), 1 / norm(sub(first, origin)));
    const normalCandidate = p.map(q => cross(u, sub(q, origin))).find(q => norm(q) > EPS);
    if (!normalCandidate) return invalid('多边形点全部共线。');
    const n = scale(normalCandidate, 1 / norm(normalCandidate)), v = cross(n, u);
    const tolerance = options.planarityTolerance ?? 1e-5;
    if (!Number.isFinite(tolerance) || tolerance < 0) return invalid('共面容差无效。');
    if (p.some(q => Math.abs(dot(sub(q, origin), n)) > tolerance)) return invalid('面积测量点必须处于同一物理平面。');
    const xy = p.map(q => [dot(sub(q, origin), u), dot(sub(q, origin), v)] as Vec2);
    assertSimplePolygon(xy);
    let signedTwice = 0, cx = 0, cy = 0, perimeter = 0;
    xy.forEach((a, i) => {
      const b = xy[(i + 1) % xy.length]!, k = a[0] * b[1] - b[0] * a[1];
      signedTwice += k; cx += (a[0] + b[0]) * k; cy += (a[1] + b[1]) * k;
      perimeter += Math.hypot(a[0] - b[0], a[1] - b[1]);
    });
    if (Math.abs(signedTwice) < EPS) return invalid('多边形面积为零。');
    const area = Math.abs(signedTwice) / 2, c: Vec2 = [cx / (3 * signedTwice), cy / (3 * signedTwice)];
    const centroid = add(origin, add(scale(u, c[0]), scale(v, c[1])));
    let extent = 1; for (const p of xy) extent = Math.max(extent, Math.hypot(p[0] - c[0], p[1] - c[1]));
    const chordTolerance = 1e-10 * extent, inside = roiContains({ kind: 'polygon', points: xy }, c);
    let lmax = NaN, perpendicularLength = NaN, longest: Vec2 = [1, 0], best: [number, number] | null = null, bestWorld: Vec3 = [-Infinity, -Infinity, -Infinity];
    if (inside) {
      // Between successive directions through vertices the two first-exit edges are fixed.
      // Each positive ray distance is a positive multiple of sec(theta-alpha), so their
      // sum is convex. A maximum therefore occurs at a vertex direction (also test tangencies).
      for (const vertex of xy) {
        const delta: Vec2 = [vertex[0] - c[0], vertex[1] - c[1]], length = Math.hypot(...delta);
        if (length <= chordTolerance) continue;
        let direction: Vec2 = [delta[0] / length, delta[1] / length];
        let worldDirection = add(scale(u, direction[0]), scale(v, direction[1]));
        const sign = worldDirection.find(n => Math.abs(n) > 1e-12) ?? 1;
        if (sign < 0) { direction = [-direction[0], -direction[1]]; worldDirection = scale(worldDirection, -1); }
        const chord = centroidLineChord(xy, c, direction, chordTolerance);
        if (!chord) continue;
        const size = chord[1] - chord[0];
        const firstDifferent = worldDirection.findIndex((n, a) => Math.abs(n - bestWorld[a]!) > 1e-12);
        const preferredTie = firstDifferent >= 0 && worldDirection[firstDifferent]! > bestWorld[firstDifferent]!;
        if (!best || size > lmax + chordTolerance || Math.abs(size - lmax) <= chordTolerance && preferredTie) { lmax = size; longest = direction; best = chord; bestWorld = worldDirection; }
      }
      if (best) {
        const perpendicular = centroidLineChord(xy, c, [-longest[1], longest[0]], chordTolerance);
        if (perpendicular) perpendicularLength = perpendicular[1] - perpendicular[0];
      }
    }
    const chordDetails: MeasurementResult['details'] = { Lmax: lmax, L: perpendicularLength, chordToleranceMm: chordTolerance,
      chordStatus: !inside ? 'centroid_outside_polygon' : best ? 'ok' : 'centroid_chord_undefined',
      lmaxDefinition: 'maximum connected boundary-inclusive interior chord through area centroid',
      chordMethod: 'continuous edge intersections at vertex directions; independent implementation' };
    if (best) { chordDetails.LmaxDirection = bestWorld; chordDetails.LmaxStart = add(centroid, scale(bestWorld, best[0])); chordDetails.LmaxEnd = add(centroid, scale(bestWorld, best[1])); }
    return result(area, { area, perimeter, centroid, Da: 2 * Math.sqrt(area / Math.PI), Dp: perimeter / Math.PI, ...chordDetails });
  } catch (error) { return invalid(error instanceof Error ? error.message : String(error)); }
}

export type DensityROI = { kind: 'rect'; min: Vec2; max: Vec2 } | { kind: 'ellipse'; center: Vec2; radius: Vec2; rotation?: number } | { kind: 'polygon'; points: Vec2[] };
/** origin is a world-space sample centre; u/v are full physical sample-step vectors in mm. */
export interface PhysicalDensityPlane { origin: Vec3; u: Vec3; v: Vec3; size: [number, number] }
export type DensityPlane = SlicePlane | PhysicalDensityPlane;
export interface DensityOptions { unit?: 'HU' | 'GV'; interpolation?: 'nearest' | 'linear' }
export interface DensityStatistics {
  count: number; excluded: number; mean: number; std: number; standardDeviation: number; min: number; max: number;
  /** Sampled area after image clipping; sampling uses integer pixel centres, inclusive boundaries. */
  area: number; sampleArea: number; geometricArea: number; unit: 'HU' | 'GV'; standardDeviationConvention: 'population';
}
function roiContains(roi: DensityROI, p: Vec2): boolean {
  if (roi.kind === 'rect') return p[0] >= Math.min(roi.min[0], roi.max[0]) - EPS && p[0] <= Math.max(roi.min[0], roi.max[0]) + EPS && p[1] >= Math.min(roi.min[1], roi.max[1]) - EPS && p[1] <= Math.max(roi.min[1], roi.max[1]) + EPS;
  if (roi.kind === 'ellipse') {
    const t = roi.rotation ?? 0, x = p[0] - roi.center[0], y = p[1] - roi.center[1];
    return ((x * Math.cos(t) + y * Math.sin(t)) / roi.radius[0]) ** 2 + ((-x * Math.sin(t) + y * Math.cos(t)) / roi.radius[1]) ** 2 <= 1 + EPS;
  }
  let inside = false;
  for (let i = 0, j = roi.points.length - 1; i < roi.points.length; j = i++) {
    const a = roi.points[j]!, b = roi.points[i]!;
    if (onSegment(p, a, b)) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function densityStatistics(grid: VolumeGrid, plane: DensityPlane, roi: DensityROI, options: DensityOptions = {}): DensityStatistics {
  requireGrid(grid);
  let origin: Vec3, u: Vec3, v: Vec3, size: [number, number];
  if ('axis' in plane) {
    if (![0, 1, 2].includes(plane.axis) || !Number.isInteger(plane.index) || plane.index < 0 || plane.index >= grid.dims[plane.axis]) throw new Error('切片位置无效。');
    const axes = plane.axis === 2 ? [0, 1] : plane.axis === 1 ? [0, 2] : [1, 2];
    const p: Vec3 = [0, 0, 0]; p[plane.axis] = plane.index; origin = physicalPoint(p, grid);
    const q = [...p] as Vec3; q[axes[0]!] += 1; u = sub(physicalPoint(q, grid), origin);
    const r = [...p] as Vec3; r[axes[1]!] += 1; v = sub(physicalPoint(r, grid), origin);
    size = [grid.dims[axes[0]!]!, grid.dims[axes[1]!]!];
  } else { ({ origin, u, v, size } = plane); }
  const pixelArea = norm(cross(u, v));
  if ([...origin, ...u, ...v].some(n => !Number.isFinite(n)) || pixelArea <= EPS || size.some(n => !Number.isSafeInteger(n) || n <= 0) || size[0] * size[1] > 128 * 1024 * 1024) throw new Error('密度采样平面无效。');
  let geometricArea: number;
  if (roi.kind === 'polygon') { assertSimplePolygon(roi.points); geometricArea = polygonArea(roi.points) * pixelArea; }
  else if (roi.kind === 'rect') {
    if ([...roi.min, ...roi.max].some(n => !Number.isFinite(n))) throw new Error('矩形ROI无效。');
    geometricArea = Math.abs((roi.max[0] - roi.min[0]) * (roi.max[1] - roi.min[1])) * pixelArea;
  } else {
    if ([...roi.center, ...roi.radius, roi.rotation ?? 0].some(n => !Number.isFinite(n)) || roi.radius.some(n => n <= 0)) throw new Error('椭圆ROI半径必须为正。');
    geometricArea = Math.PI * roi.radius[0] * roi.radius[1] * pixelArea;
  }
  let count = 0, excluded = 0, mean = 0, m2 = 0, min = Infinity, max = -Infinity;
  for (let y = 0; y < size[1]; y++) for (let x = 0; x < size[0]; x++) {
    if (!roiContains(roi, [x, y])) continue;
    const p = worldToVoxel(add(origin, add(scale(u, x), scale(v, y))), grid);
    if (p.some((n, a) => n < -1e-7 || n > grid.dims[a]! - 1 + 1e-7)) { excluded++; continue; }
    const q = p.map((n, a) => Math.max(0, Math.min(grid.dims[a]! - 1, n))) as Vec3;
    let value = 0;
    if (options.interpolation === 'linear') {
      const lo = q.map(Math.floor), hi = q.map((n, a) => Math.min(grid.dims[a]! - 1, Math.ceil(n))), f = q.map((n, a) => n - lo[a]!);
      for (let iz = 0; iz < 2; iz++) for (let iy = 0; iy < 2; iy++) for (let ix = 0; ix < 2; ix++) {
        const weight=(ix ? f[0]! : 1 - f[0]!) * (iy ? f[1]! : 1 - f[1]!) * (iz ? f[2]! : 1 - f[2]!);
        if(weight<=0)continue;
        const index = [ix ? hi[0]! : lo[0]!, iy ? hi[1]! : lo[1]!, iz ? hi[2]! : lo[2]!];
        value += grid.data[voxelIndex(index, grid.dims)]! * weight;
      }
    } else value = grid.data[voxelIndex(q.map(nearestVoxelCoordinate), grid.dims)]!;
    if (!Number.isFinite(value)) { excluded++; continue; }
    count++; const delta = value - mean; mean += delta / count; m2 += delta * (value - mean); min = Math.min(min, value); max = Math.max(max, value);
  }
  const std = count ? Math.sqrt(Math.max(0, m2 / count)) : NaN;
  return { count, excluded, mean: count ? mean : NaN, std, standardDeviation: std, min: count ? min : NaN, max: count ? max : NaN, area: count * pixelArea, sampleArea: count * pixelArea, geometricArea, unit: options.unit ?? 'GV', standardDeviationConvention: 'population' };
}
