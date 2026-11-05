import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySelection, booleanMasks, cavityFill, copySelectionSlices, cropMask, dynamicRegionGrow, fillHoles, interpolateMaskSlices, keepLargest, maskStatistics, morphology, polygonRaster, regionGrow, threshold } from '../src/mimics/segmentation.ts';
import { voxelIndex } from '../src/mimics/types.ts';
import type { Vec3, VolumeGrid } from '../src/mimics/types.ts';

function grid(dims: Vec3, data?: number[], spacing: Vec3 = [1, 1, 1]): VolumeGrid {
  return { dims, spacing, data: data ? Float32Array.from(data) : new Float32Array(dims[0] * dims[1] * dims[2]) };
}
function selected(g: VolumeGrid, points: Vec3[]): Uint8Array {
  const mask = new Uint8Array(g.data.length); for (const p of points) mask[voxelIndex(p, g.dims)] = 1; return mask;
}
function box(g: VolumeGrid, low: Vec3, high: Vec3): Uint8Array {
  const mask = new Uint8Array(g.data.length);
  for (let z = low[2]; z <= high[2]; z++) for (let y = low[1]; y <= high[1]; y++) for (let x = low[0]; x <= high[0]; x++) mask[voxelIndex([x, y, z], g.dims)] = 1;
  return mask;
}
const count = (m: Uint8Array) => m.reduce((n, value) => n + Number(value !== 0), 0);

test('threshold includes both endpoints, excludes nonfinite intensities, and honours an inclusive ROI', () => {
  const g = grid([3, 2, 1], [-2, -1, 0, 1, NaN, Infinity]), before = g.data.slice();
  assert.deepEqual([...threshold(g, -1, 1).mask], [0, 1, 1, 1, 0, 0]);
  assert.deepEqual([...threshold(g, -1, 1, { roi: { min: [1, 0, 0], max: [2, 0, 0] } }).mask], [0, 1, 1, 0, 0, 0]);
  assert.deepEqual(g.data, before);
  assert.throws(() => threshold(g, 1, -1), /上下限/);
  assert.throws(() => threshold(g, -Infinity, 1), /上下限/);
  assert.throws(() => threshold(g, 0, 1, { roi: { min: [-1, 0, 0], max: [2, 1, 0] } }), /ROI/);
});

test('scan-segment grow separates face and corner connectivity and never wraps rows', () => {
  const g = grid([3, 3, 3]); g.data.fill(NaN);
  const source = selected(g, [[0, 0, 0], [1, 1, 1], [2, 2, 2]]), before = source.slice();
  assert.equal(regionGrow(g, source, [0, 0, 0], { connectivity: 6 }).count, 1);
  assert.equal(regionGrow(g, source, [0, 0, 0], { connectivity: 26 }).count, 3);
  assert.deepEqual(source, before); // Existing mask grow is independent of image intensity.
  const flat = grid([3, 2, 1]), ends = selected(flat, [[2, 0, 0], [0, 1, 0]]);
  assert.equal(regionGrow(flat, ends, [2, 0, 0], { connectivity: 6 }).count, 1);
  assert.equal(regionGrow(flat, ends, [1, 0, 0]).count, 0);
});

test('grow respects every orthogonal slice orientation and ROI clipping', () => {
  const g = grid([5, 4, 3]), source = new Uint8Array(g.data.length).fill(1);
  for (const axis of [0, 1, 2] as const) {
    const seed: Vec3 = [1, 1, 1], result = regionGrow(g, source, seed, { connectivity: 26, plane: { axis, index: 1 } });
    assert.equal(result.count, g.data.length / g.dims[axis]);
    for (let i = 0; i < result.mask.length; i++) if (result.mask[i]) {
      const p = [i % 5, Math.floor(i / 5) % 4, Math.floor(i / 20)]; assert.equal(p[axis], 1);
    }
  }
  assert.equal(regionGrow(g, source, [2, 1, 1], { roi: { min: [2, 1, 1], max: [3, 2, 1] } }).count, 4);
  assert.throws(() => regionGrow(g, source, [0, 1, 1], { plane: { axis: 0, index: 1 } }), /种子/);
  assert.throws(() => regionGrow(g, source, [0.5, 1, 1]), /种子/);
});

test('dynamic grow uses a forced valid seed and strict open deviation endpoints', () => {
  const g = grid([5, 1, 1], [8, 10, 10, 12, NaN]);
  const result = dynamicRegionGrow(g, [1, 0, 0], { lowerDeviation: 2, upperDeviation: 2, updateMean: false });
  assert.deepEqual([...result.mask], [0, 1, 1, 0, 0]);
  assert.equal(dynamicRegionGrow(g, [1, 0, 0], { lowerDeviation: 0, upperDeviation: 0 }).count, 1);
  assert.throws(() => dynamicRegionGrow(g, [4, 0, 0], { lowerDeviation: 2, upperDeviation: 2 }), /有限/);
  assert.throws(() => dynamicRegionGrow(g, [1, 0, 0], { lowerDeviation: -1, upperDeviation: 2 }), /偏差/);
});

