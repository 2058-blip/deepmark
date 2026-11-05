import { computeNormals, meshStats, validateMesh, type MeshStats } from './geometry.ts';
import type { AlgorithmControl, TriangleMesh, Vec3 } from './types.ts';

export interface Plane { origin: Vec3; normal: Vec3 }
export interface CutOptions extends AlgorithmControl { cap?: boolean; epsilon?: number }
export interface CutResult {
  positive: TriangleMesh;
  negative: TriangleMesh;
  /** Closed contours repeat their first point at the end. */
  contours: Vec3[][];
  openContours: Vec3[][];
  capped: boolean;
  intersects: boolean;
}
export interface ComponentOptions extends AlgorithmControl { connectivity?: 'edge' | 'vertex' }
export interface SurfacePathOptions extends AlgorithmControl { maxProjectionDistance?: number }
export interface SurfacePathResult {
  points: Vec3[];
  length: number;
  projectedPoints: Vec3[];
  projectionDistances: number[];
  method: 'edge-graph';
  approximate: true;
  /** Straight distances between projected via points are lower bounds on surface length. */
  chordLowerBound: number;
}
export interface StitchOptions extends AlgorithmControl { tolerance?: number; boundaryOnly?: boolean; orient?: boolean }
export interface MergeOptions extends AlgorithmControl { weldTolerance?: number }
export interface FixNormalsOptions extends AlgorithmControl { outward?: boolean; preserveCavities?: boolean }
export interface MeshDiagnostics extends MeshStats {
  boundaryLoops: Vec3[][];
  openBoundaryChains: Vec3[][];
  branchBoundaryVertices: number[];
  selfIntersections: 'not-checked';
}
const minus = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const norm = (a: ArrayLike<number>) => Math.hypot(a[0]!, a[1]!, a[2]!);
const vertex = (p: ArrayLike<number>, i: number): Vec3 => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
const edgeKey = (a: number, b: number) => a < b ? `${a},${b}` : `${b},${a}`;
const cancelled = (control: AlgorithmControl) => { if (control.cancelled?.()) throw new Error('操作已取消。'); };
function finish(positions: number[] | Float32Array, indices: number[] | Uint32Array): TriangleMesh {
  const mesh = { positions: new Float32Array(positions), indices: new Uint32Array(indices) }; return { ...mesh, normals: computeNormals(mesh) };
}
function compact(mesh: TriangleMesh, faces?: readonly number[]): TriangleMesh {
  const map = new Map<number, number>(), positions: number[] = [], indices: number[] = [];
  const source = faces ? faces.flatMap(f => [...mesh.indices.subarray(f * 3, f * 3 + 3)]) : [...mesh.indices];
  for (const i of source) { let j = map.get(i); if (j === undefined) { j = positions.length / 3; map.set(i, j); positions.push(...vertex(mesh.positions, i)); } indices.push(j); }
  return finish(positions, indices);
}
interface Edge { a: number; b: number; faces: number[]; directions: number[] }
function topology(mesh: TriangleMesh, control: AlgorithmControl = {}) {
  const edges = new Map<string, Edge>(), atVertex = Array.from({ length: mesh.positions.length / 3 }, () => [] as number[]);
  for (let f = 0; f < mesh.indices.length / 3; f++) {
    if (f % 4096 === 0) cancelled(control);
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[3 * f + k]!, b = mesh.indices[3 * f + (k + 1) % 3]!, key = edgeKey(a, b);
      const edge = edges.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), faces: [], directions: [] };
      edge.faces.push(f); edge.directions.push(a < b ? 1 : -1); edges.set(key, edge); atVertex[a]!.push(f);
    }
  }
  return { edges, atVertex };
}
function faceGroups(mesh: TriangleMesh, options: ComponentOptions = {}): number[][] {
  const t = topology(mesh, options), adjacent = Array.from({ length: mesh.indices.length / 3 }, () => new Set<number>());
  const lists = options.connectivity === 'vertex' ? t.atVertex : [...t.edges.values()].map(e => e.faces);
  // A star has the same connected components as a clique and avoids quadratic cost at
  // a high-valence vertex or an already nonmanifold shared edge.
  for (const list of lists) for (let i = 1; i < list.length; i++) { adjacent[list[0]!]!.add(list[i]!); adjacent[list[i]!]!.add(list[0]!); }
  const visited = new Uint8Array(adjacent.length), groups: number[][] = [];
  for (let seed = 0; seed < adjacent.length; seed++) {
    if (visited[seed]) continue; cancelled(options);
    const queue = [seed]; visited[seed] = 1;
    for (let i = 0; i < queue.length; i++) { if (i % 4096 === 0) cancelled(options); for (const next of adjacent[queue[i]!]!) if (!visited[next]) { visited[next] = 1; queue.push(next); } }
    groups.push(queue);
  }
  return groups.sort((a, b) => b.length - a.length);
}
/** Split by shared topological edges by default; touching at only a point remains two shells. */
export function splitConnectedComponents(mesh: TriangleMesh, options: ComponentOptions = {}): TriangleMesh[] {
  validateMesh(mesh); cancelled(options);
  const groups = faceGroups(mesh, options);
  return groups.map((faces, i) => { cancelled(options); options.progress?.((i + 1) / groups.length); return compact(mesh, faces); });
}

