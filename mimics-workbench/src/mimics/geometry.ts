import { physicalPoint, requireGrid, voxelIndex, type AlgorithmControl, type BinaryMask, type TriangleMesh, type Vec3, type VolumeGrid } from './types.ts';
import {compactMeshStats} from './meshStatistics.ts';
import {manifoldFaceNeighbours} from './compactTopology.ts';
import {MeshNumberBuffer} from './meshBuffer.ts';
import { MC_CORNERS, MC_EDGES, MC_FACES, MC_TRIANGLES } from './marchingTables.ts';

export interface SurfaceOptions extends AlgorithmControl {
  /** Names retain the documented UI vocabulary; unrecovered native preset constants are NOT invented. */
  quality?: 'low' | 'medium' | 'high' | 'optimal' | 'custom';
  step?: number | Vec3;
  interpolation?: 'linear' | 'midpoint' | 'native-local';
  /** Native Z mode uses an extra internal scale. The UI-to-field mapping remains unverified. */
  nativeZScale?: number;
  /** Optional grey/signed samples. Their >= threshold classification must agree with mask. */
  scalarField?: Float32Array;
  threshold?: number;
  /** Resolve ambiguous cube faces consistently. 'native-table' preserves the extracted table. */
  topology?: 'resolved' | 'native-table';
  smooth?: SmoothOptions;
  reduction?: ReduceOptions;
}
export interface SmoothOptions extends AlgorithmControl {
  iterations?: number;
  factor?: number;
  compensateShrinkage?: boolean;
  compensationMethod?: 'volume-polynomial' | 'global-scale';
  preserveBoundary?: boolean;
}
export interface ReduceOptions extends AlgorithmControl {
  /** Remaining fraction of triangles, in (0,1]. */
  targetRatio?: number;
  /** Maximum displacement of either endpoint and deviation from its incident planes, mm. */
  tolerance?: number;
  preserveBoundary?: boolean;
  /** Dihedral degrees above which an edge is preserved. */
  featureAngle?: number;
  iterations?: number;
}
export interface WrapOptions extends AlgorithmControl {
  resolution?: number;
  closingDistance?: number;
  dilate?: number;
  protectThinWalls?: boolean;
  /** Explicit memory/work guard for the independent voxel implementation. */
  maxVoxels?: number;
}
export interface MeshStats {
  vertices: number;
  triangles: number;
  edges: number;
  surfaceArea: number;
  area: number;
  signedVolume: number;
  /** Absolute oriented volume, including subtraction by inward cavity walls. */
  volume: number;
  absoluteVolume: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  nonManifoldVertices: number;
  inconsistentEdges: number;
  degenerateTriangles: number;
  components: number;
  eulerCharacteristic: number;
  closed: boolean;
  bounds: { min: Vec3; max: Vec3; size: Vec3 };
}

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const length = (a: ArrayLike<number>) => Math.hypot(a[0]!, a[1]!, a[2]!);
const point = (p: ArrayLike<number>, i: number): Vec3 => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
const edgeKey = (a: number, b: number) => a < b ? `${a},${b}` : `${b},${a}`;
function checkCancel(control: AlgorithmControl): void { if (control.cancelled?.()) throw new Error('操作已取消。'); }

export interface NativeInterpolationOptions {
  threshold: number;
  lower: number;
  upper: number;
  position0?: number;
  position1?: number;
  scale?: number;
}
/** Recovered 0x1800013c0 mode=1 piecewise formula, with the caller's final edge clamp.
 * Double arithmetic and explicit finite-input guards distinguish this from bit-exact native SSE. */
export function nativeLocalInterpolation(v0: number, v1: number, options: NativeInterpolationOptions): number {
  const { threshold: t, lower: lo, upper: hi } = options;
  const p0 = options.position0 ?? 0, p1 = options.position1 ?? 1, scale = options.scale ?? 1;
  if (![v0, v1, t, lo, hi, p0, p1, scale].every(Number.isFinite) || hi < lo || scale <= 0) throw new Error('局部插值参数无效。');
  const range = hi - lo, step = p1 - p0;
  let u: number;
  if (range < 1.1920929e-7) u = 0.5;
  else {
    const d0 = Math.min(v0 - lo, hi - v0), d1 = Math.min(v1 - lo, hi - v1);
    const cutoff = Math.fround(0.1), direction = v1 > v0 ? 1 : -1;
    if (d0 >= d1 && d0 / range >= cutoff && d1 / range <= cutoff) u = p0 + direction * (t - v0) * step / (range * scale);
    else if (d0 < d1 && d1 / range >= cutoff && d0 / range <= cutoff) u = p1 + direction * (t - v1) * step / (range * scale);
    else u = Math.abs(v1 - v0) < 1e-15 ? 0.5 : p0 + (t - v0) * step / (v1 - v0);
  }
  return Math.max(0.001, Math.min(0.999, u));
}
function validateAffine(grid: Pick<VolumeGrid, 'affine'>): number {
  if (!grid.affine) return 1;
  const a = grid.affine;
  if (a.length < 3 || a.slice(0, 3).some(r => r.length < 4 || r.slice(0, 4).some(x => !Number.isFinite(x)))) throw new Error('物理空间 affine 无效。');
  if (a.length > 3 && (a[3]!.length < 4 || a[3]!.slice(0, 4).some((v, i) => !Number.isFinite(v) || Math.abs(v - (i === 3 ? 1 : 0)) > 1e-12))) throw new Error('仅支持仿射空间，不能使用透视矩阵。');
  const det = dot(a[0]!, cross(a[1]!, a[2]!));
  if (Math.abs(det) < 1e-15) throw new Error('物理空间 affine 不可逆。');
  return det;
}
export function validateMesh(mesh: TriangleMesh): void {
  if (mesh.positions.length % 3 || mesh.indices.length % 3) throw new Error('网格顶点或三角形记录不完整。');
  for (const v of mesh.positions) if (!Number.isFinite(v)) throw new Error('网格含非有限坐标。');
  const n = mesh.positions.length / 3;
  for (const i of mesh.indices) if (!Number.isSafeInteger(i) || i < 0 || i >= n) throw new Error('网格三角形索引越界。');
}

/** Area-weighted vertex normals, computed in physical space after all transforms. */
export function computeNormals(mesh: TriangleMesh): Float32Array {
  validateMesh(mesh);
  const result = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!];
    const a = point(mesh.positions, ids[0]!);
    const n = cross(sub(point(mesh.positions, ids[1]!), a), sub(point(mesh.positions, ids[2]!), a));
    for (const id of ids) for (let k = 0; k < 3; k++) result[id * 3 + k] += n[k]!;
  }
  for (let i = 0; i < result.length; i += 3) {
    const n = Math.hypot(result[i]!, result[i + 1]!, result[i + 2]!);
    if (n) for (let k = 0; k < 3; k++) result[i + k] /= n;
  }
  return result;
}

