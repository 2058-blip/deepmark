import {physicalPoint,requireGrid,voxelIndex,voxelPoint} from './types.ts';
import type {AlgorithmControl,BinaryMask,Vec3,VolumeGrid} from './types.ts';
import {fitCenterline} from './centerline.ts';

export type Affine34=number[][];
export interface RigidTransform {kind:'rigid';matrix:Affine34;landmarkRmsMm?:number}
export interface PhaseGeometry {dims:Vec3;spacing:Vec3;affine:Affine34}
/** Pull transform: target-world x maps to source-world pullAffine*x + displacement(targetVoxel). */
export interface DensePhaseTransform {
  id:string;algorithm:'independent-demons';mapping:'target-world-to-source-world';
  source:PhaseGeometry;target:PhaseGeometry;initialForward:RigidTransform;pullAffine:Affine34;
  displacement:Float32Array;iterations:number;converged:boolean;termination:'initial-match'|'tolerance'|'line-search-stalled'|'max-iterations';meanSquaredError:number[];minimumJacobian:number;validSampleFraction:number;
}
export interface PhaseRegistrationOptions extends AlgorithmControl {
  initialTransform?:RigidTransform;landmarks?:{source:Vec3[];target:Vec3[]};initialization?:'identity'|'intensity-centroid';
  iterations?:number;stepMm?:number;smoothingMm?:number;relativeTolerance?:number;maxDisplacementMm?:number;minimumJacobian?:number;maxVoxels?:number;
}
const add=(a:Vec3,b:Vec3):Vec3=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const mul=(a:Vec3,s:number):Vec3=>[a[0]*s,a[1]*s,a[2]*s];
const norm=(a:Vec3)=>Math.hypot(...a);
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function check(control:AlgorithmControl,fraction?:number){if(control.cancelled?.())throw new Error('相位处理已取消。');if(fraction!==undefined)control.progress?.(Math.max(0,Math.min(1,fraction)));if(control.cancelled?.())throw new Error('相位处理已取消。');}
const identity=():Affine34=>[[1,0,0,0],[0,1,0,0],[0,0,1,0]];
const apply=(m:Affine34,p:Vec3):Vec3=>m.map(row=>row[0]!*p[0]+row[1]!*p[1]+row[2]!*p[2]+row[3]!) as Vec3;
function affineOf(grid:Pick<VolumeGrid,'affine'|'spacing'>):Affine34{return grid.affine?grid.affine.slice(0,3).map(r=>r.slice(0,4)):grid.spacing.map((s,a)=>[a===0?s:0,a===1?s:0,a===2?s:0,0]);}
function inverse(m:Affine34):Affine34{
  if(m.length!==3||m.some(r=>r.length!==4||r.some(n=>!Number.isFinite(n))))throw new Error('相位仿射无效。');
  const a:Vec3=[m[0]![0]!,m[1]![0]!,m[2]![0]!],b:Vec3=[m[0]![1]!,m[1]![1]!,m[2]![1]!],c:Vec3=[m[0]![2]!,m[1]![2]!,m[2]![2]!],det=dot(a,cross(b,c));
  if(Math.abs(det)<=Number.EPSILON*norm(a)*norm(b)*norm(c)*16)throw new Error('相位仿射不可逆。');const result=[cross(b,c),cross(c,a),cross(a,b)].map(v=>v.map(n=>n/det));return result.map(r=>[...r,-r[0]!*m[0]![3]!-r[1]!*m[1]![3]!-r[2]!*m[2]![3]!]);
}
function geometry(grid:VolumeGrid):PhaseGeometry{requireGrid(grid);const affine=affineOf(grid),result:PhaseGeometry={dims:[...grid.dims],spacing:[...grid.spacing],affine};validatePhaseGeometry(result);return result;}
function validatePhaseGeometry(value:PhaseGeometry){
  if(!value||!Array.isArray(value.dims)||value.dims.length!==3||value.dims.some(n=>!Number.isSafeInteger(n)||n<=0)||!Array.isArray(value.spacing)||value.spacing.length!==3||value.spacing.some(n=>!Number.isFinite(n)||n<=0)||!Array.isArray(value.affine))throw new Error('相位物理网格无效。');
  inverse(value.affine);
  if(value.spacing.some((s,a)=>Math.abs(s-Math.hypot(...value.affine.map(r=>r[a]!)))>1e-5*Math.max(s,Math.hypot(...value.affine.map(r=>r[a]!)))))throw new Error('相位间距与毫米仿射不一致。');
}
function rigidValid(transform:RigidTransform){if(transform.kind!=='rigid')throw new Error('初始变换必须是刚性变换。');inverse(transform.matrix);const columns=[0,1,2].map(c=>transform.matrix.map(r=>r[c]!) as Vec3);if(columns.some(c=>Math.abs(norm(c)-1)>1e-6)||Math.abs(dot(columns[0]!,columns[1]!))>1e-6||Math.abs(dot(columns[1]!,columns[2]!))>1e-6||Math.abs(dot(columns[0]!,cross(columns[1]!,columns[2]!))-1)>1e-6)throw new Error('初始变换包含非刚性缩放、剪切或反射。');}

