/** Linear voxel addresses are stored in Uint32Array throughout the editor.
 * This is an address-format bound, not the former fixed 128 Mi-voxel quota. */
export const MAX_VOXEL_ADDRESS_COUNT = 0xffffffff;
/** The current project writer is ZIP32, without ZIP64 size records. */
export const MAX_ZIP32_BYTES = 0xffffffff;
export const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
export function checkedVoxelLength(count: number, label = '影像'): number {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(label + '体素尺寸或数量无效。');
  if (count > MAX_VOXEL_ADDRESS_COUNT) throw new Error(label + '体素数量超过当前32位体素索引可表示的范围。');
  return count;
}
export function checkedVoxelCount(dims: readonly number[], label = '影像'): number {
  if (dims.length !== 3 || dims.some(n => !Number.isSafeInteger(n) || n < 1 || n > 32767))
    throw new Error(label + '尺寸无效，NIfTI-1 每个方向需在1至32767之间。');
  return checkedVoxelLength(dims[0]! * dims[1]! * dims[2]!, label);
}
export function allocateVolumeData(count: number): Float32Array {
  checkedVoxelLength(count);
  try { return new Float32Array(count); }
  catch { throw new Error('浏览器无法分配这份影像所需的 ' + (count * 4 / 2 ** 20).toFixed(0) + ' MiB 连续内存。请关闭其他大影像页面后重试，或使用64位浏览器和更多可用内存。'); }
}
