import type {MeasurementObject} from './types.ts';

/** A present per-point array is authoritative; legacy objects fall back to their uniform partId. */
export function measurementPointPartId(measurement:MeasurementObject,index:number):string|null{
  if(!Number.isSafeInteger(index)||index<0||index>=measurement.points.length)return null;
  if(measurement.pointPartIds!==undefined)return measurement.pointPartIds[index]??null;
  return measurement.partId??null;
}
/** Distinct historical Part IDs in first-point order; image/unattached points are omitted. */
export function measurementPartIds(measurement:MeasurementObject):string[]{
  return measurement.pointPartIds!==undefined?[...new Set(measurement.pointPartIds.filter((id):id is string=>typeof id==='string'))]:measurement.partId?[measurement.partId]:[];
}
export function uniformMeasurementPartId(ids:readonly (string|null)[]):string|undefined{
  const first=ids[0];
  return typeof first==='string'&&first.length>0&&ids.every(id=>id===first)?first:undefined;
}
