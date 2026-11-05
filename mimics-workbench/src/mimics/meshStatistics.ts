import type {TriangleMesh, Vec3} from './types.ts';
import type {MeshStats} from './geometry.ts';
import {sortedMeshEdges, edgeEndpoints} from './compactTopology.ts';

/** Exact topology/area/volume analysis with flat, linear-size working buffers. */
export function compactMeshStats(mesh: TriangleMesh): MeshStats {
  const p = mesh.positions, ids = mesh.indices, vertices = p.length / 3;
  const parent = new Uint32Array(vertices), used = new Uint8Array(vertices);
  const offsets = new Uint32Array(vertices + 1);
  for (let v = 0; v < vertices; v++) parent[v] = v;
  const root = (v: number): number => {
    while (parent[v] !== v) { parent[v] = parent[parent[v]!]!; v = parent[v]!; }
    return v;
  };
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let area = 0, signed = 0, degenerate = 0, usedCount = 0;
  const ox = p[0] ?? 0, oy = p[1] ?? 0, oz = p[2] ?? 0;
  for (let f = 0; f < ids.length; f += 3) {
    const ia = ids[f]!, ib = ids[f + 1]!, ic = ids[f + 2]!;
    for (let j = 0; j < 3; j++) {
      const v = ids[f + j]!;
      if (!used[v]) { used[v] = 1; usedCount++; }
      // Match the old Set of incident faces, including degenerate triangles.
      if (j === 0 || v !== ia && (j === 1 || v !== ib)) offsets[v + 1]++;
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, p[3 * v + k]!); max[k] = Math.max(max[k]!, p[3 * v + k]!); }
    }
    parent[root(ia)] = root(ib); parent[root(ib)] = root(ic);
    const a = 3 * ia, b = 3 * ib, c = 3 * ic;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const twice = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    area += twice / 2; if (twice <= 1e-14) degenerate++;
    const ax = p[a]! - ox, ay = p[a + 1]! - oy, az = p[a + 2]! - oz;
    const bx = p[b]! - ox, by = p[b + 1]! - oy, bz = p[b + 2]! - oz;
    const cx = p[c]! - ox, cy = p[c + 1]! - oy, cz = p[c + 2]! - oz;
    signed += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  let components = 0;
  for (let v = 0; v < vertices; v++) if (used[v] && root(v) === v) components++;
  let edges = 0, boundaryEdges = 0, nonManifoldEdges = 0, inconsistentEdges = 0;
  {
    const order = sortedMeshEdges(ids, vertices);
    for (let i = 0; i < order.length;) {
      const start = i, [a, b] = edgeEndpoints(ids, order[i]!);
      let direction = 0;
      do {
        const corner = order[i]!, x = ids[corner]!, y = ids[corner - corner % 3 + (corner + 1) % 3]!;
        direction += x < y ? 1 : -1; i++;
        if (i === order.length) break;
        const [c, d] = edgeEndpoints(ids, order[i]!);
        if (a !== c || b !== d) break;
      } while (true);
      const count = i - start; edges++;
      if (count === 1) boundaryEdges++;
      if (count > 2) nonManifoldEdges++;
      if (count === 2 && direction !== 0) inconsistentEdges++;
    }
  }
  for (let v = 1; v < offsets.length; v++) offsets[v] += offsets[v - 1]!;
  const faces = new Uint32Array(offsets[vertices]!);
  {
    const cursor = offsets.slice(0, vertices);
    for (let f = 0; f < ids.length; f += 3) for (let j = 0; j < 3; j++) {
      const v = ids[f + j]!;
      if (j === 0 || v !== ids[f] && (j === 1 || v !== ids[f + 1])) faces[cursor[v]!++] = f / 3;
    }
  }
  // Reuse the component parent buffer for each vertex's link. A stamp avoids
  // constructing millions of temporary Maps/Sets or clearing a V-sized array V times.
  const stamps = new Uint32Array(vertices), degree = new Uint32Array(vertices);
  let nonManifoldVertices = 0;
  for (let v = 0; v < vertices; v++) {
    if (!used[v]) continue;
    const stamp = v + 1; let linkComponents = 0, branches = false;
    for (let i = offsets[v]!; i < offsets[v + 1]!; i++) {
      const face = faces[i]! * 3;
      let a = -1, b = -1, count = 0;
      for (let j = 0; j < 3; j++) {
        const other = ids[face + j]!;
        if (other !== v) { if (count === 0) a = other; else b = other; count++; }
      }
      if (count !== 2) continue;
      for (const other of [a, b]) {
        if (stamps[other] !== stamp) { stamps[other] = stamp; parent[other] = other; degree[other] = 0; linkComponents++; }
        degree[other]++; if (degree[other]! > 2) branches = true;
      }
      const ra = root(a), rb = root(b);
      if (ra !== rb) { parent[ra] = rb; linkComponents--; }
    }
    if (linkComponents > 1 || branches) nonManifoldVertices++;
  }
  if (!usedCount) { min.fill(0); max.fill(0); }
  return {
    vertices: usedCount, triangles: ids.length / 3, edges, area, surfaceArea: area,
    signedVolume: signed, volume: Math.abs(signed), absoluteVolume: Math.abs(signed),
    boundaryEdges, nonManifoldEdges, nonManifoldVertices, inconsistentEdges,
    degenerateTriangles: degenerate, components, eulerCharacteristic: usedCount - edges + ids.length / 3,
    closed: usedCount > 0 && !boundaryEdges && !nonManifoldEdges && !nonManifoldVertices && !inconsistentEdges && !degenerate,
    bounds: {min, max, size: max.map((value, k) => value - min[k]!) as Vec3},
  };
}