export interface MeshRayHit { position: Vec3; triangle: number; distance: number; barycentric: Vec3 }
export interface MeshPicker { intersect(origin: Vec3, direction: Vec3, maxDistance?: number): MeshRayHit | undefined }
/** Static median BVH for repeated world-mm surface picking. Rebuild after changing geometry. */
export function createMeshPicker(mesh: TriangleMesh): MeshPicker {
  validateMesh(mesh);
  interface Node { min: Vec3; max: Vec3; faces?: number[]; left?: Node; right?: Node }
  const { positions: p, indices: ids } = mesh, count = ids.length / 3, centroids = new Float64Array(count * 3);
  for (let f = 0; f < count; f++) for (let axis = 0; axis < 3; axis++) centroids[3 * f + axis] = (p[3 * ids[3 * f]! + axis]! + p[3 * ids[3 * f + 1]! + axis]! + p[3 * ids[3 * f + 2]! + axis]!) / 3;
  const build = (faces: number[]): Node => {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const cmin: Vec3 = [...min], cmax: Vec3 = [...max];
    for (const f of faces) for (let axis = 0; axis < 3; axis++) {
      for (let k = 0; k < 3; k++) { const v = p[3 * ids[3 * f + k]! + axis]!; min[axis] = Math.min(min[axis]!, v); max[axis] = Math.max(max[axis]!, v); }
      cmin[axis] = Math.min(cmin[axis]!, centroids[3 * f + axis]!); cmax[axis] = Math.max(cmax[axis]!, centroids[3 * f + axis]!);
    }
    const node: Node = { min, max };
    const extent = cmax.map((v, k) => v - cmin[k]!), axis = extent.indexOf(Math.max(...extent));
    if (faces.length <= 12 || extent[axis]! < 1e-15) node.faces = faces;
    else { faces.sort((a, b) => centroids[3 * a + axis]! - centroids[3 * b + axis]!); const half = Math.floor(faces.length / 2); node.left = build(faces.slice(0, half)); node.right = build(faces.slice(half)); }
    return node;
  };
  const root = count ? build(Array.from({ length: count }, (_, i) => i)) : null;
  return { intersect(origin, direction, maxDistance = Infinity) {
    if (![...origin, ...direction].every(Number.isFinite) || !(maxDistance >= 0)) throw new Error('射线坐标或距离无效。');
    const len = length(direction); if (len < 1e-15) throw new Error('射线方向不能为零。');
    const d = direction.map(v => v / len) as Vec3;
    let closest = maxDistance, hit: MeshRayHit | undefined;
    const near = (node: Node): number => {
      let first = 0, last = closest;
      for (let axis = 0; axis < 3; axis++) {
        if (Math.abs(d[axis]!) < 1e-15) { if (origin[axis]! < node.min[axis]! || origin[axis]! > node.max[axis]!) return Infinity; }
        else {
          const a = (node.min[axis]! - origin[axis]!) / d[axis]!, b = (node.max[axis]! - origin[axis]!) / d[axis]!;
          first = Math.max(first, Math.min(a, b)); last = Math.min(last, Math.max(a, b));
          if (first > last) return Infinity;
        }
      }
      return first;
    };
    const stack: Node[] = root ? [root] : [];
    while (stack.length) {
      const node = stack.pop()!; if (near(node) > closest || near(node) === Infinity) continue;
      if (!node.faces) {
        const a = near(node.left!), b = near(node.right!);
        if (a < b) { if (b <= closest) stack.push(node.right!); if (a <= closest) stack.push(node.left!); }
        else { if (a <= closest) stack.push(node.left!); if (b <= closest) stack.push(node.right!); }
        continue;
      }
      for (const f of node.faces) {
        const a = 3 * ids[3 * f]!, b = 3 * ids[3 * f + 1]!, c = 3 * ids[3 * f + 2]!;
        const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
        const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
        const px = d[1] * vz - d[2] * vy, py = d[2] * vx - d[0] * vz, pz = d[0] * vy - d[1] * vx;
        const det = ux * px + uy * py + uz * pz;
        if (Math.abs(det) <= Number.EPSILON * 64 * Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)) continue;
        const tx = origin[0] - p[a]!, ty = origin[1] - p[a + 1]!, tz = origin[2] - p[a + 2]!;
        const u = (tx * px + ty * py + tz * pz) / det; if (u < -1e-10 || u > 1 + 1e-10) continue;
        const qx = ty * uz - tz * uy, qy = tz * ux - tx * uz, qz = tx * uy - ty * ux;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det; if (v < -1e-10 || u + v > 1 + 1e-10) continue;
        const rawDistance = (vx * qx + vy * qy + vz * qz) / det, distance = rawDistance === 0 ? 0 : rawDistance;
        if (distance >= 0 && distance <= closest) { closest = distance; hit = { position: origin.map((x, k) => x + distance * d[k]!) as Vec3, triangle: f, distance, barycentric: [1 - u - v, u, v] }; }
      }
    }
    return hit;
  } };
}

