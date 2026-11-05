import { requireGrid, voxelIndex } from './types.ts';
import { checkAlgorithmControl } from './segmentation.ts';
import type { AlgorithmControl, Axis, BinaryMask, SlicePlane, Vec3, VolumeGrid } from './types.ts';

export interface LiveWireOptions extends AlgorithmControl {
  gradientWeight?: number;
  attraction?: number;
  /** Reusable normalized cost maps in slice-local u-fastest order. Supply both or neither. */
  gradientCost?: Float32Array | Float64Array;
  laplacianCost?: Float32Array | Float64Array;
  allowedMask?: BinaryMask;
}
export interface LiveWireTree {
  plane: SlicePlane;
  axes: [Axis, Axis];
  width: number; height: number;
  seed: Vec3; seedIndex: number;
  distances: Float64Array;
  /** Slice-local predecessor index; -1 for unreachable, seed points to itself. */
  predecessors: Int32Array;
  gradientCost: Float64Array;
  laplacianCost: Float64Array;
  /** Native gradient normalization and zero-crossing thinning are recovered; Gaussian filtering remains independent. */
  preprocessing: 'recovered-gradient-crossing-independent-gaussian' | 'supplied-normalized-costs';
}

function sliceAxes(axis: Axis): [Axis, Axis] { return ([0, 1, 2] as Axis[]).filter(a => a !== axis) as [Axis, Axis]; }
function point(plane: SlicePlane, axes: [Axis, Axis], x: number, y: number): Vec3 {
  const p: Vec3 = [0, 0, 0]; p[plane.axis] = plane.index; p[axes[0]] = x; p[axes[1]] = y; return p;
}
function localIndex(p: Vec3, plane: SlicePlane, axes: [Axis, Axis], width: number, height: number): number {
  if (p.length !== 3 || p.some(v => !Number.isSafeInteger(v)) || p[plane.axis] !== plane.index || p[axes[0]] < 0 || p[axes[0]] >= width || p[axes[1]] < 0 || p[axes[1]] >= height) throw new Error('LiveWire 点必须是当前切片内的整数体素坐标。');
  return p[axes[0]] + width * p[axes[1]];
}
function parameters(options: LiveWireOptions): { weight: number; attraction: number } {
  const weight = options.gradientWeight ?? 0.6, attraction = options.attraction ?? 0;
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('LiveWire 梯度权重必须在 [0,1]。');
  // This is an explicit numerical bound of this implementation, not a recovered native UI range.
  if (!Number.isFinite(attraction) || Math.abs(attraction) > 50) throw new Error('LiveWire 吸引参数必须在 [-50,50]。');
  return { weight, attraction };
}

/** Recovered ZeroCrossingImageFilter 0x18001AF52–0x18001AFE5: four face neighbors, closest-to-zero endpoint, positive-direction tie. */
export function zeroCrossingCosts(laplacian: Float64Array, width: number, height: number, control: AlgorithmControl = {}, valid?: Uint8Array): Float64Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || laplacian.length !== width * height || valid && valid.length !== laplacian.length) throw new Error('零交叉图尺寸无效。');
  checkAlgorithmControl(control);
  const cost = new Float64Array(laplacian.length).fill(1), offsets = [[-1, 0], [0, -1], [1, 0], [0, 1]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = x + width * y, centre = laplacian[i];
      if ((i & 4095) === 0) checkAlgorithmControl(control);
      if (valid && !valid[i]) continue;
      if (!Number.isFinite(centre)) throw new Error('拉普拉斯图必须包含有限数。');
      for (let direction = 0; direction < 4; direction++) {
        const [dx, dy] = offsets[direction], xx = Math.max(0, Math.min(width - 1, x + dx)), yy = Math.max(0, Math.min(height - 1, y + dy)), j = xx + width * yy;
        if (valid && !valid[j]) continue;
        const neighbor = laplacian[j]; if (!Number.isFinite(neighbor)) throw new Error('拉普拉斯图必须包含有限数。');
        const crossing = centre < 0 && neighbor > 0 || centre > 0 && neighbor < 0 || centre === 0 && neighbor !== 0 || centre !== 0 && neighbor === 0;
        if (crossing && (Math.abs(neighbor) > Math.abs(centre) || Math.abs(neighbor) === Math.abs(centre) && direction >= 2)) { cost[i] = 0; break; }
      }
    }
    checkAlgorithmControl(control);
  }
  return cost;
}

