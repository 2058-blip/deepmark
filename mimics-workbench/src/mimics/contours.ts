import { checkAlgorithmControl } from './segmentation.ts';
import { requireGrid, voxelIndex } from './types.ts';
import type { AlgorithmControl, Axis, BinaryMask, MaskResult, SlicePlane, Vec3, VolumeGrid } from './types.ts';

export type Point2 = [number, number];
export const CONTOUR_PROVENANCE = 'independent-half-voxel-cell-boundary' as const;
export interface ContourRing {
  /** Slice-local voxel coordinates. A voxel centre is integral; its cell boundary is half-integral. */
  points: Point2[];
  hole: boolean;
  /** Index of the immediate containing ring in this layer, or null. */
  parent: number | null;
  /** Four-connected foreground component in this layer, starting at zero. */
  component: number;
  signedArea: number;
  areaMm2: number;
  perimeterMm: number;
}
export interface ContourLayer {
  plane: SlicePlane;
  rings: ContourRing[];
  componentCount: number;
  provenance: typeof CONTOUR_PROVENANCE;
}
export interface ContourSet {
  axis: Axis;
  dims: Vec3;
  layers: ContourLayer[];
  provenance: typeof CONTOUR_PROVENANCE;
}
export interface PolylineOptions extends AlgorithmControl { axis?: Axis; slices?: readonly number[] }

function axesOf(axis: Axis): [Axis, Axis] { return ([0, 1, 2] as Axis[]).filter(a => a !== axis) as [Axis, Axis]; }
function validPlane(grid: VolumeGrid, plane: SlicePlane): [Axis, Axis] {
  requireGrid(grid);
  if (![0, 1, 2].includes(plane.axis) || !Number.isSafeInteger(plane.index) || plane.index < 0 || plane.index >= grid.dims[plane.axis]) throw new Error('轮廓切片必须位于影像内。');
  return axesOf(plane.axis);
}
function pointOnPlane(plane: SlicePlane, axes: [Axis, Axis], u: number, v: number): Vec3 {
  const p: Vec3 = [0, 0, 0]; p[plane.axis] = plane.index; p[axes[0]] = u; p[axes[1]] = v; return p;
}
function signedArea(points: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) { const p = points[i], q = points[(i + 1) % points.length]; area += p[0] * q[1] - q[0] * p[1]; }
  return area / 2;
}
function insideRing(p: Point2, points: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function simplifyCollinear(points: Point2[]): Point2[] {
  return points.filter((p, i) => {
    const previous = points[(i + points.length - 1) % points.length], next = points[(i + 1) % points.length];
    return (p[0] - previous[0]) * (next[1] - p[1]) - (p[1] - previous[1]) * (next[0] - p[0]) !== 0;
  });
}
function physicalBasis(grid: VolumeGrid, axes: [Axis, Axis]): [Vec3, Vec3] {
  if (grid.affine && (grid.affine.length < 3 || grid.affine.slice(0, 3).some(r => r.length < 4 || r.slice(0, 4).some(v => !Number.isFinite(v))))) throw new Error('轮廓物理坐标变换无效。');
  return axes.map(axis => {
    if (grid.affine) return [grid.affine[0][axis], grid.affine[1][axis], grid.affine[2][axis]] as Vec3;
    const unit: Vec3 = [0, 0, 0]; unit[axis] = grid.spacing[axis]; return unit;
  }) as [Vec3, Vec3];
}
function metric(grid: VolumeGrid, axes: [Axis, Axis]) {
  const [u, v] = physicalBasis(grid, axes), cross: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], scale = Math.hypot(...cross);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('轮廓平面的物理面积无效。');
  return { scale, length: (du: number, dv: number) => Math.hypot(...u.map((n, a) => n * du + v[a] * dv)) };
}

interface Edge { from: number; to: number; direction: number; component: number; visited: boolean }

