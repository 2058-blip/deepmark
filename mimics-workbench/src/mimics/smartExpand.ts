import { requireGrid, voxelIndex } from './types.ts';
import type { AlgorithmControl, BinaryMask, MaskResult, RegionBounds, Vec3, VolumeGrid } from './types.ts';
import { checkAlgorithmControl } from './segmentation.ts';

export interface RandomWalkerOptions extends AlgorithmControl {
  /** Native SmartExpand configures 10000, not an iteration count. */
  edgeSensitivity?: number;
  foregroundPercentage?: number;
  maxIterations?: number;
  /** Absolute, unpreconditioned residual L2 tolerance. */
  tolerance?: number;
  /** float extends the recovered kernel to HU/NIfTI. native-uint16 preserves its signed-short packing. */
  intensityEncoding?: 'float' | 'native-uint16';
  roi?: RegionBounds;
}
export interface SmartExpandOptions extends RandomWalkerOptions { maximumDistance: number }
export interface RandomWalkerResult extends MaskResult {
  probabilities: Float32Array;
  iterations: number;
  residualNorm: number;
  converged: boolean;
  normalizationMaximum: number;
  intensityEncoding: 'float' | 'native-uint16';
  roi: RegionBounds;
  unknownCount: number;
}

function bounds(grid: VolumeGrid, roi?: RegionBounds): RegionBounds {
  const min: Vec3 = roi ? [...roi.min] : [0, 0, 0], max: Vec3 = roi ? [...roi.max] : grid.dims.map(d => d - 1) as Vec3;
  for (let a = 0; a < 3; a++) if (!Number.isSafeInteger(min[a]) || !Number.isSafeInteger(max[a]) || min[a] < 0 || max[a] >= grid.dims[a] || min[a] > max[a]) throw new Error('随机游走 ROI 必须是影像内的整数体素范围。');
  return { min, max };
}
function config(options: RandomWalkerOptions) {
  const sensitivity = options.edgeSensitivity ?? 10000, percentage = options.foregroundPercentage ?? 70;
  const maxIterations = options.maxIterations ?? 200, tolerance = options.tolerance ?? 1e-6;
  const encoding = options.intensityEncoding ?? 'float';
  if (!Number.isSafeInteger(sensitivity) || sensitivity < 0 || sensitivity > 0x7fffffff) throw new Error('边缘敏感度必须是非负 32 位整数。');
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new Error('前景概率百分比必须在 [0,100]。');
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) throw new Error('最大迭代次数必须是正整数。');
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error('求解容差必须是有限正数。');
  if (encoding !== 'float' && encoding !== 'native-uint16') throw new Error('未知随机游走灰度编码。');
  return { sensitivity, percentage, maxIterations, tolerance, encoding };
}

/** Native expf and intermediate float arithmetic from Segmentation.plugin!0x180158460. No epsilon is added. */
function edgeWeight(a: number, b: number, maximum: number, sensitivity: number): number {
  const delta = Math.fround(Math.fround(a / maximum) - Math.fround(b / maximum));
  const exponent = Math.fround(Math.fround(-sensitivity) * Math.fround(delta * delta));
  return Math.fround(Math.exp(exponent));
}

/**
 * Recovered 6-neighbor weighted Laplacian + Jacobi-preconditioned conjugate gradients.
 * Foreground is Dirichlet 1, background 0, unknown starts at 0.5. Foreground wins overlap.
 * Returns convergence diagnostics rather than silently labeling an unfinished solution exact.
 */