/** MatLiveWire!0x180007FE3–0x1800080C9; orthogonal k=1/sqrt(2), diagonal k=1. */
export function liveWireEdgeCost(g0: number, g1: number, l0: number, l1: number, diagonal: boolean, gradientWeight: number, attraction: number): number {
  const values = [g0, g1, l0, l1];
  if (values.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('LiveWire 代价必须是 [0,1] 的有限数。');
  const { weight, attraction: a } = parameters({ gradientWeight, attraction });
  const g = (g0 + g1) * 0.5, l = (l0 + l1) * 0.5;
  return Math.exp(-(1 - g) * a) * ((1 - weight) * l + (diagonal ? 1 : Math.SQRT1_2) * weight * g) + Number.EPSILON;
}

interface HeapEntry { cost: number; index: number }
/** Stable tie ordering gives reproducible paths. The native heap's equal-cost ordering is unconfirmed. */
class MinHeap {
  private data: HeapEntry[] = [];
  private before(a: HeapEntry, b: HeapEntry): boolean { return a.cost < b.cost || a.cost === b.cost && a.index < b.index; }
  get length(): number { return this.data.length; }
  push(entry: HeapEntry): void {
    let i = this.data.length; this.data.push(entry);
    while (i > 0) { const p = (i - 1) >>> 1; if (!this.before(entry, this.data[p])) break; this.data[i] = this.data[p]; i = p; }
    this.data[i] = entry;
  }
  pop(): HeapEntry {
    const root = this.data[0], last = this.data.pop()!;
    if (this.data.length) {
      let i = 0;
      while (i * 2 + 1 < this.data.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.data.length && this.before(this.data[child + 1], this.data[child])) child++;
        if (!this.before(this.data[child], last)) break;
        this.data[i] = this.data[child]; i = child;
      }
      this.data[i] = last;
    }
    return root;
  }
}

function features(grid: VolumeGrid, plane: SlicePlane, axes: [Axis, Axis], valid: Uint8Array, options: LiveWireOptions): { gradient: Float64Array; laplacian: Float64Array } {
  const width = grid.dims[axes[0]], height = grid.dims[axes[1]], n = width * height;
  if (Boolean(options.gradientCost) !== Boolean(options.laplacianCost)) throw new Error('必须同时提供梯度和拉普拉斯代价图。');
  if (options.gradientCost && options.laplacianCost) {
    if (options.gradientCost.length !== n || options.laplacianCost.length !== n) throw new Error('LiveWire 代价图与切片尺寸不一致。');
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(options.gradientCost[i]) || options.gradientCost[i] < 0 || options.gradientCost[i] > 1 || !Number.isFinite(options.laplacianCost[i]) || options.laplacianCost[i] < 0 || options.laplacianCost[i] > 1) throw new Error('LiveWire 代价图必须在 [0,1]。');
      if ((i & 4095) === 0) checkAlgorithmControl(options);
    }
    return { gradient: Float64Array.from(options.gradientCost), laplacian: Float64Array.from(options.laplacianCost) };
  }
  const values = new Float64Array(n), gradient = new Float64Array(n), laplacian = new Float64Array(n), signedLaplacian = new Float64Array(n);
  let minimumIntensity = Infinity, maximumIntensity = -Infinity;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = x + width * y, value = grid.data[voxelIndex(point(plane, axes, x, y), grid.dims)];
    if (valid[i]) { values[i] = value; minimumIntensity = Math.min(minimumIntensity, value); maximumIntensity = Math.max(maximumIntensity, value); }
  }
  // Native _InitImage 0x180007634–0x1800076F8: Shift=-minimum, Scale=1/(maximum-minimum), or 0 for a constant image.
  const intensityRange = maximumIntensity - minimumIntensity;
  for (let i = 0; i < n; i++) if (valid[i]) values[i] = intensityRange > 0 ? (values[i] - minimumIntensity) / intensityRange : 0;
  let maximumGradient = 0;
  const sx = grid.spacing[axes[0]], sy = grid.spacing[axes[1]];
  const sample = (x: number, y: number, fallback: number): number => {
    const i = Math.min(width - 1, Math.max(0, x)) + width * Math.min(height - 1, Math.max(0, y));
    return valid[i] ? values[i] : fallback;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = x + width * y; if (!valid[i]) continue;
      const centre = values[i], left = sample(x - 1, y, centre), right = sample(x + 1, y, centre), up = sample(x, y - 1, centre), down = sample(x, y + 1, centre);
      gradient[i] = Math.hypot((right - left) / (2 * sx), (down - up) / (2 * sy));
      maximumGradient = Math.max(maximumGradient, gradient[i]);
      signedLaplacian[i] = (left - 2 * centre + right) / (sx * sx) + (up - 2 * centre + down) / (sy * sy);
      if (!Number.isFinite(gradient[i]) || !Number.isFinite(signedLaplacian[i])) throw new Error('LiveWire 强度和物理间距超出数值计算范围。');
    }
    checkAlgorithmControl(options);
  }
  for (let i = 0; i < n; i++) {
    // Native 0x1800077FA–0x180007823 + ShiftScale's 0x1800106C2: (G-Gmax)*(-1/Gmax), or zero when Gmax <= epsilon.
    gradient[i] = maximumGradient > Number.EPSILON ? 1 - gradient[i] / maximumGradient : 0;
    if ((i & 4095) === 0) checkAlgorithmControl(options);
  }
  // Native Gaussian smoothing ahead of this Laplacian is not yet reconstructed; do not claim full preprocessing equivalence.
  laplacian.set(zeroCrossingCosts(signedLaplacian, width, height, options, valid));
  return { gradient, laplacian };
}

