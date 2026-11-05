import { physicalPoint, requireGrid, voxelIndex, voxelPoint } from './types.ts';
import type { AlgorithmControl, Axis, BinaryMask, MaskResult, RegionBounds, SlicePlane, Vec3, VolumeGrid } from './types.ts';

/** Cooperative cancellation never publishes a partial result or modifies an input. */
export class AlgorithmCancelledError extends Error {
  constructor() { super('操作已取消。'); this.name = 'AbortError'; }
}
export function checkAlgorithmControl(control: AlgorithmControl = {}, fraction?: number): void {
  if (control.cancelled?.()) throw new AlgorithmCancelledError();
  if (fraction !== undefined) control.progress?.(Math.max(0, Math.min(1, fraction)));
  if (control.cancelled?.()) throw new AlgorithmCancelledError();
}

export interface SelectionDomain extends AlgorithmControl { roi?: RegionBounds; plane?: SlicePlane }
export interface GrowOptions extends SelectionDomain { connectivity?: 6 | 26 }
interface Domain { min: Vec3; max: Vec3; plane?: SlicePlane }

function domainOf(grid: VolumeGrid, options: SelectionDomain = {}): Domain {
  requireGrid(grid);
  const min: Vec3 = options.roi ? [...options.roi.min] : [0, 0, 0];
  const max: Vec3 = options.roi ? [...options.roi.max] : grid.dims.map(n => n - 1) as Vec3;
  for (let a = 0; a < 3; a++) {
    if (!Number.isSafeInteger(min[a]) || !Number.isSafeInteger(max[a]) || min[a] < 0 || max[a] >= grid.dims[a] || min[a] > max[a]) throw new Error('ROI 必须是影像内包含端点的整数体素范围。');
  }
  if (options.plane) {
    const { axis, index } = options.plane;
    if (![0, 1, 2].includes(axis) || !Number.isSafeInteger(index) || index < min[axis] || index > max[axis]) throw new Error('切片不在影像或 ROI 范围内。');
    min[axis] = max[axis] = index;
  }
  return { min, max, plane: options.plane };
}
function contains(p: readonly number[], d: Domain): boolean {
  return p.every((v, a) => Number.isSafeInteger(v) && v >= d.min[a] && v <= d.max[a]);
}
function seedIndex(grid: VolumeGrid, seed: Vec3, domain: Domain): number {
  if (seed.length !== 3 || !contains(seed, domain)) throw new Error('种子必须是处理范围内的整数体素坐标。');
  return voxelIndex(seed, grid.dims);
}
function connectivityOf(options: GrowOptions): 6 | 26 {
  const c = options.connectivity ?? 6;
  if (c !== 6 && c !== 26) throw new Error('连通度必须为 6 或 26。');
  return c;
}
function finiteRange(lower: number, upper: number): void {
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) throw new Error('强度上下限必须有限且下限不大于上限。');
}
function resultOf(mask: BinaryMask, control: AlgorithmControl = {}): MaskResult {
  let count = 0;
  for (let i = 0; i < mask.length; i++) { if (mask[i]) count++; if ((i & 16383) === 0) checkAlgorithmControl(control); }
  checkAlgorithmControl(control, 1);
  return { mask, count };
}
function binaryCopy(mask: BinaryMask): BinaryMask { return Uint8Array.from(mask, n => n ? 1 : 0); }

/** Confirmed comparison: lower <= intensity <= upper (MatImageOperations 0x180020A00). */
export function threshold(grid: VolumeGrid, lower: number, upper: number, options: SelectionDomain = {}): MaskResult {
  finiteRange(lower, upper);
  const domain = domainOf(grid, options), mask = new Uint8Array(grid.data.length);
  checkAlgorithmControl(options, 0);
  let count = 0, visited = 0;
  for (let z = domain.min[2]; z <= domain.max[2]; z++) for (let y = domain.min[1]; y <= domain.max[1]; y++) {
    const start = voxelIndex([domain.min[0], y, z], grid.dims), end = start + domain.max[0] - domain.min[0];
    for (let i = start; i <= end; i++) {
      const v = grid.data[i];
      if (Number.isFinite(v) && v >= lower && v <= upper) { mask[i] = 1; count++; }
      if ((++visited & 4095) === 0) checkAlgorithmControl(options, visited / grid.data.length);
    }
  }
  checkAlgorithmControl(options, 1);
  return { mask, count };
}