test('online mean is optional and a rejected candidate is not retried after mean drift', () => {
  const line = grid([3, 1, 1], [10, 12, 13.5]);
  assert.equal(dynamicRegionGrow(line, [0, 0, 0], { lowerDeviation: 3, upperDeviation: 3, updateMean: false }).count, 2);
  assert.equal(dynamicRegionGrow(line, [0, 0, 0], { lowerDeviation: 3, upperDeviation: 3, updateMean: true }).count, 3);
  // 13 is rejected first; the accepted 12s later move the mean far enough that retrying would add 13.
  const g = grid([3, 2, 1], [10, 13, 100, 12, 12, 100]);
  const grown = dynamicRegionGrow(g, [0, 0, 0], { lowerDeviation: 3, upperDeviation: 3, updateMean: true, connectivity: 6 });
  assert.deepEqual([...grown.mask], [1, 0, 0, 1, 1, 0]);
  assert.equal(dynamicRegionGrow(g, [0, 0, 0], { lowerDeviation: 100, upperDeviation: 100, plane: { axis: 1, index: 0 } }).count, 3);
});

test('Boolean masks implement independent sets, normalize bits and preserve inputs', () => {
  const a = Uint8Array.from([1, 2, 0, 0]), b = Uint8Array.from([0, 7, 1, 0]), before = a.slice();
  assert.deepEqual([...booleanMasks(a, b, 'union').mask], [1, 1, 1, 0]);
  assert.deepEqual([...booleanMasks(a, b, 'intersection').mask], [0, 1, 0, 0]);
  assert.deepEqual([...booleanMasks(a, b, 'subtract').mask], [1, 0, 0, 0]);
  assert.deepEqual([...booleanMasks(b, a, 'subtract').mask], [0, 0, 1, 0]);
  assert.deepEqual(a, before);
  assert.throws(() => booleanMasks(a, new Uint8Array(2), 'union'), /尺寸/);
});

test('physical morphology observes thick slice spacing, planar mode and independent millimetre units', () => {
  const g = grid([5, 5, 3], undefined, [1, 1, 3]), source = selected(g, [[2, 2, 1]]), before = source.slice();
  const small = morphology(g, source, { operation: 'dilate', radius: 1, connectivity: 26 });
  assert.equal(small.count, 9);
  assert.equal(small.mask[voxelIndex([2, 2, 0], g.dims)], 0);
  const large = morphology(g, source, { operation: 'dilate', radius: 3, connectivity: 26 });
  assert.equal(large.count, 75);
  assert.equal(morphology(g, source, { operation: 'dilate', radius: 3, connectivity: 8 }).count, 25);
  assert.deepEqual(source, before);
  const stretched = grid([5, 5, 1], undefined, [1, 2, 3]), dot = selected(stretched, [[2, 2, 0]]);
  assert.equal(morphology(stretched, dot, { operation: 'dilate', radius: 1, connectivity: 8 }).count, 3);
  assert.equal(morphology(stretched, dot, { operation: 'dilate', radius: 2, units: 'mm', connectivity: 8 }).count, 15);
});

test('morphology handles image exterior, limit masks, opening noise and closing a hole', () => {
  const g = grid([7, 7, 1]), square = box(g, [2, 2, 0], [4, 4, 0]); square[0] = 1;
  assert.deepEqual(morphology(g, square, { operation: 'open', radius: 1, connectivity: 8 }).mask, box(g, [2, 2, 0], [4, 4, 0]));
  const ring = box(g, [1, 1, 0], [5, 5, 0]); ring[voxelIndex([3, 3, 0], g.dims)] = 0;
  assert.deepEqual(morphology(g, ring, { operation: 'close', radius: 1, connectivity: 8 }).mask, box(g, [1, 1, 0], [5, 5, 0]));
  const full = new Uint8Array(49).fill(1);
  assert.deepEqual(morphology(g, full, { operation: 'erode', radius: 1, connectivity: 8 }).mask, box(g, [1, 1, 0], [5, 5, 0]));
  const limit = selected(g, [[3, 3, 0]]);
  assert.deepEqual(morphology(g, full, { operation: 'erode', radius: 1, connectivity: 8, limitMask: limit }).mask, limit);
  assert.throws(() => morphology(g, full, { operation: 'dilate', radius: NaN, connectivity: 8 }), /半径/);
});

