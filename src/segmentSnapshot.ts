import type {Segment} from './view.ts';

/** Copy the label data into plain objects before IndexedDB's structured clone. */
export function snapshotSegments(segments:readonly Segment[]):Segment[]{
  return segments.map(segment=>{
    const snapshot:Segment={id:segment.id,name:segment.name,color:segment.color,visible:segment.visible};
    if(segment.createdBy!==undefined)snapshot.createdBy=segment.createdBy===null?null:{id:segment.createdBy.id,name:segment.createdBy.name};
    if(segment.createdAt!==undefined)snapshot.createdAt=segment.createdAt;
    return snapshot;
  });
}