/** Marching Cubes on voxel centres, with an explicit exterior sample layer. */
export function calculateSurface(grid: VolumeGrid, mask: BinaryMask, options: SurfaceOptions = {}): TriangleMesh {
  const n = requireGrid(grid, mask);
  validateAffine(grid);
  const threshold = options.threshold ?? 0.5;
  if (!Number.isFinite(threshold)) throw new Error('等值面阈值无效。');
  const scalar = options.scalarField;
  if (options.nativeZScale !== undefined && (!(options.nativeZScale > 0) || !Number.isFinite(options.nativeZScale))) throw new Error('Z 插值比例无效。');
  if (scalar && scalar.length !== n) throw new Error('插值数据尺寸不一致。');
  if (!scalar && !(threshold > 0 && threshold < 1)) throw new Error('二值 Mask 的等值面阈值必须位于 0 和 1 之间。');
  let exterior = scalar ? threshold - 1 : 0;
  if (scalar) for (let i = 0; i < n; i++) {
    const s = scalar[i]!;
    if (!Number.isFinite(s) || (s >= threshold) !== !!mask[i]) throw new Error('灰度插值数据的阈值分类必须与 Mask 一致。');
    exterior = Math.min(exterior, s);
  }
  const steps = typeof options.step === 'number' ? [options.step, options.step, options.step] : options.step ?? [1, 1, 1];
  if (steps.some(v => !Number.isSafeInteger(v) || v < 1)) throw new Error('采样步长必须为正整数。');
  const axes = grid.dims.map((d, k) => {
    const a = [-1, 0];
    for (let i = steps[k]!; i < d - 1; i += steps[k]!) a.push(i);
    if (d > 1) a.push(d - 1);
    a.push(d);
    return a;
  });
  const [xs, ys, zs] = axes;
  const sample = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= grid.dims[0] || y >= grid.dims[1] || z >= grid.dims[2]) return exterior;
    const i = x + grid.dims[0] * (y + grid.dims[1] * z);
    return scalar ? scalar[i]! : mask[i] ? 1 : 0;
  };
  const positions = new MeshNumberBuffer(true), indices = new MeshNumberBuffer(false);
  let upperEdges = new Map<number, number>();
  const faceEdges = MC_FACES.map(face => face.map((v, i) => MC_EDGES.findIndex(e => e.includes(v as never) && e.includes(face[(i + 1) % 4]! as never))));
  const dims = [xs!.length, ys!.length, zs!.length];
  const values = new Float64Array(8);
  for (let zi = 0; zi < zs!.length - 1; zi++) {
    checkCancel(options);
    const lowerEdges = upperEdges, verticalEdges = new Map<number, number>();
    upperEdges = new Map<number, number>();
    for (let yi = 0; yi < ys!.length - 1; yi++) for (let xi = 0; xi < xs!.length - 1; xi++) {
      let code = 0;
      for (let k = 0; k < 8; k++) {
        const c = MC_CORNERS[k]!;
        values[k] = sample(xs![xi+c[0]]!,ys![yi+c[1]]!,zs![zi+c[2]]!);
        if(values[k]! >= threshold)code |= 1 << k;
      }
      if (code === 0 || code === 255) continue;
      const cubePoints = MC_CORNERS.map(c => [xs![xi + c[0]]!, ys![yi + c[1]]!, zs![zi + c[2]]!] as Vec3);
      const local = new Map<number, number>();
      const vertex = (e: number): number => {
        const existing = local.get(e); if (existing !== undefined) return existing;
        const [ca, cb] = MC_EDGES[e]!;
        const aa = MC_CORNERS[ca]!, bb = MC_CORNERS[cb]!;
        const na = xi + aa[0] + dims[0]! * (yi + aa[1] + dims[1]! * (zi + aa[2]));
        const nb = xi + bb[0] + dims[0]! * (yi + bb[1] + dims[1]! * (zi + bb[2]));
        const edgeAxis = aa[0] !== bb[0] ? 0 : aa[1] !== bb[1] ? 1 : 2;
        const key = Math.min(na, nb) * 3 + edgeAxis;
        const edgeVertices = aa[2] !== bb[2] ? verticalEdges : aa[2] ? upperEdges : lowerEdges;
        let id = edgeVertices.get(key);
        if (id === undefined) {
          let v0 = values[ca]!, v1 = values[cb]!;
          const a = cubePoints[ca]!, b = cubePoints[cb]!, direction = b.map((v, k) => v - a[k]!) as Vec3;
          const axis = direction.findIndex(v => v !== 0), edgeLength = direction[axis]!;
          let segment = 0, p0 = 0, p1 = 1;
          if (axis !== 2 && edgeLength > 1 && options.interpolation !== 'midpoint') {
            // Native XY matrix reduction scans the original edge and retains the strongest
            // threshold crossing with the same direction as its initial endpoint.
            const startsInside = v0 >= threshold; let strongest = -Infinity;
            for (let j = 0; j < edgeLength; j++) {
              const a0 = [...a] as Vec3, a1 = [...a] as Vec3; a0[axis] += j; a1[axis] += j + 1;
              const s0 = sample(...a0), s1 = sample(...a1);
              if ((s0 >= threshold) === startsInside && (s1 >= threshold) !== startsInside && Math.abs(s1 - s0) > strongest) {
                strongest = Math.abs(s1 - s0); segment = j; v0 = s0; v1 = s1; p0 = j / edgeLength; p1 = (j + 1) / edgeLength;
              }
            }
          }
          let t = options.interpolation === 'midpoint' || Math.abs(v1 - v0) < 1e-15 ? 0.5 : p0 + (threshold - v0) * (p1 - p0) / (v1 - v0);
          if (options.interpolation === 'native-local') {
            const neighbourhood = (p: Vec3): [number, number] => {
              const values: number[] = [];
              for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) values.push(sample(p[0] + dx, p[1] + dy, p[2]));
              values.sort((a, b) => a - b);
              return values[1] === values[23] ? [values[0]!, values[24]!] : [values[1]!, values[23]!];
            };
            const start = [...a] as Vec3; start[axis] += segment;
            let [lower, upper] = neighbourhood(start);
            if (axis === 2) { const other = neighbourhood(b); lower = Math.min(lower, other[0]); upper = Math.max(upper, other[1]); }
            t = nativeLocalInterpolation(v0, v1, { threshold, lower, upper, position0: p0, position1: p1, scale: axis === 2 ? options.nativeZScale ?? 1 : 1 });
          }
          // Native edge interpolators clamp away from exact endpoints (B2, 0x1c7700/04).
          t = Math.max(0.001, Math.min(0.999, t));
          const p = cubePoints[ca]!.map((v, k) => v + t * (cubePoints[cb]![k]! - v));
          const world = physicalPoint(p, grid);
          id = positions.length / 3;
          positions.push(...world); edgeVertices.set(key, id);
        }
        local.set(e, id); return id;
      };
      const ambiguous = faceEdges.some(edges => edges.filter(e => { const [a, b] = MC_EDGES[e]!; return (values[a]! >= threshold) !== (values[b]! >= threshold); }).length === 4);
      if (ambiguous && options.topology !== 'native-table') {
        // A shared-face asymptotic decider prevents cracks in the classical lookup table.
        // This robustness branch is an independent extension, NOT a recovered native algorithm.
        const graph = new Map<number, number[]>();
        const connect = (a: number, b: number) => { graph.set(a, [...graph.get(a) ?? [], b]); graph.set(b, [...graph.get(b) ?? [], a]); };
        faceEdges.forEach((edges, f) => {
          const crossings = edges.filter(e => { const [a, b] = MC_EDGES[e]!; return (values[a]! >= threshold) !== (values[b]! >= threshold); });
          if (crossings.length === 2) connect(crossings[0]!, crossings[1]!);
          else if (crossings.length === 4) {
            const corners = MC_FACES[f]!;
            const q = corners.map(c => values[c]! - threshold);
            const determinant = q[0]! * q[2]! - q[1]! * q[3]!;
            // Pairing is invariant to rotation/reversal of the same shared face.
            const node = (c: number) => { const p = MC_CORNERS[c]!; return xi + p[0] + dims[0]! * (yi + p[1] + dims[1]! * (zi + p[2])); };
            const pair02 = determinant > 0 || determinant === 0 && Math.min(node(corners[0]), node(corners[2])) < Math.min(node(corners[1]), node(corners[3]));
            if (pair02) { connect(edges[0]!, edges[1]!); connect(edges[2]!, edges[3]!); }
            else { connect(edges[0]!, edges[3]!); connect(edges[1]!, edges[2]!); }
          }
        });
        const visited = new Set<number>();
        for (const start of graph.keys()) {
          if (visited.has(start)) continue;
          const loop: number[] = []; let previous = -1, current = start;
          do {
            loop.push(vertex(current)); visited.add(current);
            const next = graph.get(current)!.find(v => v !== previous)!;
            previous = current; current = next;
          } while (current !== start && !visited.has(current));
          if (loop.length < 3) continue;
          if (loop.length === 3) indices.push(...loop);
          else {
            const centre: Vec3 = [0, 0, 0];
            for (const id of loop) for (let k = 0; k < 3; k++) centre[k] += positions.data[3 * id + k]! / loop.length;
            const id = positions.length / 3; positions.push(...centre);
            for (let k = 0; k < loop.length; k++) indices.push(loop[k]!, loop[(k + 1) % loop.length]!, id);
          }
        }
      } else {
        for (const e of MC_TRIANGLES[code]!) indices.push(vertex(e));
      }
    }
    options.progress?.((zi + 1) / (zs!.length - 1));
  }
  upperEdges.clear();
  let result: TriangleMesh = { positions: positions.finishPositions(), indices: indices.finishIndices() };
  // Table and ambiguity polygons may differ in local winding. Orient by adjacency, then use
  // the mask scalar gradient to distinguish cavity walls from exterior shell walls.
  result = orientFromField(result, grid, sample);
  if (options.smooth) result = smoothMesh(result, options.smooth);
  if (options.reduction) result = reduceMesh(result, options.reduction);
  result.normals = computeNormals(result);
  return result;
}

