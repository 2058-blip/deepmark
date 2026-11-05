import type {Volume} from '../core.ts';
import type {MprPlane,Vec3} from './types.ts';

export interface MprContourEpoch {sessionId:number;activeMaskId:string;mprPlane:MprPlane;volume:Volume;revision:number;mprRevision:number}
export interface MprContourPoint extends MprContourEpoch {position:Vec3}
export interface MprContourCompletion extends MprContourEpoch {points?:Vec3[]}
export interface MprContourDraft extends MprContourEpoch {points:Vec3[];anchors:Vec3[];hover:Vec3[];pending:boolean}
let lastSessionId=0;
export function nextMprContourSessionId(){if(lastSessionId>=Number.MAX_SAFE_INTEGER)throw new Error('MPR轮廓会话编号已耗尽，请重新加载工作台。');return++lastSessionId;}