interface TracedBoundary { loops: number[][]; chains: number[][]; branches: number[] }
function traceEdges(edges: readonly { a: number; b: number }[]): TracedBoundary {
  const at = new Map<number, number[]>(), used = new Uint8Array(edges.length), loops: number[][] = [], chains: number[][] = [];
  edges.forEach((e, i) => { at.set(e.a, [...at.get(e.a) ?? [], i]); at.set(e.b, [...at.get(e.b) ?? [], i]); });
  const branches = [...at].filter(([, e]) => e.length > 2).map(([v]) => v);
  const walk = (start: number, edge: number) => {
    const points = [start]; let current = start, nextEdge = edge;
    while (!used[nextEdge]) {
      used[nextEdge] = 1; const e = edges[nextEdge]!; current = e.a === current ? e.b : e.a; points.push(current);
      if (current === start || at.get(current)!.length !== 2) break;
      const next = at.get(current)!.find(i => !used[i]); if (next === undefined) break; nextEdge = next;
    }
    (points.length > 3 && points[0] === points[points.length - 1] ? loops : chains).push(points);
  };
  for (const [start, links] of at) if (links.length !== 2) for (const e of links) if (!used[e]) walk(start, e);
  for (let e = 0; e < edges.length; e++) if (!used[e]) walk(edges[e]!.a, e);
  return { loops, chains, branches };
}
export function diagnoseMesh(mesh: TriangleMesh, control: AlgorithmControl = {}): MeshDiagnostics {
  validateMesh(mesh); cancelled(control);
  const edges = [...topology(mesh, control).edges.values()].filter(e => e.faces.length === 1), traced = traceEdges(edges);
  return { ...meshStats(mesh), boundaryLoops: traced.loops.map(loop => loop.map(i => vertex(mesh.positions, i))), openBoundaryChains: traced.chains.map(chain => chain.map(i => vertex(mesh.positions, i))), branchBoundaryVertices: traced.branches, selfIntersections: 'not-checked' };
}

