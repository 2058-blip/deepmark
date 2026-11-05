import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateLiveWire, liveWireEdgeCost, liveWirePath, zeroCrossingCosts } from '../src/mimics/livewire.ts';
import type { Vec3, VolumeGrid } from '../src/mimics/types.ts';

function grid(dims: Vec3, spacing: Vec3 = [1, 1, 1]): VolumeGrid { return { dims, spacing, data: new Float32Array(dims[0] * dims[1] * dims[2]) }; }
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('recovered LiveWire cost keeps the special orthogonal factor only on the gradient term', () => {
  close(liveWireEdgeCost(1, 1, 0, 0, false, 1, 0), 0.7071067811865476 + Number.EPSILON);
  close(liveWireEdgeCost(1, 1, 0, 0, true, 1, 0), 1 + Number.EPSILON);
  close(liveWireEdgeCost(0, 0, 1, 1, false, 0, Math.log(2)), 0.5 + Number.EPSILON);
  // With weight zero, orthogonal and diagonal steps have the SAME cost; no hidden sqrt(2) multiplier.
  assert.equal(liveWireEdgeCost(0.3, 0.7, 0.2, 0.8, false, 0, 0), liveWireEdgeCost(0.3, 0.7, 0.2, 0.8, true, 0, 0));
  assert.throws(() => liveWireEdgeCost(-1, 1, 0, 0, false, 1, 0), /代价/);
});

test('Dijkstra tree yields the analytic shortest cost on a constant 8-neighbour field', () => {
  const g = grid([5, 4, 1]), costs = new Float64Array(20).fill(1);
  const tree = calculateLiveWire(g, { axis: 2, index: 0 }, [0, 0, 0], { gradientCost: costs, laplacianCost: costs, gradientWeight: 1 });
  close(tree.distances[3 + 5 * 2], 2 + Math.SQRT1_2 + 3 * Number.EPSILON);
  const path = liveWirePath(tree, [3, 2, 0]);
  assert.equal(path.length, 4); assert.deepEqual(path[0], [0, 0, 0]); assert.deepEqual(path.at(-1), [3, 2, 0]);
  for (let i = 1; i < path.length; i++) assert.ok(path[i].every((v, a) => Math.abs(v - path[i - 1][a]) <= 1));
  assert.deepEqual(liveWirePath(tree, [3, 2, 0]), path);
  assert.deepEqual(liveWirePath(tree, [0, 0, 0]), [[0, 0, 0]]);
});

test('shortest paths prefer an inexpensive edge corridor instead of the straight high-cost route', () => {
  const g = grid([5, 5, 1]), gradient = new Float64Array(25).fill(1), laplacian = new Float64Array(25).fill(1);
  gradient.fill(0, 5, 10);
  const tree = calculateLiveWire(g, { axis: 2, index: 0 }, [0, 2, 0], { gradientCost: gradient, laplacianCost: laplacian, gradientWeight: 1 });
  const path = liveWirePath(tree, [4, 2, 0]);
  assert.ok(path.some(p => p[1] === 1)); assert.ok(tree.distances[14] < 4 * Math.SQRT1_2);
  assert.deepEqual(path[0], [0, 2, 0]); assert.deepEqual(path.at(-1), [4, 2, 0]);
});

test('nonfinite voxels and an explicit allowed mask form barriers with honest unreachable results', () => {
  const g = grid([5, 3, 1]); for (let y = 0; y < 3; y++) g.data[2 + 5 * y] = NaN;
  const tree = calculateLiveWire(g, { axis: 2, index: 0 }, [0, 1, 0]);
  assert.deepEqual(liveWirePath(tree, [4, 1, 0]), []);
  assert.equal(tree.predecessors[9], -1); assert.equal(tree.distances[9], Infinity);
  assert.throws(() => calculateLiveWire(g, { axis: 2, index: 0 }, [2, 1, 0]), /有限强度/);
  g.data.fill(0); const allowed = new Uint8Array(15).fill(1); for (let y = 0; y < 3; y++) allowed[2 + 5 * y] = 0;
  const restricted = calculateLiveWire(g, { axis: 2, index: 0 }, [0, 1, 0], { allowedMask: allowed });
  assert.deepEqual(liveWirePath(restricted, [4, 1, 0]), []);
});

test('every orthogonal slice returns voxel coordinates in that plane and snapshots costs without aliases', () => {
  const g = grid([4, 4, 4]);
  for (const axis of [0, 1, 2] as const) {
    const axes = [0, 1, 2].filter(a => a !== axis), seed: Vec3 = [0, 0, 0], target: Vec3 = [3, 3, 3]; seed[axis] = target[axis] = 2;
    const costs = new Float64Array(16).fill(0.5), copy = costs.slice();
    const tree = calculateLiveWire(g, { axis, index: 2 }, seed, { gradientCost: costs, laplacianCost: costs });
    const path = liveWirePath(tree, target); assert.ok(path.every(p => p[axis] === 2));
    assert.equal(tree.width, g.dims[axes[0]]); assert.deepEqual(path.at(-1), target); assert.deepEqual(costs, copy);
    costs.fill(0); g.data.fill(100);
    assert.ok(tree.gradientCost.every(v => v === 0.5)); assert.deepEqual(liveWirePath(tree, target), path);
  }
});

