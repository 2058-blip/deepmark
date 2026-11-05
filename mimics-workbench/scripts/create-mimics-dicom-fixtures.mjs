import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseDicom,groupDicomSeries,convertSeriesToVolume} from '../src/mimics/dicom.ts';

// Synthetic classic single-frame images only. No patient files or installed scanner/software are read.
const output=path.resolve(process.argv[2]||fileURLToPath(new URL('../work/mimics-vue-reconstruction/fixtures/dicom/',import.meta.url)));
const UID_BASE=900000000000000000000000000000000001n;
const uid=n=>`2.25.${UID_BASE+BigInt(n)}`;
const TS='1.2.840.10008.1.2.1',JPEG2000='1.2.840.10008.1.2.4.90';
const CT_SOP='1.2.840.10008.5.1.4.1.1.2',MR_SOP='1.2.840.10008.5.1.4.1.1.4';
const STUDY_UID=uid(10),IMPLEMENTATION_UID=uid(1);
const PATIENT_NAME='SYNTHETIC^NO_PATIENT^PHANTOM',PATIENT_ID='SYNTHETIC-NOT-FOR-CLINICAL';
const longVR=new Set(['OB','OW','OF','OD','OL','OV','SQ','UC','UR','UT','UN']);
function element(group,tag,vr,value){
  let body;
  if(vr==='US'||vr==='UL'){
    const values=Array.isArray(value)?value:[value],size=vr==='US'?2:4;body=Buffer.alloc(values.length*size);
    values.forEach((v,i)=>vr==='US'?body.writeUInt16LE(v,i*size):body.writeUInt32LE(v,i*size));
  }else if(Buffer.isBuffer(value)||value instanceof Uint8Array)body=Buffer.from(value);
  else{body=Buffer.from(String(value),'ascii');if(body.length%2)body=Buffer.concat([body,Buffer.from([vr==='UI'?0:32])]);}
  assert.equal(body.length%2,0,`even-length DICOM value ${group.toString(16)},${tag.toString(16)}`);
  const header=Buffer.alloc(longVR.has(vr)?12:8);header.writeUInt16LE(group,0);header.writeUInt16LE(tag,2);header.write(vr,4,2,'ascii');
  if(longVR.has(vr))header.writeUInt32LE(body.length,8);else{assert.ok(body.length<=65534);header.writeUInt16LE(body.length,6);}
  return Buffer.concat([header,body]);
}
function pixelElement(spec,z){
  const pixels=Buffer.alloc(spec.rows*spec.columns*2);
  for(let y=0;y<spec.rows;y++)for(let x=0;x<spec.columns;x++){
    const raw=(spec.value(x,y,z)-spec.intercept)/spec.slope;
    assert.ok(Number.isInteger(raw)&&raw>=0&&raw<2**spec.bitsStored);pixels.writeUInt16LE(raw,2*(x+spec.columns*y));
  }
  return element(0x7fe0,0x10,'OW',pixels);
}
function fakeEncapsulatedPixelElement(){
  const header=Buffer.alloc(12);header.writeUInt16LE(0x7fe0,0);header.writeUInt16LE(0x10,2);header.write('OB',4);header.writeUInt32LE(0xffffffff,8);
  const item=data=>{const h=Buffer.alloc(8);h.writeUInt16LE(0xfffe,0);h.writeUInt16LE(0xe000,2);h.writeUInt32LE(data.length,4);return Buffer.concat([h,data]);};
  const end=Buffer.alloc(8);end.writeUInt16LE(0xfffe,0);end.writeUInt16LE(0xe0dd,2);
  return Buffer.concat([header,item(Buffer.alloc(0)),item(Buffer.from('NOT_JPEG2000_BAD!\0','ascii')),end]);
}
function dicomFile(spec,z,{sopUID=uid((spec.modality==='CT'?1000:2000)+z),position=spec.position(z),instance=spec.instances[z],transferSyntax=TS,fakeCompressed=false}={}){
  const sopClass=spec.modality==='CT'?CT_SOP:MR_SOP;
  const meta=Buffer.concat([
    element(2,1,'OB',Buffer.from([0,1])),element(2,2,'UI',sopClass),element(2,3,'UI',sopUID),element(2,0x10,'UI',transferSyntax),
    element(2,0x12,'UI',IMPLEMENTATION_UID),element(2,0x13,'SH','DEEPMARK_SYNTH1'),element(2,0x16,'AE','DEEPMARK_SYNTH'),
  ]);
  const tags=[];
  const add=(group,tag,vr,value)=>tags.push({group,tag,bytes:element(group,tag,vr,value)});
  add(8,5,'CS','ISO_IR 100');add(8,8,'CS',`DERIVED\\PRIMARY\\${spec.modality==='CT'?'AXIAL':'OTHER'}`);
  add(8,0x12,'DA','20000101');add(8,0x13,'TM','120000');add(8,0x16,'UI',sopClass);add(8,0x18,'UI',sopUID);
  add(8,0x20,'DA','20000101');add(8,0x21,'DA','20000101');add(8,0x22,'DA','20000101');add(8,0x23,'DA','20000101');
  add(8,0x30,'TM','120000');add(8,0x31,'TM','120000');add(8,0x32,'TM','120000');add(8,0x33,'TM','120000');
  add(8,0x50,'SH','SYNTHETIC');add(8,0x60,'CS',spec.modality);add(8,0x70,'LO','SYNTHETIC_FIXTURE');
  add(8,0x80,'LO','SYNTHETIC NONCLINICAL FIXTURE');add(8,0x90,'PN','');
  add(8,0x1030,'LO','DEEPMARK SYNTHETIC TWO SERIES');add(8,0x103e,'LO',spec.description);add(8,0x1090,'LO','DEEPMARK PHANTOM GENERATOR');
  add(8,0x2111,'ST','Entirely synthetic numerical phantom; no source patient or scanner images.');
  add(0x10,0x10,'PN',PATIENT_NAME);add(0x10,0x20,'LO',PATIENT_ID);add(0x10,0x21,'LO','DEEPMARK_FIXTURE');add(0x10,0x30,'DA','');add(0x10,0x40,'CS','O');
  add(0x12,0x62,'CS','YES');add(0x12,0x63,'LO','SYNTHETIC GENERATED DATA; NO REAL PATIENT');
  add(0x18,0x50,'DS',spec.spacing[2]);add(0x18,0x88,'DS',spec.spacing[2]);add(0x18,0x1020,'LO','DEEPMARK_FIXTURES_1');add(0x18,0x5100,'CS','HFS');
  if(spec.modality==='CT'){
    add(0x18,0x60,'DS','120');add(0x18,0x90,'DS','16');add(0x18,0x1100,'DS','16');add(0x18,0x1120,'DS','0');add(0x18,0x1210,'SH','SYNTHETIC');
  }else{
    add(0x18,0x20,'CS','SE');add(0x18,0x21,'CS','NONE');add(0x18,0x22,'CS','');add(0x18,0x23,'CS','2D');
    add(0x18,0x80,'DS','500');add(0x18,0x81,'DS','15');add(0x18,0x83,'DS','1');add(0x18,0x84,'DS','63.86');add(0x18,0x85,'SH','1H');add(0x18,0x86,'IS','1');add(0x18,0x87,'DS','1.5');add(0x18,0x91,'IS','1');
  }
  add(0x20,0x0d,'UI',STUDY_UID);add(0x20,0x0e,'UI',spec.seriesUID);add(0x20,0x10,'SH','SYNTHETIC01');add(0x20,0x11,'IS',spec.seriesNumber);
  add(0x20,0x12,'IS','1');add(0x20,0x13,'IS',instance);add(0x20,0x20,'CS','');add(0x20,0x32,'DS',position.join('\\'));add(0x20,0x37,'DS',spec.orientation.join('\\'));
  add(0x20,0x52,'UI',spec.frameUID);add(0x20,0x1040,'LO','');add(0x20,0x4000,'LT','SYNTHETIC PHANTOM - NOT FOR CLINICAL USE');
  add(0x28,2,'US',1);add(0x28,4,'CS',spec.photometric);add(0x28,0x10,'US',spec.rows);add(0x28,0x11,'US',spec.columns);add(0x28,0x30,'DS',[spec.spacing[1],spec.spacing[0]].join('\\'));
  add(0x28,0x100,'US',16);add(0x28,0x101,'US',spec.bitsStored);add(0x28,0x102,'US',spec.bitsStored-1);add(0x28,0x103,'US',0);
  add(0x28,0x301,'CS','NO');add(0x28,0x302,'CS','NO');
  add(0x28,0x1050,'DS',spec.window[0]);add(0x28,0x1051,'DS',spec.window[1]);add(0x28,0x1052,'DS',spec.intercept);add(0x28,0x1053,'DS',spec.slope);add(0x28,0x1054,'LO',spec.modality==='CT'?'HU':'US');add(0x28,0x2110,'CS','00');
  tags.sort((a,b)=>a.group-b.group||a.tag-b.tag);
  for(let i=1;i<tags.length;i++)assert.ok(tags[i-1].group!==tags[i].group||tags[i-1].tag!==tags[i].tag,'no duplicate dataset tags');
  const preamble=Buffer.alloc(132);preamble.write('DICM',128,'ascii');
  return Buffer.concat([preamble,element(2,0,'UL',meta.length),meta,...tags.map(tag=>tag.bytes),fakeCompressed?fakeEncapsulatedPixelElement():pixelElement(spec,z)]);
}
const ct={modality:'CT',description:'SYNTHETIC CT SPHERE AND CUBE',seriesUID:uid(100),frameUID:uid(300),seriesNumber:1,columns:16,rows:16,slices:6,spacing:[1,1,2],orientation:[1,0,0,0,1,0],
  position:z=>[10,20,30+2*z],instances:[106,101,104,102,105,103],fileNumbers:[50,10,60,20,40,30],bitsStored:12,slope:2,intercept:-1024,photometric:'MONOCHROME2',window:[500,2200],
  value:(x,y,z)=>x>=2&&x<=4&&y>=2&&y<=4&&z>=1&&z<=3?1200:(x-7.5)**2+(y-7.5)**2+(2*z-5)**2<=25?600:-1000};