/**
 * Independent exact boundary of selected voxel cells. Not a claim about native intensity-based STL+ polylines.
 * A right-turn rule at a diagonal vertex keeps four-connected foreground components separate.
 */
export function extractSliceContours(grid: VolumeGrid, mask: BinaryMask, plane: SlicePlane, control: AlgorithmControl = {}): ContourLayer {
  requireGrid(grid, mask); const axes = validPlane(grid, plane), width = grid.dims[axes[0]], height = grid.dims[axes[1]], n = width * height;
  if (n > 0x7fffffff) throw new Error('轮廓切片超过索引容量。');
  checkAlgorithmControl(control, 0);
  const pixels = new Uint8Array(n), labels = new Int32Array(n), queue = new Int32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels[x + width * y] = mask[voxelIndex(pointOnPlane(plane, axes, x, y), grid.dims)] ? 1 : 0;
    checkAlgorithmControl(control);
  }
  let components = 0;
  for (let seed = 0; seed < n; seed++) if (pixels[seed] && !labels[seed]) {
    const label = ++components; let tail = 1; queue[0] = seed; labels[seed] = label;
    for (let head = 0; head < tail; head++) {
      const i = queue[head], x = i % width, y = Math.floor(i / width);
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, y > 0 ? i - width : -1, y + 1 < height ? i + width : -1]) {
        if (j >= 0 && pixels[j] && !labels[j]) { labels[j] = label; queue[tail++] = j; }
      }
      if ((head & 4095) === 0) checkAlgorithmControl(control);
    }
  }
  const vertexWidth = width + 1, edges: Edge[] = [], outgoing = new Map<number, number[]>();
  const add = (ax: number, ay: number, bx: number, by: number, direction: number, component: number) => {
    const from = ax + vertexWidth * ay, to = bx + vertexWidth * by, id = edges.length;
    edges.push({ from, to, direction, component, visited: false });
    const previous = outgoing.get(from); if (previous) previous.push(id); else outgoing.set(from, [id]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = x + width * y; if (!pixels[i]) continue; const component = labels[i] - 1;
      if (!y || !pixels[i - width]) add(x, y, x + 1, y, 0, component);
      if (x + 1 === width || !pixels[i + 1]) add(x + 1, y, x + 1, y + 1, 1, component);
      if (y + 1 === height || !pixels[i + width]) add(x + 1, y + 1, x, y + 1, 2, component);
      if (!x || !pixels[i - 1]) add(x, y + 1, x, y, 3, component);
    }
    checkAlgorithmControl(control);
  }
  const rings: ContourRing[] = [], { scale, length } = metric(grid, axes);
  for (let start = 0; start < edges.length; start++) if (!edges[start].visited) {
    const initial = edges[start], vertices: Point2[] = []; let id = start, closed = false;
    for (let steps = 0; steps <= edges.length; steps++) {
      const edge = edges[id];
      if (edge.visited) throw new Error('轮廓边界出现重复访问。');
      edge.visited = true; vertices.push([edge.from % vertexWidth - 0.5, Math.floor(edge.from / vertexWidth) - 0.5]);
      if (edge.to === initial.from) { closed = true; break; }
      let selected = -1, rank = Infinity;
      for (const candidate of outgoing.get(edge.to) ?? []) {
        const next = edges[candidate]; if (next.visited || next.component !== edge.component) continue;
        const turn = (next.direction - edge.direction + 4) % 4, priority = turn === 1 ? 0 : turn === 0 ? 1 : turn === 3 ? 2 : 3;
        if (priority < rank) { rank = priority; selected = candidate; }
      }
      if (selected < 0) throw new Error('轮廓边界无法闭合。');
      id = selected; if ((steps & 4095) === 0) checkAlgorithmControl(control);
    }
    if (!closed) throw new Error('轮廓闭合超过边数限制。');
    const points = simplifyCollinear(vertices), area = signedArea(points);
    if (!area || points.length < 3) throw new Error('提取到退化轮廓。');
    let perimeterMm = 0;
    for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; perimeterMm += length(b[0] - a[0], b[1] - a[1]); }
    rings.push({ points, signedArea: area, areaMm2: Math.abs(area) * scale, perimeterMm, component: initial.component, parent: null, hole: false });
  }
  const boxes = rings.map(ring => {
    const min: Point2 = [Infinity, Infinity], max: Point2 = [-Infinity, -Infinity];
    for (const p of ring.points) for (let a = 0; a < 2; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
    return { min, max };
  });
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i], a = ring.points[0], b = ring.points[1], dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy), sign = Math.sign(ring.signedArea);
    const probe: Point2 = [(a[0] + b[0]) / 2 - sign * dy / d * 1e-4, (a[1] + b[1]) / 2 + sign * dx / d * 1e-4];
    let smallest = Infinity;
    for (let j = 0; j < rings.length; j++) {
      const size = Math.abs(rings[j].signedArea), box = boxes[j];
      if (size <= Math.abs(ring.signedArea) || size >= smallest || probe[0] < box.min[0] || probe[0] > box.max[0] || probe[1] < box.min[1] || probe[1] > box.max[1]) continue;
      if (insideRing(probe, rings[j].points)) { ring.parent = j; smallest = size; }
    }
    checkAlgorithmControl(control);
  }
  for (const ring of rings) {
    let parent = ring.parent, depth = 0;
    while (parent !== null) { depth++; if (depth > rings.length) throw new Error('轮廓包含关系存在环。'); parent = rings[parent].parent; }
    ring.hole = depth % 2 === 1;
  }
  checkAlgorithmControl(control, 1);
  return { plane: { ...plane }, rings, componentCount: components, provenance: CONTOUR_PROVENANCE };
}