interface Run { start: number; end: number; y: number; z: number; visited: boolean }
interface Runs { rows: Map<number, number[]>; runs: Run[]; width: number; height: number; domain: Domain }
/** X-directed maximal segments. Source bits are never cleared to mark visitation. */
function scanRuns(grid: VolumeGrid, domain: Domain, belongs: (i: number) => boolean, control: AlgorithmControl): Runs {
  const rows = new Map<number, number[]>(), runs: Run[] = [];
  const [width, height] = grid.dims;
  let steps = 0;
  for (let z = domain.min[2]; z <= domain.max[2]; z++) for (let y = domain.min[1]; y <= domain.max[1]; y++) {
    let x = domain.min[0]; const ids: number[] = [];
    while (x <= domain.max[0]) {
      if ((++steps & 4095) === 0) checkAlgorithmControl(control);
      if (!belongs(x + width * (y + height * z))) { x++; continue; }
      const start = x++;
      while (x <= domain.max[0] && belongs(x + width * (y + height * z))) { x++; if ((++steps & 4095) === 0) checkAlgorithmControl(control); }
      ids.push(runs.length); runs.push({ start, end: x - 1, y, z, visited: false });
    }
    if (ids.length) rows.set(y + height * z, ids);
  }
  return { rows, runs, width, height, domain };
}
function findRun(rle: Runs, seed: Vec3): number | undefined {
  return rle.rows.get(seed[1] + rle.height * seed[2])?.find(id => rle.runs[id].start <= seed[0] && rle.runs[id].end >= seed[0]);
}
function traverseRuns(rle: Runs, seeds: number[], connectivity: 6 | 26, control: AlgorithmControl, visit?: (run: Run) => void): number[] {
  const queue: number[] = [];
  for (const id of seeds) if (!rle.runs[id].visited) { rle.runs[id].visited = true; queue.push(id); }
  for (let head = 0; head < queue.length; head++) {
    if ((head & 1023) === 0) checkAlgorithmControl(control);
    const run = rle.runs[queue[head]]; visit?.(run);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
      if ((!dy && !dz) || connectivity === 6 && Math.abs(dy) + Math.abs(dz) !== 1) continue;
      const y = run.y + dy, z = run.z + dz;
      if (y < rle.domain.min[1] || y > rle.domain.max[1] || z < rle.domain.min[2] || z > rle.domain.max[2]) continue;
      const extra = connectivity === 26 ? 1 : 0;
      const neighbors = rle.rows.get(y + rle.height * z);
      if (!neighbors) continue;
      // Segments are sorted; binary search avoids scanning a long row for every run.
      let lo = 0, hi = neighbors.length;
      while (lo < hi) { const m = (lo + hi) >>> 1; if (rle.runs[neighbors[m]].end < run.start - extra) lo = m + 1; else hi = m; }
      for (let j = lo; j < neighbors.length; j++) {
        const id = neighbors[j], other = rle.runs[id];
        if (other.start > run.end + extra) break;
        if (!other.visited) { other.visited = true; queue.push(id); }
      }
    }
  }
  return queue;
}
function paintRun(mask: BinaryMask, rle: Runs, run: Run): void {
  const offset = rle.width * (run.y + rle.height * run.z);
  mask.fill(1, offset + run.start, offset + run.end + 1);
}