export function randomWalker(grid: VolumeGrid, foreground: BinaryMask, background: BinaryMask, options: RandomWalkerOptions = {}): RandomWalkerResult {
  const n = requireGrid(grid, foreground); requireGrid(grid, background);
  if (n > 0x7fffffff) throw new Error('随机游走影像超过索引容量。');
  const roi = bounds(grid, options.roi), settings = config(options), ids = new Int32Array(n); ids.fill(-1);
  const intensity = new Float32Array(n), labels = new Int8Array(n), probabilities = new Float32Array(n), mask = new Uint8Array(n);
  const unknown: number[] = [], included: number[] = [];
  let maximum = 0;
  checkAlgorithmControl(options, 0);
  for (let z = roi.min[2]; z <= roi.max[2]; z++) for (let y = roi.min[1]; y <= roi.max[1]; y++) for (let x = roi.min[0]; x <= roi.max[0]; x++) {
    const i = voxelIndex([x, y, z], grid.dims), value = grid.data[i];
    if (settings.encoding === 'native-uint16' && (!Number.isInteger(value) || value < 0 || value > 65535)) throw new Error('原生 uint16 模式要求 [0,65535] 的整数灰度；HU 可使用 float 扩展。');
    if (!Number.isFinite(value)) {
      if (foreground[i]) throw new Error('随机游走前景不能包含非有限灰度。');
      labels[i] = -2; continue; // Explicit float extension: nonfinite voxels are impenetrable barriers.
    }
    intensity[i] = settings.encoding === 'native-uint16' ? (value << 16) >> 16 : value;
    maximum = Math.max(maximum, intensity[i]); included.push(i);
    if (foreground[i]) { labels[i] = 1; probabilities[i] = 1; }
    else if (background[i]) labels[i] = -1;
    else { ids[i] = unknown.length; unknown.push(i); probabilities[i] = 0.5; }
    if ((included.length & 4095) === 0) checkAlgorithmControl(options);
  }
  const normalizationMaximum = maximum || 1, m = unknown.length;
  if (m > Math.floor(0x7fffffff / 6)) throw new Error('随机游走未知体素数量超过邻接容量。');
  const diagonal = new Float64Array(m), rhs = new Float64Array(m), neighborIds = new Int32Array(m * 6); neighborIds.fill(-1);
  const weights = new Float32Array(m * 6), strides = [1, grid.dims[0], grid.dims[0] * grid.dims[1]];
  // Native summation order is +X,+Y,+Z,-X,-Y,-Z. Image exterior contributes no graph edge.
  for (let row = 0; row < m; row++) {
    const i = unknown[row], x = i % grid.dims[0], y = Math.floor(i / grid.dims[0]) % grid.dims[1], z = Math.floor(i / strides[2]), p = [x, y, z];
    let degree = 0, forcing = 0;
    for (let slot = 0; slot < 6; slot++) {
      const axis = slot % 3, direction = slot < 3 ? 1 : -1;
      if (p[axis] + direction < roi.min[axis] || p[axis] + direction > roi.max[axis]) continue;
      const j = i + direction * strides[axis]; if (labels[j] === -2) continue;
      const w = edgeWeight(intensity[i], intensity[j], normalizationMaximum, settings.sensitivity);
      degree = Math.fround(degree + w);
      if (labels[j] === 1) forcing = Math.fround(forcing + w);
      else if (labels[j] === 0) { neighborIds[row * 6 + slot] = ids[j]; weights[row * 6 + slot] = w; }
    }
    diagonal[row] = degree; rhs[row] = forcing;
    if ((row & 1023) === 0) checkAlgorithmControl(options, 0.2 * row / Math.max(1, m));
  }
  const solution = new Float64Array(m).fill(0.5), residual = new Float64Array(m), direction = new Float64Array(m), preconditioned = new Float64Array(m), product = new Float64Array(m);
  const multiply = (input: Float64Array, output: Float64Array) => {
    for (let row = 0; row < m; row++) {
      let value = diagonal[row] * input[row];
      for (let slot = row * 6; slot < row * 6 + 6; slot++) if (neighborIds[slot] >= 0) value -= weights[slot] * input[neighborIds[slot]];
      output[row] = value;
      if ((row & 4095) === 0) checkAlgorithmControl(options);
    }
  };
  const dot = (a: Float64Array, b: Float64Array) => {
    let result = 0;
    for (let i = 0; i < m; i++) { result += a[i] * b[i]; if ((i & 8191) === 0) checkAlgorithmControl(options); }
    return result;
  };
  multiply(solution, product);
  for (let i = 0; i < m; i++) { residual[i] = rhs[i] - product[i]; preconditioned[i] = Math.abs(diagonal[i]) <= Number.EPSILON ? residual[i] : residual[i] / diagonal[i]; direction[i] = preconditioned[i]; }
  let residualNorm = Math.sqrt(dot(residual, residual)), rho = dot(residual, preconditioned), iterations = 0;
  const maxIterations = Math.min(m, settings.maxIterations);
  checkAlgorithmControl(options, 0.2);
  while (iterations < maxIterations && residualNorm >= settings.tolerance) {
    multiply(direction, product);
    const denominator = dot(direction, product), alpha = denominator === 0 ? 1 : rho / denominator;
    if (!Number.isFinite(alpha)) throw new Error('随机游走线性系统发生数值失稳。');
    for (let i = 0; i < m; i++) {
      solution[i] += alpha * direction[i]; residual[i] -= alpha * product[i];
      preconditioned[i] = Math.abs(diagonal[i]) <= Number.EPSILON ? residual[i] : residual[i] / diagonal[i];
    }
    const nextRho = dot(residual, preconditioned), beta = rho === 0 ? 1 : nextRho / rho;
    for (let i = 0; i < m; i++) direction[i] = preconditioned[i] + beta * direction[i];
    rho = nextRho; residualNorm = Math.sqrt(dot(residual, residual)); iterations++;
    if (!Number.isFinite(residualNorm)) throw new Error('随机游走残差超出数值范围。');
    checkAlgorithmControl(options, 0.2 + 0.75 * iterations / Math.max(1, maxIterations));
  }
  // Return the actual unpreconditioned residual, including after the final permitted step.
  multiply(solution, product); for (let i = 0; i < m; i++) residual[i] = rhs[i] - product[i];
  residualNorm = Math.sqrt(dot(residual, residual));
  for (let i = 0; i < m; i++) {
    if (!Number.isFinite(solution[i])) throw new Error('随机游走概率超出数值范围。');
    probabilities[unknown[i]] = solution[i];
  }
  let count = 0;
  for (const i of included) { if (probabilities[i] > settings.percentage / 100) { mask[i] = 1; count++; } }
  checkAlgorithmControl(options, 1);
  return { mask, count, probabilities, iterations, residualNorm, converged: residualNorm < settings.tolerance,
    normalizationMaximum, intensityEncoding: settings.encoding, roi, unknownCount: m };
}

