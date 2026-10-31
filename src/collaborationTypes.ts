import type {Segment} from './view.ts';
export type Person={id:string;name:string};
export type Identity=Person & {resumeKey:string;updated:number};
export type Project={id:string;datasetId:string;revision:number;latestRevision:number;branches:{id:string;name:string;mask:string}[];labels:Omit<Segment,'visible'>[]};
export type Operation={key:string;project:string;op:string;branch:string;baseRevision:number;patch:string;kind:string;created:number;label?:{id:number;name:string;color:string}};
export type ViewState={point:number[];selected:number;center:number;width:number;diameter:number;opacity:number;tool:string};
export type Draft={key:string;author:Person;project:Project;branch:string;name:string;mask:ArrayBuffer;segments:Segment[];view:ViewState;updated:number;generation:number;pending:Operation|null;needsCheckpoint:boolean;blocked?:string};
export type DraftIndex=Pick<Draft,'key'|'author'|'name'|'updated'|'needsCheckpoint'> & {projectId:string;datasetId:string};
export type Workspace={authorId:string;generation:number;revision:number;updated:string;touchedCount:number;mask:string;touched:string;checkpoint:{id:string;branch:string;revision:number;view:ViewState;labels:Segment[];snapshot:string;time:string}|null};