test('planar morphology preserves other slices in coronal and sagittal views', () => {
  const g = grid([5, 5, 5]), source = selected(g, [[2, 2, 2], [0, 0, 0]]);
  for (const axis of [0, 1] as const) {
    const result = morphology(g, source, { operation: 'dilate', radius: 1, connectivity: 8, plane: { axis, index: 2 } });
    assert.equal(result.count, 10); assert.equal(result.mask[0], 1);
    assert.equal(result.mask[voxelIndex([2, 2, 2], g.dims)], 1);
    for (let i = 1; i < result.mask.length; i++) if (result.mask[i]) {
      const p = [i % 5, Math.floor(i / 5) % 5, Math.floor(i / 25)]; assert.equal(p[axis], 2);
    }
  }
});

test('fill holes distinguishes a closed 3D shell, face leakage and diagonal exterior connectivity', () => {
  const g = grid([5, 5, 5]), shell = box(g, [1, 1, 1], [3, 3, 3]); shell[voxelIndex([2, 2, 2], g.dims)] = 0;
  assert.equal(fillHoles(g, shell).count, 27);
  const open = shell.slice(); open[voxelIndex([2, 2, 1], g.dims)] = 0;
  assert.equal(fillHoles(g, open).count, 25);
  const tiny = grid([3, 3, 3]), corners = new Uint8Array(27).fill(1); corners[0] = corners[13] = 0;
  assert.equal(fillHoles(tiny, corners, { connectivity: 6 }).count, 26);
  assert.equal(fillHoles(tiny, corners, { connectivity: 26 }).count, 25);
  assert.equal(fillHoles(g, new Uint8Array(125)).count, 0);
});

test('single-plane holes and seeded cavity fills are distinct operations', () => {
  const g = grid([5, 5, 3]), ring = box(g, [1, 1, 1], [3, 3, 1]); ring[voxelIndex([2, 2, 1], g.dims)] = 0;
  assert.equal(fillHoles(g, ring).count, 8); // The interior reaches the previous slice in 3D.
  assert.equal(fillHoles(g, ring, { plane: { axis: 2, index: 1 } }).count, 9);
  const full = new Uint8Array(g.data.length).fill(1); full[voxelIndex([1, 2, 1], g.dims)] = full[voxelIndex([3, 2, 1], g.dims)] = 0;
  assert.equal(cavityFill(g, full, [1, 2, 1], { includeSource: false }).count, 1);
  assert.equal(cavityFill(g, full, [1, 2, 1]).count, g.data.length - 1);
  assert.throws(() => cavityFill(g, full, [0, 0, 0]), /背景/);
  const empty = new Uint8Array(g.data.length);
  assert.equal(cavityFill(g, empty, [2, 2, 1], { includeSource: false }).count, g.data.length);
});

test('keep largest has a stable explicit tie rule and crop includes both ROI endpoints', () => {
  const g = grid([7, 3, 1]), source = selected(g, [[0, 0, 0], [1, 0, 0], [5, 2, 0], [6, 2, 0]]), before = source.slice();
  assert.deepEqual(keepLargest(g, source).mask, selected(g, [[0, 0, 0], [1, 0, 0]]));
  assert.deepEqual(cropMask(g, source, { min: [1, 0, 0], max: [5, 2, 0] }).mask, selected(g, [[1, 0, 0], [5, 2, 0]]));
  assert.deepEqual(source, before);
  assert.equal(keepLargest(g, new Uint8Array(source.length)).count, 0);
});

test('statistics use the affine determinant, exclude nonfinite density, and report an empty mask honestly', () => {
  const g = grid([3, 1, 1], [2, 4, NaN], [99, 99, 99]);
  g.affine = [[2, 1, 0, 10], [0, 3, 0, 20], [0, 0, 4, 30], [0, 0, 0, 1]];
  const stats = maskStatistics(g, new Uint8Array(3).fill(1));
  assert.equal(stats.count, 3); assert.equal(stats.finiteCount, 2); assert.equal(stats.nonFiniteCount, 1);
  assert.equal(stats.volumeMm3, 72); assert.equal(stats.mean, 3); assert.equal(stats.standardDeviation, 1);
  assert.deepEqual(stats.centroidMm, [12, 20, 30]); assert.deepEqual(stats.bounds, { min: [0, 0, 0], max: [2, 0, 0] });
  const empty = maskStatistics(g, new Uint8Array(3));
  assert.equal(empty.count, 0); assert.equal(empty.mean, null); assert.equal(empty.bounds, null); assert.equal(empty.centroid, null);
});

