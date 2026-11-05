import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSurface, computeNormals, createMeshPicker, exportSTL, maskFromMesh, meshStats, nativeLocalInterpolation, parseSTL, reduceMesh, smoothMesh, wrapMesh } from '../src/mimics/geometry.ts';
import { MC_CORNERS, MC_EDGES, MC_TRIANGLES } from '../src/mimics/marchingTables.ts';
import { physicalPoint, voxelIndex, type TriangleMesh, type Vec3, type VolumeGrid } from '../src/mimics/types.ts';
import { makeDemo } from '../src/core.ts';

function grid(dims: Vec3 = [25, 25, 25], spacing: Vec3 = [1, 1, 1]): VolumeGrid { return { dims, spacing, data: new Float32Array(dims[0] * dims[1] * dims[2]) }; }
function sampleMask(g: VolumeGrid, predicate: (x: number, y: number, z: number) => boolean): Uint8Array {
  const out = new Uint8Array(g.data.length);
  for (let z = 0; z < g.dims[2]; z++) for (let y = 0; y < g.dims[1]; y++) for (let x = 0; x < g.dims[0]; x++) out[voxelIndex([x, y, z], g.dims)] = predicate(x, y, z) ? 1 : 0;
  return out;
}
function sphere() {
  const g = grid([29, 29, 29]), r = 10, c = 14;
  const field = new Float32Array(g.data.length);
  const mask = sampleMask(g, (x, y, z) => { const value = r * r - (x - c) ** 2 - (y - c) ** 2 - (z - c) ** 2; field[voxelIndex([x, y, z], g.dims)] = value; return value >= 0; });
  return { g, mask, mesh: calculateSurface(g, mask, { threshold: 0, scalarField: field }) };
}
function assertClosed(mesh: TriangleMesh, euler = 2) {
  const s = meshStats(mesh);
  assert.equal(s.boundaryEdges, 0); assert.equal(s.nonManifoldEdges, 0); assert.equal(s.inconsistentEdges, 0); assert.equal(s.degenerateTriangles, 0); assert.equal(s.eulerCharacteristic, euler); assert.ok(s.closed); assert.ok(s.signedVolume > 0);
  assert.equal(mesh.normals?.length, mesh.positions.length);
  return s;
}
function cube(): TriangleMesh {
  const positions = new Float32Array([0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0, 0, 0, 4, 4, 0, 4, 4, 4, 4, 0, 4, 4]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  return { positions, indices, normals: computeNormals({ positions, indices }) };
}

test('recovered MC table has all 256 valid cases and edges cross the specified native binary corners', () => {
  assert.equal(MC_TRIANGLES.length, 256); const histogram = new Map<number, number>();
  for (let code = 0; code < 256; code++) {
    const row = MC_TRIANGLES[code]!; assert.equal(row.length % 3, 0);
    histogram.set(row.length / 3, (histogram.get(row.length / 3) ?? 0) + 1);
    for (const edge of row) { assert.ok(edge >= 0 && edge < 12); const [a, b] = MC_EDGES[edge]!; assert.notEqual(!!(code & 1 << a), !!(code & 1 << b)); }
  }
  assert.deepEqual([...histogram.entries()].sort((a, b) => a[0] - b[0]), [[0, 2], [1, 16], [2, 50], [3, 80], [4, 76], [5, 32]]);
});

test('padding closes all six acquisition boundaries and anisotropic voxel-centre bounds are correct', () => {
  const g = grid([9, 7, 5], [0.7, 1.3, 2.5]), m = new Uint8Array(g.data.length).fill(1);
  const mesh = calculateSurface(g, m), s = assertClosed(mesh);
  const expected = [9 * 0.7, 7 * 1.3, 5 * 2.5];
  s.bounds.size.forEach((v, k) => assert.ok(Math.abs(v - expected[k]!) < 1e-5));
  const trueVolume = expected.reduce((a, b) => a * b, 1);
  assert.ok(Math.abs(s.volume / trueVolume - 1) < 0.05, `MC bevel discretisation ${s.volume} / ${trueVolume}`);
  assert.deepEqual(maskFromMesh(g, mesh), m);
  for (const step of [2, 3, [2, 1, 3] as Vec3]) assertClosed(calculateSurface(g, m, { step }));
});

test('sphere uses real edge interpolation with bounded geometric and volume error and outward normals', () => {
  const { mesh } = sphere(), s = assertClosed(mesh);
  const exactVolume = 4 / 3 * Math.PI * 10 ** 3, exactArea = 4 * Math.PI * 10 ** 2;
  assert.ok(Math.abs(s.volume / exactVolume - 1) < 0.015);
  assert.ok(Math.abs(s.area / exactArea - 1) < 0.015);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const radial = [mesh.positions[i]! - 14, mesh.positions[i + 1]! - 14, mesh.positions[i + 2]! - 14];
    assert.ok(radial.reduce((sum, v, k) => sum + v * mesh.normals![i + k]!, 0) > 0);
    assert.ok(Math.abs(Math.hypot(...radial) - 10) < 0.045);
  }
});