const mr={modality:'MR',description:'SYNTHETIC MR GRADIENT MONOCHROME1',seriesUID:uid(200),frameUID:uid(400),seriesNumber:2,columns:12,rows:10,slices:4,spacing:[1.5,2,3],orientation:[0,1,0,0,0,1],
  position:z=>[-30+3*z,40,50],instances:[7,41,3,19],fileNumbers:[40,10,30,20],bitsStored:16,slope:1,intercept:0,photometric:'MONOCHROME1',window:[234.5,300],value:(x,y,z)=>100+7*x+11*y+31*z};

function inspectFileMeta(bytes,spec,sopUID,syntax=TS){
  assert.equal(bytes.subarray(128,132).toString('ascii'),'DICM');let offset=132;const tags=new Map();
  while(bytes.readUInt16LE(offset)===2){
    const tag=bytes.readUInt16LE(offset+2),vr=bytes.toString('ascii',offset+4,offset+6),start=offset+(longVR.has(vr)?12:8),length=longVR.has(vr)?bytes.readUInt32LE(offset+8):bytes.readUInt16LE(offset+6);
    assert.ok(start+length<=bytes.length);tags.set(tag,bytes.subarray(start,start+length));offset=start+length;
  }
  const text=tag=>tags.get(tag).toString('ascii').replace(/[\0 ]+$/g,'');
  assert.equal(tags.get(0).readUInt32LE(0),offset-144,'file meta group length covers all following group 0002 elements');assert.deepEqual([...tags.get(1)],[0,1]);
  assert.equal(text(2),spec.modality==='CT'?CT_SOP:MR_SOP);assert.equal(text(3),sopUID);assert.equal(text(0x10),syntax);assert.equal(text(0x12),IMPLEMENTATION_UID);assert.equal(text(0x13),'DEEPMARK_SYNTH1');
  return{groupLength:tags.get(0).readUInt32LE(0),datasetOffset:offset,sopClassUID:text(2),sopInstanceUID:text(3),transferSyntaxUID:text(0x10)};
}
await mkdir(output,{recursive:true});
const manifest=[];
async function write(relative,bytes,metadata){
  const destination=path.resolve(output,relative);assert.ok(destination.startsWith(output+path.sep),'output child stays in chosen fixture directory');
  await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,bytes);
  const disk=await readFile(destination);assert.deepEqual(disk,bytes,'read back exact generated bytes');
  const record={path:relative.replaceAll(path.sep,'/'),bytes:disk.length,sha256:createHash('sha256').update(disk).digest('hex'),...metadata};manifest.push(record);return record;
}
for(const spec of [ct,mr])for(const z of spec.modality==='CT'?[4,1,5,0,3,2]:[2,0,3,1]){
  const sopUID=uid((spec.modality==='CT'?1000:2000)+z),bytes=dicomFile(spec,z),meta=inspectFileMeta(bytes,spec,sopUID);
  await write(`valid/${spec.modality}/${spec.modality}_${String(spec.fileNumbers[z]).padStart(3,'0')}_INSTANCE${spec.instances[z]}.dcm`,bytes,{kind:'valid',modality:spec.modality,physicalSliceIndex:z,instanceNumber:spec.instances[z],imagePositionLPS:spec.position(z),seriesUID:spec.seriesUID,fileMeta:meta});
}
const validRecords=manifest.filter(record=>record.kind==='valid').sort((a,b)=>a.path.localeCompare(b.path));
const parsed=[];
for(const record of validRecords){const slice=parseDicom(await readFile(path.join(output,record.path)));assert.equal(slice.instanceNumber,record.instanceNumber);assert.deepEqual(slice.imagePosition,record.imagePositionLPS);parsed.push(slice);}
const groups=groupDicomSeries(parsed);assert.equal(groups.length,2,'valid parent directory produces exactly two selectable series');
const checks=[];
const index=(x,y,z,d)=>x+d[0]*(y+d[1]*z);
const point=(affine,p)=>affine.map(row=>row[0]*p[0]+row[1]*p[1]+row[2]*p[2]+row[3]);
for(const spec of [ct,mr]){
  const group=groups.find(group=>group.seriesInstanceUID===spec.seriesUID),volume=convertSeriesToVolume(group,`SYNTHETIC ${spec.modality}`),dims=[spec.columns,spec.rows,spec.slices];
  assert.deepEqual(volume.dims,dims);assert.deepEqual(volume.spacing,spec.spacing);assert.equal(volume.dicom.modality,spec.modality);assert.equal(volume.dicom.intensityUnit,spec.modality==='CT'?'HU':'GV');
  assert.equal(volume.dicom.displayInverted,spec.modality==='MR');assert.equal(volume.dicom.windowCenter,spec.window[0]);assert.equal(volume.dicom.windowWidth,spec.window[1]);
  const histogram={};let sum=0;
  for(let z=0;z<dims[2];z++)for(let y=0;y<dims[1];y++)for(let x=0;x<dims[0];x++){
    const expected=spec.value(x,y,z),actual=volume.data[index(x,y,z,dims)];assert.equal(actual,expected,`${spec.modality} voxel ${x},${y},${z} physically sorted and quantitatively scaled`);histogram[expected]=(histogram[expected]||0)+1;sum+=expected;
  }
  const expectedAffine=spec.modality==='CT'?[[-1,0,0,-10],[0,-1,0,-20],[0,0,2,30]]:[[0,0,-3,30],[-1.5,0,0,-40],[0,2,0,50]];
  assert.deepEqual(volume.affine.map(row=>row.map(value=>value===0?0:value)),expectedAffine);
  const samples=spec.modality==='CT'?[[0,0,0],[3,3,2],[8,8,2],[15,15,5]]:[[0,0,0],[3,4,2],[11,9,3]];
  const coordinateChecks=samples.map(voxel=>{
    const expectedRAS=spec.modality==='CT'?[-10-voxel[0],-20-voxel[1],30+2*voxel[2]]:[30-3*voxel[2],-40-1.5*voxel[0],50+2*voxel[1]],actualRAS=point(volume.affine,voxel);
    assert.deepEqual(actualRAS,expectedRAS);return{voxel,expectedRAS,intensity:spec.value(...voxel)};
  });
  if(spec.modality==='CT'){assert.deepEqual(histogram,{'-1000':1253,'600':256,'1200':27});assert.equal(volume.min,-1000);assert.equal(volume.max,1200);}
  else{assert.equal(volume.min,100);assert.equal(volume.max,369);assert.equal(sum/volume.data.length,234.5);}
  const physicalOrder=[...group.slices].sort((a,b)=>spec.modality==='CT'?a.imagePosition[2]-b.imagePosition[2]:a.imagePosition[0]-b.imagePosition[0]);
  assert.notDeepEqual(group.slices.map(slice=>slice.sopInstanceUID),physicalOrder.map(slice=>slice.sopInstanceUID),'input filename order is not physical order');
  assert.notDeepEqual(physicalOrder.map(slice=>slice.instanceNumber),[...physicalOrder].map(slice=>slice.instanceNumber).sort((a,b)=>a-b),'InstanceNumber is not physical order');
  checks.push({modality:spec.modality,seriesUID:spec.seriesUID,frameOfReferenceUID:spec.frameUID,dims,spacing:spec.spacing,sourceEncoding:{bitsAllocated:16,bitsStored:spec.bitsStored,highBit:spec.bitsStored-1,signed:false,slope:spec.slope,intercept:spec.intercept,photometricInterpretation:spec.photometric},intensityUnit:volume.dicom.intensityUnit,min:volume.min,max:volume.max,mean:sum/volume.data.length,affineRAS:expectedAffine,coordinateChecks,...(spec.modality==='CT'?{expectedHUHistogram:histogram}:{}),allVoxelsMatchFormula:true,filenameAndInstanceOrderDifferFromPhysical:true});
}
const truncated=dicomFile(ct,0,{sopUID:uid(5000)}).subarray(0,-17);
const truncatedRecord=await write('invalid/truncated/INVALID_TRUNCATED_PIXEL_DATA.dcm',truncated,{kind:'invalid',expectedRefusal:'TRUNCATED_DATASET'});
const compressed=dicomFile(ct,0,{sopUID:uid(5001),transferSyntax:JPEG2000,fakeCompressed:true});inspectFileMeta(compressed,ct,uid(5001),JPEG2000);
const compressedRecord=await write('unsupported/jpeg2000-marker/UNSUPPORTED_JPEG2000_MARKER_FAKE_PAYLOAD.dcm',compressed,{kind:'unsupported',expectedRefusal:'UNSUPPORTED_TRANSFER_SYNTAX',payload:'deliberately not a JPEG2000 codestream'});
const irregularSpec={...ct,seriesUID:uid(5100),frameUID:uid(5101),description:'INVALID SYNTHETIC IRREGULAR SPACING'};
const irregular=[];
for(const [z,physicalZ] of [30,32,35.5].entries())irregular.push(await write(`invalid/irregular-spacing/INVALID_SPACING_${[30,10,20][z]}.dcm`,dicomFile(irregularSpec,z,{sopUID:uid(5200+z),position:[10,20,physicalZ],instance:[31,11,21][z]}),{kind:'invalid-series',physicalZ,expectedSeriesRefusal:'IRREGULAR_SLICE_SPACING'}));
function refusal(label,operation,expected){
  try{operation();assert.fail(`${label} must be refused`);}catch(error){assert.equal(error.code,expected);return{case:label,code:error.code,message:error.message};}
}
const refusals=[refusal('truncated Pixel Data',()=>parseDicom(truncated),truncatedRecord.expectedRefusal),refusal('JPEG2000 marker with explicitly fake payload',()=>parseDicom(compressed),compressedRecord.expectedRefusal)];
const badSlices=[];for(const record of irregular)badSlices.push(parseDicom(await readFile(path.join(output,record.path))));
refusals.push(refusal('irregular 30/32/35.5 mm slice positions',()=>convertSeriesToVolume(groupDicomSeries(badSlices)[0]),'IRREGULAR_SLICE_SPACING'));
const generation={origin:'Synthetic DICOM byte construction and CLI parse/group/convert checks; not browser import or file-picker verification',synthetic:true,patientName:PATIENT_NAME,patientId:PATIENT_ID,
  format:'DICOM Part 10 classic single-frame CT/MR; Explicit VR Little Endian for valid files',studyUID:STUDY_UID,implementationUID:IMPLEMENTATION_UID,
  formulas:{CT:'cube x/y=2..4,z=1..3 => 1200 HU; else (x-7.5)^2+(y-7.5)^2+(2z-5)^2<=25 => 600 HU; else -1000 HU. raw=(HU+1024)/2.',MR:'GV=100+7*x+11*y+31*z; slope=1,intercept=0; MONOCHROME1 changes display only.'},
  checks,refusals,files:manifest,validFileCount:validRecords.length,invalidOrUnsupportedFileCount:manifest.length-validRecords.length,
  limitations:['Fixture preparation and CLI validation only; browser folder selection, multi-series chooser and UI refusals remain to be verified.','No full DICOM IOD/conformance certification or external DICOM validator was run.','JPEG2000-marked file deliberately contains a non-decodable fake payload and is not a valid compressed image.']};