test('temporary selection Apply updates only selected voxels, including local threshold removal', () => {
  const g = grid([4, 1, 1], [5, 10, 20, NaN]), active = Uint8Array.from([1, 1, 1, 1]), selection = Uint8Array.from([0, 1, 1, 1]);
  assert.deepEqual([...applySelection(g, active, selection, { operation: 'threshold', lower: 10, upper: 10 }).mask], [1, 1, 0, 0]);
  assert.deepEqual([...applySelection(g, active, selection, { operation: 'remove' }).mask], [1, 0, 0, 0]);
  assert.deepEqual([...applySelection(g, new Uint8Array(4), selection, { operation: 'add' }).mask], [0, 1, 1, 1]);
  assert.deepEqual([...active], [1, 1, 1, 1]);
});

test('slice copying replaces whole slices, clips the destination and supports zero for all remaining', () => {
  const g = grid([4, 3, 3]), selection = selected(g, [[1, 1, 1], [3, 2, 2]]), before = selection.slice();
  const copied = copySelectionSlices(g, selection, { axis: 2, index: 1 }, 1, 99).mask;
  assert.equal(copied[voxelIndex([1, 1, 2], g.dims)], 1); assert.equal(copied[voxelIndex([3, 2, 2], g.dims)], 0);
  const reverse = copySelectionSlices(g, selection, { axis: 0, index: 1 }, -1, 0).mask;
  assert.equal(reverse[voxelIndex([0, 1, 1], g.dims)], 1);
  assert.deepEqual(selection, before);
});

test('polygon rasterization uses a stated centre and boundary convention on any plane', () => {
  const g = grid([5, 5, 5]);
  assert.equal(polygonRaster(g, { axis: 2, index: 2 }, [[1, 1], [3, 1], [1, 3]]).count, 6);
  const concave = polygonRaster(g, { axis: 0, index: 2 }, [[1, 1], [3, 1], [3, 2], [2, 2], [2, 3], [1, 3]]);
  assert.equal(concave.count, 8); assert.equal(concave.mask[voxelIndex([2, 3, 3], g.dims)], 0);
  assert.equal(polygonRaster(g, { axis: 1, index: 1 }, [[-5, -5], [-3, -5], [-3, -3]]).count, 0);
  assert.throws(() => polygonRaster(g, { axis: 2, index: 1 }, [[0, 0], [NaN, 1], [2, 2]]), /顶点/);
});

test('independent signed-distance interpolation preserves anchors and creates an intermediate nested shape', () => {
  const g = grid([7, 7, 3]), selection = selected(g, [[3, 3, 0]]);
  const last = box(g, [1, 1, 2], [5, 5, 2]); for (let i = 0; i < selection.length; i++) selection[i] ||= last[i];
  const before = selection.slice(), result = interpolateMaskSlices(g, selection, 2, 0, 2);
  assert.equal(count(result.mask.slice(49, 98)), 9);
  assert.deepEqual(result.mask.slice(0, 49), selection.slice(0, 49)); assert.deepEqual(result.mask.slice(98), selection.slice(98));
  assert.deepEqual(selection, before);
  assert.equal(interpolateMaskSlices(g, new Uint8Array(selection.length), 2, 0, 2).count, 0);
  assert.throws(() => interpolateMaskSlices(g, selection, 2, 2, 0), /起点/);
});

test('identical interpolation anchors remain identical for coronal and sagittal orientations', () => {
  for (const axis of [0, 1] as const) {
    const g = grid([5, 5, 5], undefined, [1, 2, 3]), selection = new Uint8Array(125);
    const axes = [0, 1, 2].filter(a => a !== axis);
    for (const layer of [0, 4]) for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) {
      const p: Vec3 = [0, 0, 0]; p[axis] = layer; p[axes[0]] = x; p[axes[1]] = y; selection[voxelIndex(p, g.dims)] = 1;
    }
    const result = interpolateMaskSlices(g, selection, axis, 0, 4);
    assert.equal(result.count, 45);
  }
});

test('cancellation aborts without publishing a partial mutation and progress stays bounded', () => {
  const g = grid([100, 100, 1]); g.data.fill(10); const before = g.data.slice();
  let cancelled = false; const progress: number[] = [];
  assert.throws(() => threshold(g, 0, 20, { cancelled: () => cancelled, progress: f => { progress.push(f); if (f > 0) cancelled = true; } }), { name: 'AbortError' });
  assert.deepEqual(g.data, before); assert.ok(progress.every(f => f >= 0 && f <= 1));
  const source = new Uint8Array(g.data.length).fill(1), snapshot = source.slice();
  for (const run of [() => regionGrow(g, source, [0, 0, 0], { cancelled: () => true }), () => morphology(g, source, { operation: 'open', radius: 1, connectivity: 8, cancelled: () => true }), () => fillHoles(g, source, { cancelled: () => true })]) assert.throws(run, { name: 'AbortError' });
  assert.deepEqual(source, snapshot);
});