test('recovered local mode handles both edge directions, endpoint branches, flat ranges, Z scale and native clamp', () => {
  const range = { lower: 0, upper: 1000 };
  assert.equal(nativeLocalInterpolation(500, 1000, { ...range, threshold: 750 }), 0.25);
  assert.equal(nativeLocalInterpolation(1000, 500, { ...range, threshold: 750 }), 0.75);
  assert.equal(nativeLocalInterpolation(500, 0, { ...range, threshold: 250 }), 0.25);
  assert.equal(nativeLocalInterpolation(0, 500, { ...range, threshold: 250 }), 0.75);
  assert.equal(nativeLocalInterpolation(200, 800, { ...range, threshold: 500 }), 0.5);
  assert.equal(nativeLocalInterpolation(500, 1000, { ...range, threshold: 750, scale: 2 }), 0.125);
  assert.equal(nativeLocalInterpolation(0, 0, { lower: 0, upper: 0, threshold: 0 }), 0.5);
  assert.equal(nativeLocalInterpolation(0, 1000, { ...range, threshold: 0 }), 0.001);
  assert.equal(nativeLocalInterpolation(0, 1000, { ...range, threshold: 1000 }), 0.999);
  assert.throws(() => nativeLocalInterpolation(0, 1, { lower: 1, upper: 0, threshold: 0.5 }), /无效/);
});

test('coarse XY extraction chooses the strongest original threshold crossing in the starting direction', () => {
  const g = grid([5, 3, 3]), samples = [-10, 10, -100, 100, 200];
  const field = Float32Array.from(g.data, (_, i) => samples[i % 5]!);
  const mask = Uint8Array.from(field, value => +(value >= 0));
  for (const interpolation of ['linear', 'native-local'] as const) {
    const mesh = calculateSurface(g, mask, { threshold: 0, scalarField: field, step: [3, 1, 1], interpolation });
    assertClosed(mesh);
    const matches: number[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) if (mesh.positions[i + 1] === 1 && mesh.positions[i + 2] === 1 && mesh.positions[i]! > 0 && mesh.positions[i]! < 3) matches.push(mesh.positions[i]!);
    assert.equal(matches.length, 1);
    const expected = interpolation === 'linear' ? 2.5 : 8 / 3;
    assert.ok(Math.abs(matches[0]! - expected) < 1e-6);
  }
});

test('full affine shear/reflection preserves orientation, scales volume by determinant and voxelises in the inverse space', () => {
  const { g, mask } = sphere();
  const reference = calculateSurface(g, mask), base = meshStats(reference);
  g.affine = [[-1.2, 0.2, 0.1, 71], [0, 2.3, 0.3, -43], [0, 0, 0.8, 12], [0, 0, 0, 1]];
  const transformed = calculateSurface(g, mask), s = assertClosed(transformed);
  assert.ok(Math.abs(s.volume / (base.volume * 1.2 * 2.3 * 0.8) - 1) < 1e-5);
  assert.deepEqual(maskFromMesh(g, transformed), mask);
  const p = physicalPoint([4, 7, 9], g); [68.5, -24.2, 19.2].forEach((v, k) => assert.ok(Math.abs(p[k]! - v) < 1e-12));
});

