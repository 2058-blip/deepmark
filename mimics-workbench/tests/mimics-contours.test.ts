import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitmapToMask, calculatePolylines, contoursToMask, extractSliceContours, independentSmoothMask, updatePolylines } from '../src/mimics/contours.ts';
import type { ContourLayer } from '../src/mimics/contours.ts';
import type { Vec3, VolumeGrid } from '../src/mimics/types.ts';
import { voxelIndex } from '../src/mimics/types.ts';

function grid(dims: Vec3, spacing: Vec3 = [1, 1, 1]): VolumeGrid { return { dims, spacing, data: new Float32Array(dims[0] * dims[1] * dims[2]) }; }
function selected(g: VolumeGrid, points: Vec3[]): Uint8Array { const m = new Uint8Array(g.data.length); for (const p of points) m[voxelIndex(p, g.dims)] = 1; return m; }
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('one voxel has a closed half-voxel boundary, correct physical metrics and an exact round trip', () => {
  const g = grid([3, 3, 1], [2, 3, 4]), mask = selected(g, [[1, 1, 0]]), layer = extractSliceContours(g, mask, { axis: 2, index: 0 });
  assert.equal(layer.rings.length, 1); assert.equal(layer.componentCount, 1);
  assert.deepEqual(layer.rings[0].points, [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5]]);
  assert.equal(layer.rings[0].areaMm2, 6); assert.equal(layer.rings[0].perimeterMm, 10); assert.equal(layer.rings[0].hole, false);
  assert.deepEqual(contoursToMask(g, layer).mask, mask);
});

test('nested outer ring, hole and island retain hierarchy, signs and two foreground components', () => {
  const g = grid([7, 7, 1], [2, 3, 1]), mask = new Uint8Array(49);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) if (!x || !y || x === 6 || y === 6 || x === 3 && y === 3) mask[x + 7 * y] = 1;
  const layer = extractSliceContours(g, mask, { axis: 2, index: 0 });
  assert.equal(layer.componentCount, 2); assert.equal(layer.rings.length, 3); assert.equal(layer.rings.filter(r => r.hole).length, 1);
  const outer = layer.rings.findIndex(r => r.signedArea === 49), hole = layer.rings.findIndex(r => r.signedArea === -25), island = layer.rings.findIndex(r => r.signedArea === 1);
  assert.equal(layer.rings[outer].parent, null); assert.equal(layer.rings[hole].parent, outer); assert.equal(layer.rings[island].parent, hole);
  assert.equal(layer.rings[island].hole, false); assert.equal(layer.rings.reduce((s, r) => s + (r.hole ? -1 : 1) * r.areaMm2, 0), 150);
  assert.deepEqual(contoursToMask(g, layer).mask, mask);
});

test('diagonal foreground contact preserves four-connected components without merging at a corner', () => {
  const g = grid([3, 3, 1]), mask = selected(g, [[0, 0, 0], [1, 1, 0], [2, 2, 0]]), layer = extractSliceContours(g, mask, { axis: 2, index: 0 });
  assert.equal(layer.componentCount, 3); assert.equal(layer.rings.length, 3); assert.ok(layer.rings.every(r => r.points.length === 4 && !r.hole));
  assert.deepEqual(contoursToMask(g, layer).mask, mask);
});

test('all 512 binary 3x3 images survive tracing and rasterization, including diagonal and point-touch cases', () => {
  const g = grid([3, 3, 1]); g.data.fill(NaN); // Extraction depends on the mask, not intensity.
  for (let bits = 0; bits < 512; bits++) {
    const mask = Uint8Array.from({ length: 9 }, (_, i) => bits >> i & 1), layer = extractSliceContours(g, mask, { axis: 2, index: 0 });
    assert.deepEqual(contoursToMask(g, layer).mask, mask, `pattern ${bits}`);
    assert.equal(layer.rings.reduce((sum, r) => sum + r.signedArea, 0), mask.reduce((sum, v) => sum + v, 0), `area ${bits}`);
  }
});

test('all orthogonal plane orientations and boundary-touching masks round-trip through a complete set', () => {
  const g = grid([4, 5, 3]), mask = new Uint8Array(60);
  for (let i = 0; i < mask.length; i++) if ((i * 17 + Math.floor(i / 4) * 13) % 7 < 3) mask[i] = 1;
  for (const axis of [0, 1, 2] as const) {
    const set = calculatePolylines(g, mask, { axis });
    assert.equal(set.layers.length, g.dims[axis]); assert.deepEqual(contoursToMask(g, set).mask, mask);
  }
});