/** Extracts one connected source component with a scan-segment queue, never an intensity threshold. */
export function regionGrow(grid: VolumeGrid, source: BinaryMask, seed: Vec3, options: GrowOptions = {}): MaskResult {
  requireGrid(grid, source);
  const domain = domainOf(grid, options), connectivity = connectivityOf(options);
  const seedId = seedIndex(grid, seed, domain), mask = new Uint8Array(source.length);
  checkAlgorithmControl(options, 0);
  if (!source[seedId]) return resultOf(mask, options);
  const rle = scanRuns(grid, domain, i => source[i] !== 0, options), start = findRun(rle, seed)!;
  let count = 0;
  traverseRuns(rle, [start], connectivity, options, run => { paintRun(mask, rle, run); count += run.end - run.start + 1; });
  checkAlgorithmControl(options, 1);
  return { mask, count };
}

export interface DynamicGrowOptions extends GrowOptions {
  lowerDeviation: number; upperDeviation: number; updateMean?: boolean;
}
/** Confirmed strict predicate and permanent rejected visitation. FIFO, z/y/x neighbor order. */
export function dynamicRegionGrow(grid: VolumeGrid, seed: Vec3, options: DynamicGrowOptions): MaskResult {
  const domain = domainOf(grid, options), connectivity = connectivityOf(options), first = seedIndex(grid, seed, domain);
  if (![options.lowerDeviation, options.upperDeviation].every(v => Number.isFinite(v) && v >= 0)) throw new Error('偏差必须是有限非负数。');
  if (options.updateMean !== undefined && typeof options.updateMean !== 'boolean') throw new Error('在线均值开关必须为布尔值。');
  if (!Number.isFinite(grid.data[first])) throw new Error('种子强度必须是有限数。');
  checkAlgorithmControl(options, 0);
  const mask = new Uint8Array(grid.data.length), visited = new Uint8Array(Math.ceil(mask.length / 4));
  const queue: number[] = [first]; mask[first] = 1;
  const mark = (i: number, state: number) => { visited[i >>> 2] |= state << ((i & 3) * 2); };
  const seen = (i: number) => ((visited[i >>> 2] >>> ((i & 3) * 2)) & 1) !== 0;
  mark(first, 3);
  let mean = grid.data[first], count = 1, steps = 0;
  for (let head = 0; head < queue.length; head++) {
    if ((head & 1023) === 0) checkAlgorithmControl(options, head / mask.length);
    const p = voxelPoint(queue[head], grid.dims);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const distance = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      if (!distance || connectivity === 6 && distance !== 1) continue;
      const q: Vec3 = [p[0] + dx, p[1] + dy, p[2] + dz];
      if (!contains(q, domain)) continue;
      const i = voxelIndex(q, grid.dims);
      if (seen(i)) continue;
      mark(i, 1); // Rejected voxels must not be retried after the mean moves.
      const value = grid.data[i];
      if (Number.isFinite(value) && mean - options.lowerDeviation < value && value < mean + options.upperDeviation) {
        mark(i, 3); mask[i] = 1; queue.push(i);
        if (options.updateMean) mean += (value - mean) / (count + 1);
        count++;
      }
      if ((++steps & 4095) === 0) checkAlgorithmControl(options);
    }
  }
  checkAlgorithmControl(options, 1);
  return { mask, count };
}

export type BooleanOperation = 'union' | 'intersection' | 'subtract';
export function booleanMasks(a: BinaryMask, b: BinaryMask, operation: BooleanOperation, control: AlgorithmControl = {}): MaskResult {
  if (a.length !== b.length) throw new Error('Mask 尺寸不一致。');
  if (!['union', 'intersection', 'subtract'].includes(operation)) throw new Error('未知布尔操作。');
  checkAlgorithmControl(control, 0);
  const mask = new Uint8Array(a.length); let count = 0;
  for (let i = 0; i < mask.length; i++) {
    const selected = operation === 'union' ? a[i] || b[i] : operation === 'intersection' ? a[i] && b[i] : a[i] && !b[i];
    if (selected) { mask[i] = 1; count++; }
    if ((i & 4095) === 0) checkAlgorithmControl(control, i / Math.max(1, mask.length));
  }
  checkAlgorithmControl(control, 1);
  return { mask, count };
}