/** Horn absolute orientation, with Jacobi diagonalisation of the symmetric 4×4 quaternion matrix. */
export function estimateRigidTransform(source:Vec3[],target:Vec3[]):RigidTransform{
  if(source.length<3||source.length!==target.length||[...source,...target].some(p=>p.length!==3||p.some(n=>!Number.isFinite(n))))throw new Error('刚性配准需要至少三对有限地标。');
  const mean=(p:Vec3[])=>p.reduce((s,q)=>add(s,mul(q,1/p.length)),[0,0,0] as Vec3),cs=mean(source),ct=mean(target),x=source.map(p=>sub(p,cs)),y=target.map(p=>sub(p,ct));
  if(!x.some(a=>x.some(b=>norm(cross(a,b))>1e-8))||!y.some(a=>y.some(b=>norm(cross(a,b))>1e-8)))throw new Error('刚性地标不能全部共线。');
  const s=Array.from({length:3},()=>[0,0,0]);x.forEach((p,i)=>{for(let a=0;a<3;a++)for(let b=0;b<3;b++)s[a]![b]+=p[a]!*y[i]![b]!;});const [sxx,sxy,sxz]=s[0]!,[syx,syy,syz]=s[1]!,[szx,szy,szz]=s[2]!;
  const n=[[sxx!+syy!+szz!,syz!-szy!,szx!-sxz!,sxy!-syx!],[syz!-szy!,sxx!-syy!-szz!,sxy!+syx!,szx!+sxz!],[szx!-sxz!,sxy!+syx!,-sxx!+syy!-szz!,syz!+szy!],[sxy!-syx!,szx!+sxz!,syz!+szy!,-sxx!-syy!+szz!]],v=Array.from({length:4},(_,a)=>Array.from({length:4},(_,b)=>Number(a===b)));
  for(let iter=0;iter<80;iter++){let p=0,q=1;for(let a=0;a<4;a++)for(let b=a+1;b<4;b++)if(Math.abs(n[a]![b]!)>Math.abs(n[p]![q]!)){p=a;q=b;}if(Math.abs(n[p]![q]!)<1e-13*Math.max(1,...n.map((r,i)=>Math.abs(r[i]!))))break;const theta=.5*Math.atan2(2*n[p]![q]!,n[q]![q]!-n[p]![p]!),c=Math.cos(theta),s=Math.sin(theta),app=n[p]![p]!,aqq=n[q]![q]!,apq=n[p]![q]!;
    for(let k=0;k<4;k++)if(k!==p&&k!==q){const a=n[k]![p]!,b=n[k]![q]!;n[k]![p]=n[p]![k]=c*a-s*b;n[k]![q]=n[q]![k]=s*a+c*b;}n[p]![p]=c*c*app-2*s*c*apq+s*s*aqq;n[q]![q]=s*s*app+2*s*c*apq+c*c*aqq;n[p]![q]=n[q]![p]=0;for(let k=0;k<4;k++){const a=v[k]![p]!,b=v[k]![q]!;v[k]![p]=c*a-s*b;v[k]![q]=s*a+c*b;}}
  let at=0;for(let i=1;i<4;i++)if(n[i]![i]!>n[at]![at]!)at=i;const q=v.map(row=>row[at]!),[w,a,b,c]=q as [number,number,number,number],r=[[1-2*(b*b+c*c),2*(a*b-c*w),2*(a*c+b*w)],[2*(a*b+c*w),1-2*(a*a+c*c),2*(b*c-a*w)],[2*(a*c-b*w),2*(b*c+a*w),1-2*(a*a+b*b)]],matrix=r.map((row,i)=>[...row,ct[i]!-dot(row as Vec3,cs)]),rms=Math.sqrt(source.reduce((sum,p,i)=>sum+norm(sub(apply(matrix,p),target[i]!))**2,0)/source.length);
  const result:RigidTransform={kind:'rigid',matrix,landmarkRmsMm:rms};rigidValid(result);return result;
}
function imageCentroid(grid:VolumeGrid):Vec3{let min=Infinity;for(const n of grid.data){if(!Number.isFinite(n))throw new Error('相位图像包含非有限灰度。');min=Math.min(min,n);}let sum=0,point:Vec3=[0,0,0];for(let i=0;i<grid.data.length;i++){const weight=grid.data[i]!-min;sum+=weight;point=add(point,mul(physicalPoint(voxelPoint(i,grid.dims),grid),weight));}if(!sum)return physicalPoint(grid.dims.map(n=>(n-1)/2) as Vec3,grid);return mul(point,1/sum);}
interface Sample {value:number;gradient:Vec3;valid:boolean}
function sample(data:Float32Array,dims:Vec3,p:Vec3,outside=0):Sample{
  if(p.some((n,a)=>n<0||n>dims[a]!-1))return {value:outside,gradient:[0,0,0],valid:false};const lo=p.map(Math.floor),hi=p.map((n,a)=>Math.min(dims[a]!-1,lo[a]!+1)),f=p.map((n,a)=>n-lo[a]!);let value=0;const gradient:Vec3=[0,0,0];
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++){const voxel=[x?hi[0]!:lo[0]!,y?hi[1]!:lo[1]!,z?hi[2]!:lo[2]!],v=data[voxelIndex(voxel,dims)]!,wx=x?f[0]!:1-f[0]!,wy=y?f[1]!:1-f[1]!,wz=z?f[2]!:1-f[2]!;value+=v*wx*wy*wz;if(hi[0]!==lo[0])gradient[0]+=v*(x?1:-1)*wy*wz;if(hi[1]!==lo[1])gradient[1]+=v*wx*(y?1:-1)*wz;if(hi[2]!==lo[2])gradient[2]+=v*wx*wy*(z?1:-1);}
  return {value,gradient,valid:true};
}
function vectorSample(data:Float32Array,dims:Vec3,p:Vec3):Vec3{
  if(p.some((n,a)=>n<0||n>dims[a]!-1))throw new Error('位移场查询越出目标网格。');const lo=p.map(Math.floor),hi=p.map((_,a)=>Math.min(dims[a]!-1,lo[a]!+1)),f=p.map((n,a)=>n-lo[a]!),out:Vec3=[0,0,0];
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++){const i=3*voxelIndex([x?hi[0]!:lo[0]!,y?hi[1]!:lo[1]!,z?hi[2]!:lo[2]!],dims),w=(x?f[0]!:1-f[0]!)*(y?f[1]!:1-f[1]!)*(z?f[2]!:1-f[2]!);for(let a=0;a<3;a++)out[a]+=data[i+a]!*w;}return out;
}
function smoothField(input:Float32Array,dims:Vec3,spacing:Vec3,sigma:number):Float32Array{
  if(!sigma)return input;let current=input;for(let axis=0;axis<3;axis++){const radius=Math.ceil(2*sigma/spacing[axis]!),kernel=Array.from({length:2*radius+1},(_,i)=>Math.exp(-.5*((i-radius)*spacing[axis]!/sigma)**2)),sum=kernel.reduce((s,n)=>s+n,0),out=new Float32Array(input.length);for(let i=0;i<input.length/3;i++){const p=voxelPoint(i,dims);for(let k=-radius;k<=radius;k++){const q=[...p] as Vec3;q[axis]=Math.max(0,Math.min(dims[axis]!-1,q[axis]!+k));const j=3*voxelIndex(q,dims),w=kernel[k+radius]!/sum;for(let a=0;a<3;a++)out[3*i+a]+=current[j+a]!*w;}}current=out;}return current;
}
function minJacobian(field:Float32Array,target:PhaseGeometry,pull:Affine34):number{
  const inv=inverse(target.affine);let min=Infinity;for(let i=0;i<field.length/3;i++){const p=voxelPoint(i,target.dims),du=Array.from({length:3},()=>[0,0,0]);for(let axis=0;axis<3;axis++){const a=[...p] as Vec3,b=[...p] as Vec3;a[axis]=Math.max(0,p[axis]!-1);b[axis]=Math.min(target.dims[axis]!-1,p[axis]!+1);const ia=3*voxelIndex(a,target.dims),ib=3*voxelIndex(b,target.dims),span=b[axis]!-a[axis]!;for(let r=0;r<3;r++)du[r]![axis]=span?(field[ib+r]!-field[ia+r]!)/span:0;}const j=pull.map((row,r)=>row.slice(0,3).map((value,c)=>value+du[r]!.reduce((s,n,a)=>s+n*inv[a]![c]!,0)));const det=dot(j[0] as Vec3,cross(j[1] as Vec3,j[2] as Vec3));min=Math.min(min,det);}return min;
}
let objectSerial=0;
const temporalId=(prefix:string)=>`${prefix}-${globalThis.crypto?.randomUUID?.()??`${Date.now().toString(36)}-${++objectSerial}`}`;
export function registerPhases(sourceGrid:VolumeGrid,targetGrid:VolumeGrid,options:PhaseRegistrationOptions={}):DensePhaseTransform{
  const source=geometry(sourceGrid),target=geometry(targetGrid),n=targetGrid.data.length,max=options.maxVoxels??2_000_000,iterations=options.iterations??60,step=options.stepMm??Math.min(...target.spacing),sigma=options.smoothingMm??Math.min(...target.spacing)*.7,tolerance=options.relativeTolerance??1e-5,maxDisplacement=options.maxDisplacementMm??30,jacobianLimit=options.minimumJacobian??.05;
  if(!Number.isSafeInteger(max)||max<1||sourceGrid.data.length+n>max||!Number.isSafeInteger(iterations)||iterations<0||iterations>1000||![step,sigma,tolerance,maxDisplacement,jacobianLimit].every(Number.isFinite)||step<=0||sigma<0||sigma>20*Math.max(...target.spacing)||tolerance<0||maxDisplacement<=0||jacobianLimit<=0||jacobianLimit>1)throw new Error('稠密相位配准参数无效或超过体素预算。');
  let background=Infinity;for(const value of sourceGrid.data){if(!Number.isFinite(value))throw new Error('源相位有非有限灰度。');background=Math.min(background,value);}if(targetGrid.data.some(v=>!Number.isFinite(v)))throw new Error('目标相位有非有限灰度。');
  let initial:RigidTransform=options.initialTransform??{kind:'rigid',matrix:identity()};if(options.initialTransform&&options.landmarks)throw new Error('初始变换与地标初始化不能同时指定。');if(options.landmarks)initial=estimateRigidTransform(options.landmarks.source,options.landmarks.target);else if(!options.initialTransform&&options.initialization!=='identity'){const t=sub(imageCentroid(targetGrid),imageCentroid(sourceGrid));initial={kind:'rigid',matrix:[[1,0,0,t[0]],[0,1,0,t[1]],[0,0,1,t[2]]]};}rigidValid(initial);check(options,0);
  const work=n*3*target.spacing.reduce((sum,s)=>sum+2*Math.ceil(2*sigma/s)+1,0);if(work>500_000_000||target.spacing.some(s=>Math.ceil(2*sigma/s)>128))throw new Error('配准平滑核超过当前工作预算。');
  const pull=inverse(initial.matrix),sourceInverse=inverse(source.affine),baseVoxel=new Float64Array(n*3);for(let i=0;i<n;i++){const p=apply(sourceInverse,apply(pull,physicalPoint(voxelPoint(i,target.dims),targetGrid)));baseVoxel.set(p,3*i);}let field:Float32Array=new Float32Array(n*3),valid=0;
  const read=(displacement:Float32Array,i:number)=>{const d:Vec3=[displacement[3*i]!,displacement[3*i+1]!,displacement[3*i+2]!],p=sourceInverse.map((r,a)=>baseVoxel[3*i+a]!+r[0]!*d[0]+r[1]!*d[1]+r[2]!*d[2]) as Vec3;return sample(sourceGrid.data,source.dims,p,background);};
  const error=(displacement:Float32Array)=>{let sum=0;valid=0;for(let i=0;i<n;i++){const s=read(displacement,i);sum+=(targetGrid.data[i]!-s.value)**2;if(s.valid)valid++;}return sum/n;};
  const history=[error(field)];let completed=0,converged=history[0]===0,jacobian=1,termination:DensePhaseTransform['termination']=converged?'initial-match':'max-iterations';
  for(let iteration=0;iteration<iterations&&!converged;iteration++){
    check(options,iteration/Math.max(1,iterations));const update=new Float32Array(n*3);
    for(let i=0;i<n;i++){if(!(i%4096))check(options);const s=read(field,i),diff=targetGrid.data[i]!-s.value,g=sourceInverse[0]!.slice(0,3).map((_,a)=>sourceInverse.reduce((sum,row,k)=>sum+row[a]!*s.gradient[k]!,0)) as Vec3,den=dot(g,g)+diff*diff/(step*step);if(den>1e-20)update.set(mul(g,diff/den),3*i);}
    let accepted:Float32Array|null=null,nextError=history.at(-1)!,nextJacobian=jacobian;
    for(const scale of [1,.5,.25,.125,.0625]){
      const candidate=new Float32Array(field.length);for(let i=0;i<n;i++){let d:Vec3=[field[3*i]!+scale*update[3*i]!,field[3*i+1]!+scale*update[3*i+1]!,field[3*i+2]!+scale*update[3*i+2]!];if(norm(d)>maxDisplacement)d=mul(d,maxDisplacement/norm(d));candidate.set(d,3*i);}const smoothed=smoothField(candidate,target.dims,target.spacing,sigma),mse=error(smoothed);if(mse>history.at(-1)!*(1+1e-10))continue;const min=minJacobian(smoothed,target,pull);if(min<jacobianLimit)continue;accepted=smoothed;nextError=mse;nextJacobian=min;break;
    }
    if(!accepted){termination='line-search-stalled';break;}const previous=history.at(-1)!;field=accepted;jacobian=nextJacobian;history.push(nextError);completed++;converged=(previous-nextError)/Math.max(1e-20,previous)<=tolerance;if(converged)termination='tolerance';
  }
  error(field);check(options,1);return {id:temporalId('phase-transform'),algorithm:'independent-demons',mapping:'target-world-to-source-world',source,target,initialForward:initial,pullAffine:pull,displacement:field,iterations:completed,converged,termination,meanSquaredError:history,minimumJacobian:jacobian,validSampleFraction:valid/n};
}
function geometryMatches(a:PhaseGeometry,b:PhaseGeometry){return a.dims.every((n,i)=>n===b.dims[i])&&a.affine.every((r,i)=>r.every((n,j)=>Math.abs(n-b.affine[i]![j]!)<=1e-7*Math.max(1,Math.abs(n),Math.abs(b.affine[i]![j]!))));}
export function validatePhaseTransform(value:unknown):asserts value is DensePhaseTransform{
  const transform=value as DensePhaseTransform;
  if(!transform||typeof transform.id!=='string'||!transform.id||transform.algorithm!=='independent-demons'||transform.mapping!=='target-world-to-source-world')throw new Error('相位位移场标识或映射方向损坏。');
  validatePhaseGeometry(transform.source);validatePhaseGeometry(transform.target);
  if(!(transform.displacement instanceof Float32Array)||transform.displacement.length!==transform.target.dims.reduce((s,n)=>s*n,1)*3||transform.displacement.some(n=>!Number.isFinite(n)))throw new Error('相位位移场损坏。');
  rigidValid(transform.initialForward);inverse(transform.pullAffine);const expected=inverse(transform.initialForward.matrix);
  if(expected.some((r,a)=>r.some((n,b)=>Math.abs(n-transform.pullAffine[a]![b]!)>1e-7*Math.max(1,Math.abs(n)))))throw new Error('相位初始刚性与拉回矩阵不一致。');
  if(!Number.isSafeInteger(transform.iterations)||transform.iterations<0||!Array.isArray(transform.meanSquaredError)||transform.meanSquaredError.length!==transform.iterations+1||transform.meanSquaredError.some((n,i,a)=>!Number.isFinite(n)||n<0||i>0&&n>a[i-1]!*(1+1e-9))||!Number.isFinite(transform.minimumJacobian)||transform.minimumJacobian<=0||!Number.isFinite(transform.validSampleFraction)||transform.validSampleFraction<0||transform.validSampleFraction>1||typeof transform.converged!=='boolean'||!['initial-match','tolerance','line-search-stalled','max-iterations'].includes(transform.termination)||transform.converged!==['initial-match','tolerance'].includes(transform.termination))throw new Error('相位配准统计或终止状态损坏。');
}
export function mapTargetToSource(transform:DensePhaseTransform,targetWorld:Vec3):Vec3{validatePhaseTransform(transform);return add(apply(transform.pullAffine,targetWorld),vectorSample(transform.displacement,transform.target.dims,apply(inverse(transform.target.affine),targetWorld)));}
export function warpPhaseMask(sourceGrid:VolumeGrid,mask:BinaryMask,targetGrid:VolumeGrid,transform:DensePhaseTransform,control:AlgorithmControl={}):BinaryMask{
  requireGrid(sourceGrid,mask);requireGrid(targetGrid);validatePhaseTransform(transform);if(!geometryMatches(geometry(sourceGrid),transform.source)||!geometryMatches(geometry(targetGrid),transform.target))throw new Error('位移场与源/目标物理网格不一致。');const out=new Uint8Array(targetGrid.data.length),inv=inverse(transform.source.affine),targetAffine=transform.target.affine;
  for(let i=0;i<out.length;i++){if(!(i%4096))check(control,i/out.length);const base=apply(transform.pullAffine,apply(targetAffine,voxelPoint(i,targetGrid.dims))),d:Vec3=[transform.displacement[3*i]!,transform.displacement[3*i+1]!,transform.displacement[3*i+2]!],p=apply(inv,add(base,d)).map(Math.round) as Vec3;if(p.every((n,a)=>n>=0&&n<sourceGrid.dims[a]!))out[i]=Number(!!mask[voxelIndex(p,sourceGrid.dims)]);}
  check(control,1);return out;
}
export function resamplePhaseImage(sourceGrid:VolumeGrid,targetGrid:VolumeGrid,transform:DensePhaseTransform,control:AlgorithmControl={}):Float32Array{
  validatePhaseTransform(transform);if(!geometryMatches(geometry(sourceGrid),transform.source)||!geometryMatches(geometry(targetGrid),transform.target))throw new Error('相位采样网格不匹配。');const out=new Float32Array(targetGrid.data.length),inv=inverse(affineOf(sourceGrid));let background=Infinity;for(const value of sourceGrid.data)background=Math.min(background,value);
  for(let i=0;i<out.length;i++){if(!(i%4096))check(control,i/out.length);const base=apply(transform.pullAffine,physicalPoint(voxelPoint(i,targetGrid.dims),targetGrid)),p=apply(inv,add(base,[transform.displacement[3*i]!,transform.displacement[3*i+1]!,transform.displacement[3*i+2]!]));out[i]=sample(sourceGrid.data,sourceGrid.dims,p,background).value;}check(control,1);return out;
}