test('physical contour metrics respect affine shear rather than multiplying nominal spacings', () => {
  const g = grid([2, 2, 1], [9, 9, 9]); g.affine = [[2, 1, 0, 10], [0, 3, 0, 20], [0, 0, 4, 30], [0, 0, 0, 1]];
  const ring = extractSliceContours(g, selected(g, [[0, 0, 0]]), { axis: 2, index: 0 }).rings[0];
  close(ring.areaMm2, 6); close(ring.perimeterMm, 4 + 2 * Math.sqrt(10));
  g.affine[0][3] = g.affine[1][3] = g.affine[2][3] = 1e20;
  close(extractSliceContours(g, selected(g, [[0, 0, 0]]), { axis: 2, index: 0 }).rings[0].areaMm2, 6);
});

test('update replaces only the chosen layer, preserving other layer objects and the source set', () => {
  const g = grid([3, 3, 3]), mask = selected(g, [[1, 1, 0], [1, 1, 1], [1, 1, 2]]), set = calculatePolylines(g, mask), json = JSON.stringify(set);
  const changed = mask.slice(); changed[voxelIndex([2, 1, 1], g.dims)] = 1;
  const updated = updatePolylines(g, changed, set, 1);
  assert.equal(updated.layers[0], set.layers[0]); assert.equal(updated.layers[2], set.layers[2]); assert.notEqual(updated.layers[1], set.layers[1]);
  assert.equal(JSON.stringify(set), json); assert.deepEqual(contoursToMask(g, updated).mask, changed);
});

test('rasterization preserves other slices and supports selected-only add and remove', () => {
  const g = grid([3, 3, 3]), target = selected(g, [[0, 0, 0], [2, 2, 1]]), layer = extractSliceContours(g, selected(g, [[1, 1, 1]]), { axis: 2, index: 1 }), before = target.slice();
  assert.deepEqual(contoursToMask(g, layer, { source: target, operation: 'replace' }).mask, selected(g, [[0, 0, 0], [1, 1, 1]]));
  const added = contoursToMask(g, layer, { source: target, operation: 'add' }).mask;
  assert.deepEqual(added, selected(g, [[0, 0, 0], [1, 1, 1], [2, 2, 1]]));
  assert.deepEqual(contoursToMask(g, layer, { source: added, operation: 'remove' }).mask, target); assert.deepEqual(target, before);
});

test('a caller contour has an explicit half-open integer-centre boundary convention', () => {
  const g = grid([4, 4, 1]), layer: ContourLayer = { plane: { axis: 2, index: 0 }, componentCount: 1, provenance: 'independent-half-voxel-cell-boundary', rings: [{ points: [[1, 1], [3, 1], [3, 3], [1, 3]], hole: false, parent: null, component: 0, signedArea: 4, areaMm2: 4, perimeterMm: 8 }] };
  assert.deepEqual(contoursToMask(g, layer).mask, selected(g, [[1, 1, 0], [2, 1, 0], [1, 2, 0], [2, 2, 0]]));
});

test('solid bitmap labels preserve glyph holes and use physical in-plane size and depth', () => {
  const g = grid([9, 9, 6], [1, 2, 3]), bitmap = { width: 3, height: 3, data: Uint8Array.from([255, 255, 255, 255, 0, 255, 255, 255, 255]) };
  const before = bitmap.data.slice(), r = bitmapToMask(g, bitmap, { origin: [2, 2, 2], pixelSizeMm: [2, 4], depthMm: 6 });
  assert.equal(r.count, 64); assert.equal(r.labelVoxelCount, 64); assert.deepEqual(r.layers, [2, 3]); assert.equal(r.actualDepthMm, 6);
  assert.equal(r.mask[voxelIndex([3, 3, 2], g.dims)], 0); assert.equal(r.mask[voxelIndex([1, 1, 2], g.dims)], 1);
  assert.equal(r.mask[voxelIndex([1, 1, 4], g.dims)], 0); assert.deepEqual(bitmap.data, before);
});

test('label auto depth reaches the top then copies remaining layers downward, with clipping exposed', () => {
  const g = grid([3, 3, 6]), bitmap = { width: 1, height: 1, data: Uint8Array.of(255) }, options = { origin: [1, 1, 4] as Vec3, pixelSizeMm: [1, 1] as [number, number], depthMm: 3 };
  assert.deepEqual(bitmapToMask(g, bitmap, options).layers, [4, 5, 3]);
  assert.deepEqual(bitmapToMask(g, bitmap, { ...options, direction: 'down' }).layers, [4, 3, 2]);
  const up = bitmapToMask(g, bitmap, { ...options, direction: 'up' }); assert.deepEqual(up.layers, [4, 5]); assert.equal(up.clipped, true);
  const huge = bitmapToMask(g, bitmap, { ...options, depthMm: 99 }); assert.equal(huge.count, 6); assert.equal(huge.clipped, true);
});

