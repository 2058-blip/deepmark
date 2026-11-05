# Named Reslice Plane objects

Scope: RP data/schema/history, object management, and deferred Properties. Source NIfTI grid/header/units/voxel data, independent Masks/Parts, and historical measurement frames are not rewritten. Curved reslices remain outside the implemented contract. No new dependency, browser/native-program inspection, or real patient data was used.

## Document contract

`types.ts` exports `ReslicePlaneObject {id,name,kind:'plane',plane:MprPlane}` and the currently plane-only `ResliceObject` alias. There is no object `visible` property. Optional `ProjectState.resliceObjects` stores the collection; optional `selectedResliceId` is both selected and active RP ID. `''` explicitly clears selection; missing fields remain missing for legacy files. A nonempty selection must reference an existing RP object.

MPR enabled/disabled and its current scrolled frame remain independent view state. Closing the view does not remove RP selection. Ordinary slice scrolling does not edit the stored RP definition. Neither stored RP geometry nor its mutations retarget existing `MeasurementObject.mprPlane` world geometry.

Project schema and ZIP restore reject unsupported fields/kinds, malformed world planes, missing active IDs, and duplicate object IDs across Masks, Parts, Measurements, Centerlines, Polylines, and RP objects. New RP IDs also participate in wrong-object-type reference rejection. Part references include Mask/Centerline `sourcePartId` and both legacy measurement `partId` and per-point `pointPartIds`; Mask references include Part/Centerline/Polyline `sourceMaskId`. A reference to an existing RP is rejected consistently in validation, ZIP restore, and history; a genuinely missing historical source retains the existing orphan policy. Measurement Properties also includes RP objects in both foreign-ID and wrong-attachment checks, including a referenced ID that becomes owned by an RP while the dialog is open. History validates before changing either stack; all RP plane arrays are deeply cloned in history/ZIP/activation payloads, while the established immutable typed-buffer sharing remains intact. Empty optional collections roundtrip without synthetic defaults.

## Manager API

`useResliceObjects({state,volume,busy,commit,fail,onActivate})` returns:

- `objects`, `selected`, `propertiesDraft`.
- `fromPlane(plane,name?)`, `newObject(name?)` (default source-fitted 256×256 plane), `select(id)`.
- `rename(id,name)`, `duplicate(id=selected)`, `remove(id=selected)`.
- `updatePlane(id,plane,transactionName='调整重切片平面')`.
- `openProperties(id=selected)`, `applyProperties(patch?)`, `cancelProperties()`.

Creation, duplication, rename, deletion, and actual geometry/Properties edits commit one atomic transaction each. No-op operations do not add history. Select changes persistent selection without geometry history or dirtying the document; repeated explicit select may re-activate the current object. Deleting active RP clears selection rather than silently selecting another object.

`onActivate(object|null)` receives a detached clone. A synchronous watcher on volume identity, selected ID, and selected frame signature handles Undo/Redo and external state replacement. Explicit mutations rely on this same watcher, avoiding duplicate callbacks. Identity-only state clones and geometric no-ops do not loop. A metadata-only Properties Apply notifies once after its successful commit. Same-volume document replacement must call `cancelProperties()` explicitly; ordinary volume replacement, busy state, selection changes, and deleting the edited object cancel synchronously.

## Properties and physical geometry

`ResliceProperties` is `{name,center:Vec3,angles:Vec3,widthMm,heightMm}`. `ReslicePropertiesDraft` adds readonly `id` and frozen output `size`. Angles use extrinsic fixed-world X, then Y, then Z degrees, matching `createMprPlane`. Existing arbitrary orientations, gimbal configurations, and rounded orthogonal frames can be displayed without silently changing unchanged geometry.

Physical FOV width is `size[0] * |u|` and height is `size[1] * |v|`: the full pixel-support rectangle, not sample counts or first-to-last-center distance. Editing millimetre FOV changes per-pixel steps while output dimensions stay fixed. The form labels world centre, world angles, physical millimetre FOV, and readonly output pixels separately.

Apply compares provided fields against the opening baseline and merges actual user changes into the latest live RP. A metadata-only form submission preserves the newest exact frame; partial centre/FOV edits retain untouched live size and orientation. Cancel is deferred and creates no object/history mutation. Failed validation or commit retains the editable draft. Geometric equality uses a small absolute tolerance plus floating roundoff (`1e-8 + 32*EPS*maxAbs`), so a large world translation does not hide a real small millimetre edit.

## Verification

`tests/mimics-reslice-objects.test.ts`: 14/14 pass. Includes m/mm/micron and little/big-endian ZIP roundtrip, independent RP/view frames, strict schema and global ID collisions, seven classes of foreign source/attachment references, true historical orphans, late RP ID ownership during Properties, old-file omission, deep clones/history, once-only activation through replay/external state, FOV-versus-output-size semantics, live-field merge, exact rounded frames, Euler/gimbal roundtrip, 1e9-world-origin 0.05 mm movement, invalid/failed commits, lifecycle cancellation, and the actual compiled Properties SFC setup/render/events connected to the real manager.

Existing owned project/measurement/provenance suites plus MPR project tests pass 60/60 with the RP schema installed; combined with the RP suite, the targeted run is 74/74. Adding the real MPR workflow produces 83/83 passing tests. `npx vue-tsc --noEmit` passes. Root coordinates full-suite/build and UI verification.

The existing MPR workflow three-point case passes with the native RP-addition contract: collinear/cancel remains view-only; success adds one RP and one Undo transaction with unchanged source/measurement geometry; subsequent scrolling and crosshair navigation stay view-only. All 9 MPR workflow cases pass, retaining their independent world-linear oracle. A nearest-sampling exact-half regression exposed by the worker-sampler optimization was reported to and fixed by the sampler owner; the independent expected value was preserved.
