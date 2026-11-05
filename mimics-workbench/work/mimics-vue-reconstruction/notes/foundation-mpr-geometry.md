# Arbitrary-plane MPR geometry and sampling

## Read-only native-help evidence

Read from `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/`:

- `Online reslice.txt` and `Online reslice2.txt`: online reslicing along a curve or a plane preserves the original project. Three points in 2D images or on 3D objects can define the plane.
- `Along Plane.txt` and `Along Plane2.txt`: plane reslicing produces three orthogonal views, one parallel to the chosen plane; plane rotation, translation and resizing are supported. Interactive MPR starts parallel to the current axial view. Ctrl enables the blue interactive crosshair for rotation and translation. That crosshair is independent of the view-intersection crosshair and does not automatically follow ordinary scrolling.
- `Reslice Objects.txt`: reslice objects can be created, selected, renamed, deleted, duplicated and opened in Properties; their images use Reslice Layout.
- `Reslice layout.txt`: online reslicing enables the axial, cross-sectional and parallel layout.
- `Reslice Project.txt`: a distinct operation creates a new project on disk. Width, height, pixel size, slice distance, orientation and a transformation-matrix export are described.
- `Reslicing preferences.txt`: physical spacing between sections/parallels and navigation preferences are described.

These help pages do not establish the proprietary interpolation kernel, voxel-edge behavior, Euler-angle convention, automatic FOV calculation or native performance. The implementation below is independently specified and tested. It does not claim native numerical equivalence, curved reconstruction, slab/X-ray projection or a newly exported resliced volume.

## Independent implementation contract

`src/mimics/mpr.ts` consumes source `VolumeGrid` coordinates already normalized to millimetres. It uses the complete existing `worldToVoxel` affine inverse, including translation, anisotropy, shear and reflection; it does not rescale units a second time. Each output pixel is actually sampled in the source volume.

`MprPlane.origin` is the world centre of output pixel `(0,0)`. `u` and `v` are full world displacement vectors per one output pixel, not unit axes. Positive `up` means positive sample `v`. Angles are an explicit application convention: degrees, world right-handed X then Y then Z rotations of the initial XY frame.

Validation clones exact plain data, rejects unknown fields/accessors/sparse arrays, requires finite nonzero orthogonal steps and finite output corners, and caps outputs at 4,194,304 pixels and 16,384 pixels per dimension. Sampling also has a 128 MiB output allocation cap and optional smaller budgets. Cancellation throws without returning a partial image or changing source arrays.

FOV fitting projects all eight source half-voxel support corners onto the requested output orientation. The three-view helper keeps view zero an exact clone of the saved base plane and fits only the two complementary planes, with directions `(v,n)` and `(n,u)`, around the same world centre. The saved base spacing is never silently refitted by that helper.

Gray uses trilinear interpolation by default, with an optional explicit nearest mode. Gray validity deliberately matches the existing physical-plane density statistics: source centre bounds `[0,dims-1]` with the existing `1e-7` clipping tolerance. Outside that centre support the gray output is NaN and `valid=0`. This is an application edge convention, not native evidence.

Each independent Mask always uses nearest sampling, preserves its source byte labels and returns its own new output array. `support` covers the source's closed half-voxel box `[-0.5,dims-0.5]`; an edge Mask can therefore be supported where gray is invalid. Outside support Mask outputs are zero. Masks are never merged or gray-interpolated.

The output plane is structurally the same as `PhysicalDensityPlane`. `mprDensityPlane` exposes a validated clone for calling the existing `densityStatistics` evaluator with the same output sample centres. Existing measurements and ROI metrics are not reimplemented in the resampler.

## Density NaN correction

The existing linear density loop now reads only strictly positive-weight contributors. A targeted counterexample uses finite fractions `fx=fy=1e-200`: the diagonal product underflows to exactly zero, so a NaN at that diagonal must not poison the valid result. A NaN with positive weight is still excluded, and the previous nearest default is unchanged. Ordinary integer-centre cases already benefited from the old ceil-based upper index; the regression test does not incorrectly claim those ordinary cases reproduced the original defect.

## Executed evidence

`tests/mimics-mpr.test.ts` uses small literal source grids and an analytic world-linear intensity field. Expected gray values are hand-derived from that field, including a genuinely oblique plane that mixes all three voxel axes. Independent expected Mask samples cover nearest rounding and separate overlays. Further cases cover full-affine FOV fitting, reflected axes, pixel/world mapping, spacing-only anisotropy, strict schema rejection, source immutability, gray/Mask edge distinctions, NaN weights, cancellation and allocation budgets.

This is pure helper and evaluator evidence. Browser responsiveness, live canvas rendering, controller gestures, persistent-document wiring and full-suite integration belong to the other coordinated checks and are not certified by these tests alone.

## Coordinated controller review

Read-only review of `useMprView.ts` and its `useWorkbench.ts` integration identified four issues. Root corrected each in its owned source: scroll payloads now validate document/project/pose epochs even when a reopened document has an identical plane; restored plane axes recover the explicit Euler convention before a resolution-only application; orientation matching distinguishes a small real rotation from pure normal translation; and density labels validate against their current displayed plane after scrolling.

`tests/mimics-use-mpr-view.test.ts` adds 10 independently executed checks using the real view composable and real controller/Worker initialization. Hand-computed evidence includes first-to-second three-point axis, positive projected-up direction and world centroid; each orthogonal view's signed scroll direction; unchanged original-source and independent MPR crosshairs during scroll; full-affine explicit crosshair sync; positive/negative 90-degree Euler restoration; stale pose/document rejection; and a reflected/sheared density field whose expected mean changes from 24.5 to 13.5 after a +4 mm physical scroll. Source image, raw ROI geometry and undo history remain unchanged by that scroll.