test('label placement supports sagittal planes, mirror orientation, alpha thresholds and target-mask unions', () => {
  const g = grid([5, 5, 5], [2, 3, 4]), bitmap = { width: 2, height: 1, data: Uint8Array.from([255, 100]) }, source = selected(g, [[0, 0, 0]]), before = source.slice();
  const base = { axis: 0 as const, origin: [2, 1, 2] as Vec3, pixelSizeMm: [3, 4] as [number, number], depthMm: 4, source };
  assert.deepEqual(bitmapToMask(g, bitmap, base).mask, selected(g, [[0, 0, 0], [2, 1, 2], [3, 1, 2]]));
  assert.deepEqual(bitmapToMask(g, bitmap, { ...base, flipU: true }).mask, selected(g, [[0, 0, 0], [2, 2, 2], [3, 2, 2]]));
  assert.equal(bitmapToMask(g, bitmap, { ...base, alphaThreshold: 50 }).count, 5);
  assert.deepEqual(source, before);
});

test('malformed grids, rings, bitmaps and placements are rejected explicitly', () => {
  const g = grid([3, 3, 3]), mask = new Uint8Array(27), bitmap = { width: 1, height: 1, data: Uint8Array.of(255) };
  assert.throws(() => extractSliceContours(g, mask, { axis: 2, index: 3 }), /切片/);
  assert.throws(() => calculatePolylines(g, mask, { slices: [0, 0] }), /重复/);
  assert.throws(() => bitmapToMask(g, bitmap, { origin: [0, 0, 0.5], pixelSizeMm: [1, 1], depthMm: 1 }), /锚点/);
  assert.throws(() => bitmapToMask(g, { ...bitmap, width: 2 }, { origin: [0, 0, 0], pixelSizeMm: [1, 1], depthMm: 1 }), /位图/);
  assert.throws(() => bitmapToMask(g, bitmap, { origin: [0, 0, 0], pixelSizeMm: [0, 1], depthMm: 1 }), /尺寸/);
  const layer = extractSliceContours(g, mask, { axis: 2, index: 0 }); layer.rings.push({ points: [[NaN, 0], [1, 0], [0, 1]], hole: false, parent: null, component: 0, signedArea: 0, areaMm2: 0, perimeterMm: 0 });
  assert.throws(() => contoursToMask(g, layer), /顶点/);
});

test('cancelled contour and solid-label operations never change inputs', () => {
  const g = grid([10, 10, 4]), mask = new Uint8Array(400).fill(1), before = mask.slice(), bitmap = { width: 2, height: 2, data: new Uint8Array(4).fill(255) };
  assert.throws(() => calculatePolylines(g, mask, { cancelled: () => true }), { name: 'AbortError' });
  let cancelled = false;
  assert.throws(() => bitmapToMask(g, bitmap, { origin: [2, 2, 1], pixelSizeMm: [1, 1], depthMm: 3, source: mask, cancelled: () => cancelled, progress: f => { if (f > 0) cancelled = true; } }), { name: 'AbortError' });
  assert.deepEqual(mask, before);
});

test('independent Smooth Mask requires an explicit strategy and removes an isolated voxel', () => {
  const g = grid([5, 5, 5]), source = selected(g, [[2, 2, 2]]), before = source.slice();
  const result = independentSmoothMask(g, source, { strategy: 'majority-26' });
  assert.equal(result.count, 0); assert.equal(result.provenance, 'independent-neighborhood-majority'); assert.deepEqual(source, before);
  assert.throws(() => independentSmoothMask(g, source, { strategy: 'gaussian' as never }), /显式/);
});

test('independent planar majority fills a surrounded centre and preserves other slices', () => {
  const g = grid([5, 5, 3]), source = selected(g, [[2, 1, 1], [1, 2, 1], [3, 2, 1], [2, 3, 1], [0, 0, 0]]);
  const result = independentSmoothMask(g, source, { strategy: 'majority-6', plane: { axis: 2, index: 1 } });
  assert.equal(result.mask[voxelIndex([2, 2, 1], g.dims)], 1); assert.equal(result.mask[0], 1);
  assert.throws(() => independentSmoothMask(g, source, { strategy: 'majority-6', cancelled: () => true }), { name: 'AbortError' });
});