export interface MorphologyOptions extends AlgorithmControl {
  operation: 'erode' | 'dilate' | 'open' | 'close';
  radius: number; connectivity: 8 | 26; limitMask?: BinaryMask; plane?: SlicePlane;
  /** Default pixels: physical radius = radius * smallest spacing in the processing plane. */
  units?: 'pixels' | 'mm';
}
/** Independent physical Chebyshev kernel; the native structuring element is not fully recovered. */
export function morphology(grid: VolumeGrid, source: BinaryMask, options: MorphologyOptions): MaskResult {
  requireGrid(grid, source);
  if (options.limitMask) requireGrid(grid, options.limitMask);
  if (!['erode', 'dilate', 'open', 'close'].includes(options.operation)) throw new Error('未知形态学操作。');
  if (!Number.isFinite(options.radius) || options.radius < 0) throw new Error('形态学半径必须是有限非负数。');
  if (options.connectivity !== 8 && options.connectivity !== 26) throw new Error('形态学连通度必须为 8 或 26。');
  if (options.units !== undefined && options.units !== 'pixels' && options.units !== 'mm') throw new Error('未知半径单位。');
  const domain = domainOf(grid, options), fixedAxis = options.plane?.axis ?? 2;
  const planeAxes = ([0, 1, 2] as Axis[]).filter(a => a !== fixedAxis);
  const axes = options.connectivity === 8 || options.plane ? planeAxes : [0, 1, 2] as Axis[];
  const radiusMm = options.radius * (options.units === 'mm' ? 1 : Math.min(...planeAxes.map(a => grid.spacing[a])));
  if (!Number.isFinite(radiusMm)) throw new Error('形态学物理半径过大。');
  const operations = options.operation === 'open' ? ['erode', 'dilate'] : options.operation === 'close' ? ['dilate', 'erode'] : [options.operation];
  const strides = [1, grid.dims[0], grid.dims[0] * grid.dims[1]], totalStages = operations.length * axes.length;
  let mask = binaryCopy(source), stage = 0;
  checkAlgorithmControl(options, 0);
  // Rectangular physical kernels are separable; sliding prefix sums keep work linear in image size.
  for (const operation of operations) for (const axis of axes) {
    const extent = Math.floor(radiusMm / grid.spacing[axis] + 1e-10);
    const next = mask.slice(), length = grid.dims[axis], stride = strides[axis];
    const prefix = new Float64Array(length + 1);
    const [lineU, lineV] = ([0, 1, 2] as Axis[]).filter(a => a !== axis);
    let lines = 0;
    for (let v = 0; v < grid.dims[lineV]; v++) for (let u = 0; u < grid.dims[lineU]; u++) {
      const p: Vec3 = [0, 0, 0]; p[lineU] = u; p[lineV] = v;
      if (options.plane && p[fixedAxis] !== options.plane.index) continue;
      const base = voxelIndex(p, grid.dims); prefix[0] = 0;
      for (let t = 0; t < length; t++) prefix[t + 1] = prefix[t] + mask[base + t * stride];
      for (let t = 0; t < length; t++) {
        const sum = prefix[Math.min(length, t + extent + 1)] - prefix[Math.max(0, t - extent)];
        next[base + t * stride] = operation === 'dilate' ? Number(sum > 0) : Number(sum === 2 * extent + 1);
      }
      if ((++lines & 255) === 0) checkAlgorithmControl(options);
    }
    mask = next; checkAlgorithmControl(options, ++stage / (totalStages + 1));
  }
  if (options.limitMask) for (let i = 0; i < mask.length; i++) {
    if (mask[i] && !options.limitMask[i] && (!options.plane || voxelPoint(i, grid.dims)[fixedAxis] === domain.min[fixedAxis])) mask[i] = 0;
    if ((i & 16383) === 0) checkAlgorithmControl(options);
  }
  return resultOf(mask, options);
}