/** Calculate all or specified slice layers. Output has an explicit independent boundary provenance. */
export function calculatePolylines(grid: VolumeGrid, mask: BinaryMask, options: PolylineOptions = {}): ContourSet {
  requireGrid(grid, mask); const axis = options.axis ?? 2; validPlane(grid, { axis, index: 0 });
  const slices = options.slices ? [...options.slices] : Array.from({ length: grid.dims[axis] }, (_, i) => i);
  if (new Set(slices).size !== slices.length) throw new Error('轮廓切片列表不能重复。');
  slices.forEach(index => validPlane(grid, { axis, index })); slices.sort((a, b) => a - b);
  checkAlgorithmControl(options, 0);
  const layers = slices.map((index, i) => extractSliceContours(grid, mask, { axis, index }, { cancelled: options.cancelled, progress: f => checkAlgorithmControl(options, (i + f) / Math.max(1, slices.length)) }));
  checkAlgorithmControl(options, 1);
  return { axis, dims: [...grid.dims], layers, provenance: CONTOUR_PROVENANCE };
}
function validateSet(grid: VolumeGrid, set: ContourSet): void {
  validPlane(grid, { axis: set.axis, index: 0 });
  if (set.dims.length !== 3 || set.dims.some((n, a) => n !== grid.dims[a])) throw new Error('轮廓集合与影像尺寸不一致。');
  if (set.layers.some(layer => layer.plane.axis !== set.axis)) throw new Error('轮廓集合包含不同方向。');
}
/** Replace the current layer only; unchanged layers are retained by immutable reference. */
export function updatePolylines(grid: VolumeGrid, mask: BinaryMask, set: ContourSet, index: number, control: AlgorithmControl = {}): ContourSet {
  requireGrid(grid, mask); validateSet(grid, set); const layer = extractSliceContours(grid, mask, { axis: set.axis, index }, control);
  const layers = set.layers.filter(previous => previous.plane.index !== index).concat(layer).sort((a, b) => a.plane.index - b.plane.index);
  return { ...set, dims: [...set.dims], layers };
}