function inversePoint(p: Vec3, grid: Pick<VolumeGrid, 'spacing' | 'affine'>): Vec3 {
  if (!grid.affine) return p.map((v, k) => v / grid.spacing[k]!) as Vec3;
  const a = grid.affine, t: Vec3 = [p[0] - a[0]![3]!, p[1] - a[1]![3]!, p[2] - a[2]![3]!];
  // Columns of the linear affine, with Cramer's rule for the inverse.
  const x = [a[0]![0]!, a[1]![0]!, a[2]![0]!], y = [a[0]![1]!, a[1]![1]!, a[2]![1]!], z = [a[0]![2]!, a[1]![2]!, a[2]![2]!];
  const d = dot(x, cross(y, z));
  return [dot(t, cross(y, z)) / d, dot(x, cross(t, z)) / d, dot(x, cross(y, t)) / d];
}
function trilinearSample(p: Vec3, sample: (x: number, y: number, z: number) => number): number {
  const q = p.map(Math.floor), t = p.map((v, k) => v - q[k]!);
  let s = 0;
  for (const c of MC_CORNERS) s += sample(q[0]! + c[0], q[1]! + c[1], q[2]! + c[2]) * (c[0] ? t[0]! : 1 - t[0]!) * (c[1] ? t[1]! : 1 - t[1]!) * (c[2] ? t[2]! : 1 - t[2]!);
  return s;
}
function orientFromField(mesh: TriangleMesh, grid: VolumeGrid, sample: (x: number, y: number, z: number) => number): TriangleMesh {
  const ids = mesh.indices, adjacent = manifoldFaceNeighbours(ids, mesh.positions.length / 3);
  const done = new Uint8Array(ids.length / 3), flipped = new Uint8Array(done.length), queue = new Uint32Array(done.length);
  for (let seed = 0; seed < done.length; seed++) {
    if (done[seed]) continue;
    let count = 1; queue[0] = seed; done[seed] = 1;
    for (let q = 0; q < count; q++) {
      const f = queue[q]!;
      for (let e = 0; e < 3; e++) {
        const other = adjacent[3 * f + e]!; if (other < 0 || done[other]) continue;
        const a = ids[3 * f + e]!, b = ids[3 * f + (e + 1) % 3]!;
        let same = false;
        for (let j = 0; j < 3; j++) if (ids[3 * other + j] === a && ids[3 * other + (j + 1) % 3] === b) same = true;
        flipped[other] = flipped[f]! ^ Number(same); done[other] = 1; queue[count++] = other;
      }
    }
    let score = 0;
    for (let q = 0; q < count; q++) {
      const f = queue[q]!, a = point(mesh.positions, ids[3 * f]!), b = point(mesh.positions, ids[3 * f + 1]!), c = point(mesh.positions, ids[3 * f + 2]!);
      const n = cross(sub(b, a), sub(c, a)), size = length(n); if (!size) continue;
      if (flipped[f]) for (let k = 0; k < 3; k++) n[k] = -n[k]!;
      const centre = a.map((v, k) => (v + b[k]! + c[k]!) / 3) as Vec3, scale = Math.min(...grid.spacing) * 0.05;
      const plus = inversePoint(centre.map((v, k) => v + n[k]! / size * scale) as Vec3, grid);
      const minus = inversePoint(centre.map((v, k) => v - n[k]! / size * scale) as Vec3, grid);
      score += size * (trilinearSample(minus, sample) - trilinearSample(plus, sample));
    }
    if (score < 0) for (let q = 0; q < count; q++) flipped[queue[q]!] ^= 1;
  }
  for (let f = 0; f < done.length; f++) if (flipped[f]) [ids[3 * f + 1], ids[3 * f + 2]] = [ids[3 * f + 2]!, ids[3 * f + 1]!];
  return mesh;
}

interface EdgeInfo { a: number; b: number; faces: number[]; direction: number }
function meshTopology(mesh: TriangleMesh) {
  const edges = new Map<string, EdgeInfo>();
  const neighbours = Array.from({ length: mesh.positions.length / 3 }, () => new Set<number>());
  const vertexFaces = Array.from({ length: neighbours.length }, () => new Set<number>());
  for (let f = 0; f < mesh.indices.length / 3; f++) for (let j = 0; j < 3; j++) {
    const a = mesh.indices[3 * f + j]!, b = mesh.indices[3 * f + (j + 1) % 3]!;
    const key = edgeKey(a, b), e = edges.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), faces: [], direction: 0 };
    e.faces.push(f); e.direction += a < b ? 1 : -1; edges.set(key, e);
    neighbours[a]!.add(b); neighbours[b]!.add(a); vertexFaces[a]!.add(f);
  }
  return { edges, neighbours, vertexFaces };
}