interface CutVertex { key: string; p: Vec3; distance: number }
class CutBuilder {
  positions: number[] = [];
  indices: number[] = [];
  refs: CutVertex[] = [];
  lookup = new Map<string, number>();
  index(ref: CutVertex): number {
    let id = this.lookup.get(ref.key); if (id === undefined) { id = this.positions.length / 3; this.lookup.set(ref.key, id); this.positions.push(...ref.p); this.refs.push(ref); } return id;
  }
  polygon(refs: CutVertex[]): void {
    const points = refs.filter((p, i) => p.key !== refs[(i + refs.length - 1) % refs.length]?.key);
    if (points.length < 3) return;
    for (let i = 1; i + 1 < points.length; i++) {
      const a = points[0]!, b = points[i]!, c = points[i + 1]!;
      if (norm(cross(minus(b.p, a.p), minus(c.p, a.p))) <= 1e-14) throw new Error('切割生成无法可靠存储的退化三角形，请调整平面或容差。');
      this.indices.push(this.index(a), this.index(b), this.index(c));
    }
  }
  mesh(): TriangleMesh { return finish(this.positions, this.indices); }
}
type P2 = [number, number];
const orient2 = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function area2(loop: number[], points: P2[]): number { return loop.reduce((s, id, i) => { const a = points[id]!, b = points[loop[(i + 1) % loop.length]!]!; return s + a[0] * b[1] - b[0] * a[1]; }, 0); }
function contains2(p: P2, loop: number[], points: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) { const a = points[loop[i]!]!, b = points[loop[j]!]!; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; }
  return inside;
}
function same2(a: P2, b: P2, eps: number) { return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps; }
function intersects2(a: P2, b: P2, c: P2, d: P2, eps: number): boolean {
  if (same2(a, c, eps) || same2(a, d, eps) || same2(b, c, eps) || same2(b, d, eps)) return false;
  const abC = orient2(a, b, c), abD = orient2(a, b, d), cdA = orient2(c, d, a), cdB = orient2(c, d, b);
  if (abC * abD < -eps * eps && cdA * cdB < -eps * eps) return true;
  const on = (p: P2, q: P2, r: P2) => Math.abs(orient2(p, q, r)) <= eps && r[0] >= Math.min(p[0], q[0]) - eps && r[0] <= Math.max(p[0], q[0]) + eps && r[1] >= Math.min(p[1], q[1]) - eps && r[1] <= Math.max(p[1], q[1]) + eps;
  return on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}
function triangulateRings(loops: number[][], points: P2[], eps: number, control: AlgorithmControl): number[][] {
  const rings = loops.map(loop => loop.slice(0, -1));
  const absArea = rings.map(loop => Math.abs(area2(loop, points)));
  const depth = rings.map((loop, i) => rings.filter((other, j) => i !== j && absArea[j]! > absArea[i]! && contains2(points[loop[0]!]!, other, points)).length);
  const triangles: number[][] = [];
  for (let outerIndex = 0; outerIndex < rings.length; outerIndex++) {
    if (depth[outerIndex]! % 2) continue; cancelled(control);
    let polygon = [...rings[outerIndex]!]; if (area2(polygon, points) < 0) polygon.reverse();
    const holes = rings.filter((loop, j) => depth[j] === depth[outerIndex]! + 1 && contains2(points[loop[0]!]!, rings[outerIndex]!, points)).map(loop => area2(loop, points) > 0 ? [...loop].reverse() : [...loop]);
    holes.sort((a, b) => Math.max(...b.map(i => points[i]![0])) - Math.max(...a.map(i => points[i]![0])));
    for (const hole of holes) {
      let hi = 0; for (let i = 1; i < hole.length; i++) if (points[hole[i]!]![0] > points[hole[hi]!]![0]) hi = i;
      const h = hole[hi]!, hp = points[h]!;
      let best = -1, distance = Infinity;
      const boundaries = [polygon, ...holes];
      for (let pi = 0; pi < polygon.length; pi++) {
        const p = polygon[pi]!, pp = points[p]!, middle: P2 = [(hp[0] + pp[0]) / 2, (hp[1] + pp[1]) / 2];
        if (!contains2(middle, rings[outerIndex]!, points) || holes.some(loop => contains2(middle, loop, points))) continue;
        if (boundaries.some(loop => loop.some((id, i) => intersects2(hp, pp, points[id]!, points[loop[(i + 1) % loop.length]!]!, eps)))) continue;
        const d = (hp[0] - pp[0]) ** 2 + (hp[1] - pp[1]) ** 2;
        if (d < distance) { distance = d; best = pi; }
      }
      if (best < 0) throw new Error('切面孔洞无法建立无交叉桥接，未生成不可靠封面。');
      const around = [...hole.slice(hi), ...hole.slice(0, hi), h];
      polygon = [...polygon.slice(0, best + 1), ...around, polygon[best]!, ...polygon.slice(best + 1)];
    }
    while (polygon.length > 3) {
      cancelled(control); let ear = -1;
      for (let i = 0; i < polygon.length; i++) {
        const ia = polygon[(i + polygon.length - 1) % polygon.length]!, ib = polygon[i]!, ic = polygon[(i + 1) % polygon.length]!;
        const a = points[ia]!, b = points[ib]!, c = points[ic]!;
        if (orient2(a, b, c) <= eps * eps) continue;
        if (polygon.some(id => { const p = points[id]!; if (same2(p, a, eps) || same2(p, b, eps) || same2(p, c, eps)) return false; return orient2(a, b, p) >= -eps * eps && orient2(b, c, p) >= -eps * eps && orient2(c, a, p) >= -eps * eps; })) continue;
        if (polygon.some((id, k) => intersects2(a, c, points[id]!, points[polygon[(k + 1) % polygon.length]!]!, eps * eps))) continue;
        ear = i; triangles.push([ia, ib, ic]); break;
      }
      if (ear < 0) throw new Error('切面轮廓退化、自交或数值不稳定，无法可靠三角化。');
      polygon.splice(ear, 1);
    }
    if (polygon.length === 3) {
      if (orient2(points[polygon[0]!]!, points[polygon[1]!]!, points[polygon[2]!]!) <= eps * eps) throw new Error('切面末端三角形退化，未提交切割。');
      triangles.push([...polygon]);
    }
  }
  return triangles;
}