export interface TemporalMask {id:string;name:string;data:BinaryMask;revision:number;edited?:boolean;origin?:{sourcePhaseId:string;sourceMaskId:string;sourceRevision:number;transformId:string}}
export type PhaseStatus='unprocessed'|'source'|'in_process'|'needs_review'|'completed'|'error';
export interface TemporalSegment {id:string;data:BinaryMask;assignedMaskId:string}
export interface TemporalPhase {id:string;name:string;time?:number;grid:VolumeGrid;masks:TemporalMask[];revision:number;status:PhaseStatus;segments?:TemporalSegment[];segmentState?:'available'|'accepted'|'invalidated';frame?:FramePhaseState}
export interface PhaseTransformRecord {sourcePhaseId:string;targetPhaseId:string;sourceRevision:number;targetRevision:number;transform:DensePhaseTransform}
export interface PhasePropagationTicket {id:string;studyRevision:number;sourcePhaseId:string;sourceRevision:number;targetPhaseId:string;targetRevision:number;previousStatus:PhaseStatus}
export interface TemporalStudy {phases:TemporalPhase[];order:string[];referencePhaseId:string;activeSourcePhaseId:string;mode:'cardiac-sequential'|'frame-from-reference';revision:number;transforms:PhaseTransformRecord[];pending?:PhasePropagationTicket}
const phaseStatuses:PhaseStatus[]=['unprocessed','source','in_process','needs_review','completed','error'];
const validRevision=(revision:number)=>Number.isSafeInteger(revision)&&revision>=0;
const validId=(id:unknown):id is string=>typeof id==='string'&&id.length>0;
function binaryMask(data:BinaryMask,count:number){return data instanceof Uint8Array&&data.length===count&&!data.some(n=>n!==0&&n!==1);}
/** Validate decoded typed arrays and cross references before publishing a loaded project. */
export function validateTemporalStudy(value:unknown):asserts value is TemporalStudy{
  const study=value as TemporalStudy;
  if(!study||!Array.isArray(study.phases)||!study.phases.length||!Array.isArray(study.order)||!Array.isArray(study.transforms)||!validRevision(study.revision)||!['cardiac-sequential','frame-from-reference'].includes(study.mode))throw new Error('4D工程结构或版本无效。');
  const ids=new Set<string>();
  for(const phase of study.phases){
    if(!phase||!validId(phase.id)||ids.has(phase.id)||typeof phase.name!=='string'||!validRevision(phase.revision)||phase.time!==undefined&&!Number.isFinite(phase.time)||!phaseStatuses.includes(phase.status)||!Array.isArray(phase.masks)||!phase.grid||!(phase.grid.data instanceof Float32Array)||phase.grid.data.some(n=>!Number.isFinite(n)))throw new Error('相位ID、版本、状态、时间或图像无效。');
    ids.add(phase.id);geometry(phase.grid);const masks=new Set<string>();
    for(const mask of phase.masks){if(!mask||!validId(mask.id)||masks.has(mask.id)||typeof mask.name!=='string'||!binaryMask(mask.data,phase.grid.data.length)||!validRevision(mask.revision)||mask.edited!==undefined&&typeof mask.edited!=='boolean')throw new Error('相位Mask尺寸、成员或版本无效。');masks.add(mask.id);}
    if(phase.segmentState!==undefined&&!['available','accepted','invalidated'].includes(phase.segmentState))throw new Error('相位Segment状态无效。');
    if(phase.segments){const segments=new Set<string>();for(const segment of phase.segments){if(!segment||!validId(segment.id)||segments.has(segment.id)||!masks.has(segment.assignedMaskId)||!binaryMask(segment.data,phase.grid.data.length))throw new Error('相位Segment引用或成员无效。');segments.add(segment.id);}}
    if(phase.segmentState==='invalidated'&&phase.segments?.length)throw new Error('普通Mask编辑后不能保留失效的Segment。');
    if(phase.frame)validateFramePhaseState(phase.frame,phase.grid);
  }
  if(!ids.has(study.referencePhaseId)||!ids.has(study.activeSourcePhaseId)||study.order.length!==ids.size||new Set(study.order).size!==ids.size||study.order.some(id=>!ids.has(id))||study.mode==='frame-from-reference'&&study.activeSourcePhaseId!==study.referencePhaseId||study.phases.filter(p=>p.status==='source').length>1)throw new Error('相位顺序或源相位无效。');
  for(const record of study.transforms){const source=study.phases.find(p=>p.id===record.sourcePhaseId),target=study.phases.find(p=>p.id===record.targetPhaseId);if(!source||!target||source===target||!validRevision(record.sourceRevision)||record.sourceRevision>source.revision||!validRevision(record.targetRevision)||record.targetRevision>target.revision)throw new Error('相位变换引用或版本无效。');validatePhaseTransform(record.transform);if(!geometryMatches(geometry(source.grid),record.transform.source)||!geometryMatches(geometry(target.grid),record.transform.target))throw new Error('相位变换物理网格不一致。');}
  for(const phase of study.phases){
    for(const mask of phase.masks)if(mask.origin){const origin=mask.origin,source=study.phases.find(p=>p.id===origin.sourcePhaseId),sourceMask=source?.masks.find(m=>m.id===origin.sourceMaskId);if(!sourceMask||!validRevision(origin.sourceRevision)||origin.sourceRevision>sourceMask.revision||!study.transforms.some(r=>r.transform.id===origin.transformId&&r.sourcePhaseId===origin.sourcePhaseId&&r.targetPhaseId===phase.id))throw new Error('相位Mask来源引用无效。');}
    if(phase.frame){const reference=study.phases.find(p=>p.id===phase.frame!.referencePhaseId);if(phase.frame.referencePhaseId!==study.referencePhaseId||!reference?.masks.some(m=>m.id===phase.frame!.referenceMaskId)||!study.transforms.some(r=>r.transform.id===phase.frame!.transformId&&r.sourcePhaseId===reference.id&&r.targetPhaseId===phase.id))throw new Error('Frame参考相位、Mask或变换引用无效。');}
  }
  const processing=study.phases.filter(p=>p.status==='in_process');
  if(study.pending){const p=study.pending,source=study.phases.find(v=>v.id===p.sourcePhaseId),target=study.phases.find(v=>v.id===p.targetPhaseId);if(!validId(p.id)||p.studyRevision!==study.revision||source?.revision!==p.sourceRevision||target?.revision!==p.targetRevision||source===target||processing.length!==1||processing[0]!==target||!phaseStatuses.includes(p.previousStatus)||p.previousStatus==='in_process'||p.sourcePhaseId!==(study.mode==='frame-from-reference'?study.referencePhaseId:study.activeSourcePhaseId))throw new Error('4D待处理任务或版本无效。');}else if(processing.length)throw new Error('处理中相位缺少任务。');
}
function validateStudy(study:TemporalStudy){validateTemporalStudy(study);}
export function createTemporalStudy(phases:TemporalPhase[],sourcePhaseId:string,mode:TemporalStudy['mode']='cardiac-sequential'):TemporalStudy{
  const study:TemporalStudy={phases:phases.map(p=>({...p,masks:p.masks.map(m=>({...m})),status:p.id===sourcePhaseId?'source':'unprocessed'})),order:phases.map(p=>p.id),referencePhaseId:sourcePhaseId,activeSourcePhaseId:sourcePhaseId,mode,revision:0,transforms:[]};validateStudy(study);return study;
}
export function beginPhasePropagation(study:TemporalStudy,targetPhaseId:string):{study:TemporalStudy;ticket:PhasePropagationTicket}{
  validateStudy(study);if(study.pending)throw new Error('已有相位处理尚未完成。');const sourceId=study.mode==='frame-from-reference'?study.referencePhaseId:study.activeSourcePhaseId,source=study.phases.find(p=>p.id===sourceId)!,target=study.phases.find(p=>p.id===targetPhaseId);
  if(!target||target.id===source.id||source.status==='in_process'||source.status==='needs_review')throw new Error('目标相位无效，或源相位编辑结果尚未接受。');const revision=study.revision+1,ticket:PhasePropagationTicket={id:temporalId('phase-job'),studyRevision:revision,sourcePhaseId:source.id,sourceRevision:source.revision,targetPhaseId:target.id,targetRevision:target.revision,previousStatus:target.status};
  return {study:{...study,revision,pending:{...ticket},phases:study.phases.map(p=>p.id===target.id?{...p,status:'in_process'}:p)},ticket};
}
function requireTicket(study:TemporalStudy,ticket:PhasePropagationTicket){const source=study.phases.find(p=>p.id===ticket.sourcePhaseId),target=study.phases.find(p=>p.id===ticket.targetPhaseId);if(!study.pending||Object.keys(study.pending).some(key=>study.pending![key as keyof PhasePropagationTicket]!==ticket[key as keyof PhasePropagationTicket])||study.revision!==ticket.studyRevision||source?.revision!==ticket.sourceRevision||target?.revision!==ticket.targetRevision)throw new Error('相位结果已过期，源/目标或工程版本发生变化。');return {source:source!,target:target!};}
export function finishPhasePropagation(study:TemporalStudy,ticket:PhasePropagationTicket,transform:DensePhaseTransform,maskIds?:string[],control:AlgorithmControl={}):TemporalStudy{
  const {source,target}=requireTicket(study,ticket),selected=maskIds?source.masks.filter(m=>maskIds.includes(m.id)):source.masks;
  if(!selected.length||selected.length>10||maskIds&&maskIds.length!==selected.length)throw new Error('每次必须选择1到10个有效Mask。');
  const created=selected.map((mask,i):TemporalMask=>({id:`morph-${ticket.id}-${i}`,name:mask.name,data:warpPhaseMask(source.grid,mask.data,target.grid,transform,control),revision:0,edited:false,origin:{sourcePhaseId:source.id,sourceMaskId:mask.id,sourceRevision:mask.revision,transformId:transform.id}}));
  check(control,1);const revision=target.revision+1;return {...study,revision:study.revision+1,pending:undefined,phases:study.phases.map(p=>p.id===target.id?{...p,masks:[...p.masks,...created],revision,status:'needs_review',segments:undefined,segmentState:'invalidated'}:p),transforms:[...study.transforms,{sourcePhaseId:source.id,targetPhaseId:target.id,sourceRevision:source.revision,targetRevision:revision,transform}]};
}
export function cancelPhasePropagation(study:TemporalStudy,ticket:PhasePropagationTicket):TemporalStudy{const {target}=requireTicket(study,ticket);return {...study,pending:undefined,revision:study.revision+1,phases:study.phases.map(p=>p.id===target.id?{...p,status:ticket.previousStatus}:p)};}
export function propagateNextPhase(study:TemporalStudy,targetPhaseId:string,options:{maskIds?:string[];registration?:PhaseRegistrationOptions}={}):TemporalStudy{
  const pending=beginPhasePropagation(study,targetPhaseId),source=pending.study.phases.find(p=>p.id===pending.ticket.sourcePhaseId)!,target=pending.study.phases.find(p=>p.id===targetPhaseId)!,transform=registerPhases(source.grid,target.grid,options.registration);return finishPhasePropagation(pending.study,pending.ticket,transform,options.maskIds,options.registration);
}
export function editTemporalMask(study:TemporalStudy,phaseId:string,maskId:string,data:BinaryMask):TemporalStudy{
  validateStudy(study);const phase=study.phases.find(p=>p.id===phaseId),mask=phase?.masks.find(m=>m.id===maskId);if(!phase||!mask||data.length!==phase.grid.data.length||data.some(n=>n!==0&&n!==1))throw new Error('相位编辑Mask无效。');
  return {...study,pending:undefined,revision:study.revision+1,phases:study.phases.map(p=>p.id===phaseId?{...p,revision:p.revision+1,status:'needs_review',masks:p.masks.map(m=>m.id===maskId?{...m,data:data.slice(),revision:m.revision+1,edited:true}:m),segments:undefined,segmentState:'invalidated',...(p.frame?{frame:{...p.frame,status:'needs_rebuild' as const}}:{})}:p.id===study.pending?.targetPhaseId?{...p,status:study.pending.previousStatus}:p)};
}
export function acceptTemporalPhase(study:TemporalStudy,phaseId:string):TemporalStudy{
  validateStudy(study);if(study.pending)throw new Error('处理进行中不能接受相位。');const phase=study.phases.find(p=>p.id===phaseId);if(!phase||phase.status!=='needs_review')throw new Error('该相位没有待接受结果。');const cardiac=study.mode==='cardiac-sequential';return {...study,revision:study.revision+1,activeSourcePhaseId:cardiac?phaseId:study.referencePhaseId,phases:study.phases.map(p=>p.id===phaseId?{...p,status:cardiac?'source':'completed',segmentState:p.segments?'accepted':p.segmentState}:cardiac&&p.id===study.activeSourcePhaseId?{...p,status:'completed'}:p)};
}