export function meshStats(mesh: TriangleMesh): MeshStats {
  validateMesh(mesh);
  return compactMeshStats(mesh);
}

function polynomialAt(c: readonly number[], x: number): number { return ((c[3]! * x + c[2]!) * x + c[1]!) * x + c[0]!; }
function stationaryPoints(c: readonly number[]): number[] {
  const a = 3 * c[3]!, b = 2 * c[2]!, d = c[1]!;
  if (Math.abs(a) < 1e-15) return Math.abs(b) < 1e-15 ? [] : [-d / b];
  const discriminant = b * b - 4 * a * d; if (discriminant < 0) return [];
  const r = Math.sqrt(discriminant); return [(-b - r) / (2 * a), (-b + r) / (2 * a)];
}
function volumePolynomial(positions: Float32Array, indices: Uint32Array, delta: Float64Array, targetVolume: number): number[] {
  const coefficients = [0, 0, 0, 0], origin = positions.length ? point(positions, 0) : [0, 0, 0] as Vec3;
  for (let f = 0; f < indices.length; f += 3) {
    const [i, j, k] = [indices[f]!, indices[f + 1]!, indices[f + 2]!];
    const a = sub(point(positions, i!), origin), b = sub(point(positions, j!), origin), c = sub(point(positions, k!), origin);
    const da = point(delta, i!), db = point(delta, j!), dc = point(delta, k!);
    coefficients[0] += dot(a, cross(b, c)) / 6;
    coefficients[1] += (dot(da, cross(b, c)) + dot(a, cross(db, c)) + dot(a, cross(b, dc))) / 6;
    coefficients[2] += (dot(da, cross(db, c)) + dot(da, cross(b, dc)) + dot(a, cross(db, dc))) / 6;
    coefficients[3] += dot(da, cross(db, dc)) / 6;
  }
  coefficients[0] -= targetVolume; return coefficients;
}
function compensationMu(c: readonly number[], factor: number, targetVolume: number): number {
  const stationary = stationaryPoints(c).filter(x => x > -1 && x < 0), boundaries = [-1, ...stationary, 0].sort((a, b) => a - b);
  const epsilon = Math.max(1, Math.abs(targetVolume)) * 1e-12, roots: number[] = [];
  for (const x of boundaries) if (Math.abs(polynomialAt(c, x)) < epsilon) roots.push(x);
  for (let i = 0; i + 1 < boundaries.length; i++) {
    let a = boundaries[i]!, b = boundaries[i + 1]!, va = polynomialAt(c, a), vb = polynomialAt(c, b);
    if (va * vb >= 0) continue;
    for (let step = 0; step < 60; step++) {
      const mid = (a + b) / 2, value = polynomialAt(c, mid);
      if (Math.abs(value) < epsilon) { a = mid; b = mid; break; }
      if (va * value <= 0) { b = mid; vb = value; } else { a = mid; va = value; }
    }
    roots.push((a + b) / 2);
  }
  // Native chooses the largest real root in [-1,0], reducing unnecessary displacement.
  if (roots.length) return Math.max(...roots);
  const baseline = -factor, candidates = [baseline, -1, 0, ...stationary];
  candidates.sort((a, b) => Math.abs(polynomialAt(c, a)) - Math.abs(polynomialAt(c, b)));
  const best = candidates[0]!;
  return best < -0.95 && baseline > best ? baseline : best;
}

/** Uniform Jacobi Laplacian, with optional native-inspired cubic-volume second pass. */
export function smoothMesh(mesh: TriangleMesh, options: SmoothOptions = {}): TriangleMesh {
  validateMesh(mesh);
  const iterations = options.iterations ?? 5, factor = options.factor ?? 0.3;
  if (!Number.isSafeInteger(iterations) || iterations < 0 || iterations > 1000 || !Number.isFinite(factor) || factor < 0 || factor > 1) throw new Error('平滑次数或因子无效。');
  let positions = new Float32Array(mesh.positions);
  const topology = meshTopology(mesh), boundary = new Set<number>();
  for (const e of topology.edges.values()) if (e.faces.length !== 2) { boundary.add(e.a); boundary.add(e.b); }
  const originalVolume = meshStats(mesh).signedVolume;
  for (let t = 0; t < iterations; t++) {
    checkCancel(options);
    const next = new Float32Array(positions);
    for (let v = 0; v < topology.neighbours.length; v++) {
      if ((options.preserveBoundary ?? true) && boundary.has(v)) continue;
      const neighbours = topology.neighbours[v]!; if (!neighbours.size) continue;
      for (let k = 0; k < 3; k++) {
        let average = 0; for (const q of neighbours) average += positions[3 * q + k]! / neighbours.size;
        next[3 * v + k] = positions[3 * v + k]! + factor * (average - positions[3 * v + k]!);
      }
    }
    positions = next;
    if (options.compensateShrinkage && options.compensationMethod !== 'global-scale' && !boundary.size && Math.abs(originalVolume) > 1e-15) {
      const delta = new Float64Array(positions.length);
      for (let v = 0; v < topology.neighbours.length; v++) {
        const neighbours = topology.neighbours[v]!; if (!neighbours.size) continue;
        for (let k = 0; k < 3; k++) { let average = 0; for (const q of neighbours) average += positions[3 * q + k]! / neighbours.size; delta[3 * v + k] = average - positions[3 * v + k]!; }
      }
      const mu = compensationMu(volumePolynomial(positions, mesh.indices, delta, originalVolume), factor, originalVolume);
      for (let i = 0; i < positions.length; i++) positions[i] += mu * delta[i]!;
    }
    options.progress?.((t + 1) / Math.max(1, iterations));
  }
  if (options.compensateShrinkage && options.compensationMethod === 'global-scale' && !boundary.size && Math.abs(originalVolume) > 1e-15) {
    const currentVolume = meshStats({ positions, indices: mesh.indices }).signedVolume;
    if (currentVolume * originalVolume > 0) {
      const scale = Math.cbrt(originalVolume / currentVolume), centre: Vec3 = [0, 0, 0];
      const n = positions.length / 3;
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) centre[k] += positions[3 * i + k]! / n;
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) positions[3 * i + k] = centre[k]! + scale * (positions[3 * i + k]! - centre[k]!);
    }
  }
  const result = { positions, indices: new Uint32Array(mesh.indices) };
  return { ...result, normals: computeNormals(result) };
}