/** Independent tie rule: earliest x-fastest component wins equal voxel counts. */
export function keepLargest(grid: VolumeGrid, source: BinaryMask, options: GrowOptions = {}): MaskResult {
  requireGrid(grid, source);
  const domain = domainOf(grid, options), connectivity = connectivityOf(options), mask = new Uint8Array(source.length);
  checkAlgorithmControl(options, 0);
  const rle = scanRuns(grid, domain, i => source[i] !== 0, options);
  let largest: number[] = [], count = 0;
  for (let id = 0; id < rle.runs.length; id++) if (!rle.runs[id].visited) {
    let size = 0;
    const component = traverseRuns(rle, [id], connectivity, options, run => { size += run.end - run.start + 1; });
    if (size > count) { count = size; largest = component; }
  }
  for (const id of largest) paintRun(mask, rle, rle.runs[id]);
  checkAlgorithmControl(options, 1);
  return { mask, count };
}

/** Boundary-connected background remains exterior. A plane uses only its two free axes. */
export function fillHoles(grid: VolumeGrid, source: BinaryMask, options: GrowOptions = {}): MaskResult {
  requireGrid(grid, source);
  const domain = domainOf(grid, options), connectivity = connectivityOf(options);
  checkAlgorithmControl(options, 0);
  const rle = scanRuns(grid, domain, i => !source[i], options), seeds: number[] = [];
  for (let id = 0; id < rle.runs.length; id++) {
    const r = rle.runs[id];
    if (domain.plane?.axis !== 0 && (r.start === domain.min[0] || r.end === domain.max[0]) ||
        domain.plane?.axis !== 1 && (r.y === domain.min[1] || r.y === domain.max[1]) ||
        domain.plane?.axis !== 2 && (r.z === domain.min[2] || r.z === domain.max[2])) seeds.push(id);
  }
  traverseRuns(rle, seeds, connectivity, options);
  const mask = binaryCopy(source);
  for (let id = 0; id < rle.runs.length; id++) {
    if (!rle.runs[id].visited) paintRun(mask, rle, rle.runs[id]);
    if ((id & 4095) === 0) checkAlgorithmControl(options);
  }
  return resultOf(mask, options);
}

export interface CavityOptions extends GrowOptions { /** true fills the source; false returns just the selected background component. */ includeSource?: boolean }
export function cavityFill(grid: VolumeGrid, source: BinaryMask, seed: Vec3, options: CavityOptions = {}): MaskResult {
  requireGrid(grid, source);
  if (options.includeSource !== undefined && typeof options.includeSource !== 'boolean') throw new Error('是否保留源 Mask 必须为布尔值。');
  const domain = domainOf(grid, options), first = seedIndex(grid, seed, domain), connectivity = connectivityOf(options);
  checkAlgorithmControl(options, 0);
  if (source[first]) throw new Error('腔体种子必须位于源 Mask 的背景中。');
  const rle = scanRuns(grid, domain, i => !source[i], options), mask = options.includeSource === false ? new Uint8Array(source.length) : binaryCopy(source);
  // A seed in an open cavity deliberately reaches exterior, matching the documented leakage boundary.
  traverseRuns(rle, [findRun(rle, seed)!], connectivity, options, run => paintRun(mask, rle, run));
  return resultOf(mask, options);
}

/** Independent explicit convention: integer voxel ROI includes both endpoints. */
export function cropMask(grid: VolumeGrid, source: BinaryMask, roi: RegionBounds, control: AlgorithmControl = {}): MaskResult {
  requireGrid(grid, source);
  const domain = domainOf(grid, { roi }), mask = new Uint8Array(source.length);
  checkAlgorithmControl(control, 0);
  for (let z = domain.min[2]; z <= domain.max[2]; z++) for (let y = domain.min[1]; y <= domain.max[1]; y++) {
    const start = voxelIndex([domain.min[0], y, z], grid.dims);
    for (let x = 0; x <= domain.max[0] - domain.min[0]; x++) mask[start + x] = source[start + x] ? 1 : 0;
    checkAlgorithmControl(control);
  }
  return resultOf(mask, control);
}