export interface RasterOptions extends AlgorithmControl { source?: BinaryMask; operation?: 'replace' | 'add' | 'remove' }
/**
 * Even-odd scanline filling preserves holes and nested islands. Integer voxel-centre samples;
 * an exact edge hit uses left-inclusive/right-exclusive, lower-inclusive/upper-exclusive convention.
 */
export function contoursToMask(grid: VolumeGrid, contours: ContourLayer | ContourSet, options: RasterOptions = {}): MaskResult {
  requireGrid(grid, options.source); const operation = options.operation ?? 'replace';
  if (!['replace', 'add', 'remove'].includes(operation)) throw new Error('未知轮廓栅格操作。');
  if ('layers' in contours) validateSet(grid, contours);
  const layers = 'layers' in contours ? contours.layers : [contours], seen = new Set<string>(), mask = options.source ? Uint8Array.from(options.source, v => v ? 1 : 0) : new Uint8Array(grid.data.length);
  checkAlgorithmControl(options, 0);
  for (let layerNumber = 0; layerNumber < layers.length; layerNumber++) {
    const layer = layers[layerNumber], axes = validPlane(grid, layer.plane), width = grid.dims[axes[0]], height = grid.dims[axes[1]], key = `${layer.plane.axis}:${layer.plane.index}`;
    if (seen.has(key)) throw new Error('轮廓集合包含重复切片。'); seen.add(key);
    for (const ring of layer.rings) if (ring.points.length < 3 || ring.points.some(p => p.length !== 2 || p.some(v => !Number.isFinite(v)))) throw new Error('轮廓必须至少包含三个有限二维顶点。');
    for (let y = 0; y < height; y++) {
      if (operation === 'replace') for (let x = 0; x < width; x++) mask[voxelIndex(pointOnPlane(layer.plane, axes, x, y), grid.dims)] = 0;
      const crossings: number[] = [];
      for (const ring of layer.rings) for (let a = 0, b = ring.points.length - 1; a < ring.points.length; b = a++) {
        const p = ring.points[b], q = ring.points[a];
        if ((p[1] > y) !== (q[1] > y)) {
          const crossing = p[0] + (y - p[1]) * (q[0] - p[0]) / (q[1] - p[1]);
          if (!Number.isFinite(crossing)) throw new Error('轮廓坐标超出扫描计算范围。'); crossings.push(crossing);
        }
      }
      crossings.sort((a, b) => a - b);
      if (crossings.length % 2) throw new Error('轮廓扫描线交点无法配对。');
      for (let i = 0; i < crossings.length; i += 2) {
        const min = Math.max(0, Math.ceil(crossings[i] - 1e-10)), max = Math.min(width - 1, Math.ceil(crossings[i + 1] - 1e-10) - 1);
        for (let x = min; x <= max; x++) mask[voxelIndex(pointOnPlane(layer.plane, axes, x, y), grid.dims)] = operation === 'remove' ? 0 : 1;
      }
      checkAlgorithmControl(options, (layerNumber + (y + 1) / height) / Math.max(1, layers.length));
    }
  }
  let count = 0;
  for (let i = 0; i < mask.length; i++) { if (mask[i]) count++; if ((i & 8191) === 0) checkAlgorithmControl(options); }
  checkAlgorithmControl(options, 1); return { mask, count };
}

export interface LabelBitmap { width: number; height: number; /** One alpha byte per pixel, row-major. */ data: Uint8Array | Uint8ClampedArray }
export interface BitmapLabelOptions extends AlgorithmControl {
  /** Voxel coordinate of bitmap pixel (0,0)'s centre; normal-axis coordinate is an integer slice. */
  origin: Vec3;
  axis?: Axis;
  pixelSizeMm: [number, number];
  depthMm: number;
  /** auto fills upward first, then downward when reaching the stack top. */
  direction?: 'up' | 'down' | 'auto';
  flipU?: boolean; flipV?: boolean;
  alphaThreshold?: number;
  source?: BinaryMask;
  operation?: 'replace' | 'add' | 'remove';
}
export interface BitmapLabelResult extends MaskResult { layers: number[]; clipped: boolean; requestedDepthMm: number; actualDepthMm: number; labelVoxelCount: number }