await writeFile(path.join(output,'generation.json'),JSON.stringify(generation,null,2)+'\n');
await writeFile(path.join(output,'README.md'),`# Synthetic DICOM import fixtures\n\nAll 15 DICOM files are generated numerical phantoms, with PatientName **${PATIENT_NAME}**. No real patient or scanner images are used. Dates, equipment names and identifiers are synthetic constants. Not for clinical use.\n\n## Valid import folders\n\n- Choose **valid/** in the folder picker to load 10 files and offer **two series**. Its CT/ and MR/ children contain no duplicated instances.\n- Choose **valid/CT/** for one classic CT series: 16×16×6, spacing 1/1/2 mm, origin LPS (10,20,30), orientation (1,0,0,0,1,0). Background -1000 HU (1253 voxels), sphere 600 HU (256 voxels), separate cube 1200 HU (27 voxels). Raw unsigned 12-bit pixels use slope 2/intercept -1024.\n- Choose **valid/MR/** for one classic MR series: 12×10×4, spacing 1.5/2/3 mm, orientation (0,1,0,0,0,1), origin LPS (-30,40,50). GV=100+7x+11y+31z, range 100..369, mean 234.5. MONOCHROME1 display inversion must not change quantitative values.\n\nFilenames and InstanceNumber are deliberately **not** physical slice order. Use ImagePositionPatient/orientation. CT world RAS = (-10-x,-20-y,30+2z); MR world RAS = (30-3z,-40-1.5x,50+2y). Full formulas, per-file physical slice indices, SHA256 and CLI assertions are in generation.json.\n\nValid files have Part 10 preamble, complete conventional file-meta group (version, matching SOP Class/Instance, transfer syntax, implementation UID/version and correct group length), Study/Series/Frame UIDs, orientation/position/pixel spacing, conventional patient/study/equipment/image attributes, Bits and linear Rescale tags. This is not a comprehensive DICOM conformance certification.\n\n## Separate refusal cases\n\nDo not choose the dicom/ root as a valid-series folder: it also contains these explicitly invalid/unsupported cases. Select only the indicated leaf folder for each refusal test.\n\n- invalid/truncated/: one deliberately truncated Pixel Data file; expected TRUNCATED_DATASET.\n- unsupported/jpeg2000-marker/: one JPEG2000 transfer-syntax-marked file with an explicitly fake, non-decodable encapsulated payload; expected UNSUPPORTED_TRANSFER_SYNTAX. It is not a valid JPEG2000 sample.\n- invalid/irregular-spacing/: three otherwise parseable slices at physical z=30/32/35.5 mm in one separate Series UID; conversion must refuse IRREGULAR_SLICE_SPACING rather than guessing/resampling.\n\n## Reproduce and evidence boundary\n\nRun: node --experimental-strip-types scripts/create-mimics-dicom-fixtures.mjs\n\nThe script writes files, reads them back, checks conventional file-meta bytes, then invokes the application's parse/group/convert kernel against independent explicit dimensions/intensity/world-coordinate formulas. All valid voxels and expected refusals are checked. This proves fixture preparation and CLI parsing only. Browser import/folder UI, multi-series selection and UI error presentation are **not verified** by this generation run. No external DICOM conformance tool or new dependency is used.\n`,'utf8');
console.log(JSON.stringify({output,validFiles:validRecords.length,invalidOrUnsupported:manifest.length-validRecords.length,series:checks.map(check=>({modality:check.modality,dims:check.dims,spacing:check.spacing,allVoxelsMatchFormula:check.allVoxelsMatchFormula})),refusals:refusals.map(item=>item.code)},null,2));