test('shared-face saddle resolution closes every binary 2×2×2 configuration and deterministic random masks', () => {
  const g = grid([2, 2, 2]);
  for (let code = 1; code < 256; code++) {
    const m = sampleMask(g, (x, y, z) => !!(code & 1 << (x + 2 * y + 4 * z)));
    const s = meshStats(calculateSurface(g, m));
    assert.ok(s.closed, `configuration ${code}: boundary ${s.boundaryEdges}, nonmanifold ${s.nonManifoldEdges}`);
  }
  let random = 123456789; const larger = grid([7, 6, 5]);
  for (let i = 0; i < 12; i++) {
    const m = sampleMask(larger, () => { random = (Math.imul(random, 1664525) + 1013904223) | 0; return (random >>> 29) < 3; });
    assert.ok(meshStats(calculateSurface(larger, m)).closed);
  }
});

test('cavity walls point inward, disconnected shells and Euler counts are diagnosed, mesh-to-mask preserves hollow regions', () => {
  const g = grid([25, 25, 25]);
  const shell = sampleMask(g, (x, y, z) => { const r = Math.hypot(x - 12, y - 12, z - 12); return r <= 9 && r >= 4; });
  const mesh = calculateSurface(g, shell), s = assertClosed(mesh, 4);
  assert.equal(s.components, 2); assert.ok(s.volume < 4 / 3 * Math.PI * 9 ** 3); assert.deepEqual(maskFromMesh(g, mesh), shell);
  const separated = sampleMask(g, (x, y, z) => Math.hypot(x - 6, y - 12, z - 12) < 4 || Math.hypot(x - 19, y - 12, z - 12) < 3);
  const parts = assertClosed(calculateSurface(g, separated), 4); assert.equal(parts.components, 2);
});

test('mesh statistics distinguish boundary, reversed winding, nonmanifold and degenerate geometry', () => {
  const box = cube(), stats = assertClosed(box); assert.equal(stats.area, 96); assert.ok(Math.abs(stats.volume - 64) < 1e-12);
  const reversed = { positions: box.positions, indices: Uint32Array.from(box.indices, (_, i) => box.indices[Math.floor(i / 3) * 3 + (2 - i % 3)]!) };
  assert.ok(Math.abs(meshStats(reversed).signedVolume + 64) < 1e-12);
  const open = { positions: box.positions, indices: box.indices.subarray(3) };
  assert.equal(meshStats(open).boundaryEdges, 3); assert.equal(meshStats(open).closed, false); assert.throws(() => maskFromMesh(grid(), open), /闭合/);
  const bad = { positions: box.positions, indices: new Uint32Array([...box.indices, 0, 2, 1, 0, 0, 1]) };
  assert.ok(meshStats(bad).nonManifoldEdges > 0); assert.equal(meshStats(bad).degenerateTriangles, 1);
  // Two tetrahedra share exactly one point: every edge is paired, yet the vertex link
  // has two cycles and this must not be accepted as a closed manifold solid.
  const touching = {
    positions: new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,1, -1,0,0, 0,-1,0, 0,0,-1]),
    indices: new Uint32Array([0,2,1, 0,1,3, 0,3,2, 1,2,3, 0,4,5, 0,6,4, 0,5,6, 4,6,5]),
  };
  const pinch = meshStats(touching); assert.equal(pinch.nonManifoldEdges, 0); assert.equal(pinch.boundaryEdges, 0); assert.equal(pinch.nonManifoldVertices, 1); assert.equal(pinch.closed, false);
  assert.throws(() => meshStats({ positions: new Float32Array([NaN, 0, 0]), indices: new Uint32Array() }), /非有限/);
  assert.throws(() => meshStats({ positions: new Float32Array(3), indices: new Uint32Array([0, 1, 0]) }), /越界/);
});

test('STL binary is exactly 84 + 50 bytes per facet, survives solid-prefixed headers and ASCII roundtrips', () => {
  const mesh = cube(), binary = exportSTL(mesh, { name: 'solid is still binary' }) as Uint8Array;
  assert.equal(binary.length, 84 + 12 * 50); assert.equal(new DataView(binary.buffer).getUint32(80, true), 12);
  const decoded = parseSTL(binary), ascii = exportSTL(mesh, { binary: false, name: 'test cube' });
  assert.ok(Math.abs(meshStats(decoded).volume - 64) < 1e-12); assertClosed(decoded);
  assert.ok(Math.abs(meshStats(parseSTL(ascii)).volume - 64) < 1e-12);
  assert.deepEqual(exportSTL(decoded, { name: 'solid is still binary' }), binary);
  // Slice views with byte offsets must parse the intended bytes only.
  const container = new Uint8Array(binary.length + 13); container.set(binary, 7);
  assert.ok(Math.abs(meshStats(parseSTL(container.subarray(7, 7 + binary.length))).volume - 64) < 1e-12);
});

