import type {Volume} from '../core.ts';
import type {MprPlane,Vec3} from './types.ts';
import type {ResliceProjectPlan} from './resliceProjectGeometry.ts';

export interface ResliceProjectDraft {
  name:string;start:Vec3;end:Vec3;up:Vec3;rotationDegrees:number;
  widthMm:number;heightMm:number;pixelSize:number;sliceDistance:number;
  interpolation:'linear'|'nearest';background:number;updateCoordinateSystem:boolean;copyWorldObjects:boolean;
}
export interface ResliceProjectPreview {
  plan:ResliceProjectPlan|null;error:string;effectiveWidthMm:number;effectiveHeightMm:number;
  estimatedBytes:number;warnings:string[];
}
export interface ResliceProjectResultSummary {name:string;dims:Vec3;masks:number;parts:number;measurements:number;grayOutside:number;written:boolean}
export interface WorldReferenceLine {id:string;points:Vec3[];color:string;label?:string}
export interface ResliceProjectPoint {position:Vec3;volume:Volume;revision:number;lineToken:number;mprPlane?:MprPlane;mprRevision?:number;partId?:string}
