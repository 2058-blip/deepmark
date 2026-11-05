import {parseNifti, type Volume} from '../core.ts';

/** Every returned image has a three-dimensional, millimetre-normalized header and affine. */
export interface TemporalVolumeSeries {
  frames: Volume[];
  source: 'nifti-4d' | 'nifti-3d-list';
  /** Time values, when present, are seconds; no timing is invented for a 3D list. */
  times?: number[];
  timeStep?: number;
  timeOffset?: number;
}
export interface TemporalImportOptions {maxFrames?: number; maxTotalVoxels?: number}
export interface NiftiPhaseFile {buffer: ArrayBuffer; name?: string; timeSeconds?: number}
const scalarBytes: Record<number, number> = {2: 1, 4: 2, 8: 4, 16: 4, 64: 8, 256: 1, 512: 2, 768: 4};
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(a), Math.abs(b));

function limits(options: TemporalImportOptions) {
  const maxFrames = options.maxFrames ?? 256, maxTotalVoxels = options.maxTotalVoxels ?? 128 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || !Number.isSafeInteger(maxTotalVoxels) || maxTotalVoxels < 1)
    throw new Error('相位导入预算无效。');
  return {maxFrames, maxTotalVoxels};
}
function inspect(buffer: ArrayBuffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 352) throw new Error('相位文件过短，不是完整 NIfTI-1。');
  const view = new DataView(buffer), little = view.getInt32(0, true) === 348;
  if (view.getInt32(0, little) !== 348 || [110, 43, 49, 0].some((v, i) => view.getUint8(344 + i) !== v))
    throw new Error('时间序列仅接受解压后的 NIfTI-1 .nii 单文件。');
  const rank = view.getInt16(40, little);
  if (rank < 3 || rank > 7) throw new Error('相位图像至少需要三个空间维度。');
  const dims = [1, 2, 3].map(a => view.getInt16(40 + 2 * a, little));
  if (dims.some(n => n < 1)) throw new Error('相位空间尺寸无效。');
  for (let a = 5; a <= rank; a++) if (view.getInt16(40 + 2 * a, little) !== 1)
    throw new Error('不支持多通道或非时间的高维影像。');
  const count = dims.reduce((a, b) => a * b, 1), frames = rank >= 4 ? view.getInt16(48, little) : 1;
  if (frames < 1) throw new Error('相位数量无效。');
  const bytes = scalarBytes[view.getInt16(70, little)];
  if (!bytes || view.getInt16(72, little) !== bytes * 8) throw new Error('相位灰度类型或位深不受支持。');
  const offset = view.getFloat32(108, little), expected = offset + count * frames * bytes;
  if (!Number.isSafeInteger(offset) || offset < 352 || !Number.isSafeInteger(expected) || expected > buffer.byteLength)
    throw new Error('时间序列数据截断或偏移无效，不能只读取首相位。');
  const spatialUnit = view.getUint8(123) & 7;
  if (![1, 2, 3].includes(spatialUnit)) throw new Error('相位空间单位未知；请声明 m、mm 或 µm。');
  const spatialFactor = spatialUnit === 1 ? 1000 : spatialUnit === 3 ? .001 : 1;
  for (let a = 1; a <= 3; a++) if (!Number.isFinite(view.getFloat32(76 + 4 * a, little)) || view.getFloat32(76 + 4 * a, little) <= 0)
    throw new Error('相位空间间距必须为有限正数。');
  let timeStep: number | undefined, timeOffset: number | undefined;
  if (frames > 1) {
    const temporalUnit = view.getUint8(123) & 56, timeFactor = temporalUnit === 8 ? 1 : temporalUnit === 16 ? .001 : temporalUnit === 24 ? .000001 : undefined;
    if (timeFactor === undefined) throw new Error('4D 时间单位必须为 s、ms 或 µs，未知及频率单位不能作为相位时间。');
    timeStep = view.getFloat32(92, little) * timeFactor;
    timeOffset = view.getFloat32(136, little) * timeFactor;
    if (!Number.isFinite(timeStep) || timeStep <= 0 || !Number.isFinite(timeOffset) || !Number.isFinite(timeOffset + (frames - 1) * timeStep))
      throw new Error('4D 时间步长或时间起点无效。');
  }
  return {view, little, count, frames, bytes, offset, spatialFactor, timeStep, timeOffset};
}