/** Triangle-plane clipping with shared original-edge intersections and planar caps with holes. */
export function cutMeshByPlane(mesh: TriangleMesh, plane: Plane, options: CutOptions = {}): CutResult {
  validateMesh(mesh); cancelled(options);
  if (![...plane.origin, ...plane.normal].every(Number.isFinite) || norm(plane.normal) < 1e-15) throw new Error('切割平面原点或法向无效。');
  const n = plane.normal.map(x => x / norm(plane.normal)) as Vec3, stats = meshStats(mesh);
  const epsilon = options.epsilon ?? Math.max(1e-8, norm(stats.bounds.size) * 1e-8);
  if (!(epsilon > 0) || !Number.isFinite(epsilon)) throw new Error('切割容差必须为有限正数。');
  if (stats.degenerateTriangles || stats.nonManifoldEdges || stats.nonManifoldVertices) throw new Error('切割输入含退化或非流形结构，请先诊断。');
  const refs = Array.from({ length: mesh.positions.length / 3 }, (_, id): CutVertex => {
    let p = vertex(mesh.positions, id), distance = dot(minus(p, plane.origin), n);
    if (Math.abs(distance) <= epsilon) { p = p.map((v, k) => Math.fround(v - distance * n[k]!)) as Vec3; distance = 0; }
    return { key: `v${id}`, p, distance };
  });
  const intersection = new Map<string, CutVertex>();
  const edgeIntersection = (a: CutVertex, b: CutVertex): CutVertex => {
    if (a.distance === 0) return a; if (b.distance === 0) return b;
    const key = a.key < b.key ? `${a.key}:${b.key}` : `${b.key}:${a.key}`;
    let ref = intersection.get(key);
    if (!ref) { const t = a.distance / (a.distance - b.distance); ref = { key, p: a.p.map((v, k) => Math.fround(v + t * (b.p[k]! - v))) as Vec3, distance: 0 }; intersection.set(key, ref); }
    return ref;
  };
  const positive = new CutBuilder(), negative = new CutBuilder();
  for (let f = 0; f < mesh.indices.length / 3; f++) {
    if (f % 2048 === 0) { cancelled(options); options.progress?.(0.6 * f / Math.max(1, stats.triangles)); }
    const tri = [0, 1, 2].map(k => refs[mesh.indices[3 * f + k]!]!);
    if (tri.every(v => v.distance === 0)) {
      const normal = cross(minus(tri[1]!.p, tri[0]!.p), minus(tri[2]!.p, tri[0]!.p));
      (dot(normal, n) >= 0 ? negative : positive).polygon(tri); continue;
    }
    for (const side of [1, -1]) {
      const polygon: CutVertex[] = [];
      for (let k = 0; k < 3; k++) {
        const a = tri[(k + 2) % 3]!, b = tri[k]!, insideA = a.distance * side >= 0, insideB = b.distance * side >= 0;
        if (insideA !== insideB) polygon.push(edgeIntersection(a, b));
        if (insideB) polygon.push(b);
      }
      (side > 0 ? positive : negative).polygon(polygon);
    }
  }
  const capSide = (builder: CutBuilder, outward: number): TracedBoundary => {
    const temp: TriangleMesh = { positions: new Float32Array(builder.positions), indices: new Uint32Array(builder.indices) };
    const cutEdges = [...topology(temp, options).edges.values()].filter(e => e.faces.length === 1 && builder.refs[e.a]!.distance === 0 && builder.refs[e.b]!.distance === 0);
    const traced = traceEdges(cutEdges);
    if ((options.cap ?? true) && cutEdges.length) {
      if (!stats.closed) throw new Error('封切面目前要求闭合且方向一致的输入；可关闭 cap 保留开放裁切。');
      if (traced.chains.length || traced.branches.length) throw new Error('切面轮廓开放或分叉，无法可靠封闭。');
      const helper: Vec3 = Math.abs(n[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
      const rawU = cross(helper, n), u = rawU.map(x => x / norm(rawU)) as Vec3, v = cross(n, u);
      const points = builder.refs.map(ref => { const p = minus(ref.p, plane.origin); return [dot(p, u), dot(p, v)] as P2; });
      for (const tri of triangulateRings(traced.loops, points, epsilon, options)) {
        if (outward > 0) builder.indices.push(...tri); else builder.indices.push(tri[0]!, tri[2]!, tri[1]!);
      }
    }
    return traced;
  };
  const a = capSide(positive, -1), b = capSide(negative, 1);
  const primary = a.loops.length || a.chains.length ? { traced: a, builder: positive } : { traced: b, builder: negative };
  const result: CutResult = { positive: positive.mesh(), negative: negative.mesh(), contours: primary.traced.loops.map(loop => loop.map(i => [...primary.builder.refs[i]!.p] as Vec3)), openContours: primary.traced.chains.map(loop => loop.map(i => [...primary.builder.refs[i]!.p] as Vec3)), capped: !!(options.cap ?? true) && !!(a.loops.length || b.loops.length), intersects: !!(a.loops.length || a.chains.length || b.loops.length || b.chains.length) };
  if (result.capped) for (const part of [result.positive, result.negative]) if (part.indices.length && !meshStats(part).closed) throw new Error('封切面后的拓扑验证失败，未提交不完整结果。');
  options.progress?.(1); return result;
}

/** Closest point in all seven Voronoi regions of a nondegenerate triangle. */
function closestTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = minus(b, a), ac = minus(c, a), ap = minus(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [...a];
  const bp = minus(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return [...b];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); return a.map((v, k) => v + t * ab[k]!) as Vec3; }
  const cp = minus(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return [...c];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); return a.map((v, k) => v + t * ac[k]!) as Vec3; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / (d4 - d3 + d5 - d6); return b.map((v, k) => v + t * (c[k]! - v)) as Vec3; }
  const inverse = 1 / (va + vb + vc), v = vb * inverse, w = vc * inverse;
  return a.map((n, k) => n + ab[k]! * v + ac[k]! * w) as Vec3;
}
class MinHeap {
  data: [number, number][] = [];
  push(value: [number, number]) { let i = this.data.length; this.data.push(value); while (i > 0) { const parent = (i - 1) >> 1; if (this.data[parent]![0] <= value[0]) break; this.data[i] = this.data[parent]!; i = parent; } this.data[i] = value; }
  pop(): [number, number] | undefined {
    if (!this.data.length) return undefined; const result = this.data[0]!, tail = this.data.pop()!;
    if (this.data.length) { let i = 0; while (i * 2 + 1 < this.data.length) { let child = 2 * i + 1; if (child + 1 < this.data.length && this.data[child + 1]![0] < this.data[child]![0]) child++; if (tail[0] <= this.data[child]![0]) break; this.data[i] = this.data[child]!; i = child; } this.data[i] = tail; }
    return result;
  }
}
/** Face projection plus Dijkstra on mesh edges and endpoint-to-face-vertex connectors.
 * The route lies on the piecewise-flat surface; it is an edge-graph approximation, not
 * the exact continuous geodesic. Sampling orientation can introduce significant overestimate. */
