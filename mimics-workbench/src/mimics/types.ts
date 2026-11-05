/** Shared contracts for the image → independent masks → mesh → measurement chain. */
export type Vec3 = [number, number, number];
export type Axis = 0 | 1 | 2;
export interface VolumeGrid {
  dims: Vec3;
  spacing: Vec3;
  data: Float32Array;
  /** Row-major voxel-to-physical affine; coordinates use millimetres. */
  affine?: number[][];
}
export type BinaryMask = Uint8Array;
export interface MaskObject {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  opacity: number;
  data: BinaryMask;
  threshold: [number, number] | null;
  revision: number;
  /** Historical Part used to create this independent Mask; no Part revision is implied. */
  sourcePartId?:string;
}
export interface TriangleMesh {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
}
export interface PartObject {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  opacity: number;
  mesh: TriangleMesh;
  sourceMaskId?: string;
  sourceRevision?: number;
}
export interface RegionBounds { min: Vec3; max: Vec3 }
export interface AlgorithmControl {
  cancelled?: () => boolean;
  progress?: (fraction: number) => void;
}
export interface SlicePlane { axis: Axis; index: number }
/** Output sample (0,0) and orthogonal one-sample steps in world mm; native IJK geometry is unchanged. */
export interface MprPlane {origin:Vec3;u:Vec3;v:Vec3;size:[number,number]}
/** Stored world-mm parameter plane; its independent steps may retain source in-plane shear. */
export interface AffinePlane {origin:Vec3;u:Vec3;v:Vec3;size:[number,number]}
/** A named native-grid-independent reslice definition. Selection activates it; MPR visibility is view state. */
export interface ReslicePlaneObject {id:string;name:string;kind:'plane';plane:MprPlane}
/** Curved reslices are deliberately not represented until their geometry contract exists. */
export type ResliceObject=ReslicePlaneObject;
export type Connectivity = 4 | 6 | 8 | 18 | 26;
export interface MaskResult { mask: BinaryMask; count: number }
export type MeasurementKind = 'distance' | 'angle' | 'diameter' | 'ellipse' | 'area' | 'density-rectangle' | 'density-ellipse' | 'annotation' | 'surface-distance';
/** Supported application styles; these enums do not claim complete native Mimics coverage. */
export interface AnnotationStyle {
  arrow:'none'|'arrow'|'dot';
  rotation:number;
  align:'left'|'center'|'right';
}
export interface MeasurementObject {
  id: string;
  name: string;
  kind: MeasurementKind;
  points: Vec3[];
  /** Physical-space points. Planar measurements also retain voxel slice context. */
  plane?: SlicePlane;
  /** An independent resampled world-mm plane; mutually exclusive with the native SlicePlane field. */
  mprPlane?:MprPlane;
  /** Historical density ROI basis, including shear; exclusive with plane and mprPlane. */
  densityPlane?:AffinePlane;
  partId?: string;
  /** Per-world-point Part ancestry. null means image/unattached; partId is only an optional uniform summary. */
  pointPartIds?:(string|null)[];
  /** Non-annotation label displacement from its geometric anchor, in world millimetres. */
  labelOffset?:Vec3;
  /** Surface path constraints, distinct from its dense resolved path in points. */
  controlPoints?: Vec3[];
  pathMethod?: 'edge-graph';
  text?: string;
  annotationStyle?:AnnotationStyle;
  visible: boolean;
  color: string;
}
export function voxelIndex(p: readonly number[], d: readonly number[]): number {
  return p[0]! + d[0]! * (p[1]! + d[1]! * p[2]!);
}
export function voxelPoint(i: number, d: readonly number[]): Vec3 {
  const x = i % d[0]!; const q = (i - x) / d[0]!;
  return [x, q % d[1]!, Math.floor(q / d[1]!)];
}
export function physicalPoint(p: readonly number[], grid: Pick<VolumeGrid, 'spacing' | 'affine'>): Vec3 {
  if (grid.affine) return [0, 1, 2].map(r => grid.affine![r]![0]! * p[0]! + grid.affine![r]![1]! * p[1]! + grid.affine![r]![2]! * p[2]! + grid.affine![r]![3]!) as Vec3;
  return [p[0]! * grid.spacing[0], p[1]! * grid.spacing[1], p[2]! * grid.spacing[2]];
}
export function requireGrid(grid: VolumeGrid, mask?: BinaryMask): number {
  if (grid.dims.some(n => !Number.isSafeInteger(n) || n <= 0) || grid.spacing.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('影像尺寸或物理间距无效。');
  const n = grid.dims[0] * grid.dims[1] * grid.dims[2];
  if (grid.data.length !== n || mask && mask.length !== n) throw new Error('影像与Mask尺寸不一致。');
  return n;
}