/**
 * Independent bitmap-to-voxel solid label. Browser/OS font shaping is a separate caller operation.
 * Pixel footprint sampling and ceil(depth/spacing) are explicit conventions, not recovered native rounding.
 */
export function bitmapToMask(grid: VolumeGrid, bitmap: LabelBitmap, options: BitmapLabelOptions): BitmapLabelResult {
  requireGrid(grid, options.source);
  if (!Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height) || bitmap.width < 1 || bitmap.height < 1 || !(bitmap.data instanceof Uint8Array || bitmap.data instanceof Uint8ClampedArray) || bitmap.width * bitmap.height !== bitmap.data.length) throw new Error('标签位图尺寸无效。');
  const axis = options.axis ?? 2, axes = axesOf(axis), origin = options.origin;
  if (![0, 1, 2].includes(axis) || origin.length !== 3 || origin.some(n => !Number.isFinite(n)) || !Number.isSafeInteger(origin[axis]) || origin[axis] < 0 || origin[axis] >= grid.dims[axis]) throw new Error('标签锚点必须位于有效整数切片。');
  if (options.pixelSizeMm.length !== 2 || options.pixelSizeMm.some(n => !Number.isFinite(n) || n <= 0) || !Number.isFinite(options.depthMm) || options.depthMm <= 0) throw new Error('标签像素物理尺寸和厚度必须为有限正数。');
  const direction = options.direction ?? 'auto', threshold = options.alphaThreshold ?? 128, operation = options.operation ?? (options.source ? 'add' : 'replace');
  if (!['up', 'down', 'auto'].includes(direction) || !['replace', 'add', 'remove'].includes(operation)) throw new Error('未知标签方向或操作。');
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw new Error('标签 Alpha 阈值必须在 [0,255]。');
  if (options.flipU !== undefined && typeof options.flipU !== 'boolean' || options.flipV !== undefined && typeof options.flipV !== 'boolean') throw new Error('标签翻转开关必须为布尔值。');
  checkAlgorithmControl(options, 0);
  const requestedLayers = Math.max(1, Math.ceil(options.depthMm / grid.spacing[axis] - 1e-10)), limit = Math.min(grid.dims[axis], requestedLayers), layers: number[] = [];
  if (direction === 'down') { for (let i = origin[axis]; i >= 0 && layers.length < limit; i--) layers.push(i); }
  else {
    for (let i = origin[axis]; i < grid.dims[axis] && layers.length < limit; i++) layers.push(i);
    if (direction === 'auto') for (let i = origin[axis] - 1; i >= 0 && layers.length < limit; i--) layers.push(i);
  }
  const label = new Uint8Array(grid.data.length), ratios: Point2 = [options.pixelSizeMm[0] / grid.spacing[axes[0]], options.pixelSizeMm[1] / grid.spacing[axes[1]]];
  if (ratios.some(r => !Number.isFinite(r) || r <= 0)) throw new Error('标签采样比例超出数值范围。');
  const minU = Math.max(0, Math.ceil(origin[axes[0]] - ratios[0] / 2)), maxU = Math.min(grid.dims[axes[0]] - 1, Math.ceil(origin[axes[0]] + (bitmap.width - 0.5) * ratios[0]) - 1);
  const minV = Math.max(0, Math.ceil(origin[axes[1]] - ratios[1] / 2)), maxV = Math.min(grid.dims[axes[1]] - 1, Math.ceil(origin[axes[1]] + (bitmap.height - 0.5) * ratios[1]) - 1);
  let labelVoxelCount = 0;
  for (let layer = 0; layer < layers.length; layer++) {
    for (let v = minV; v <= maxV; v++) {
      for (let u = minU; u <= maxU; u++) {
        let x = Math.floor((u - origin[axes[0]]) / ratios[0] + 0.5), y = Math.floor((v - origin[axes[1]]) / ratios[1] + 0.5);
        if (x < 0 || x >= bitmap.width || y < 0 || y >= bitmap.height) continue;
        if (options.flipU) x = bitmap.width - 1 - x; if (options.flipV) y = bitmap.height - 1 - y;
        const alpha = bitmap.data[x + bitmap.width * y];
        if (alpha > 0 && alpha >= threshold) { label[voxelIndex(pointOnPlane({ axis, index: layers[layer] }, axes, u, v), grid.dims)] = 1; labelVoxelCount++; }
      }
      checkAlgorithmControl(options);
    }
    checkAlgorithmControl(options, (layer + 1) / (layers.length + 1));
  }
  const mask = operation === 'replace' || !options.source ? new Uint8Array(label.length) : Uint8Array.from(options.source, v => v ? 1 : 0);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (label[i]) mask[i] = operation === 'remove' ? 0 : 1;
    if (mask[i]) count++; if ((i & 8191) === 0) checkAlgorithmControl(options);
  }
  checkAlgorithmControl(options, 1);
  return { mask, count, layers, clipped: layers.length < requestedLayers, requestedDepthMm: options.depthMm, actualDepthMm: layers.length * grid.spacing[axis], labelVoxelCount };
}

