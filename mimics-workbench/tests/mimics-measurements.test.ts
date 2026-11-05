import { test } from 'node:test';
import assert from 'node:assert/strict';
import { densityStatistics, evaluateMeasurement, worldToVoxel } from '../src/mimics/measurements.ts';
import { physicalPoint } from '../src/mimics/types.ts';
import type { VolumeGrid } from '../src/mimics/types.ts';

const close = (a: number, b: number, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≠ ${b}`);
const grid: VolumeGrid = { dims: [3, 3, 2], spacing: [2, 3, 5], affine: [[0, -3, 0, 10], [2, 0, 0, -4], [0, 0, 5, 7]], data: Float32Array.from({ length: 18 }, (_, i) => i % 3 + 10 * (Math.floor(i / 3) % 3) + 100 * Math.floor(i / 9)) };

test('physical distance and inverse transform retain rotation, translation, anisotropy and shear', () => {
  const p: [number, number, number] = [1.25, 2, .5];
  const restored = worldToVoxel(physicalPoint(p, grid), grid);
  restored.forEach((n, a) => close(n, p[a]!));
  const measurement = evaluateMeasurement('distance', [[0, 0, 0], [1, 1, 1]], { coordinateSpace: 'voxel', grid });
  assert.equal(measurement.valid, true); close(measurement.value, Math.sqrt(38)); assert.equal(measurement.unit, 'mm');
  const sheared = { spacing: [2, 3, 4] as [number, number, number], affine: [[2, .5, 1, 8], [0, 3, .25, 9], [0, 0, 4, -2]] };
  worldToVoxel(physicalPoint(p, sheared), sheared).forEach((n, a) => close(n, p[a]!));
  assert.throws(() => worldToVoxel([0, 0, 0], { spacing: [1, 1, 1], affine: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] }), /不可逆/);
});
test('angle uses the second point as vertex, diameter uses a circumcircle and rejects degeneracy', () => {
  close(evaluateMeasurement('angle', [[1, 0, 0], [0, 0, 0], [0, 1, 0]]).value, 90);
  const diameter = evaluateMeasurement('3pointdiameter', [[1, 0, 3], [0, 1, 3], [-1, 0, 3]]);
  close(diameter.value, 2); assert.deepEqual(diameter.details.center, [0, 0, 3]);
  assert.equal(evaluateMeasurement('angle', [[0, 0, 0], [0, 0, 0], [1, 0, 0]]).valid, false);
  assert.equal(evaluateMeasurement('diameter', [[0, 0, 0], [1, 0, 0], [2, 0, 0]]).valid, false);
});
test('ellipse reports every documented output and documented eccentricity', () => {
  const ellipse = evaluateMeasurement('ellipse', [[-2, 0, 0], [2, 0, 0], [0, 1, 0]]);
  assert.equal(ellipse.valid, true); close(ellipse.value, 2 * Math.PI);
  close(ellipse.details.D1 as number, 4); close(ellipse.details.D2 as number, 2); close(ellipse.details.E as number, Math.sqrt(.75));
  close(ellipse.details.P as number, 9.688448220547675, 1e-9);
  close(ellipse.details.DP as number, (ellipse.details.P as number) / Math.PI);
  close(ellipse.details.DA as number, 2 * Math.sqrt(2));
  const circle = evaluateMeasurement('ellipse', [[-2, 0, 0], [2, 0, 0], [0, 2, 0]]);
  close(circle.details.P as number, 4 * Math.PI); close(circle.details.E as number, 0);
});
test('area uses the physical planar polygon, with centroid and perimeter rather than a bounding box', () => {
  const area = evaluateMeasurement('planarpolygon', [[0, 0, 5], [4, 0, 5], [0, 3, 5]]);
  close(area.value, 6); close(area.details.perimeter as number, 12);
  const centroid = area.details.centroid as [number, number, number]; close(centroid[0], 4 / 3); close(centroid[1], 1); close(centroid[2], 5);
  assert.equal(evaluateMeasurement('area', [[0, 0, 0], [2, 2, 0], [0, 2, 0], [2, 0, 0]]).valid, false);
  assert.equal(evaluateMeasurement('area', [[0, 0, 0], [1, 0, 0], [1, 1, 1], [0, 1, 0]]).valid, false);
  const rotated = evaluateMeasurement('area', [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], { coordinateSpace: 'voxel', grid });
  close(rotated.value, 6);
});
test('Lmax is the maximum chord through the area centroid, not the maximum vertex-pair distance', () => {
  const polygon: [number, number, number][] = [[0, 0, 5], [4, 0, 5], [0, 3, 5]];
  const measured = evaluateMeasurement('planarpolygon', polygon);
  // The 5 mm hypotenuse misses centroid (4/3,1); the longest centroid chord runs (0,1.5)→(4,0).
  close(measured.details.Lmax as number, Math.sqrt(73) / 2);
  assert.ok((measured.details.Lmax as number) < 5);
  close(measured.details.L as number, 73 * Math.sqrt(73) / 328);
  assert.equal(measured.details.chordStatus, 'ok');
  const start = measured.details.LmaxStart as [number, number, number], end = measured.details.LmaxEnd as [number, number, number];
  start.forEach((n, a) => close(n, [0, 1.5, 5][a]!));end.forEach((n, a) => close(n, [4, 0, 5][a]!));
  const reordered = evaluateMeasurement('area', [polygon[1]!, polygon[0]!, polygon[2]!]);
  close(reordered.details.Lmax as number, measured.details.Lmax as number);close(reordered.details.L as number, measured.details.L as number);
  const tilted = evaluateMeasurement('area', [[7, 0, 0], [7, 4, 0], [7, 0, 3]]);
  close(tilted.details.Lmax as number, measured.details.Lmax as number);close(tilted.details.L as number, measured.details.L as number);
});
test('concave centroid chords use the connected interior segment and exclude disconnected lobes', () => {
  // A 10×10 square with the open notch [7,9]×[2,10]; centroid=(31/7,101/21) lies inside.
  const measured = evaluateMeasurement('area', [[0, 0, 0], [10, 0, 0], [10, 10, 0], [9, 10, 0], [9, 2, 0], [7, 2, 0], [7, 10, 0], [0, 10, 0]]);
  close(measured.value, 84);
  close(measured.details.Lmax as number, 10 * Math.sqrt(20530) / 109);
  // Perpendicular intersects a separate right-hand lobe over x=9..10; only x=0..7 contains the centroid.
  close(measured.details.L as number, 7 * Math.sqrt(20530) / 109);
  const outside = evaluateMeasurement('area', [[0, 0, 0], [6, 0, 0], [6, 6, 0], [4, 6, 0], [4, 2, 0], [2, 2, 0], [2, 6, 0], [0, 6, 0]]);
  assert.equal(outside.valid, true);close(outside.value, 28);assert.equal(outside.details.chordStatus, 'centroid_outside_polygon');
  assert.ok(Number.isNaN(outside.details.Lmax));assert.ok(Number.isNaN(outside.details.L));
});
test('rectangular, elliptical and polygon density use raw data and physical sample area', () => {
  const rect = densityStatistics(grid, { axis: 2, index: 0 }, { kind: 'rect', min: [0, 0], max: [2, 2] }, { unit: 'HU' });
  assert.equal(rect.count, 9); close(rect.mean, 11); close(rect.std, Math.sqrt(202 / 3)); close(rect.area, 54); close(rect.geometricArea, 24); assert.equal(rect.unit, 'HU');
  const ellipse = densityStatistics(grid, { axis: 2, index: 0 }, { kind: 'ellipse', center: [1, 1], radius: [1, 1] });
  assert.equal(ellipse.count, 5); close(ellipse.mean, 11); close(ellipse.std, Math.sqrt(202 / 5)); close(ellipse.area, 30); close(ellipse.geometricArea, 6 * Math.PI); assert.equal(ellipse.unit, 'GV');
  const polygon = densityStatistics(grid, { axis: 2, index: 0 }, { kind: 'polygon', points: [[0, 0], [2, 0], [0, 2]] });
  assert.equal(polygon.count, 6); close(polygon.mean, 44 / 6); close(polygon.geometricArea, 12);
});
test('oblique MPR density uses the provided world-space basis and trilinear samples', () => {
  const stats = densityStatistics(grid, { origin: physicalPoint([0, 0, .5], grid), u: [0, 2, 0], v: [-3, 0, 0], size: [3, 3] }, { kind: 'rect', min: [0, 0], max: [2, 2] }, { interpolation: 'linear' });
  assert.equal(stats.count, 9); close(stats.mean, 61); close(stats.area, 54);
  const excluded = densityStatistics(grid, { origin: physicalPoint([-1, 0, 0], grid), u: [0, 2, 0], v: [-3, 0, 0], size: [4, 3] }, { kind: 'rect', min: [0, 0], max: [3, 2] });
  assert.equal(excluded.count, 9); assert.equal(excluded.excluded, 3);
  assert.throws(() => densityStatistics(grid, { axis: 2, index: 0 }, { kind: 'ellipse', center: [1, 1], radius: [0, 1] }), /半径/);
});