export function surfacePath(mesh: TriangleMesh, viaPoints: readonly Vec3[], options: SurfacePathOptions = {}): SurfacePathResult {
  validateMesh(mesh); cancelled(options);
  if (viaPoints.length < 2 || viaPoints.some(p => p.length !== 3 || !p.every(Number.isFinite))) throw new Error('曲面路径需要至少两个有效三维点。');
  const maxProjection = options.maxProjectionDistance ?? Infinity;
  if (!(maxProjection >= 0)) throw new Error('最大投影距离无效。');
  const projectedPoints: Vec3[] = [], faces: number[] = [], projectionDistances: number[] = [];
  for (let j = 0; j < viaPoints.length; j++) {
    let nearest = Infinity, projected: Vec3 | undefined, face = -1;
    for (let f = 0; f < mesh.indices.length / 3; f++) {
      if (f % 4096 === 0) cancelled(options);
      const [a, b, c] = [0, 1, 2].map(k => vertex(mesh.positions, mesh.indices[3 * f + k]!));
      if (norm(cross(minus(b!, a!), minus(c!, a!))) <= 1e-14) continue;
      const p = closestTriangle(viaPoints[j]!, a!, b!, c!), d = norm(minus(p, viaPoints[j]!));
      if (d < nearest) { nearest = d; projected = p; face = f; }
    }
    if (!projected || nearest > maxProjection) throw new Error('路径控制点无法在允许距离内投影到有效三角面。');
    projectedPoints.push(projected); faces.push(face); projectionDistances.push(nearest);
    options.progress?.(0.25 * (j + 1) / viaPoints.length);
  }
  const count = mesh.positions.length / 3, points = Array.from({ length: count }, (_, i) => vertex(mesh.positions, i)).concat(projectedPoints);
  const graph = Array.from({ length: points.length }, () => new Map<number, number>());
  const connect = (a: number, b: number) => { const weight = norm(minus(points[a]!, points[b]!)); graph[a]!.set(b, weight); graph[b]!.set(a, weight); };
  for (const edge of topology(mesh, options).edges.values()) connect(edge.a, edge.b);
  faces.forEach((f, j) => { for (let k = 0; k < 3; k++) connect(count + j, mesh.indices[3 * f + k]!); });
  faces.forEach((face, i) => faces.forEach((other, j) => { if (i < j && (face === other || norm(minus(projectedPoints[i]!, projectedPoints[j]!)) < 1e-10)) connect(count + i, count + j); }));
  const route: number[] = []; let chordLowerBound = 0;
  for (let segment = 0; segment + 1 < viaPoints.length; segment++) {
    cancelled(options); const start = count + segment, end = start + 1;
    const distance = new Float64Array(points.length).fill(Infinity), previous = new Int32Array(points.length).fill(-1), heap = new MinHeap();
    distance[start] = 0; heap.push([0, start]); let iterations = 0;
    while (heap.data.length) {
      if (++iterations % 1024 === 0) cancelled(options);
      const [cost, node] = heap.pop()!; if (cost > distance[node]!) continue; if (node === end) break;
      for (const [next, weight] of graph[node]!) if (cost + weight < distance[next]! - 1e-12) { distance[next] = cost + weight; previous[next] = node; heap.push([distance[next]!, next]); }
    }
    if (!Number.isFinite(distance[end])) throw new Error('控制点位于不连通的曲面，无法生成表面路径。');
    const local = [end]; while (local[local.length - 1] !== start) { const next = previous[local[local.length - 1]!]!; if (next < 0) throw new Error('曲面路径回溯失败。'); local.push(next); }
    local.reverse(); route.push(...(segment ? local.slice(1) : local));
    chordLowerBound += norm(minus(projectedPoints[segment + 1]!, projectedPoints[segment]!));
    options.progress?.(0.25 + 0.75 * (segment + 1) / (viaPoints.length - 1));
  }
  const result = route.map(i => [...points[i]!] as Vec3).filter((p, i, all) => !i || norm(minus(p, all[i - 1]!)) > 1e-10);
  return { points: result, length: result.reduce((sum, p, i) => sum + (i ? norm(minus(p, result[i - 1]!)) : 0), 0), projectedPoints: projectedPoints.map(p => [...p]), projectionDistances, chordLowerBound, method: 'edge-graph', approximate: true };
}