/** Builds a reusable complete 8-neighbor Dijkstra predecessor tree for one immutable slice snapshot. */
export function calculateLiveWire(grid: VolumeGrid, plane: SlicePlane, seed: Vec3, options: LiveWireOptions = {}): LiveWireTree {
  requireGrid(grid); if (options.allowedMask) requireGrid(grid, options.allowedMask);
  if (![0, 1, 2].includes(plane.axis) || !Number.isSafeInteger(plane.index) || plane.index < 0 || plane.index >= grid.dims[plane.axis]) throw new Error('LiveWire 切片无效。');
  const axes = sliceAxes(plane.axis), width = grid.dims[axes[0]], height = grid.dims[axes[1]], n = width * height;
  if (n > 0x7fffffff) throw new Error('LiveWire 切片超过索引容量。');
  const first = localIndex(seed, plane, axes, width, height), { weight, attraction } = parameters(options);
  checkAlgorithmControl(options, 0);
  const valid = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const global = voxelIndex(point(plane, axes, x, y), grid.dims);
      valid[x + width * y] = Number(Number.isFinite(grid.data[global]) && (!options.allowedMask || options.allowedMask[global] !== 0));
    }
    checkAlgorithmControl(options);
  }
  if (!valid[first]) throw new Error('LiveWire 种子必须具有有限强度并位于允许区域。');
  const { gradient, laplacian } = features(grid, plane, axes, valid, options);
  const distances = new Float64Array(n); distances.fill(Infinity);
  const predecessors = new Int32Array(n); predecessors.fill(-1);
  const closed = new Uint8Array(n), heap = new MinHeap();
  distances[first] = 0; predecessors[first] = first; heap.push({ cost: 0, index: first });
  let settled = 0, popped = 0;
  while (heap.length) {
    if ((popped++ & 1023) === 0) checkAlgorithmControl(options, settled / n);
    const current = heap.pop(), i = current.index;
    if (closed[i] || current.cost !== distances[i]) continue;
    closed[i] = 1; settled++;
    const x = i % width, y = Math.floor(i / width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
      const j = xx + width * yy;
      if (!valid[j] || closed[j]) continue;
      // Keep the recovered k on the gradient term only. This is deliberately not Euclidean step length.
      const g = (gradient[i] + gradient[j]) * 0.5, l = (laplacian[i] + laplacian[j]) * 0.5;
      const delta = Math.exp(-(1 - g) * attraction) * ((1 - weight) * l + (dx && dy ? 1 : Math.SQRT1_2) * weight * g) + Number.EPSILON;
      const cost = current.cost + delta;
      if (cost < distances[j]) { distances[j] = cost; predecessors[j] = i; heap.push({ cost, index: j }); }
    }
  }
  checkAlgorithmControl(options, 1);
  return { plane: { ...plane }, axes, width, height, seed: [...seed], seedIndex: first, distances, predecessors,
    gradientCost: gradient, laplacianCost: laplacian,
    preprocessing: options.gradientCost ? 'supplied-normalized-costs' : 'recovered-gradient-crossing-independent-gaussian' };
}

/** Returns seed → target including both endpoints, or [] for an unreachable target. */
export function liveWirePath(tree: LiveWireTree, target: Vec3, control: AlgorithmControl = {}): Vec3[] {
  const n = tree.width * tree.height;
  if (!Number.isSafeInteger(n) || n <= 0 || tree.predecessors.length !== n || tree.distances.length !== n) throw new Error('LiveWire 路径树尺寸无效。');
  const final = localIndex(target, tree.plane, tree.axes, tree.width, tree.height);
  checkAlgorithmControl(control, 0);
  if (!Number.isFinite(tree.distances[final])) { checkAlgorithmControl(control, 1); return []; }
  const path: Vec3[] = []; let i = final;
  for (let steps = 0; steps <= n; steps++) {
    if ((steps & 1023) === 0) checkAlgorithmControl(control);
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error('LiveWire 前驱索引损坏。');
    path.push(point(tree.plane, tree.axes, i % tree.width, Math.floor(i / tree.width)));
    if (i === tree.seedIndex) { path.reverse(); checkAlgorithmControl(control, 1); return path; }
    const previous = tree.predecessors[i];
    if (previous < 0 || previous >= n || Math.abs(previous % tree.width - i % tree.width) > 1 || Math.abs(Math.floor(previous / tree.width) - Math.floor(i / tree.width)) > 1) throw new Error('LiveWire 前驱连接损坏。');
    i = previous;
  }
  throw new Error('LiveWire 前驱路径存在环。');
}
