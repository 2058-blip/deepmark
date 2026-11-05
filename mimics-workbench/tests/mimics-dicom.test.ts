import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSeriesToVolume, DICOM_TRANSFER_SYNTAX, groupDicomSeries, parseDicom } from '../src/mimics/dicom.ts';
import { exportNifti, parseNifti } from '../src/core.ts';

const encoder = new TextEncoder();
type FixtureOptions = { syntax?: string; uid?: string; x?: number; signed?: boolean; highBit?: number; stored?: number; values?: number[]; modality?: string; mono?: string; frames?: number; slope?: number; intercept?: number; sop?: string; spacingBetween?: number; temporal?: number; sequence?: boolean };
function concat(parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const p of parts) { out.set(p, offset); offset += p.length; } return out; }
/** Synthetic values only. No real imaging or patient files are accessed by these tests. */
function fixture(options: FixtureOptions = {}): Uint8Array {
  const uid = options.syntax ?? DICOM_TRANSFER_SYNTAX.explicitLittleEndian;
  const explicit = uid !== DICOM_TRANSFER_SYNTAX.implicitLittleEndian, little = uid !== DICOM_TRANSFER_SYNTAX.explicitBigEndian;
  function element(group: number, tag: number, vr: string, value: string | number | Uint8Array, meta = false): Uint8Array {
    const le = meta || little, exp = meta || explicit;
    let body: Uint8Array;
    if (typeof value === 'number') { body = new Uint8Array(2); new DataView(body.buffer).setUint16(0, value, le); }
    else if (typeof value === 'string') { body = encoder.encode(value + (value.length % 2 ? vr === 'UI' ? '\0' : ' ' : '')); }
    else body = value;
    const long = ['OB', 'OW', 'SQ', 'UN'].includes(vr), header = new Uint8Array(exp && long ? 12 : 8), v = new DataView(header.buffer);
    v.setUint16(0, group, le); v.setUint16(2, tag, le);
    if (exp) { header.set(encoder.encode(vr), 4); if (long) v.setUint32(8, body.length, le); else v.setUint16(6, body.length, le); }
    else v.setUint32(4, body.length, le);
    return concat([header, body]);
  }
  const bitsStored = options.stored ?? 12, highBit = options.highBit ?? 11;
  const pixels = new Uint8Array(8), view = new DataView(pixels.buffer);
  (options.values ?? [0, 1, 2, 3]).forEach((value, i) => { const packed = ((value % 2 ** bitsStored + 2 ** bitsStored) % 2 ** bitsStored) * 2 ** (highBit + 1 - bitsStored); view.setUint16(i * 2, packed, little); });
  const preamble = new Uint8Array(132); preamble.set(encoder.encode('DICM'), 128);
  const tags = [element(2, 0x10, 'UI', uid, true), element(8, 0x18, 'UI', options.sop ?? `1.2.840.9.${(options.x ?? 0) + 100}`), element(8, 0x60, 'CS', options.modality ?? 'CT'),
    element(0x10, 0x10, 'PN', 'SYNTHETIC^NO_PATIENT'), element(0x18, 0x50, 'DS', '2'),
    ...(options.spacingBetween !== undefined ? [element(0x18, 0x88, 'DS', String(options.spacingBetween))] : []),
    element(0x20, 0xe, 'UI', options.uid ?? '1.2.840.99.1'), element(0x20, 0x13, 'IS', String(100 - (options.x ?? 0))),
    element(0x20, 0x32, 'DS', `${options.x ?? 0}\\20\\30`), element(0x20, 0x37, 'DS', '0\\1\\0\\0\\0\\1'),
    ...(options.temporal !== undefined ? [element(0x20, 0x100, 'IS', String(options.temporal))] : []),
    element(0x28, 2, 'US', 1), element(0x28, 4, 'CS', options.mono ?? 'MONOCHROME2'), element(0x28, 8, 'IS', String(options.frames ?? 1)), element(0x28, 0x10, 'US', 2), element(0x28, 0x11, 'US', 2), element(0x28, 0x30, 'DS', '2\\3'),
    element(0x28, 0x100, 'US', 16), element(0x28, 0x101, 'US', bitsStored), element(0x28, 0x102, 'US', highBit), element(0x28, 0x103, 'US', options.signed ? 1 : 0),
    element(0x28, 0x1052, 'DS', String(options.intercept ?? -1000)), element(0x28, 0x1053, 'DS', String(options.slope ?? 2))];
  if (options.sequence) {
    const sequence = new Uint8Array(explicit ? 28 : 24), seq = new DataView(sequence.buffer);
    seq.setUint16(0, 0x40, little); seq.setUint16(2, 0x275, little);
    let off = 8;
    if (explicit) { sequence.set(encoder.encode('SQ'), 4); seq.setUint32(8, 0xffffffff, little); off = 12; } else seq.setUint32(4, 0xffffffff, little);
    seq.setUint16(off, 0xfffe, little); seq.setUint16(off + 2, 0xe000, little); seq.setUint32(off + 4, 0, little);
    seq.setUint16(off + 8, 0xfffe, little); seq.setUint16(off + 10, 0xe0dd, little); seq.setUint32(off + 12, 0, little);
    tags.push(sequence);
  }
  tags.push(element(0x7fe0, 0x10, 'OW', pixels));
  return concat([preamble, ...tags]);
}