export interface MaskStatistics {
  count: number; finiteCount: number; nonFiniteCount: number;
  volumeMm3: number; voxelVolumeMm3: number; min: number | null; max: number | null;
  mean: number | null; standardDeviation: number | null; bounds: RegionBounds | null;
  centroid: Vec3 | null; centroidMm: Vec3 | null;
}
export function maskStatistics(grid: VolumeGrid, mask: BinaryMask, control: AlgorithmControl = {}): MaskStatistics {
  requireGrid(grid, mask); checkAlgorithmControl(control, 0);
  let voxelVolumeMm3 = grid.spacing.reduce((a, b) => a * b, 1);
  if (grid.affine) {
    const a = grid.affine;
    if (a.length < 3 || a.slice(0, 3).some(row => row.length < 4 || row.slice(0, 4).some(v => !Number.isFinite(v)))) throw new Error('物理坐标变换无效。');
    voxelVolumeMm3 = Math.abs(a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]));
  }
  if (!Number.isFinite(voxelVolumeMm3) || voxelVolumeMm3 <= 0) throw new Error('体素物理体积无效。');
  let count = 0, finiteCount = 0, mean = 0, m2 = 0, min = Infinity, max = -Infinity;
  const low: Vec3 = [...grid.dims], high: Vec3 = [-1, -1, -1], sums: Vec3 = [0, 0, 0];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      count++; const p = voxelPoint(i, grid.dims);
      for (let a = 0; a < 3; a++) { sums[a] += p[a]; low[a] = Math.min(low[a], p[a]); high[a] = Math.max(high[a], p[a]); }
      const value = grid.data[i];
      if (Number.isFinite(value)) {
        finiteCount++; const delta = value - mean; mean += delta / finiteCount; m2 += delta * (value - mean);
        min = Math.min(min, value); max = Math.max(max, value);
      }
    }
    if ((i & 8191) === 0) checkAlgorithmControl(control, i / mask.length);
  }
  const centroid = count ? sums.map(s => s / count) as Vec3 : null;
  checkAlgorithmControl(control, 1);
  return { count, finiteCount, nonFiniteCount: count - finiteCount, voxelVolumeMm3, volumeMm3: count * voxelVolumeMm3,
    min: finiteCount ? min : null, max: finiteCount ? max : null, mean: finiteCount ? mean : null,
    standardDeviation: finiteCount ? Math.sqrt(Math.max(0, m2 / finiteCount)) : null,
    bounds: count ? { min: low, max: high } : null, centroid, centroidMm: centroid ? physicalPoint(centroid, grid) : null };
}

export interface ApplySelectionOptions extends AlgorithmControl { operation: 'add' | 'remove' | 'threshold'; lower?: number; upper?: number }
/** Selection is temporary data: Apply is the only operation which produces the updated active mask. */
export function applySelection(grid: VolumeGrid, active: BinaryMask, selection: BinaryMask, options: ApplySelectionOptions): MaskResult {
  requireGrid(grid, active); requireGrid(grid, selection);
  if (!['add', 'remove', 'threshold'].includes(options.operation)) throw new Error('未知选区操作。');
  if (options.operation === 'threshold') finiteRange(options.lower!, options.upper!);
  const mask = binaryCopy(active); checkAlgorithmControl(options, 0);
  for (let i = 0; i < mask.length; i++) {
    if (selection[i]) {
      const value = grid.data[i];
      mask[i] = options.operation === 'add' ? 1 : options.operation === 'remove' ? 0 : Number(Number.isFinite(value) && value >= options.lower! && value <= options.upper!);
    }
    if ((i & 4095) === 0) checkAlgorithmControl(options, i / mask.length);
  }
  return resultOf(mask, options);
}