/** FastMorphology/SingleDirectionMorphology's confirmed forward/backward true-pixel expansion. */
function dilateAxes(grid: VolumeGrid, source: BinaryMask, radius: Vec3, control: AlgorithmControl): BinaryMask {
  let mask = Uint8Array.from(source, v => v ? 1 : 0);
  const stride = [1, grid.dims[0], grid.dims[0] * grid.dims[1]];
  for (let axis = 0; axis < 3; axis++) {
    const extent = radius[axis]; if (!extent) continue;
    const next = mask.slice(), other = [0, 1, 2].filter(a => a !== axis), prefix = new Float64Array(grid.dims[axis] + 1);
    for (let v = 0; v < grid.dims[other[1]]; v++) for (let u = 0; u < grid.dims[other[0]]; u++) {
      const p: Vec3 = [0, 0, 0]; p[other[0]] = u; p[other[1]] = v; const base = voxelIndex(p, grid.dims); prefix[0] = 0;
      for (let t = 0; t < grid.dims[axis]; t++) prefix[t + 1] = prefix[t] + mask[base + t * stride[axis]];
      for (let t = 0; t < grid.dims[axis]; t++) next[base + t * stride[axis]] = Number(prefix[Math.min(grid.dims[axis], t + extent + 1)] - prefix[Math.max(0, t - extent)] > 0);
      checkAlgorithmControl(control);
    }
    mask = next;
  }
  return mask;
}

/**
 * Native SmartExpand chain: dilated source defines possible region, its complement is background,
 * then random-walker probabilities rather than the dilation itself determine the result.
 */
export function smartExpand(grid: VolumeGrid, source: BinaryMask, options: SmartExpandOptions): RandomWalkerResult {
  const n = requireGrid(grid, source); config(options);
  if (!Number.isSafeInteger(options.maximumDistance) || options.maximumDistance <= 0) throw new Error('最大扩张距离必须是正整数像素数。');
  if (options.roi) throw new Error('Smart Expand 自动从扩张区域建立 ROI；显式约束 ROI 请使用 randomWalker。');
  checkAlgorithmControl(options, 0);
  let sourceCount = 0;
  for (let i = 0; i < n; i++) { if (source[i]) { if (!Number.isFinite(grid.data[i])) throw new Error('源 Mask 不能包含非有限灰度。'); sourceCount++; } if ((i & 8191) === 0) checkAlgorithmControl(options); }
  if (!sourceCount) throw new Error('Smart Expand 源 Mask 为空。');
  // Mimics 17 uses one planar pixel size for X/Y and converts it to the slice axis through pixelSize/sliceDistance.
  const distance = options.maximumDistance, zRadius = Math.trunc(Math.fround(Math.fround(grid.spacing[0] / grid.spacing[2]) * Math.fround(distance)));
  if (!Number.isFinite(zRadius)) throw new Error('最大扩张距离与层间距超出数值范围。');
  const grown = dilateAxes(grid, source, [distance, distance, zRadius], options), background = new Uint8Array(n);
  const min: Vec3 = [...grid.dims], max: Vec3 = [-1, -1, -1];
  for (let z = 0; z < grid.dims[2]; z++) for (let y = 0; y < grid.dims[1]; y++) for (let x = 0; x < grid.dims[0]; x++) {
    const i = voxelIndex([x, y, z], grid.dims); background[i] = grown[i] ? 0 : 1;
    if (grown[i]) { min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z); max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z); }
    if ((i & 8191) === 0) checkAlgorithmControl(options);
  }
  for (let a = 0; a < 3; a++) { min[a] = Math.max(0, min[a] - 1); max[a] = Math.min(grid.dims[a] - 1, max[a] + 1); }
  checkAlgorithmControl(options, 0.15);
  return randomWalker(grid, source, background, { ...options, roi: { min, max }, progress: f => checkAlgorithmControl(options, 0.15 + 0.85 * f) });
}
