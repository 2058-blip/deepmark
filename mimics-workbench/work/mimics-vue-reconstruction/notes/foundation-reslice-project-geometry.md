# Reslice Project: independent bounded 3D resampling geometry

`src/mimics/resliceProjectGeometry.ts` implements a pure 3D gray/independent-Mask resampling kernel and a geometry-only preview planner. It does not create an image header, install a project, transform other project objects, modify raw samples, or change existing MPR/worker/type modules. Those integration steps belong to the caller.

## Native evidence and independent conventions

Local `Mimics Reference Guide/Reslice Project.txt` establishes straight-line reslicing into a new project, adjustable endpoints/rotation/dimensions/pixel size/slice distance, a bounding-box preview, written transformation matrices, and Update CS default Off. It describes Update CS On as moving the origin to the upper-left corner of the first image and aligning the axes to the image stack. Static/help evidence does not recover exact interpolation kernels, layer endpoint rounding, upper-left corner versus first pixel-center offset, row handedness, background policy or numerical tie rules.

The native dialog's Image Width/Height are physical millimetres. **This pure kernel's `width` and `height` are explicitly integer output sample counts.** The parent UI may separately quantize requested millimetres with `max(1, round(widthMm/pixelSize))` and display the effective physical FOV; that conversion is an independent application convention, not a claim that native width/height fields are sample counts or use the same rounding.

The chosen line start is the first layer center. The line end bounds the last permitted regular layer center. Layer count is `floor(lineLength/sliceDistance)+1`, at least one for a shorter positive line. It does not add a stretched last layer to reach an indivisible endpoint. A just-below-integer floating quotient can round upward; if the resulting regular last-layer distance would exceed the represented line length, one interval is removed. Zero-length lines reject.

`normal` points from start to end. `up` means positive image-row direction: project it perpendicular to the line, normalize as `v`, and choose `u=cross(v,normal)`. Default up is world +Y, switching to +X when `abs(normal.y)>=.9`. Zero or nearly parallel explicit up uses the same stable fallback. A positive `rotationDegrees` rotates right-handed around the forward line: `u'=cos*u+sin*v`, `v'=cos*v-sin*u`. These row/orientation choices are explicit reconstruction policies.

The first sample center is `start - ((width-1)/2)*pixelSize*u - ((height-1)/2)*pixelSize*v`. Thus sample-center extents are `(width-1)*pixelSize` and `(height-1)*pixelSize`; complete voxel-support FOV spans `width*pixelSize` by `height*pixelSize`. A one-sample dimension has zero center extent but positive support.

Update CS Off preserves source-world coordinates and returns identity world-to-world transforms. Its output affine columns are `pixelSize*u`, `pixelSize*v`, `sliceDistance*normal`, with the true source-world first-sample origin. Update CS On makes the first **pixel center** world zero and the output image axes positive X/Y/Z; output affine is positive diagonal spacing. The source-world→output-world rigid matrix contains rows `u/v/normal` and translations `-dot(axis, sourceOrigin)`; its inverse contains those unit columns and `sourceOrigin`. The exact native half-voxel/upper-left convention remains unknown, so this center-based choice is not asserted native-equivalent.

## API

`createResliceProjectGeometry(options)` allocates no image volume. It returns a `ResliceProjectPlan` with:

- `dims`, `spacing`, and a 4×4 millimetre output affine;
- `sourceWorldToOutputWorld` and inverse `outputWorldToSourceWorld` 4×4 matrices;
- `geometry`: layer count/line length/last and remaining distance; first and last layer centers; first pixel `sourceOrigin`; unit `u/v/normal`; eight `sampleCenterCorners` and eight `supportCorners`, all in source-world coordinates;
- `physicalBounds` and `supportBounds`, each with source-world/output-world `{min,max}` AABBs. Corners are emitted with Z outermost, Y next and X innermost.

`resliceProject(grid, options, masks=[])` adds new `Float32Array data`, independent `{id,data:Uint8Array,count}` Masks, and coverage `{totalVoxels,grayValid,grayOutside,grayNonfinite,maskSupported,maskOutside}`. Options include `start/end`, optional `up/rotationDegrees`, sample `width/height`, physical `pixelSize/sliceDistance`, optional `updateCoordinateSystem/interpolation/background/maxVoxels/maxBytes`, and `AlgorithmControl`. Defaults are linear interpolation, background0 and Update CS Off. Background must fit finite Float32.

## Sampling and validation

The kernel inverts the complete source affine, including shear/reflection, using translation-free inverse increments. It resamples all three dimensions directly; a cross-section is not forced through the existing 2D MPR pixel limit. Gray samples use the existing center-box support convention (1e-7 voxel boundary tolerance) and trilinear or nearest interpolation. Outside-center support or nonfinite participating gray contributors produce the chosen finite background; coverage distinguishes outside from nonfinite. Zero-weight trilinear contributors cannot poison an exact finite sample.

Each independent Mask uses nearest source membership within the closed half-cell support box. The existing two-ULP half-integer policy rounds ties toward positive infinity, then clamps outer half-cell contacts to the source boundary. Mask coverage therefore differs deliberately from finite gray center support and does not depend on gray interpolation. Overlapping Masks stay independent. IDs must be unique/nonempty, lengths/types must match, and every source Mask byte is validated strictly0/1 before any output array is allocated. Validation scans are cooperatively cancellable and represented in progress; there is no arbitrary source-Mask byte hard cap. Source gray NaNs/infinities are not globally rejected, because they are handled as unavailable sample contributors.

## Resource limits and atomicity

Default output limits are 16,777,216 voxels and256MiB. Hard configurable ceilings are 134,217,728 voxels and512MiB. Dimensions have a32767 hard ceiling for the existing NIfTI-1 header range, and Mask count has a1024 metadata/array ceiling. These are application limits, not recovered native defaults. Output typed-buffer bytes are counted as `voxelCount*(4+maskCount)` before allocation. No complete output is silently downsampled, no source-sized gray copy is made, and preview planning allocates only fixed-size geometry data.

All output arrays are private until successful return. Invalid parameters/geometry/source affine, nonbinary Masks, resource excess, callback errors, cancellation or gray/Mask allocation failure throw without returning a partial result or modifying source arrays. Cancellation uses `AbortError`; progress covers Mask validation followed by output scanning and checks cancellation after callbacks including final progress. This synchronous heavy kernel is intended for worker execution.

## Verification

`node --experimental-strip-types --test tests/mimics-reslice-project-geometry.test.ts` passes17 owned analytic cases; `npx vue-tsc --noEmit` passes. Tests use explicit expected voxel sets/values and world matrices: axial and genuine oblique linear fields; full source shear/reflection; both coordinate-system modes; world transform round trips; center/support corners and one-sample support; positive rotation and row fallback; divisible/nondivisible/sub-layer/floating endpoint cases; half-cell Mask contacts and positive nearest ties; nonfinite gray/background categories; independent overlapping Masks and immutable inputs; all output budgets and binary validation; cooperative cancellation and synthetic gray/Mask allocation failures. An actual4,196,352-sample single cross-section exceeds the2D MPR4,194,304 cap and is still resampled at the requested size under the3D budget. No original target or patient data was executed, and no original-result equivalence is claimed.