function planeAxes(axis: Axis): [Axis, Axis] { return ([0, 1, 2] as Axis[]).filter(a => a !== axis) as [Axis, Axis]; }
function onPlane(plane: SlicePlane, u: number, v: number): Vec3 {
  const axes = planeAxes(plane.axis), p: Vec3 = [0, 0, 0]; p[plane.axis] = plane.index; p[axes[0]] = u; p[axes[1]] = v; return p;
}
/** Copies the complete source selection slice, including its deselected pixels. Zero means all remaining slices. */
export function copySelectionSlices(grid: VolumeGrid, selection: BinaryMask, plane: SlicePlane, direction: -1 | 1, count: number, control: AlgorithmControl = {}): MaskResult {
  requireGrid(grid, selection); domainOf(grid, { plane });
  if (direction !== -1 && direction !== 1 || !Number.isSafeInteger(count) || count < 0) throw new Error('复制方向或切片数量无效。');
  const [u, v] = planeAxes(plane.axis), mask = binaryCopy(selection);
  const available = direction === 1 ? grid.dims[plane.axis] - plane.index - 1 : plane.index, copies = count === 0 ? available : Math.min(count, available);
  checkAlgorithmControl(control, 0);
  for (let offset = 1; offset <= copies; offset++) {
    const target = { axis: plane.axis, index: plane.index + direction * offset };
    for (let y = 0; y < grid.dims[v]; y++) {
      for (let x = 0; x < grid.dims[u]; x++) mask[voxelIndex(onPlane(target, x, y), grid.dims)] = selection[voxelIndex(onPlane(plane, x, y), grid.dims)] ? 1 : 0;
      checkAlgorithmControl(control);
    }
    checkAlgorithmControl(control, offset / (copies + 1));
  }
  return resultOf(mask, control);
}

/** Independent even-odd polygon fill at integer voxel centres, with boundary included. */
export function polygonRaster(grid: VolumeGrid, plane: SlicePlane, points: readonly (readonly [number, number])[], control: AlgorithmControl = {}): MaskResult {
  domainOf(grid, { plane });
  if (points.length < 3 || points.some(p => p.length !== 2 || p.some(n => !Number.isFinite(n)))) throw new Error('多边形需要至少三个有限二维顶点。');
  const mask = new Uint8Array(grid.data.length), [u, v] = planeAxes(plane.axis);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of points) { minU = Math.min(minU, p[0]); maxU = Math.max(maxU, p[0]); minV = Math.min(minV, p[1]); maxV = Math.max(maxV, p[1]); }
  const lowU = Math.max(0, Math.ceil(minU)), highU = Math.min(grid.dims[u] - 1, Math.floor(maxU));
  const lowV = Math.max(0, Math.ceil(minV)), highV = Math.min(grid.dims[v] - 1, Math.floor(maxV));
  let count = 0; checkAlgorithmControl(control, 0);
  for (let y = lowV; y <= highV; y++) {
    for (let x = lowU; x <= highU; x++) {
      let inside = false, boundary = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[j], b = points[i], cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
        const scale = Math.max(1, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        if (Math.abs(cross) <= 1e-10 * scale && x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0]) && y >= Math.min(a[1], b[1]) && y <= Math.max(a[1], b[1])) { boundary = true; break; }
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      if (inside || boundary) { mask[voxelIndex(onPlane(plane, x, y), grid.dims)] = 1; count++; }
    }
    checkAlgorithmControl(control, (y - lowV + 1) / (highV - lowV + 2));
  }
  checkAlgorithmControl(control, 1); return { mask, count };
}