export interface FrameNode {id:string;position:Vec3}
export interface FrameLink {id:string;from:string;to:string;points:Vec3[];manual?:boolean}
export interface FrameGraph {nodes:FrameNode[];links:FrameLink[];revision:number}
export interface FrameParameters {connectivity:number;radiusMm:number;intensityFraction:number}
export interface FramePhaseState {
  status:'built'|'edited'|'needs_rebuild';referencePhaseId:string;referenceMaskId:string;transformId:string;
  graph:FrameGraph;referenceGraph:FrameGraph;parameters:FrameParameters;sourceThreshold:number;
  skeleton:BinaryMask;frame:BinaryMask;threshold:BinaryMask;manualAdded:string[];manualRemoved:string[];warnings:string[];
}
export function validateFrameGraph(value:unknown):asserts value is FrameGraph{const graph=value as FrameGraph;if(!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.links)||!validRevision(graph.revision))throw new Error('Frame图或版本无效。');const nodes=new Map<string,FrameNode>();for(const n of graph.nodes){if(!n||!validId(n.id)||nodes.has(n.id)||!Array.isArray(n.position)||n.position.length!==3||n.position.some(x=>!Number.isFinite(x)))throw new Error('Frame节点无效。');nodes.set(n.id,n);}const ids=new Set<string>();for(const link of graph.links){if(!link||!validId(link.id)||ids.has(link.id)||!nodes.has(link.from)||!nodes.has(link.to)||link.from===link.to||!Array.isArray(link.points)||link.points.length<2||link.points.some(p=>!Array.isArray(p)||p.length!==3||p.some(n=>!Number.isFinite(n)))||norm(sub(link.points[0]!,nodes.get(link.from)!.position))>1e-4||norm(sub(link.points.at(-1)!,nodes.get(link.to)!.position))>1e-4||link.manual!==undefined&&typeof link.manual!=='boolean')throw new Error('Frame连线/端点无效。');ids.add(link.id);}}
export function validateFramePhaseState(value:unknown,grid:VolumeGrid):asserts value is FramePhaseState{
  const state=value as FramePhaseState;requireGrid(grid);
  if(!state||!['built','edited','needs_rebuild'].includes(state.status)||![state.referencePhaseId,state.referenceMaskId,state.transformId].every(validId)||!Number.isFinite(state.sourceThreshold)||!state.parameters||!Number.isSafeInteger(state.parameters.connectivity)||state.parameters.connectivity<1||!Number.isFinite(state.parameters.radiusMm)||state.parameters.radiusMm<=0||!Number.isFinite(state.parameters.intensityFraction)||state.parameters.intensityFraction<0||state.parameters.intensityFraction>1||![state.skeleton,state.frame,state.threshold].every(data=>binaryMask(data,grid.data.length))||![state.manualAdded,state.manualRemoved,state.warnings].every(a=>Array.isArray(a)&&a.every(v=>typeof v==='string')))throw new Error('Frame状态、参数或输出Mask无效。');
  validateFrameGraph(state.graph);validateFrameGraph(state.referenceGraph);
  if(state.manualAdded.some(id=>!state.graph.links.some(l=>l.id===id)&&!state.manualRemoved.includes(id))||state.manualRemoved.some(id=>!state.referenceGraph.links.some(l=>l.id===id)&&!state.manualAdded.includes(id)))throw new Error('Frame手工连接记录无效。');
}
let frameLinkSerial=0;
/** Independent bright-voxel shortest route; does not connect user endpoints across dark background. */
export function findFrameLink(grid:VolumeGrid,from:FrameNode,to:FrameNode,options:{minimumIntensity:number;id?:string}&AlgorithmControl):FrameLink{
  if(!Number.isFinite(options.minimumIntensity))throw new Error('Frame连接灰度阈值无效。');const mask=Uint8Array.from(grid.data,v=>Number(Number.isFinite(v)&&v>=options.minimumIntensity)),graph=fitCenterline(grid,mask,{root:from.position,endpoints:[to.position],centerWeight:0,cancelled:options.cancelled,progress:options.progress}),points=graph.branches[0]!.points;points[0]=[...from.position];points[points.length-1]=[...to.position];return {id:options.id??`manual-frame-link-${++frameLinkSerial}`,from:from.id,to:to.id,points,manual:true};
}
function mapSourcePoint(transform:DensePhaseTransform,point:Vec3):Vec3{
  const targetInverse=inverse(transform.target.affine);let x=apply(transform.initialForward.matrix,point);for(let i=0;i<60;i++){const voxel=apply(targetInverse,x);if(voxel.some((n,a)=>n<0||n>transform.target.dims[a]!-1))throw new Error('Frame节点传播越出目标网格。');const mapped=add(apply(transform.pullAffine,x),vectorSample(transform.displacement,transform.target.dims,voxel)),error=sub(point,mapped);if(norm(error)<1e-4)return x;const step=transform.initialForward.matrix.map(row=>dot(row.slice(0,3) as Vec3,error)) as Vec3;x=add(x,step);}throw new Error('稠密位移的Frame点反求未收敛。');
}
function denseInteriorPath(grid:VolumeGrid,mask:BinaryMask,points:Vec3[]):Vec3[]{
  const inv=inverse(affineOf(grid)),out:Vec3[]=[];for(let i=0;i<points.length;i++){const b=apply(inv,points[i]!);if(b.map(Math.round).some((n,a)=>n<0||n>=grid.dims[a]!)||!mask[voxelIndex(b.map(Math.round),grid.dims)])throw new Error('Frame骨架点未落在所选源Mask内。');if(!i){out.push([...points[i]!]);continue;}const a=apply(inv,points[i-1]!),delta=sub(b,a),cuts=[0,1];for(let axis=0;axis<3;axis++)if(Math.abs(delta[axis]!)>1e-12)for(let k=Math.ceil(Math.min(a[axis]!,b[axis]!)-.5);k<=Math.floor(Math.max(a[axis]!,b[axis]!)-.5);k++){const t=(k+.5-a[axis]!)/delta[axis]!;if(t>0&&t<1)cuts.push(t);}cuts.sort((x,y)=>x-y);for(let k=1;k<cuts.length;k++){const p=add(a,mul(delta,(cuts[k-1]!+cuts[k]!)/2)).map(Math.round) as Vec3;if(p.some((n,axis)=>n<0||n>=grid.dims[axis]!)||!mask[voxelIndex(p,grid.dims)])throw new Error('Frame节点间连线穿过源Mask外部；请先计算真实连接路径。');}const steps=Math.max(1,Math.ceil(Math.max(...delta.map(Math.abs))*4));for(let k=1;k<=steps;k++)out.push(add(points[i-1]!,mul(sub(points[i]!,points[i-1]!),k/steps)));}return out;
}
function frameMasks(grid:VolumeGrid,graph:FrameGraph,parameters:FrameParameters,sourceThreshold:number,control:AlgorithmControl={}):Pick<FramePhaseState,'skeleton'|'frame'|'threshold'>{
  requireGrid(grid);validateFrameGraph(graph);const {connectivity,radiusMm,intensityFraction}=parameters;if(!Number.isSafeInteger(connectivity)||connectivity<1||!Number.isFinite(radiusMm)||radiusMm<=0||!Number.isFinite(intensityFraction)||intensityFraction<0||intensityFraction>1||!Number.isFinite(sourceThreshold))throw new Error('Frame参数无效。');
  const degree=new Map(graph.nodes.map(n=>[n.id,0]));for(const l of graph.links){degree.set(l.from,degree.get(l.from)!+1);degree.set(l.to,degree.get(l.to)!+1);}if([...degree.values()].some(n=>n>connectivity))throw new Error('Frame输入图的连接数超过明确给定的Connectivity；当前不自动猜测节点连接。');
  const inv=inverse(affineOf(grid)),skeleton=new Uint8Array(grid.data.length),frame=new Uint8Array(grid.data.length),threshold=new Uint8Array(grid.data.length);let background=Infinity;for(const value of grid.data){if(!Number.isFinite(value))throw new Error('Frame图像灰度无效。');background=Math.min(background,value);}
  const mark=(p:Vec3)=>{const q=apply(inv,p).map(Math.round) as Vec3;if(!q.every((n,a)=>n>=0&&n<grid.dims[a]!))throw new Error('Frame路径越出目标图像。');skeleton[voxelIndex(q,grid.dims)]=1;};
  for(const link of graph.links)for(let i=1;i<link.points.length;i++){const a=link.points[i-1]!,b=link.points[i]!,delta=sub(apply(inv,b),apply(inv,a)),steps=Math.max(1,Math.ceil(Math.max(...delta.map(Math.abs))*4));for(let k=0;k<=steps;k++)mark(add(a,mul(sub(b,a),k/steps)));}
  const basis=[0,1,2].map(a=>affineOf(grid).map(r=>r[a]!) as Vec3),det=Math.abs(dot(basis[0]!,cross(basis[1]!,basis[2]!))),heights=[det/norm(cross(basis[1]!,basis[2]!)),det/norm(cross(basis[2]!,basis[0]!)),det/norm(cross(basis[0]!,basis[1]!))],extents=heights.map(h=>Math.ceil(radiusMm/h));if(extents.some(n=>n>64))throw new Error('Frame半径超过当前邻域预算。');
  const offsets:{p:Vec3;distance:number}[]=[];for(let z=-extents[2]!;z<=extents[2]!;z++)for(let y=-extents[1]!;y<=extents[1]!;y++)for(let x=-extents[0]!;x<=extents[0]!;x++){const p:Vec3=[x,y,z],distance=norm(add(add(mul(basis[0]!,x),mul(basis[1]!,y)),mul(basis[2]!,z)));if(distance<=radiusMm+1e-10)offsets.push({p,distance});}
  let count=0;for(let i=0;i<skeleton.length;i++)if(skeleton[i]){count++;if(grid.data[i]!<=background)throw new Error('Frame路径穿过最暗背景，不能当成真实亮支架连接。');}if(count*offsets.length>50_000_000)throw new Error('Frame重建超过当前邻域工作预算。');
  for(let i=0;i<skeleton.length;i++)if(skeleton[i]){if(!(i%1024))check(control);const p=voxelPoint(i,grid.dims),reference=grid.data[i]!-background;for(const offset of offsets){const q=add(p,offset.p);if(!q.every((n,a)=>n>=0&&n<grid.dims[a]!))continue;const j=voxelIndex(q,grid.dims),fraction=intensityFraction+(1-intensityFraction)*(offset.distance/radiusMm)**2;if(grid.data[j]!-background>=reference*fraction)frame[j]=1;if(grid.data[j]!>=sourceThreshold)threshold[j]=1;}}
  check(control,1);return {skeleton,frame,threshold};
}
export function buildFramePhase(sourceGrid:VolumeGrid,sourceMask:BinaryMask,sourceGraph:FrameGraph,targetGrid:VolumeGrid,transform:DensePhaseTransform,parameters:FrameParameters,reference:{phaseId:string;maskId:string},control:AlgorithmControl={}):FramePhaseState{
  requireGrid(sourceGrid,sourceMask);validateFrameGraph(sourceGraph);validatePhaseTransform(transform);if(!geometryMatches(geometry(sourceGrid),transform.source)||!geometryMatches(geometry(targetGrid),transform.target))throw new Error('Frame源/目标和位移场网格不一致。');const graph:FrameGraph={revision:sourceGraph.revision,nodes:sourceGraph.nodes.map(n=>({...n,position:mapSourcePoint(transform,n.position)})),links:[]};
  graph.links=sourceGraph.links.map(link=>{const points=denseInteriorPath(sourceGrid,sourceMask,link.points).map(p=>mapSourcePoint(transform,p));points[0]=[...graph.nodes.find(n=>n.id===link.from)!.position];points[points.length-1]=[...graph.nodes.find(n=>n.id===link.to)!.position];return {...link,points};});
  let n=0,mean=0,m2=0;for(let i=0;i<sourceMask.length;i++)if(sourceMask[i]){const value=sourceGrid.data[i]!;n++;const delta=value-mean;mean+=delta/n;m2+=delta*(value-mean);}if(!n)throw new Error('Frame源Mask为空。');const sourceThreshold=mean-Math.sqrt(m2/n),masks=frameMasks(targetGrid,graph,parameters,sourceThreshold,control);
  return {status:'built',referencePhaseId:reference.phaseId,referenceMaskId:reference.maskId,transformId:transform.id,graph,referenceGraph:structuredClone(graph),parameters:{...parameters},sourceThreshold,...masks,manualAdded:[],manualRemoved:[],warnings:['Independent registered user-supplied frame graph; automatic native node/skeleton discovery is not recovered.','Three masks use explicitly independent radius/intensity rules; source threshold is mean minus population standard deviation.','STL models must be calculated separately; this is not a claim of complete native Frame Mask Morphing.']};
}
export function editFrameLink(state:FramePhaseState,edit:{add?:FrameLink;removeId?:string}):FramePhaseState{
  if(Boolean(edit.add)===Boolean(edit.removeId))throw new Error('请指定添加或移除一条Frame连接。');const graph=structuredClone(state.graph);if(edit.add){if(graph.links.some(l=>l.id===edit.add!.id))throw new Error('Frame连接ID已存在。');graph.links.push({...edit.add,manual:true});}else {if(!graph.links.some(l=>l.id===edit.removeId))throw new Error('Frame连接不存在。');graph.links=graph.links.filter(l=>l.id!==edit.removeId);}graph.revision++;validateFrameGraph(graph);return {...state,status:'needs_rebuild',graph,manualAdded:edit.add?[...state.manualAdded,edit.add.id]:state.manualAdded,manualRemoved:edit.removeId?[...state.manualRemoved,edit.removeId]:state.manualRemoved};
}
export function rebuildFramePhase(state:FramePhaseState,targetGrid:VolumeGrid,parameters:FrameParameters=state.parameters,control:AlgorithmControl={}):FramePhaseState{
  const reset=parameters.connectivity!==state.parameters.connectivity,graph=reset?structuredClone(state.referenceGraph):state.graph,masks=frameMasks(targetGrid,graph,parameters,state.sourceThreshold,control);return {...state,parameters:{...parameters},graph,...masks,status:reset?'built':'edited',manualAdded:reset?[]:state.manualAdded,manualRemoved:reset?[]:state.manualRemoved};
}