/** Concatenate immutable mesh data. This is an assembly merge, not a solid Boolean union. */
export function mergeMeshes(meshes: readonly TriangleMesh[], options: MergeOptions = {}): TriangleMesh {
  const positions: number[] = [], indices: number[] = [];
  meshes.forEach((mesh, j) => { validateMesh(mesh); cancelled(options); const offset = positions.length / 3; for (let i = 0; i < mesh.positions.length; i++) { if (i % 131072 === 0) cancelled(options); positions.push(mesh.positions[i]!); } for (let i = 0; i < mesh.indices.length; i++) { if (i % 131072 === 0) cancelled(options); indices.push(mesh.indices[i]! + offset); } options.progress?.((j + 1) / Math.max(1, meshes.length)); });
  const result = finish(positions, indices);
  return options.weldTolerance === undefined ? result : stitchMesh(result, { ...options, tolerance: options.weldTolerance });
}

function shellVolume(mesh: TriangleMesh, faces: readonly number[], indices: Uint32Array): number {
  const origin = faces.length ? vertex(mesh.positions, indices[3 * faces[0]!]!) : [0, 0, 0] as Vec3;
  let volume = 0; for (const f of faces) { const a = minus(vertex(mesh.positions, indices[3 * f]!), origin), b = minus(vertex(mesh.positions, indices[3 * f + 1]!), origin), c = minus(vertex(mesh.positions, indices[3 * f + 2]!), origin); volume += dot(a, cross(b, c)) / 6; } return volume;
}
function insideShell(p: Vec3, mesh: TriangleMesh, faces: readonly number[], indices: Uint32Array, epsilon: number): boolean {
  const d: Vec3 = [1, 0.3713906763541037, 0.529098123671234], hits: number[] = [];
  for (const f of faces) {
    const a = vertex(mesh.positions, indices[3 * f]!), b = vertex(mesh.positions, indices[3 * f + 1]!), c = vertex(mesh.positions, indices[3 * f + 2]!);
    const e1 = minus(b, a), e2 = minus(c, a), h = cross(d, e2), determinant = dot(e1, h);
    if (Math.abs(determinant) < 1e-14) continue;
    const s = minus(p, a), u = dot(s, h) / determinant; if (u < -1e-10 || u > 1 + 1e-10) continue;
    const q = cross(s, e1), v = dot(d, q) / determinant; if (v < -1e-10 || u + v > 1 + 1e-10) continue;
    const t = dot(e2, q) / determinant;
    if (Math.abs(t) <= epsilon) throw new Error('壳体互相接触，无法可靠判定内外方向。');
    if (t > epsilon) hits.push(t);
  }
  hits.sort((a, b) => a - b); return hits.filter((v, i) => !i || Math.abs(v - hits[i - 1]!) > epsilon).length % 2 === 1;
}
/** Repair orientation only. No faces are deleted, no holes filled, no self-intersection repair. */
export function fixMeshNormals(mesh: TriangleMesh, options: FixNormalsOptions = {}): TriangleMesh {
  validateMesh(mesh); cancelled(options); const stats = meshStats(mesh);
  if (stats.degenerateTriangles || stats.nonManifoldEdges || stats.nonManifoldVertices) throw new Error('法线修正不能代替退化/非流形网格修复，请先处理输入结构。');
  const t = topology(mesh, options), adjacent = Array.from({ length: stats.triangles }, () => [] as { face: number; toggle: boolean }[]);
  for (const edge of t.edges.values()) if (edge.faces.length === 2) { const [a, b] = edge.faces as [number, number], toggle = edge.directions[0] === edge.directions[1]; adjacent[a]!.push({ face: b, toggle }); adjacent[b]!.push({ face: a, toggle }); }
  const flags = new Int8Array(stats.triangles).fill(-1), groups: number[][] = [];
  for (let seed = 0; seed < stats.triangles; seed++) {
    if (flags[seed] !== -1) continue; cancelled(options); const faces = [seed]; flags[seed] = 0;
    for (let i = 0; i < faces.length; i++) { if (i % 2048 === 0) cancelled(options); for (const { face, toggle } of adjacent[faces[i]!]!) {
      const flag = flags[faces[i]!]! ^ +toggle;
      if (flags[face] === -1) { flags[face] = flag; faces.push(face); }
      else if (flags[face] !== flag) throw new Error('网格不可一致定向，法线修正已中止。');
    } }
    groups.push(faces);
  }
  const indices = new Uint32Array(mesh.indices);
  const invert = (f: number) => { [indices[3 * f + 1], indices[3 * f + 2]] = [indices[3 * f + 2]!, indices[3 * f + 1]!]; };
  for (let f = 0; f < stats.triangles; f++) if (flags[f]) invert(f);
  if (options.outward ?? true) {
    const closed = groups.map(faces => faces.every(f => [0, 1, 2].every(k => t.edges.get(edgeKey(indices[3 * f + k]!, indices[3 * f + (k + 1) % 3]!))!.faces.length === 2)));
    const epsilon = Math.max(1e-8, norm(stats.bounds.size) * 1e-8);
    groups.forEach((faces, j) => {
      cancelled(options); if (!closed[j]) return;
      const volume = shellVolume(mesh, faces, indices); if (Math.abs(volume) < epsilon ** 3) throw new Error('闭合壳体有向体积为零，无法定义可靠内外方向。');
      let depth = 0;
      if (options.preserveCavities ?? true) {
        const f = faces[0]!, probe = [0, 1, 2].map(k => (mesh.positions[3 * indices[3 * f]! + k]! + mesh.positions[3 * indices[3 * f + 1]! + k]! + mesh.positions[3 * indices[3 * f + 2]! + k]!) / 3) as Vec3;
        groups.forEach((other, k) => { if (k !== j && closed[k] && insideShell(probe, mesh, other, indices, epsilon)) depth++; });
      }
      if ((volume > 0) !== (depth % 2 === 0)) for (const f of faces) invert(f);
      options.progress?.((j + 1) / Math.max(1, groups.length));
    });
  }
  return finish(mesh.positions, indices);
}

