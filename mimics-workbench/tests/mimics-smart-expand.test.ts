import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomWalker, smartExpand } from '../src/mimics/smartExpand.ts';
import type { Vec3, VolumeGrid } from '../src/mimics/types.ts';
import { voxelIndex } from '../src/mimics/types.ts';

function grid(dims: Vec3, values?: number[], spacing: Vec3 = [1, 1, 1]): VolumeGrid { return { dims, spacing, data: values ? Float32Array.from(values) : new Float32Array(dims[0] * dims[1] * dims[2]).fill(100) }; }
function mask(g: VolumeGrid, points: Vec3[]): Uint8Array { const m = new Uint8Array(g.data.length); for (const p of points) m[voxelIndex(p, g.dims)] = 1; return m; }
const near = (a: number, b: number, tolerance = 2e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test('Dirichlet line probabilities have an analytic linear solution and preserve hard constraints', () => {
  const g = grid([5, 1, 1]), fg = mask(g, [[0, 0, 0]]), bg = mask(g, [[4, 0, 0]]), snapshot = fg.slice();
  const r = randomWalker(g, fg, bg, { edgeSensitivity: 0 });
  [1, 0.75, 0.5, 0.25, 0].forEach((p, i) => near(r.probabilities[i], p));
  assert.deepEqual([...r.mask], [1, 1, 0, 0, 0]); assert.ok(r.converged); assert.ok(r.residualNorm < 1e-6);
  assert.deepEqual(fg, snapshot); assert.equal(r.unknownCount, 3);
});

test('strict probability threshold excludes equality and foreground takes precedence over background', () => {
  const g = grid([3, 1, 1]), fg = mask(g, [[0, 0, 0]]), bg = mask(g, [[2, 0, 0], [0, 0, 0]]);
  const r = randomWalker(g, fg, bg, { edgeSensitivity: 0, foregroundPercentage: 50 });
  assert.deepEqual([...r.probabilities], [1, 0.5, 0]); assert.deepEqual([...r.mask], [1, 0, 0]);
});

test('edge weights change harmonic probabilities at an intensity discontinuity', () => {
  const g = grid([3, 1, 1], [0, 0, 100]), fg = mask(g, [[0, 0, 0]]), bg = mask(g, [[2, 0, 0]]);
  const neutral = randomWalker(g, fg, bg, { edgeSensitivity: 0 }), weighted = randomWalker(g, fg, bg, { edgeSensitivity: 4 });
  near(neutral.probabilities[1], 0.5);
  near(weighted.probabilities[1], 1 / (1 + Math.exp(-4)));
  assert.equal(weighted.mask[1], 1); assert.ok(weighted.converged);
});

test('matrix graph uses 6 neighbors and spacing affects expansion bounds rather than random-walker edge lengths', () => {
  const g = grid([3, 2, 1]), fg = mask(g, [[0, 0, 0]]), bg = mask(g, [[2, 0, 0], [2, 1, 0]]);
  const r = randomWalker(g, fg, bg, { edgeSensitivity: 0 }), stretched = randomWalker({ ...g, spacing: [1, 99, 3] }, fg, bg, { edgeSensitivity: 0 });
  assert.deepEqual(r.probabilities, stretched.probabilities);
  // Solving the three unknown-node Kirchhoff equations by hand gives 6/13, 9/13, 5/13.
  near(r.probabilities[1], 6 / 13); near(r.probabilities[3], 9 / 13); near(r.probabilities[4], 5 / 13);
});

test('native uint16 encoding retains signed-short packing and float extension supports negative HU', () => {
  const g = grid([3, 1, 1], [65535, 0, 100]), fg = mask(g, [[0, 0, 0]]), bg = mask(g, [[2, 0, 0]]);
  const native = randomWalker(g, fg, bg, { edgeSensitivity: 1, intensityEncoding: 'native-uint16' });
  const signed = randomWalker({ ...g, data: Float32Array.from([-1, 0, 100]) }, fg, bg, { edgeSensitivity: 1, intensityEncoding: 'float' });
  assert.deepEqual(native.probabilities, signed.probabilities); assert.equal(native.normalizationMaximum, 100);
  assert.throws(() => randomWalker({ ...g, data: Float32Array.from([-1, 0, 100]) }, fg, bg, { intensityEncoding: 'native-uint16' }), /uint16/);
});

test('nonfinite float voxels form barriers and zero-weight components retain the recovered 0.5 initial value', () => {
  const g = grid([5, 1, 1], [10, 10, NaN, 10, 10]), fg = mask(g, [[0, 0, 0]]), bg = mask(g, [[4, 0, 0]]);
  const r = randomWalker(g, fg, bg, { edgeSensitivity: 0 });
  assert.deepEqual([...r.probabilities], [1, 1, 0, 0, 0]); assert.ok(r.converged);
  const disconnected = grid([3, 1, 1], [0, 100, 0]);
  const zero = randomWalker(disconnected, mask(disconnected, [[0, 0, 0]]), mask(disconnected, [[2, 0, 0]]));
  assert.equal(zero.probabilities[1], 0.5); assert.equal(zero.mask[1], 0); assert.ok(zero.converged);
});

test('Smart Expand computes probabilities inside a distance-limited domain, not the dilation output', () => {
  const g = grid([9, 1, 1]), source = mask(g, [[4, 0, 0]]), before = source.slice();
  const r = smartExpand(g, source, { maximumDistance: 2, edgeSensitivity: 0 });
  near(r.probabilities[3], 2 / 3); near(r.probabilities[2], 1 / 3);
  assert.deepEqual([...r.mask], [0, 0, 0, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(r.roi, { min: [1, 0, 0], max: [7, 0, 0] }); assert.deepEqual(source, before);
  assert.equal(smartExpand(g, source, { maximumDistance: 2, edgeSensitivity: 0, foregroundPercentage: 50 }).count, 3);
});

test('native maximum-distance mapping truncates thick-slice radius and leaves other layers background', () => {
  const g = grid([5, 5, 3], undefined, [1, 1, 4]), source = mask(g, [[2, 2, 1]]);
  const r = smartExpand(g, source, { maximumDistance: 1, edgeSensitivity: 0, foregroundPercentage: 0 });
  assert.equal(r.count, 9);
  for (let i = 0; i < r.mask.length; i++) if (r.mask[i]) assert.equal(Math.floor(i / 25), 1);
});

test('unfinished solves expose convergence failure, and cancellation never mutates inputs', () => {
  const g = grid([11, 1, 1]), fg = mask(g, [[0, 0, 0]]), bg = mask(g, [[10, 0, 0]]), before = fg.slice();
  const early = randomWalker(g, fg, bg, { edgeSensitivity: 0, maxIterations: 1 });
  assert.equal(early.converged, false); assert.equal(early.iterations, 1); assert.ok(early.residualNorm > 1e-6);
  let cancel = false;
  assert.throws(() => smartExpand(g, fg, { maximumDistance: 2, cancelled: () => cancel, progress: f => { if (f > 0) cancel = true; } }), { name: 'AbortError' });
  assert.deepEqual(fg, before);
  assert.throws(() => smartExpand(g, new Uint8Array(11), { maximumDistance: 2 }), /为空/);
  assert.throws(() => smartExpand(g, fg, { maximumDistance: 0 }), /距离/);
  assert.throws(() => randomWalker(g, fg, bg, { tolerance: 0 }), /容差/);
});