Final executed review subset: 16 helper tests plus 10 view/controller checks passed (26/26), and `vue-tsc --noEmit` passed. Root retains ownership of final aggregate validation and UI wiring.

The native interactive Ctrl blue-crosshair gestures, curved reconstruction and complete Reslice Project workflow remain separate unverified scope. Euler controls and three-point plane definition are not evidence that those native interactions or numerical implementations have been reproduced.

## Resident background sampling

`mprSamplingClient.ts`, `mprSampling.worker.ts` and `useMprSampling.ts` move raster sampling into a real Worker. A per-document pool shares one resident image and each independent Mask among all three owner slots. Initial source arrays are copied into new owned arrays, and only those copies are transferred. The source Float32Array, Mask buffers and source geometry remain usable and unchanged in the main document.

Actual source changes use image data/geometry and each Mask's ID, data identity and optional membership revision. A new data identity or an explicitly incremented Mask revision starts a new resident epoch. Metadata-only project revisions, names, colors, visibility, opacity and window/level changes do not resample or copy the source. An unsignalled in-place typed-array mutation with neither a replacement data identity nor an explicit Mask revision is outside this immutable-source contract; arbitrary byte writes are not implicitly observable.

Preparation validates the resident source and computes its affine inverse once. Both the strict synchronous helper and the Worker use the same global-coordinate generator. It validates the full-plane pixel and 128 MiB allocation budgets before allocating the image; asynchronous scanning yields every 4096 output pixels without reconstructing strip origins or changing nearest-neighbor ties. There is no per-strip source validation or separate interpolator.

The worker keeps at most one active full-plane scan and the newest pending request for each owner. On each yield it can process cancellations or newer owner requests and abandon obsolete work. The client also checks worker identity, source epoch, owner and request ID before publishing. Every new sampled pose clears the old displayed samples immediately. Old document/source results, canceled scans and disposed owners cannot restore an obsolete image. Document replacement or final-owner disposal terminates the unused Worker. Failure and unavailable-Worker states are visible errors; there is no synchronous raster fallback. An explicit refresh can retry a failed Worker.

Resident storage costs one additional copy of `4*N + sum(mask.byteLength)` bytes per live source document, rather than one source copy per pane. Output storage is separate: each of three panes can retain its own result; the worker has one active output allocation bounded at 128 MiB. During replacement a new copy and the old document's resident can briefly coexist until its remaining owner slots dispose. This output budget is not a bound on total volume, Mask or browser-process memory. Initial source copying and browser rendering responsiveness have not been certified by browser evidence.

`tests/mimics-mpr-sampling.test.ts` uses an actual Node Worker adapter with transfer semantics. Cases cover three-owner resident reuse; analytic oblique samples and global coordinates across a yield boundary; separate nearest Mask bytes; latest-only cancellation in the worker itself; document/source replacement; metadata-only redraw; same-buffer writes with an explicit Mask revision; strict allocation/cancellation; source-buffer preservation; worker initialization/failure/unavailability; and explicit retry. SFC interaction tests can stub the composable for deterministic event checks, while the real background lifecycle is established by this separate Worker suite.

The read native plane-help text describes grabbing and dropping but does not specify whether raster resampling is live or release-only. The current gesture's preview/commit cadence is therefore an application convention and must not be reported as recovered native timing.

## Nearest half-tie stability after resident preparation

The independently written full-affine workflow caught an actual preparation regression: its reflected/sheared matrix maps world `(6.3125,-13.375,35)` analytically to voxel `(2.5,2,1.25)`, but cached inverse arithmetic yielded `2.4999999999999996` on the first coordinate. Unqualified rounding chose the wrong neighboring Mask voxel.

The shared `measurements.nearestVoxelCoordinate` now makes an explicit independent convention: coordinates within two binary ULPs of a half-integer count as that tie and round toward positive infinity; other values retain `Math.round`. It derives ULP from the IEEE exponent and applies no blanket epsilon bias to non-half values. Extreme magnitudes at or above `2^50`, far beyond valid source-array coordinates, retain ordinary rounding rather than letting an ULP neighborhood absorb integers. MPR nearest gray, each independent Mask and physical-plane density nearest sampling share the function. This does not globally redefine existing IJK editing round operations or claim native tie behavior.

The original workflow oracle assertion was not changed. It now passes again (9/9), and a real Worker counterexample verifies the same point's expected nearest gray 75, parity Mask 1, overlap Mask 1 and linear gray 77.25. A separate helper test ensures values genuinely below the tie neighborhood still round down. The focused helper/Worker/workflow run passed 39/39 with type checking.

## Shared-worker recovery regression

A later integration review found that a peer's empty source invalidation cleared its image and error but never submitted a new request. After one of three panes explicitly retried a shared Worker failure, the other two could therefore remain blank indefinitely.

Empty source invalidation now schedules the peer update in a microtask, capturing its generation, owner and document identity. A subsequent fatal error, cancellation, disposal, document replacement or newer request revokes that queued recovery. Fatal invalidations remain visible and do not schedule automatic retries.

Three additional tests use three actual Vue composable instances and a shared real Node Worker. An uncaught error in that worker clears all three panes; an explicit retry from only one restores all three with one new source initialization and three pose requests. A synchronous failure during that retry cancels both queued peer jobs instead of producing blind retries. Explicit cancellation and disposal also prevent queued peer resurrection. The sampling suite now passes 16/16.