/** Boundary-vertex tolerance weld. Conservative rejection prevents degenerate/duplicate faces.
 * This is not the native zipper stretch/shrink algorithm and is not a complete repair tool. */
export function stitchMesh(mesh: TriangleMesh, options: StitchOptions = {}): TriangleMesh {
  validateMesh(mesh); cancelled(options); const tolerance = options.tolerance ?? 1e-6;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('缝合容差必须为非负有限数。');
  const t = topology(mesh, options), eligible = new Set<number>();
  for (const edge of t.edges.values()) if (edge.faces.length === 1) { eligible.add(edge.a); eligible.add(edge.b); }
  const positions: number[] = [], remap = new Uint32Array(mesh.positions.length / 3), buckets = new Map<string, number[]>();
  const cell = (p: Vec3) => tolerance ? p.map(v => Math.floor(v / tolerance)) : p;
  for (let i = 0; i < remap.length; i++) {
    if (i % 4096 === 0) cancelled(options);
    const p = vertex(mesh.positions, i), key = cell(p), canWeld = !(options.boundaryOnly ?? true) || eligible.has(i); let match: number | undefined;
    if (canWeld) {
      const range = tolerance ? [-1, 0, 1] : [0];
      for (const z of range) for (const y of range) for (const x of range) {
        const ids = buckets.get([key[0]! + x, key[1]! + y, key[2]! + z].join(',')) ?? [];
        for (const id of ids) if (norm(minus(vertex(positions, id), p)) <= tolerance) { match = id; break; }
      }
    }
    if (match === undefined) { match = positions.length / 3; positions.push(...p); if (canWeld) { const k = key.join(','); buckets.set(k, [...buckets.get(k) ?? [], match]); } }
    remap[i] = match;
  }
  const indices = Uint32Array.from(mesh.indices, i => remap[i]!), unique = new Set<string>();
  for (let f = 0; f < indices.length; f += 3) {
    const ids = [...indices.subarray(f, f + 3)], key = [...ids].sort((a, b) => a - b).join(',');
    const [a, b, c] = ids.map(i => vertex(positions, i));
    if (new Set(ids).size !== 3 || norm(cross(minus(b!, a!), minus(c!, a!))) <= 1e-14) throw new Error('缝合容差会生成退化面，已拒绝修改。');
    if (unique.has(key)) throw new Error('缝合后出现重叠重复面，当前工具不会自动删面修复。'); unique.add(key);
  }
  const result = compact({ positions: new Float32Array(positions), indices }), stats = meshStats(result);
  if (stats.nonManifoldEdges || stats.nonManifoldVertices) throw new Error('缝合会产生或保留非流形结构，已拒绝修改。');
  return options.orient === false ? result : fixMeshNormals(result, options);
}