test('STL rejects truncated records, malformed structure, nonfinite coordinates and degenerate export', () => {
  const mesh = cube(), bytes = exportSTL(mesh) as Uint8Array;
  assert.throws(() => parseSTL(bytes.subarray(0, bytes.length - 1)), /长度/);
  const bad = bytes.slice(); new DataView(bad.buffer).setFloat32(96, NaN, true); assert.throws(() => parseSTL(bad), /非有限/);
  const ascii = exportSTL(mesh, { binary: false }); assert.throws(() => parseSTL(ascii.replace('outer loop', 'loop')), /outer/);
  assert.throws(() => parseSTL(ascii.replace('endsolid', 'missing')), /endsolid/);
  assert.throws(() => exportSTL({ positions: new Float32Array(3), indices: new Uint32Array([0, 0, 0]) }), /退化/);
});

test('BVH ray picking returns the nearest world-mm point, handles parallel/inside rays and bounds distance', () => {
  const mesh = cube(), picker = createMeshPicker(mesh);
  const hit = picker.intersect([8, 2, 2], [-7, 0, 0]); assert.ok(hit);
  assert.deepEqual(hit.position, [4, 2, 2]); assert.equal(hit.distance, 4);
  const ids = [...mesh.indices.subarray(hit.triangle * 3, hit.triangle * 3 + 3)];
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(ids.reduce((s, id, j) => s + mesh.positions[3 * id + k]! * hit.barycentric[j]!, 0) - hit.position[k]!) < 1e-12);
  assert.equal(picker.intersect([8, 2, 2], [-1, 0, 0], 3), undefined);
  assert.equal(picker.intersect([8, 5, 2], [-1, 0, 0]), undefined);
  assert.deepEqual(picker.intersect([2, 2, 2], [0, 1, 0])?.position, [2, 4, 2]);
  assert.equal(picker.intersect([0, 2, 2], [-1, 0, 0])?.distance, 0);
  assert.throws(() => picker.intersect([0, 0, 0], [0, 0, 0]), /方向/);
  assert.equal(createMeshPicker({ positions: new Float32Array(), indices: new Uint32Array() }).intersect([0, 0, 0], [1, 0, 0]), undefined);
});

test('BVH surface hits agree with the analytic sphere over arbitrary camera rays', () => {
  const { mesh } = sphere(), picker = createMeshPicker(mesh);
  for (let i = 1; i <= 24; i++) {
    const theta = i * 2.3999632297, phi = Math.acos(1 - 2 * i / 25), normal: Vec3 = [Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi)];
    const origin = normal.map(v => 14 + 30 * v) as Vec3, hit = picker.intersect(origin, normal.map(v => -v) as Vec3);
    assert.ok(hit); assert.ok(Math.abs(hit.distance - 20) < 0.05); assert.ok(Math.abs(Math.hypot(...hit.position.map(v => v - 14)) - 10) < 0.05);
  }
});

test('smoothing is Jacobi, retains topology and optional volume compensation without mutating the source', () => {
  const { mesh } = sphere(), before = mesh.positions.slice(), volume = meshStats(mesh).volume;
  const smooth = smoothMesh(mesh, { iterations: 4, factor: 0.25 }), compensated = smoothMesh(mesh, { iterations: 4, factor: 0.25, compensateShrinkage: true });
  assertClosed(smooth); assertClosed(compensated); assert.deepEqual(mesh.positions, before);
  assert.ok(meshStats(smooth).volume < volume);
  assert.ok(Math.abs(meshStats(compensated).volume / volume - 1) < 1e-6);
  const global = smoothMesh(mesh, { iterations: 4, factor: 0.25, compensateShrinkage: true, compensationMethod: 'global-scale' });
  assert.ok(Math.abs(meshStats(global).volume / volume - 1) < 1e-6);
  assert.notDeepEqual(compensated.positions, global.positions, 'the polynomial second pass must not silently fall back to uniform scaling');
  assert.deepEqual(smooth.indices, mesh.indices);
  assert.throws(() => smoothMesh(mesh, { factor: -1 }), /无效/);
});