export interface IndependentSmoothOptions extends AlgorithmControl {
  /** Required explicit policy; the native Smooth Mask filter remains unverified. */
  strategy: 'majority-6' | 'majority-26';
  iterations?: number;
  plane?: SlicePlane;
}
/** Independent centre-inclusive voxel majority, with image exterior as background. No native-equivalence claim. */
export function independentSmoothMask(grid: VolumeGrid, source: BinaryMask, options: IndependentSmoothOptions): MaskResult & { strategy: IndependentSmoothOptions['strategy']; iterations: number; provenance: 'independent-neighborhood-majority' } {
  requireGrid(grid, source);
  if (options.strategy !== 'majority-6' && options.strategy !== 'majority-26') throw new Error('必须显式选择独立多数滤波策略。');
  const iterations = options.iterations ?? 1;
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error('平滑次数必须为正整数。');
  if (options.plane) validPlane(grid, options.plane);
  const offsets: Vec3[] = [];
  for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    const d: Vec3 = [x, y, z];
    if (options.plane && d[options.plane.axis] || options.strategy === 'majority-6' && Math.abs(x) + Math.abs(y) + Math.abs(z) > 1) continue;
    offsets.push(d);
  }
  const needed = Math.floor(offsets.length / 2) + 1;
  let mask = Uint8Array.from(source, v => v ? 1 : 0); checkAlgorithmControl(options, 0);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = mask.slice();
    for (let z = 0; z < grid.dims[2]; z++) for (let y = 0; y < grid.dims[1]; y++) for (let x = 0; x < grid.dims[0]; x++) {
      const p: Vec3 = [x, y, z], i = voxelIndex(p, grid.dims);
      if (!options.plane || p[options.plane.axis] === options.plane.index) {
        let votes = 0;
        for (const d of offsets) {
          const qx = x + d[0], qy = y + d[1], qz = z + d[2];
          if (qx >= 0 && qx < grid.dims[0] && qy >= 0 && qy < grid.dims[1] && qz >= 0 && qz < grid.dims[2] && mask[qx + grid.dims[0] * (qy + grid.dims[1] * qz)]) votes++;
        }
        next[i] = Number(votes >= needed);
      }
      if ((i & 4095) === 0) checkAlgorithmControl(options, (iteration + (i + 1) / mask.length) / iterations);
    }
    mask = next;
  }
  let count = 0;
  for (let i = 0; i < mask.length; i++) { if (mask[i]) count++; if ((i & 8191) === 0) checkAlgorithmControl(options); }
  checkAlgorithmControl(options, 1);
  return { mask, count, strategy: options.strategy, iterations, provenance: 'independent-neighborhood-majority' };
}