/** Exact separable squared Euclidean distance transform of a 2D feature map, in mm. */
function distanceTransform(features: Uint8Array, width: number, height: number, spacing: [number, number], control: AlgorithmControl): Float64Array {
  let data = Float64Array.from(features, f => f ? 0 : Infinity);
  for (const axis of [0, 1]) {
    const length = axis ? height : width, lines = axis ? width : height, stride = axis ? width : 1, weight = spacing[axis] ** 2;
    const next = new Float64Array(data.length), vertices = new Int32Array(length), edges = new Float64Array(length + 1);
    for (let line = 0; line < lines; line++) {
      const base = axis ? line : line * width; let k = -1;
      for (let q = 0; q < length; q++) {
        const fq = data[base + q * stride]; if (!Number.isFinite(fq)) continue;
        let s = -Infinity;
        while (k >= 0) {
          const p = vertices[k]; s = (fq - data[base + p * stride]) / (2 * weight * (q - p)) + (q + p) / 2;
          if (s > edges[k]) break; k--;
        }
        vertices[++k] = q; edges[k] = k === 0 ? -Infinity : s; edges[k + 1] = Infinity;
      }
      let cell = 0;
      for (let q = 0; q < length; q++) {
        if (k < 0) { next[base + q * stride] = Infinity; continue; }
        while (cell < k && edges[cell + 1] < q) cell++;
        const p = vertices[cell]; next[base + q * stride] = weight * (q - p) ** 2 + data[base + p * stride];
      }
      if ((line & 63) === 0) checkAlgorithmControl(control);
    }
    data = next;
  }
  return data;
}
function signedSliceDistance(grid: VolumeGrid, source: BinaryMask, plane: SlicePlane, control: AlgorithmControl): Float64Array {
  const [u, v] = planeAxes(plane.axis), width = grid.dims[u] + 2, height = grid.dims[v] + 2;
  const foreground = new Uint8Array(width * height), background = new Uint8Array(width * height); background.fill(1);
  let count = 0;
  for (let y = 0; y < height - 2; y++) for (let x = 0; x < width - 2; x++) {
    if (source[voxelIndex(onPlane(plane, x, y), grid.dims)]) { const i = x + 1 + width * (y + 1); foreground[i] = 1; background[i] = 0; count++; }
  }
  const signed = new Float64Array((width - 2) * (height - 2));
  if (!count) { signed.fill(-Math.hypot(width * grid.spacing[u], height * grid.spacing[v])); return signed; }
  const spacing: [number, number] = [grid.spacing[u], grid.spacing[v]];
  const toForeground = distanceTransform(foreground, width, height, spacing, control), toBackground = distanceTransform(background, width, height, spacing, control);
  for (let y = 0; y < height - 2; y++) for (let x = 0; x < width - 2; x++) {
    const i = x + 1 + width * (y + 1); signed[x + (width - 2) * y] = Math.sqrt(toBackground[i]) - Math.sqrt(toForeground[i]);
  }
  return signed;
}
/** Independent algorithm: interpolate physical signed-distance fields; native Mimics interpolation is unconfirmed. */
export function interpolateMaskSlices(grid: VolumeGrid, selection: BinaryMask, axis: Axis, start: number, end: number, control: AlgorithmControl = {}): MaskResult {
  requireGrid(grid, selection); domainOf(grid, { plane: { axis, index: start } }); domainOf(grid, { plane: { axis, index: end } });
  if (start >= end) throw new Error('插值起点必须小于终点切片。');
  checkAlgorithmControl(control, 0);
  const mask = binaryCopy(selection), [u, v] = planeAxes(axis);
  const first = signedSliceDistance(grid, selection, { axis, index: start }, control), last = signedSliceDistance(grid, selection, { axis, index: end }, control);
  for (let index = start + 1; index < end; index++) {
    const t = (index - start) / (end - start);
    for (let y = 0; y < grid.dims[v]; y++) for (let x = 0; x < grid.dims[u]; x++) {
      const i = x + grid.dims[u] * y;
      mask[voxelIndex(onPlane({ axis, index }, x, y), grid.dims)] = Number((1 - t) * first[i] + t * last[i] >= 0);
    }
    checkAlgorithmControl(control, (index - start) / (end - start));
  }
  return resultOf(mask, control);
}