function readFrame(buffer: ArrayBuffer, info: ReturnType<typeof inspect>, index: number, name: string): Volume {
  const output = new ArrayBuffer(352 + info.count * info.bytes), header = new DataView(output);
  new Uint8Array(output, 0, 348).set(new Uint8Array(buffer, 0, 348));
  header.setInt16(40, 3, info.little);
  for (let a = 4; a <= 7; a++) header.setInt16(40 + 2 * a, 1, info.little);
  header.setFloat32(108, 352, info.little);
  header.setFloat32(92, 0, info.little); header.setFloat32(136, 0, info.little);
  // Normalize before invoking the shared parser, including translations and qform offsets.
  for (let a = 1; a <= 3; a++) header.setFloat32(76 + 4 * a, info.view.getFloat32(76 + 4 * a, info.little) * info.spatialFactor, info.little);
  for (let a = 0; a < 3; a++) header.setFloat32(268 + 4 * a, info.view.getFloat32(268 + 4 * a, info.little) * info.spatialFactor, info.little);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) header.setFloat32(280 + 16 * r + 4 * c, info.view.getFloat32(280 + 16 * r + 4 * c, info.little) * info.spatialFactor, info.little);
  header.setUint8(123, 2);
  new Uint8Array(output, 352).set(new Uint8Array(buffer, info.offset + index * info.count * info.bytes, info.count * info.bytes));
  return parseNifti(output, name);
}

/** Split true time volumes; preserves scalar type, endian, scaling and full spatial affine. */
export function parseNiftiTemporal(buffer: ArrayBuffer, name = 'series.nii', options: TemporalImportOptions = {}): TemporalVolumeSeries {
  const info = inspect(buffer), budget = limits(options);
  if (info.frames > budget.maxFrames || info.frames * info.count > budget.maxTotalVoxels) throw new Error('4D 导入超过相位数或总体素预算。');
  const frames = Array.from({length: info.frames}, (_, i) => readFrame(buffer, info, i, info.frames === 1 ? name : `${name} [${i + 1}/${info.frames}]`));
  if (info.timeStep === undefined) return {frames, source: 'nifti-4d'};
  return {frames, source: 'nifti-4d', timeStep: info.timeStep, timeOffset: info.timeOffset, times: frames.map((_, i) => info.timeOffset! + i * info.timeStep!)};
}

/** A list keeps the supplied phase order and requires compatible physical grids. */
export function parseNiftiPhaseFiles(files: NiftiPhaseFile[], options: TemporalImportOptions = {}): TemporalVolumeSeries {
  const budget = limits(options);
  if (!Array.isArray(files) || !files.length || files.length > budget.maxFrames) throw new Error('请选择预算范围内的三维相位文件。');
  // Inspect the complete list and total allocation before decoding any image.
  const infos = files.map(file => inspect(file.buffer));
  if (infos.some(info => info.frames !== 1)) throw new Error('多文件相位导入要求每个文件只含单个三维体积。');
  if (infos.reduce((sum, info) => sum + info.count, 0) > budget.maxTotalVoxels) throw new Error('相位文件超过总体素预算。');
  const hasTimes = files.some(file => file.timeSeconds !== undefined);
  const times = hasTimes ? files.map(file => file.timeSeconds!) : undefined;
  if (times && times.some((t, i) => !Number.isFinite(t) || i > 0 && t <= times[i - 1]!)) throw new Error('相位时间需全部提供且按输入顺序严格递增，单位为秒。');
  const frames = files.map((file, i) => readFrame(file.buffer, infos[i]!, 0, file.name ?? `phase-${i + 1}.nii`)), first = frames[0]!;
  if (frames.some(frame => frame.dims.some((n, a) => n !== first.dims[a]) || frame.spacing.some((n, a) => !close(n, first.spacing[a]!)) || frame.affine.some((row, r) => row.some((n, c) => !close(n, first.affine[r]![c]!)))))
    throw new Error('相位空间网格不兼容：尺寸、间距、方向与位置必须一致。');
  const result: TemporalVolumeSeries = {frames, source: 'nifti-3d-list', ...(times ? {times, timeOffset: times[0]} : {})};
  if (times && times.length > 1) {
    const step = times[1]! - times[0]!;
    if (times.every((t, i) => close(t, times[0]! + i * step))) result.timeStep = step;
  }
  return result;
}