test('automatic feature maps state their independent origin and account for physical spacing', () => {
  const g = grid([5, 5, 1]);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) g.data[x + y * 5] = x * x + 3 * y * y;
  const original = g.data.slice(), isotropic = calculateLiveWire(g, { axis: 2, index: 0 }, [2, 2, 0]);
  const anisotropic = calculateLiveWire({ ...g, spacing: [1, 4, 1] }, { axis: 2, index: 0 }, [2, 2, 0]);
  assert.equal(isotropic.preprocessing, 'recovered-gradient-crossing-independent-gaussian');
  assert.notDeepEqual(isotropic.gradientCost, anisotropic.gradientCost);
  assert.ok([...isotropic.gradientCost, ...isotropic.laplacianCost].every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  assert.deepEqual(g.data, original);
});

test('recovered gradient ShiftScale produces zero for flat or sub-epsilon gradients and is intensity scale invariant', () => {
  const flat = grid([3, 3, 1]); flat.data.fill(500);
  assert.ok(calculateLiveWire(flat, { axis: 2, index: 0 }, [1, 1, 0]).gradientCost.every(v => v === 0));
  const ramp = grid([3, 3, 1]); ramp.data.set([0, 1, 4, 0, 1, 4, 0, 1, 4]);
  const ordinary = calculateLiveWire(ramp, { axis: 2, index: 0 }, [1, 1, 0]);
  const transformed = { ...ramp, data: Float32Array.from(ramp.data, v => 100 + 10 * v) };
  const rescaled = calculateLiveWire(transformed, { axis: 2, index: 0 }, [1, 1, 0]);
  for (let i = 0; i < 9; i++) close(ordinary.gradientCost[i], rescaled.gradientCost[i]);
  close(ordinary.gradientCost[1], 0); close(ordinary.gradientCost[0], 0.75); close(ordinary.gradientCost[2], 0.25);
  const tiny = calculateLiveWire({ ...ramp, spacing: [1e16, 1e16, 1] }, { axis: 2, index: 0 }, [1, 1, 0]);
  assert.ok(tiny.gradientCost.every(v => v === 0));
});

test('recovered zero crossing places a thin edge on the closest-to-zero side with a deterministic tie', () => {
  assert.deepEqual([...zeroCrossingCosts(Float64Array.from([-2, 1]), 2, 1)], [1, 0]);
  assert.deepEqual([...zeroCrossingCosts(Float64Array.from([-1, 1]), 2, 1)], [0, 1]);
  assert.deepEqual([...zeroCrossingCosts(Float64Array.from([-1, 0, 1]), 3, 1)], [1, 0, 1]);
  assert.deepEqual([...zeroCrossingCosts(new Float64Array(4), 2, 2)], [1, 1, 1, 1]);
  assert.deepEqual([...zeroCrossingCosts(Float64Array.from([-1, 2, 2, 1]), 2, 2)], [0, 1, 1, 1]);
});

test('LiveWire rejects malformed parameters and corrupted predecessor loops', () => {
  const g = grid([3, 3, 1]), plane = { axis: 2 as const, index: 0 };
  assert.throws(() => calculateLiveWire(g, plane, [0, 0, 0], { gradientWeight: NaN }), /权重/);
  assert.throws(() => calculateLiveWire(g, plane, [0, 0, 0], { gradientWeight: 2 }), /权重/);
  assert.throws(() => calculateLiveWire(g, plane, [0, 0, 0], { attraction: Infinity }), /吸引/);
  assert.throws(() => calculateLiveWire(g, plane, [0, 0, 0], { gradientCost: new Float64Array(9) }), /同时/);
  assert.throws(() => calculateLiveWire(g, plane, [0, 0, 0], { gradientCost: new Float64Array(8), laplacianCost: new Float64Array(8) }), /尺寸/);
  const bad = new Float64Array(9); bad[3] = NaN;
  assert.throws(() => calculateLiveWire(g, plane, [0, 0, 0], { gradientCost: bad, laplacianCost: new Float64Array(9) }), /代价图/);
  assert.throws(() => calculateLiveWire(g, plane, [0.5, 0, 0]), /整数/);
  assert.throws(() => calculateLiveWire({ ...g, spacing: [1e-300, 1, 1] }, plane, [0, 0, 0]), /数值计算范围/);
  const tree = calculateLiveWire(g, plane, [0, 0, 0]); tree.predecessors[8] = 7; tree.predecessors[7] = 8;
  assert.throws(() => liveWirePath(tree, [2, 2, 0]), /环/);
  assert.throws(() => liveWirePath(tree, [2, 2, 1]), /当前切片/);
});

test('cancellation leaves image and supplied feature maps intact', () => {
  const g = grid([40, 40, 1]), costs = new Float64Array(1600).fill(1), before = g.data.slice();
  let cancelled = false;
  assert.throws(() => calculateLiveWire(g, { axis: 2, index: 0 }, [0, 0, 0], {
    gradientCost: costs, laplacianCost: costs, cancelled: () => cancelled,
    progress: f => { assert.ok(f >= 0 && f <= 1); if (f > 0) cancelled = true; },
  }), { name: 'AbortError' });
  assert.deepEqual(g.data, before); assert.ok(costs.every(v => v === 1));
});