type Quadric = Float64Array;
function quadricValue(q: Quadric, p: Vec3): number {
  const v = [...p, 1]; let s = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s += v[i]! * q[4 * i + j]! * v[j]!;
  return Math.max(0, s);
}
function optimum(q: Quadric): Vec3 | null {
  const a = [q[0]!, q[1]!, q[2]!], b = [q[4]!, q[5]!, q[6]!], c = [q[8]!, q[9]!, q[10]!];
  const det = dot(a, cross(b, c)); if (Math.abs(det) < 1e-12) return null;
  const rhs = [-q[3]!, -q[7]!, -q[11]!];
  // A rows -> inverse columns.
  const bc = cross(b, c), ca = cross(c, a), ab = cross(a, b);
  return [0, 1, 2].map(k => (rhs[0]! * bc[k]! + rhs[1]! * ca[k]! + rhs[2]! * ab[k]!) / det) as Vec3;
}

/** Quadric edge collapse, with link-condition, boundary, normal and duplicate-face guards. */
export function reduceMesh(mesh: TriangleMesh, options: ReduceOptions = {}): TriangleMesh {
  validateMesh(mesh);
  const ratio = options.targetRatio ?? 0.5, tolerance = options.tolerance ?? Infinity;
  const featureAngle = options.featureAngle ?? 70, maxRounds = options.iterations ?? 100;
  if (!(ratio > 0 && ratio <= 1) || !(tolerance >= 0) || !(featureAngle >= 0 && featureAngle <= 180) || !Number.isSafeInteger(maxRounds) || maxRounds < 1) throw new Error('减面参数无效。');
  let working = { positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) } as TriangleMesh;
  const target = Math.max(4, Math.ceil(mesh.indices.length / 3 * ratio));
  const initial = mesh.indices.length / 3;
  const accumulated: Quadric[] = Array.from({ length: mesh.positions.length / 3 }, () => new Float64Array(16));
  // Plane quadrics are accumulated once and carried across collapses, retaining original error.
  for (let f = 0; f < mesh.indices.length; f += 3) {
    const ids = [...mesh.indices.subarray(f, f + 3)], a = point(mesh.positions, ids[0]!);
    let n = cross(sub(point(mesh.positions, ids[1]!), a), sub(point(mesh.positions, ids[2]!), a));
    const len = length(n); if (!len) continue; n = n.map(v => v / len) as Vec3;
    const plane = [...n, -dot(n, a)];
    for (const id of ids) for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) accumulated[id]![4 * i + j] += plane[i]! * plane[j]!;
  }
  for (let round = 0; round < maxRounds && working.indices.length / 3 > target; round++) {
    checkCancel(options);
    const topology = meshTopology(working), boundary = new Set<number>(), protectedVertices = new Set<number>();
    const faceNormals = Array.from({ length: working.indices.length / 3 }, (_, f) => {
      const a = point(working.positions, working.indices[3 * f]!);
      const n = cross(sub(point(working.positions, working.indices[3 * f + 1]!), a), sub(point(working.positions, working.indices[3 * f + 2]!), a));
      const l = length(n); return l ? n.map(v => v / l) as Vec3 : [0, 0, 0] as Vec3;
    });
    for (const e of topology.edges.values()) {
      if (e.faces.length !== 2) { boundary.add(e.a); boundary.add(e.b); }
      else if (dot(faceNormals[e.faces[0]!]!, faceNormals[e.faces[1]!]!) < Math.cos(featureAngle * Math.PI / 180)) { protectedVertices.add(e.a); protectedVertices.add(e.b); }
    }
    const candidates: { a: number; b: number; p: Vec3; error: number; q: Quadric }[] = [];
    for (const e of topology.edges.values()) {
      if (e.faces.length > 2) continue;
      const touchesBoundary = boundary.has(e.a) || boundary.has(e.b);
      if (touchesBoundary && ((options.preserveBoundary ?? true) || e.faces.length !== 1 || !boundary.has(e.a) || !boundary.has(e.b))) continue;
      if (protectedVertices.has(e.a) || protectedVertices.has(e.b)) continue;
      const q = accumulated[e.a]!.map((v, i) => v + accumulated[e.b]![i]!);
      const a = point(working.positions, e.a), b = point(working.positions, e.b);
      const choices = [a, b, a.map((v, k) => (v + b[k]!) / 2) as Vec3];
      const o = optimum(q); if (o && o.every(Number.isFinite)) choices.push(o);
      choices.sort((x, y) => quadricValue(q, x) - quadricValue(q, y));
      // All subsequent guards must inspect the coordinates that will actually be stored.
      // A double-precision optimum can become collinear only after Float32 quantisation.
      const p = choices[0]!.map(Math.fround) as Vec3;
      if (length(sub(p, a)) > tolerance || length(sub(p, b)) > tolerance) continue;
      candidates.push({ a: e.a, b: e.b, p, q, error: quadricValue(q, p) });
    }
    candidates.sort((a, b) => a.error - b.error);
    const removed = new Set<number>(), moved = new Set<number>(), replacements = new Map<number, number>();
    let count = working.indices.length / 3;
    for (const c of candidates) {
      if (count <= target) break;
      const ring = new Set([c.a, c.b, ...topology.neighbours[c.a]!, ...topology.neighbours[c.b]!]);
      if ([...ring].some(v => moved.has(v))) continue;
      const common = [...topology.neighbours[c.a]!].filter(v => topology.neighbours[c.b]!.has(v));
      const incident = topology.edges.get(edgeKey(c.a, c.b))!.faces;
      const opposite = new Set(incident.flatMap(f => [...working.indices.subarray(3 * f, 3 * f + 3)].filter(v => v !== c.a && v !== c.b)));
      if (common.length !== opposite.size || common.some(v => !opposite.has(v))) continue;
      const touched = new Set([...topology.vertexFaces[c.a]!, ...topology.vertexFaces[c.b]!]);
      let valid = true;
      const replacementFaces = new Set<string>();
      for (const f of touched) {
        if (incident.includes(f)) continue;
        const ids = [...working.indices.subarray(3 * f, 3 * f + 3)].map(v => v === c.b ? c.a : v);
        const p = ids.map(v => v === c.a ? c.p : point(working.positions, v));
        const nn = cross(sub(p[1]!, p[0]!), sub(p[2]!, p[0]!)), nnLength = length(nn);
        const key = [...ids].sort((a, b) => a - b).join(',');
        if (nnLength < 1e-12 || dot(nn, faceNormals[f]!) / nnLength < 0.1 || replacementFaces.has(key)) { valid = false; break; }
        replacementFaces.add(key);
        const old = point(working.positions, working.indices[3 * f]!);
        if (Math.abs(dot(sub(c.p, old), faceNormals[f]!)) > tolerance) { valid = false; break; }
      }
      // Prevent an entire tetrahedron from folding into a duplicate face.
      if (!valid || replacementFaces.size < 3) continue;
      for (let k = 0; k < 3; k++) working.positions[3 * c.a + k] = c.p[k]!;
      accumulated[c.a] = c.q; replacements.set(c.b, c.a);
      for (const f of incident) removed.add(f);
      for (const v of ring) moved.add(v);
      count -= incident.length;
    }
    if (!removed.size) break;
    const next: number[] = [];
    for (let f = 0; f < working.indices.length / 3; f++) if (!removed.has(f)) for (let k = 0; k < 3; k++) { const v = working.indices[3 * f + k]!; next.push(replacements.get(v) ?? v); }
    working.indices = new Uint32Array(next);
    options.progress?.((initial - count) / Math.max(1, initial - target));
  }
  const result = compactMesh(working);
  result.normals = computeNormals(result); return result;
}

