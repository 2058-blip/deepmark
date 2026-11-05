import type {MaskObject,PartObject} from './types.ts';

export type PartSourceStatus='external'|'missing'|'unknown'|'current'|'stale';
/** Application provenance policy: source revision describes ancestry, not a claim that a processed mesh equals the Mask. */
export function partSourceStatus(part:PartObject,masks:readonly MaskObject[]):PartSourceStatus{
  if(part.sourceMaskId===undefined)return'external';
  const source=masks.find(mask=>mask.id===part.sourceMaskId);
  if(!source)return'missing';
  if(part.sourceRevision===undefined)return'unknown';
  return part.sourceRevision===source.revision?'current':'stale';
}
/** Keep the input Part's captured ancestry. Never replace it with a newer live Mask revision. */
export function inheritPartSource(part:PartObject):Pick<PartObject,'sourceMaskId'|'sourceRevision'>{
  return{...(part.sourceMaskId!==undefined?{sourceMaskId:part.sourceMaskId}:{}),...(part.sourceRevision!==undefined?{sourceRevision:part.sourceRevision}:{})};
}
