import type { Volume } from '../core.ts';
import type { AlgorithmControl, Vec3 } from './types.ts';

export const DICOM_TRANSFER_SYNTAX = {
  implicitLittleEndian: '1.2.840.10008.1.2',
  explicitLittleEndian: '1.2.840.10008.1.2.1',
  explicitBigEndian: '1.2.840.10008.1.2.2',
} as const;
export class DicomError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'DicomError'; }
}
export interface DicomSlice {
  seriesInstanceUID: string;
  sopInstanceUID?: string;
  modality: 'CT' | 'MR';
  rows: number; columns: number;
  imagePosition: Vec3;
  /** First triplet is the increasing-column direction, second the increasing-row direction (DICOM LPS). */
  imageOrientation: [number, number, number, number, number, number];
  pixelSpacing: [number, number];
  sliceThickness?: number; spacingBetweenSlices?: number;
  instanceNumber?: number; temporalPosition?: number;
  bitsAllocated: number; bitsStored: number; highBit: number; signed: boolean;
  rescaleSlope: number; rescaleIntercept: number;
  intensityUnit: 'HU' | 'GV';
  photometricInterpretation: 'MONOCHROME1' | 'MONOCHROME2';
  windowCenter?: number; windowWidth?: number;
  /** Rescaled quantitative values. MONOCHROME1 inversion belongs only to display. */
  data: Float32Array;
  transferSyntaxUID: string;
}
export interface DicomSeries { seriesInstanceUID: string; modality: 'CT' | 'MR'; slices: DicomSlice[] }
export type DicomVolume = Volume & { dicom: {
  modality: 'CT' | 'MR'; intensityUnit: 'HU' | 'GV';
  photometricInterpretation: 'MONOCHROME1' | 'MONOCHROME2'; displayInverted: boolean;
  /** Imported DICOM is RAS; a resliced project may explicitly use its new local image frame. */
  windowCenter?: number; windowWidth?: number; coordinateSystem: 'RAS'|'reslice-local';
} };
export interface ParseDicomOptions {
  /** Required to disambiguate a raw dataset without Part-10 file metadata. */
  transferSyntaxUID?: string;
}
type Element = { group: number; element: number; vr: string; offset: number; length: number; next: number };
const longVR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN']);
const validVR = new Set(['AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FD', 'FL', 'IS', 'LO', 'LT', 'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'PN', 'SH', 'SL', 'SQ', 'SS', 'ST', 'SV', 'TM', 'UC', 'UI', 'UL', 'UN', 'UR', 'US', 'UT', 'UV']);
const decoder = new TextDecoder('ascii');
function fail(code: string, message: string): never { throw new DicomError(code, message); }
function syntax(uid: string): { explicit: boolean; little: boolean } {
  if (uid === DICOM_TRANSFER_SYNTAX.implicitLittleEndian) return { explicit: false, little: true };
  if (uid === DICOM_TRANSFER_SYNTAX.explicitLittleEndian) return { explicit: true, little: true };
  if (uid === DICOM_TRANSFER_SYNTAX.explicitBigEndian) return { explicit: true, little: false };
  return fail('UNSUPPORTED_TRANSFER_SYNTAX', `不支持压缩或该传输语法 ${uid}。请离线转换为未压缩单帧 CT/MR DICOM 后导入；JPEG/JPEG-LS/JPEG2000/RLE/Deflated 目前未实现。`);
}
/** Offline parser. Only whitelisted imaging tags are retained; patient names/IDs are never returned. */
export function parseDicom(input: ArrayBuffer | Uint8Array, nameOrOptions?: string | ParseDicomOptions, options: ParseDicomOptions = {}): DicomSlice {
  if (typeof nameOrOptions === 'object') options = nameOrOptions;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const textAt = (offset: number, length: number): string => decoder.decode(bytes.subarray(offset, offset + length)).replace(/[\0 ]+$/g, '');
  function readElement(start: number, explicit: boolean, little: boolean): Element {
    if (start + 8 > bytes.length) return fail('TRUNCATED_DATASET', 'DICOM 元素头不完整。');
    const group = view.getUint16(start, little), element = view.getUint16(start + 2, little);
    let offset = start + 8, length: number, vr = '';
    if (group === 0xfffe || !explicit) length = view.getUint32(start + 4, little);
    else {
      vr = textAt(start + 4, 2);
      if (!validVR.has(vr)) return fail('INVALID_VR', `DICOM VR 无效：${vr}。`);
      if (longVR.has(vr)) {
        if (start + 12 > bytes.length || view.getUint16(start + 6, little) !== 0) return fail('INVALID_ELEMENT', 'DICOM 长 VR 元素头无效。');
        offset = start + 12; length = view.getUint32(start + 8, little);
      } else length = view.getUint16(start + 6, little);
    }
    if (length !== 0xffffffff && offset + length > bytes.length) return fail('TRUNCATED_DATASET', 'DICOM 元素数据被截断。');
    return { group, element, vr, offset, length, next: length === 0xffffffff ? offset : offset + length };
  }
  function skipUndefined(start: number, explicit: boolean, little: boolean, ending: number, depth = 0): number {
    if (depth > 32) return fail('SEQUENCE_DEPTH', 'DICOM 序列嵌套过深。');
    let position = start;
    while (position < bytes.length) {
      const e = readElement(position, explicit, little);
      if (e.group === 0xfffe && e.element === ending) {
        if (e.length !== 0) return fail('INVALID_DELIMITER', 'DICOM 序列分隔符无效。');
        return e.next;
      }
      if (e.group === 0xfffe && (e.element === 0xe00d || e.element === 0xe0dd)) return fail('INVALID_DELIMITER', 'DICOM 序列分隔符不匹配。');
      position = e.length === 0xffffffff ? skipUndefined(e.offset, explicit, little, e.group === 0xfffe && e.element === 0xe000 ? 0xe00d : 0xe0dd, depth + 1) : e.next;
    }
    return fail('TRUNCATED_DATASET', 'DICOM 未定长序列缺少结束符。');
  }
  let position = bytes.length >= 132 && textAt(128, 4) === 'DICM' ? 132 : 0;
  let transferSyntaxUID = options.transferSyntaxUID;
  let sawMeta = false;
  while (position + 8 <= bytes.length && view.getUint16(position, true) === 0x0002) {
    const e = readElement(position, true, true); sawMeta = true;
    if (e.length === 0xffffffff) return fail('INVALID_META', 'DICOM 文件元信息不能使用未定长度。');
    if (e.element === 0x0010) transferSyntaxUID = textAt(e.offset, e.length);
    position = e.next;
  }
  if (!transferSyntaxUID) return fail('MISSING_TRANSFER_SYNTAX', sawMeta ? 'DICOM 文件缺少 Transfer Syntax UID。' : '无文件头的 DICOM 数据集需要显式指定 transferSyntaxUID。');
  const { explicit, little } = syntax(transferSyntaxUID);
  const retained = new Map<string, Element>();
  const whitelist = new Set(['0008,0018', '0008,0060', '0018,0050', '0018,0088', '0020,000e', '0020,0013', '0020,0032', '0020,0037', '0020,0100', '0028,0002', '0028,0004', '0028,0008', '0028,0010', '0028,0011', '0028,0030', '0028,0100', '0028,0101', '0028,0102', '0028,0103', '0028,1050', '0028,1051', '0028,1052', '0028,1053', '0028,1054', '7fe0,0010']);
  while (position < bytes.length) {
    // Permit only standard even-byte padding after the final element.
    if (bytes.length - position < 8 && bytes.subarray(position).every(v => v === 0)) break;
    const e = readElement(position, explicit, little);
    const key = `${e.group.toString(16).padStart(4, '0')},${e.element.toString(16).padStart(4, '0')}`;
    if (key === '0028,3000' || key === '0040,9096') return fail('UNSUPPORTED_INTENSITY_MAPPING', '当前未实现 Modality LUT / Real World Value Mapping；不能忽略定量映射后导入。请离线转换为线性 RescaleSlope/Intercept。');
    if (key === '7fe0,0008' || key === '7fe0,0009') return fail('UNSUPPORTED_FLOAT_PIXEL_DATA', '当前未实现 Float/Double Float Pixel Data；请转换为支持的整数 CT/MR 数据。');
    if (key === '7fe0,0010' && e.length === 0xffffffff) return fail('ENCAPSULATED_PIXEL_DATA', '不支持封装/压缩的 DICOM Pixel Data。');
    if (whitelist.has(key)) {
      if (retained.has(key)) return fail('DUPLICATE_ELEMENT', `DICOM 数据集包含重复元素 ${key}。`);
      if (e.length === 0xffffffff) return fail('INVALID_ELEMENT', `影像属性 ${key} 不能使用未定长度。`);
      retained.set(key, e);
    }
    position = e.length === 0xffffffff ? skipUndefined(e.offset, explicit, little, 0xe0dd) : e.next;
  }
  const text = (key: string): string => { const e = retained.get(key); return e ? textAt(e.offset, e.length) : ''; };
  const numbers = (key: string): number[] => text(key).split('\\').map(s => s.trim()).filter(Boolean).map(Number);
  const numeric = (key: string, fallback?: number): number => { const list = numbers(key); return list.length ? list[0]! : fallback ?? NaN; };
  const us = (key: string, fallback?: number): number => { const e = retained.get(key); if (!e) return fallback ?? NaN; if (e.length !== 2) return fail('INVALID_NUMERIC_TAG', `DICOM ${key} 不是单个 US 值。`); return view.getUint16(e.offset, little); };
  const modality = text('0008,0060');
  if (modality !== 'CT' && modality !== 'MR') return fail('UNSUPPORTED_MODALITY', `只支持未压缩单帧 CT/MR；当前 Modality=${modality || '(缺失)'}。`);
  if (numeric('0028,0008', 1) !== 1) return fail('UNSUPPORTED_MULTIFRAME', '当前未实现 Enhanced/多帧/4D DICOM 导入。请先离线拆分为单帧系列。');
  if (us('0028,0002', 1) !== 1) return fail('UNSUPPORTED_COLOR', '当前只支持单通道 MONOCHROME CT/MR。');
  const photometricInterpretation = text('0028,0004');
  if (photometricInterpretation !== 'MONOCHROME1' && photometricInterpretation !== 'MONOCHROME2') return fail('UNSUPPORTED_PHOTOMETRIC', '当前只支持 MONOCHROME1/MONOCHROME2。');
  const rows = us('0028,0010'), columns = us('0028,0011'), bitsAllocated = us('0028,0100'), bitsStored = us('0028,0101'), highBit = us('0028,0102'), representation = us('0028,0103');
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(columns) || columns < 1 || rows * columns > 128 * 1024 * 1024) return fail('INVALID_DIMENSIONS', 'DICOM Rows/Columns 无效或超过体素上限。');
  if (![8, 16, 32].includes(bitsAllocated) || !Number.isInteger(bitsStored) || bitsStored < 1 || bitsStored > bitsAllocated || !Number.isInteger(highBit) || highBit < bitsStored - 1 || highBit >= bitsAllocated || ![0, 1].includes(representation)) return fail('UNSUPPORTED_PIXEL_FORMAT', 'DICOM BitsAllocated/BitsStored/HighBit/PixelRepresentation 无效或不受支持。');
  const imagePosition = numbers('0020,0032'), imageOrientation = numbers('0020,0037'), pixelSpacing = numbers('0028,0030');
  if (imagePosition.length !== 3 || imageOrientation.length !== 6 || pixelSpacing.length !== 2 || [...imagePosition, ...imageOrientation, ...pixelSpacing].some(n => !Number.isFinite(n)) || pixelSpacing.some(n => n <= 0)) return fail('MISSING_GEOMETRY', 'DICOM 缺少有效 ImagePositionPatient/ImageOrientationPatient/PixelSpacing；不能以实例序号猜测空间位置。');
  const directionX = imageOrientation.slice(0, 3), directionY = imageOrientation.slice(3, 6);
  if (Math.abs(Math.hypot(...directionX) - 1) > 1e-4 || Math.abs(Math.hypot(...directionY) - 1) > 1e-4 || Math.abs(directionX.reduce((s, n, i) => s + n * directionY[i]!, 0)) > 1e-4) return fail('INVALID_ORIENTATION', 'DICOM 方向余弦必须为正交单位向量。');
  const seriesInstanceUID = text('0020,000e');
  if (!seriesInstanceUID || !/^[\d.]+$/.test(seriesInstanceUID)) return fail('MISSING_SERIES_UID', 'DICOM 缺少有效 SeriesInstanceUID，无法安全分组。');
  const rescaleSlope = numeric('0028,1053', 1), rescaleIntercept = numeric('0028,1052', 0);
  if (!Number.isFinite(rescaleSlope) || rescaleSlope === 0 || !Number.isFinite(rescaleIntercept)) return fail('INVALID_RESCALE', 'DICOM RescaleSlope/Intercept 无效。');
  const pixel = retained.get('7fe0,0010'), count = rows * columns, byteCount = count * bitsAllocated / 8;
  if (!pixel || pixel.length < byteCount || pixel.length > byteCount + (byteCount % 2)) return fail('INVALID_PIXEL_LENGTH', 'DICOM Pixel Data 长度与图像尺寸/位深不一致。');
  const data = new Float32Array(count), shift = highBit + 1 - bitsStored, modulus = 2 ** bitsStored;
  for (let i = 0; i < count; i++) {
    const offset = pixel.offset + i * bitsAllocated / 8;
    const raw = bitsAllocated === 8 ? view.getUint8(offset) : bitsAllocated === 16 ? view.getUint16(offset, little) : view.getUint32(offset, little);
    let value = Math.floor(raw / 2 ** shift) % modulus;
    if (representation === 1 && value >= modulus / 2) value -= modulus;
    value = value * rescaleSlope + rescaleIntercept;
    if (!Number.isFinite(value) || Math.abs(value) > 3.402823466e38) return fail('INVALID_PIXEL_VALUE', 'DICOM 重标度产生非有限像素值。');
    data[i] = value;
  }
  const optional = (key: string): number | undefined => { const value = numeric(key); return Number.isFinite(value) ? value : undefined; };
  const rescaleType = text('0028,1054').toUpperCase();
  return { seriesInstanceUID, sopInstanceUID: text('0008,0018') || undefined, modality, rows, columns,
    imagePosition: imagePosition as Vec3, imageOrientation: imageOrientation as DicomSlice['imageOrientation'], pixelSpacing: pixelSpacing as [number, number],
    sliceThickness: optional('0018,0050'), spacingBetweenSlices: optional('0018,0088'), instanceNumber: optional('0020,0013'), temporalPosition: optional('0020,0100'),
    bitsAllocated, bitsStored, highBit, signed: representation === 1, rescaleSlope, rescaleIntercept,
    intensityUnit: modality === 'CT' && (!rescaleType || rescaleType === 'HU') ? 'HU' : 'GV',
    photometricInterpretation, windowCenter: optional('0028,1050'), windowWidth: optional('0028,1051'), data, transferSyntaxUID };
}

export function groupDicomSeries(slices: readonly DicomSlice[]): DicomSeries[] {
  const groups = new Map<string, DicomSeries>();
  for (const slice of slices) {
    let series = groups.get(slice.seriesInstanceUID);
    if (!series) { series = { seriesInstanceUID: slice.seriesInstanceUID, modality: slice.modality, slices: [] }; groups.set(slice.seriesInstanceUID, series); }
    if (series.modality !== slice.modality) return fail('MIXED_MODALITY', '相同 SeriesInstanceUID 中混有不同 Modality。');
    series.slices.push(slice);
  }
  return [...groups.values()].sort((a, b) => a.seriesInstanceUID.localeCompare(b.seriesInstanceUID));
}

/** Build a regular 3-D RAS-mm volume. Irregular or repeated planes are rejected, never silently averaged. */
export function convertSeriesToVolume(input: DicomSeries | readonly DicomSlice[], name = '离线 DICOM 系列', control: AlgorithmControl = {}): DicomVolume {
  const slices = Array.isArray(input) ? [...input] as DicomSlice[] : [...(input as DicomSeries).slices];
  if (!slices.length) return fail('EMPTY_SERIES', 'DICOM 系列为空。');
  const first = slices[0]!, orient = first.imageOrientation;
  if (slices.length * first.rows * first.columns > 128 * 1024 * 1024 || [first.rows, first.columns, slices.length].some(n => n > 32767)) return fail('VOLUME_TOO_LARGE', 'DICOM 系列超过体素上限或 NIfTI-1 维数上限。');
  const normal: Vec3 = [orient[1] * orient[5] - orient[2] * orient[4], orient[2] * orient[3] - orient[0] * orient[5], orient[0] * orient[4] - orient[1] * orient[3]];
  const project = (p: Vec3): number => p.reduce((s, n, a) => s + n * normal[a]!, 0);
  const close = (a: number, b: number, tolerance = 1e-4): boolean => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
  const sopIDs = new Set<string>(), phases = new Set<number>();
  for (const slice of slices) {
    if (slice.seriesInstanceUID !== first.seriesInstanceUID) return fail('MIXED_SERIES', '不能把不同 SeriesInstanceUID 合并为一个体积。');
    if (slice.rows !== first.rows || slice.columns !== first.columns || slice.data.length !== first.rows * first.columns || slice.modality !== first.modality || slice.intensityUnit !== first.intensityUnit || slice.photometricInterpretation !== first.photometricInterpretation || slice.imageOrientation.some((n, a) => !close(n, orient[a]!)) || slice.pixelSpacing.some((n, a) => !close(n, first.pixelSpacing[a]!))) return fail('INCONSISTENT_GEOMETRY', 'DICOM 系列的尺寸/方向/间距/灰度单位不一致；请按采集系列拆分。');
    if (slice.sopInstanceUID) { if (sopIDs.has(slice.sopInstanceUID)) return fail('DUPLICATE_INSTANCE', '系列中存在重复 SOPInstanceUID。'); sopIDs.add(slice.sopInstanceUID); }
    if (slice.temporalPosition !== undefined) phases.add(slice.temporalPosition);
  }
  if (phases.size > 1) return fail('UNSUPPORTED_4D', '系列包含多个时间相位，当前未实现 4D 导入。');
  slices.sort((a, b) => project(a.imagePosition) - project(b.imagePosition));
  const origin = slices[0]!.imagePosition;
  let zStep: Vec3;
  if (slices.length === 1) {
    const step = Math.abs(first.spacingBetweenSlices ?? first.sliceThickness ?? 0);
    if (!Number.isFinite(step) || step <= 0) return fail('MISSING_SLICE_SPACING', '单层 DICOM 需要有效 SliceThickness/SpacingBetweenSlices 来建立三维间距。');
    zStep = normal.map(n => n * step) as Vec3;
  } else {
    zStep = slices[1]!.imagePosition.map((n, a) => n - origin[a]!) as Vec3;
    const separation = project(zStep);
    if (separation < 1e-5) return fail('DUPLICATE_SLICE_POSITION', '存在相同切面或多个时间相位；当前只支持单个规则三维系列。');
    for (let z = 1; z < slices.length; z++) {
      if (slices[z]!.imagePosition.some((n, a) => Math.abs(n - (origin[a]! + z * zStep[a]!)) > Math.max(1e-3, Math.abs(zStep[a]!) * 1e-3))) return fail('IRREGULAR_SLICE_SPACING', 'DICOM 切片间距不规则、包含重复切面或存在缺片；当前不会静默重采样。');
    }
    const declaredSpacing = Math.abs(first.spacingBetweenSlices ?? 0);
    if (declaredSpacing > 0 && !close(separation, declaredSpacing, 1e-3)) return fail('SLICE_SPACING_MISMATCH', '实际切片间隔与 SpacingBetweenSlices 不一致，可能缺片。');
  }
  const dims: Vec3 = [first.columns, first.rows, slices.length], spacing: Vec3 = [first.pixelSpacing[1], first.pixelSpacing[0], Math.hypot(...zStep)];
  // DICOM patient LPS → NIfTI RAS. Preserve gantry-tilt shear in the sform.
  const affine = [0, 1, 2].map(r => { const sign = r === 2 ? 1 : -1; return [orient[r]! * spacing[0] * sign, orient[r + 3]! * spacing[1] * sign, zStep[r]! * sign, origin[r]! * sign]; });
  const data = new Float32Array(dims[0] * dims[1] * dims[2]); let min = Infinity, max = -Infinity;
  for (let z = 0; z < slices.length; z++) {
    if (control.cancelled?.()) return fail('CANCELLED', 'DICOM 转换已取消。');
    const pixels = slices[z]!.data; data.set(pixels, z * first.rows * first.columns);
    for (const value of pixels) { if (!Number.isFinite(value)) return fail('INVALID_PIXEL_VALUE', '系列包含非有限像素值。'); min = Math.min(min, value); max = Math.max(max, value); }
    control.progress?.((z + 1) / slices.length);
  }
  const header = new Uint8Array(348), h = new DataView(header.buffer);
  h.setInt32(0, 348, true); h.setInt16(40, 3, true);
  dims.forEach((n, a) => h.setInt16(42 + a * 2, n, true));
  for (let a = 4; a < 8; a++) h.setInt16(40 + a * 2, 1, true);
  h.setInt16(70, 16, true); h.setInt16(72, 32, true); h.setFloat32(76, 1, true);
  spacing.forEach((n, a) => h.setFloat32(80 + a * 4, n, true));
  h.setFloat32(108, 352, true); h.setFloat32(112, 1, true); h.setUint8(123, 2); h.setInt16(254, 1, true);
  affine.forEach((row, r) => row.forEach((n, c) => h.setFloat32(280 + r * 16 + c * 4, n, true)));
  header.set([110, 43, 49, 0], 344);
  const oblique = [0, 1, 2].some(col => Math.max(...affine.map(row => Math.abs(row[col]!))) / Math.hypot(...affine.map(row => row[col]!)) < .9999);
  return { name, dims, spacing, data, header, little: true, min, max, affine, oblique, unit: 'mm',
    dicom: { modality: first.modality, intensityUnit: first.intensityUnit, photometricInterpretation: first.photometricInterpretation, displayInverted: first.photometricInterpretation === 'MONOCHROME1', windowCenter: first.windowCenter, windowWidth: first.windowWidth, coordinateSystem: 'RAS' } };
}