test('large synthetic bone shell reduction validates Float32 candidates before collapse, retaining both closed shells', () => {
  const g = makeDemo(), mask = Uint8Array.from(g.data, v => +(v >= 226));
  const source = calculateSurface(g, mask), mesh = reduceMesh(source, { targetRatio: 0.5, tolerance: 1, featureAngle: 70 });
  const s = assertClosed(mesh, 4); assert.equal(s.components, 2); assert.ok(s.triangles <= source.indices.length / 6 + 2);
});

test('quadric reduction reduces a curved surface while preserving topology, positive orientation and bounded volume error', () => {
  const { mesh } = sphere(), original = mesh.positions.slice(), baseline = meshStats(mesh);
  const reduced = reduceMesh(mesh, { targetRatio: 0.55, tolerance: 0.8, featureAngle: 80 }), s = assertClosed(reduced);
  assert.ok(s.triangles < baseline.triangles * 0.7, `${s.triangles}/${baseline.triangles}`);
  assert.ok(Math.abs(s.volume / baseline.volume - 1) < 0.025);
  assert.deepEqual(mesh.positions, original);
  const constrained = reduceMesh(cube(), { targetRatio: 0.2, featureAngle: 30 }); assert.equal(constrained.indices.length, 36);
  // A grid patch has a true open boundary. Its boundary positions remain exactly fixed.
  const p: number[] = [], ids: number[] = [], boundary: number[][] = [];
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) { const point = [x, y, 0.05 * Math.sin(x) * Math.sin(y)]; p.push(...point); if (!x || !y || x === 6 || y === 6) boundary.push(point); }
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) { const a = x + 7 * y; ids.push(a, a + 1, a + 8, a, a + 8, a + 7); }
  const patch = reduceMesh({ positions: new Float32Array(p), indices: new Uint32Array(ids) }, { targetRatio: 0.65, preserveBoundary: true });
  const boundaryKeys = new Set([...patch.positions].reduce<number[][]>((rows, _, i, all) => { if (i % 3 === 0) rows.push(all.slice(i, i + 3)); return rows; }, []).map(row => row.join(',')));
  for (const vertex of boundary) assert.ok(boundaryKeys.has([...new Float32Array(vertex)].join(',')));
  assert.equal(meshStats(patch).boundaryEdges, 24); assert.equal(meshStats(patch).eulerCharacteristic, 1);
});

test('independent voxel Wrap closes a small tunnel and emits a valid closed surface', () => {
  const g = grid([13, 13, 13]);
  const tunnel = sampleMask(g, (x, y, z) => x >= 2 && x <= 10 && y >= 2 && y <= 10 && z >= 2 && z <= 10 && !(x === 6 && y === 6));
  const mesh = calculateSurface(g, tunnel), before = meshStats(mesh); assert.equal(before.eulerCharacteristic, 0);
  const wrapped = wrapMesh(mesh, { resolution: 0.7, closingDistance: 3, protectThinWalls: true }), after = assertClosed(wrapped);
  assert.ok(after.volume > before.volume); assert.equal(after.eulerCharacteristic, 2);
  assert.throws(() => wrapMesh(mesh, { resolution: 0.001 }), /数量/);
});

test('empty masks and cancellation are explicit and invalid grids/fields cannot silently produce surfaces', () => {
  const g = grid([3, 3, 3]), m = new Uint8Array(27);
  assert.equal(calculateSurface(g, m).indices.length, 0);
  assert.throws(() => calculateSurface(g, m, { cancelled: () => true }), /取消/);
  assert.throws(() => calculateSurface(g, m, { step: 0 }), /步长/);
  assert.throws(() => calculateSurface(g, m.subarray(1)), /尺寸/);
  assert.throws(() => calculateSurface(g, m, { scalarField: new Float32Array(27).fill(1) }), /分类/);
  assert.throws(() => calculateSurface({ ...g, affine: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] }, m), /不可逆/);
});