function compactMesh(mesh: TriangleMesh): TriangleMesh {
  const remap = new Map<number, number>(), p: number[] = [], ids: number[] = [];
  for (const id of mesh.indices) {
    let next = remap.get(id);
    if (next === undefined) { next = p.length / 3; remap.set(id, next); p.push(...point(mesh.positions, id)); }
    ids.push(next);
  }
  return { positions: new Float32Array(p), indices: new Uint32Array(ids) };
}

/** Independent slice scanline voxelizer. Positions are converted through the full inverse affine. */
export function maskFromMesh(grid: VolumeGrid, mesh: TriangleMesh, control: AlgorithmControl = {}): BinaryMask {
  const n = requireGrid(grid); validateAffine(grid); validateMesh(mesh);
  const stats = meshStats(mesh);
  if (mesh.indices.length && (!stats.closed || stats.signedVolume === 0)) throw new Error('体素化需要闭合、方向一致且非退化的网格。');
  const mask = new Uint8Array(n);
  const vp = new Float64Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length / 3; i++) vp.set(inversePoint(point(mesh.positions, i), grid), 3 * i);
  const rows: { a: Vec3; b: Vec3; c: Vec3 }[][] = Array.from({ length: grid.dims[2] }, () => []);
  for (let f = 0; f < mesh.indices.length; f += 3) {
    const [a, b, c] = [mesh.indices[f]!, mesh.indices[f + 1]!, mesh.indices[f + 2]!].map(i => point(vp, i));
    const z0 = Math.max(0, Math.ceil(Math.min(a![2], b![2], c![2]) - 1e-7));
    const z1 = Math.min(grid.dims[2] - 1, Math.floor(Math.max(a![2], b![2], c![2]) + 1e-7));
    for (let z = z0; z <= z1; z++) rows[z]!.push({ a: a!, b: b!, c: c! });
  }
  // Irrational tiny offset avoids shared-edge/vertex rays without changing voxel-centre classification.
  for (let z = 0; z < grid.dims[2]; z++) {
    checkCancel(control);
    for (let y = 0; y < grid.dims[1]; y++) {
      const rayY = y + 1.234567e-7, rayZ = z + 7.654321e-8, xs: number[] = [];
      for (const { a, b, c } of rows[z]!) {
        const by = b[1] - a[1], bz = b[2] - a[2], cy = c[1] - a[1], cz = c[2] - a[2];
        const det = by * cz - bz * cy;
        if (Math.abs(det) < 1e-14) continue;
        const dy = rayY - a[1], dz = rayZ - a[2];
        const u = (dy * cz - dz * cy) / det, v = (by * dz - bz * dy) / det;
        if (u >= 0 && v >= 0 && u + v <= 1) xs.push(a[0] + u * (b[0] - a[0]) + v * (c[0] - a[0]));
      }
      xs.sort((a, b) => a - b);
      // Intersections coinciding at one geometric crossing count once.
      const unique = xs.filter((x, i) => !i || Math.abs(x - xs[i - 1]!) > 1e-8);
      if (unique.length % 2) throw new Error('网格截面交点不成对，可能自交或几何精度不足。');
      for (let i = 0; i + 1 < unique.length; i += 2) {
        const first = Math.max(0, Math.ceil(unique[i]! - 1e-8)), last = Math.min(grid.dims[0] - 1, Math.floor(unique[i + 1]! + 1e-8));
        for (let x = first; x <= last; x++) mask[voxelIndex([x, y, z], grid.dims)] = 1;
      }
    }
    control.progress?.((z + 1) / grid.dims[2]);
  }
  return mask;
}

function morphPhysical(mask: Uint8Array, dims: Vec3, radius: number, spacing: number, dilate: boolean, control: AlgorithmControl): Uint8Array {
  if (radius <= 0) return mask.slice();
  const r = Math.ceil(radius / spacing), offsets: Vec3[] = [];
  for (let z = -r; z <= r; z++) for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if ((x * x + y * y + z * z) * spacing * spacing <= radius * radius + 1e-12) offsets.push([x, y, z]);
  if (offsets.length * mask.length > 4e8) throw new Error('Wrap 当前体素分辨率和偏移量计算量过大，请增大分辨率。');
  const out = new Uint8Array(mask.length);
  for (let z = 0; z < dims[2]; z++) {
    checkCancel(control);
    for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
      let value = dilate ? 0 : 1;
      for (const o of offsets) {
        const p = [x + o[0], y + o[1], z + o[2]];
        const inside = p.every((v, k) => v >= 0 && v < dims[k]!);
        const hit = inside ? mask[voxelIndex(p, dims)]! : 0;
        if (dilate ? hit : !hit) { value = dilate ? 1 : 0; break; }
      }
      out[voxelIndex([x, y, z], dims)] = value;
    }
  }
  return out;
}