test('all three uncompressed syntaxes decode signed stored bits, high bit and rescale identically', () => {
  for (const syntax of Object.values(DICOM_TRANSFER_SYNTAX)) {
    const slice = parseDicom(fixture({ syntax, signed: true, stored: 12, highBit: 14, values: [-2, 0, 5, 2047], sequence: true }));
    assert.deepEqual([...slice.data], [-1004, -1000, -990, 3094]); assert.equal(slice.intensityUnit, 'HU');
    assert.equal('patientName' in slice, false); assert.equal(JSON.stringify(slice).includes('SYNTHETIC'), false);
  }
});
test('series are grouped by UID and spatially sorted, with correct LPS→RAS affine and NIfTI export', () => {
  const slices = [4, 0, 2].map(x => parseDicom(fixture({ x, values: [x, x, x, x] })));
  const groups = groupDicomSeries([...slices, parseDicom(fixture({ uid: '1.2.840.99.2', x: 20 }))]);
  assert.equal(groups.length, 2); assert.equal(groups[0]!.slices.length, 3);
  const volume = convertSeriesToVolume(groups[0]!);
  assert.deepEqual(volume.dims, [2, 2, 3]); assert.deepEqual(volume.spacing, [3, 2, 2]);
  assert.deepEqual(volume.affine.map(row => row.map(n => n || 0)), [[0, 0, -2, 0], [-3, 0, 0, -20], [0, 2, 0, 30]]);
  assert.deepEqual([...volume.data], [-1000, -1000, -1000, -1000, -996, -996, -996, -996, -992, -992, -992, -992]);
  const labels = new Uint16Array(12); labels[9] = 4;
  const restored = parseNifti(exportNifti(volume, labels));
  assert.deepEqual(restored.dims, volume.dims); assert.deepEqual(restored.affine, volume.affine); assert.equal(restored.data[9], 4); assert.equal(restored.unit, 'mm');
});
test('MONOCHROME1 affects display only; MRI intensities remain GV', () => {
  const slice = parseDicom(fixture({ modality: 'MR', mono: 'MONOCHROME1', values: [0, 20, 30, 40], slope: 1, intercept: 0 }));
  const volume = convertSeriesToVolume([slice]);
  assert.deepEqual([...volume.data], [0, 20, 30, 40]); assert.equal(volume.dicom.displayInverted, true); assert.equal(volume.dicom.intensityUnit, 'GV');
});
test('unsupported compression, multiframe, bad pixels and truncated data produce explicit failures', () => {
  assert.throws(() => parseDicom(fixture({ syntax: '1.2.840.10008.1.2.4.90' })), /JPEG2000/);
  assert.throws(() => parseDicom(fixture({ frames: 4 })), /多帧/);
  assert.throws(() => parseDicom(fixture({ stored: 17 })), /BitsAllocated/);
  const good = fixture(); assert.throws(() => parseDicom(good.subarray(0, good.length - 1)), /截断/);
  const raw = good.subarray(140 + new DataView(good.buffer).getUint16(138, true));
  assert.throws(() => parseDicom(raw), /transferSyntaxUID/);
  assert.equal(parseDicom(raw, { transferSyntaxUID: DICOM_TRANSFER_SYNTAX.explicitLittleEndian }).rows, 2);
});
test('mixed/irregular/repeated slices and multiple time phases cannot silently become a 3D volume', () => {
  const s = (x: number, more: FixtureOptions = {}) => parseDicom(fixture({ x, ...more }));
  assert.throws(() => convertSeriesToVolume([s(0), s(2), s(5)]), /不规则/);
  assert.throws(() => convertSeriesToVolume([s(0), s(0, { sop: '1.2.100.99' })]), /相同切面/);
  assert.throws(() => convertSeriesToVolume([s(0), s(2, { uid: '1.2.100' })]), /SeriesInstanceUID/);
  assert.throws(() => convertSeriesToVolume([s(0, { temporal: 1 }), s(2, { temporal: 2 })]), /4D/);
  assert.throws(() => convertSeriesToVolume([s(0, { spacingBetween: 1 }), s(2, { spacingBetween: 1 })]), /可能缺片/);
  assert.throws(() => convertSeriesToVolume([s(0)], 'cancelled', { cancelled: () => true }), /已取消/);
});