/** Voxel closing/offset + MC. Inspired by the documented image-offset chain; independently implemented. */
export function wrapMesh(mesh: TriangleMesh, options: WrapOptions = {}): TriangleMesh {
  const stats = meshStats(mesh);
  if (!stats.closed) throw new Error('当前独立 Wrap 需要闭合输入网格。');
  const resolution = options.resolution ?? Math.max(...stats.bounds.size) / 48;
  const distance = options.closingDistance ?? resolution * 2, dilation = options.dilate ?? 0;
  if (!(resolution > 0) || !Number.isFinite(resolution) || !(distance >= 0) || !Number.isFinite(distance) || !Number.isFinite(dilation)) throw new Error('Wrap 分辨率或偏移参数无效。');
  const padding = Math.ceil((distance + Math.abs(dilation)) / resolution) + 3;
  const dims = stats.bounds.size.map(s => Math.ceil(s / resolution) + 2 * padding + 1) as Vec3;
  const count = dims[0] * dims[1] * dims[2];
  if (count > (options.maxVoxels ?? 2_000_000)) throw new Error('Wrap 体素数量超过当前内存限制，请增大分辨率。');
  const origin = stats.bounds.min.map(v => v - padding * resolution);
  const grid: VolumeGrid = { dims, spacing: [resolution, resolution, resolution], data: new Float32Array(count), affine: [[resolution, 0, 0, origin[0]!], [0, resolution, 0, origin[1]!], [0, 0, resolution, origin[2]!], [0, 0, 0, 1]] };
  const original = maskFromMesh(grid, mesh, options);
  const radius = distance / 2;
  let out = morphPhysical(original, dims, radius, resolution, true, options);
  out = morphPhysical(out, dims, radius, resolution, false, options);
  if (options.protectThinWalls) for (let i = 0; i < count; i++) out[i] ||= original[i]!;
  if (dilation) out = morphPhysical(out, dims, Math.abs(dilation), resolution, dilation > 0, options);
  return calculateSurface(grid, out, { ...options, quality: 'custom' });
}

export interface STLOptions { binary?: boolean; name?: string }
function facet(mesh: TriangleMesh, f: number): { vertices: Vec3[]; normal: Vec3 } {
  const vertices = [0, 1, 2].map(k => point(mesh.positions, mesh.indices[3 * f + k]!));
  const n = cross(sub(vertices[1]!, vertices[0]!), sub(vertices[2]!, vertices[0]!)), l = length(n);
  if (l <= 1e-14) throw new Error('STL 无法写入退化三角形。');
  return { vertices, normal: n.map(v => v / l) as Vec3 };
}
export function exportSTL(mesh: TriangleMesh, options: STLOptions & { binary: false }): string;
export function exportSTL(mesh: TriangleMesh, options?: STLOptions): Uint8Array | string;
export function exportSTL(mesh: TriangleMesh, options: STLOptions = {}): Uint8Array | string {
  validateMesh(mesh);
  const name = (options.name ?? 'mimics-vue-surface').replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 70), count = mesh.indices.length / 3;
  if (options.binary !== false) {
    if (count > 0xffffffff) throw new Error('STL 三角形数量超过格式上限。');
    const bytes = new Uint8Array(84 + count * 50), view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode(name).subarray(0, 80)); view.setUint32(80, count, true);
    for (let f = 0; f < count; f++) {
      const { normal, vertices } = facet(mesh, f), values = [...normal, ...vertices.flat()];
      values.forEach((v, k) => view.setFloat32(84 + 50 * f + k * 4, v, true));
      view.setUint16(84 + 50 * f + 48, 0, true);
    }
    return bytes;
  }
  const lines = [`solid ${name}`];
  for (let f = 0; f < count; f++) {
    const { normal, vertices } = facet(mesh, f);
    lines.push(`  facet normal ${normal.join(' ')}`, '    outer loop', ...vertices.map(v => `      vertex ${v.join(' ')}`), '    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`); return lines.join('\n') + '\n';
}

/** Strict standard STL parser. Binary files whose header starts 'solid' remain binary. */
export function parseSTL(input: ArrayBuffer | Uint8Array | string): TriangleMesh {
  const positions: number[] = [], indices: number[] = [], vertices = new Map<string, number>();
  const add = (tri: number[]) => {
    if (tri.length !== 9 || tri.some(v => !Number.isFinite(v))) throw new Error('STL 含无效或非有限顶点。');
    const a = tri.slice(0, 3), b = tri.slice(3, 6), c = tri.slice(6, 9);
    if (length(cross(sub(b, a), sub(c, a))) <= 1e-14) throw new Error('STL 含退化三角形。');
    for (let k = 0; k < 9; k += 3) {
      const p = tri.slice(k, k + 3).map(v => Object.is(v, -0) ? 0 : v), key = p.join(',');
      let id = vertices.get(key); if (id === undefined) { id = positions.length / 3; vertices.set(key, id); positions.push(...p); } indices.push(id);
    }
  };
  let ascii: string | undefined = typeof input === 'string' ? input : undefined;
  if (ascii === undefined) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input as ArrayBuffer);
    if (bytes.length >= 84) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint32(80, true);
      if (84 + count * 50 === bytes.length) {
        for (let f = 0; f < count; f++) {
          const normal = [0, 1, 2].map(k => view.getFloat32(84 + 50 * f + 4 * k, true));
          if (normal.some(v => !Number.isFinite(v))) throw new Error('STL 含无效法线。');
          add(Array.from({ length: 9 }, (_, k) => view.getFloat32(84 + 50 * f + 12 + 4 * k, true)));
        }
      } else if (!/^\s*solid\b/i.test(new TextDecoder().decode(bytes.subarray(0, 80)))) throw new Error('二进制 STL 长度与三角形计数不一致。');
      else ascii = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } else ascii = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  if (ascii !== undefined) {
    const tokens = ascii.trim().split(/\s+/); let cursor = 0;
    const expect = (word: string) => { if (tokens[cursor++]?.toLowerCase() !== word) throw new Error(`ASCII STL 缺少 ${word}。`); };
    expect('solid'); while (cursor < tokens.length && !['facet', 'endsolid'].includes(tokens[cursor]!.toLowerCase())) cursor++;
    while (tokens[cursor]?.toLowerCase() === 'facet') {
      expect('facet'); expect('normal');
      for (let k = 0; k < 3; k++) if (!Number.isFinite(Number(tokens[cursor++]))) throw new Error('ASCII STL 法线无效。');
      expect('outer'); expect('loop'); const tri: number[] = [];
      for (let i = 0; i < 3; i++) { expect('vertex'); for (let k = 0; k < 3; k++) { const t = tokens[cursor++]; if (!t) throw new Error('ASCII STL 顶点不完整。'); tri.push(Number(t)); } }
      expect('endloop'); expect('endfacet'); add(tri);
    }
    expect('endsolid');
    // The remaining tokens are the optional solid name, never more facets.
    if (tokens.slice(cursor).some(t => ['facet', 'vertex', 'solid', 'endsolid'].includes(t.toLowerCase()))) throw new Error('ASCII STL 结束标记后存在多余几何记录。');
  }
  const mesh: TriangleMesh = { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  mesh.normals = computeNormals(mesh); return mesh;
}
