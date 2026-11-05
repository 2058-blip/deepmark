# Pure TypeScript segmentation and LiveWire implementation

Update: the later [native depth pass](native-segmentation-depth.md) recovers LiveWire's two ShiftScale normalizations and zero-crossing placement, and implements the newly confirmed Smart Expand random-walker chain. Its 38-test record supersedes the initial 27-test checkpoint below. The Gaussian preprocessing kernel remains an explicit independent approximation.

Implementation: `src/mimics/segmentation.ts`, `src/mimics/livewire.ts`.
Validation: `tests/mimics-segmentation.test.ts`, `tests/mimics-livewire.test.ts`.
The existing application, package configuration, shared types and original Mimics installation were not modified by this task. No proprietary executable was run.

## Evidence boundary

The source evidence is `work/mimics-17-analysis/report/modules/annotation/annotation.md` and its saved C decompilations in `work/mimics-17-analysis/evidence/annotation/`. This implementation reconstructs confirmed local semantics and explicitly supplies independent algorithms for unresolved mathematics. It is not a claim of byte-for-byte or clinical equivalence to Mimics 17.

| Implemented tool | Confirmed native evidence | Implemented choice and remaining difference |
| --- | --- | --- |
| Threshold | `imageops-0x180020a00.c`: reject `< lower` and `> upper`, maximal row segments | Closed interval, finite Float32 values, inclusive integer ROI/optional slice. Independent dense output, not the proprietary 16-bit compressed storage. Nonfinite values are explicitly excluded. |
| Existing-mask region grow | `imageops-0x18004a680.c`: RLE segment queue, intersecting/expanded row intervals | Maximal X runs, binary search of neighboring rows, FIFO run queue, 6 or 26 topology. Extracts a fresh component; no source clearing or mutation of other masks. Physical-to-voxel seed conversion belongs to the caller. Native GUI enum-to-flag mapping remains incompletely verified. |
| Dynamic grow | `imageops-0x18000db40.c`, `imageops-0x180003a60.c`, `imageops-0x180003f30.c` | Packed 2-bit visited states; FIFO z/y/x neighbor enumeration; accepted and rejected candidates visited permanently; strict `mean-lowerDeviation < I < mean+upperDeviation`; seed included; optional online mean. Default is fixed seed mean. Seed must be finite. Incremental mean is numerically stable but not asserted to have identical floating-point rounding to native `n*mean+I`. |
| Boolean | `imageops-0x180005fb0.c`, `...61c0.c`, `...63d0.c` | Union, intersection, ordered A-minus-B. Independent Uint8 masks normalize nonzero values to 1. Threshold metadata is a caller concern. |
| Erode/dilate/open/close | `imageops-0x180017050.c`, `imageops-0x18004bc40.c`, `imageops-0x18004bb60.c`: dispatch, physical parameters, open erode→dilate and close dilate→erode | **Independent structuring element.** A separable physical Chebyshev box uses sliding prefix sums. Native full erosion/dilation loops have not been recovered; no claim of exact sphere/cube/ITK equivalence. 8 connectivity acts per axial plane across all slices, or per explicitly chosen plane. 26 connectivity includes Z unless a single plane is specified. Pixels convert to millimetres using minimum spacing of the selected plane (axial by default); `units:'mm'` is also supported. Integer axis extents are `floor(radiusMm/axisSpacing)`, so a thick slice is not added until the physical radius reaches its spacing. Outside the image is background for erosion. The final `limitMask` intersection is explicit; advanced native limit behavior is not completely recovered. |
| Automatic hole filling | `imageops-0x18005e090.c`: 2D/3D split, boundary propagation and internal background writeback | Boundary-connected complement runs remain exterior; other background runs are filled. Independent default background connectivity 6; 26 optional. ROI defines the exterior boundary. Single-plane operations ignore the fixed axis when finding the exterior. Native complete packed-state/neighbor mapping remains unconfirmed. |
| Seeded cavity fill | `imageops-0x18000e520.c`, `imageops-0x18004c9b0.c`: seed bounds, line propagation | Complement-run component from the seed, including documented leakage through an opening. Default fresh result is source union selected cavity; `includeSource:false` returns only the cavity component for a separate target. This target assembly convention is explicit and is not claimed to recover every native source/target option. |
| Keep largest | Advanced threshold action proven by `seg-0x18016c530.c`; native ordering details not recovered | **Independent exact connected-component selection.** Largest by voxel count, earliest x-fastest component wins a tie. Single grid voxels share one affine volume, so ordering by physical volume is identical here. |
| Crop | CropMask action documented; detailed native bbox inclusion not recovered | **Independent inclusive convention.** Keep integer ROI `min <= coordinate <= max`; image grid and intensities remain unchanged. |
| Multiple-slice selection | CHM A06 and exported copy-slice settings | Temporary selection data is separate from active mask. `applySelection` returns the edited active mask (Add/Remove/local closed threshold). Copy replaces each complete target selection slice, including zeros, clips at image edge, and count 0 means all remaining slices in that direction. These lifecycle/copy details follow the documentation; the native CopySlice loop is not fully recovered. |
| Polygon/lasso | Native DrawMaskLine add/erase confirmed; exact rasterization unresolved | **Independent even-odd rasterization** at integer voxel centers, boundary included. Slice coordinates are u/v, the remaining two axes in ascending order. Self crossings use even-odd semantics. |
| Selection interpolation | CHM confirms temporary-mask interpolation but no recovered formula | **Independent signed-distance interpolation.** Exact separable weighted Euclidean distance transforms in physical in-plane units; interpolate signed distances between two anchors; zero crossing included. A one-pixel exterior background padding defines full-slice distances. An empty anchor uses a finite negative field equal to the padded diagonal, which is an explicit implementation convention. Anchors and other slices are preserved. This is not asserted to be Mimics' interpolation or 3D LiveWire turtle-map fusion. |
| Statistics | New utility, not attributed to a particular native function | Count, affine determinant volume, finite-only intensity min/max/mean/population deviation, voxel bbox/centroid and physical centroid. Nonfinite density count is separate from selected voxel count. Affine shear is supported for volume/centroid; morphology and interpolation use axis spacing, not full sheared-affine metric. |
| 2D LiveWire | `livewire-0x180007a30.c`: heap Dijkstra and predecessor offsets; `...73a0.c`: weight bounds; `...7560.c`: ITK preprocessing pipeline not fully recovered | Complete reusable 8-neighbor predecessor tree, deterministic index tie rule, finite-image/optional-mask barriers, path backtracking and unreachable `[]`. The native heap's equal-cost tie order is unconfirmed. Automatic central-gradient magnitude normalization and neighborhood Laplacian zero crossing are **independent**. Tree metadata says so, and caller-supplied normalized cost maps bypass automatic preprocessing. No NURBS smoothing or 3D constraint fusion is implied. |

## LiveWire recovered edge formula

The native decompilation at `0x180007FE3–0x1800080C9` gives:

```text
g = (gradientCost[current] + gradientCost[neighbor]) / 2
l = (laplacianCost[current] + laplacianCost[neighbor]) / 2
increment = exp(-(1-g)*attraction) * ((1-weight)*l + k*weight*g) + Number.EPSILON
k = 1/sqrt(2) for an orthogonal step, 1 for a diagonal step
```

The `k` factor multiplies only the gradient term; replacing it with a generic Euclidean edge length changes the recovered formula. The implementation retains this distinction. Supplied cost maps are explicitly required to contain finite values in [0,1]. `gradientWeight` defaults to 0.6 as an implementation default, not an asserted universal installation setting. Attraction defaults to 0; this implementation imposes [-50,50] for numerical stability, not as a claim about native UI bounds. Automatic preprocessing throws a clear error if extreme physical spacing causes numerical overflow.

## API contract

All public mask operations return `{mask: Uint8Array, count: number}`. Every returned mask is fresh, including no-op cases. Inputs are treated as immutable; nonzero mask bytes mean foreground. Input image/mask lengths, finite thresholds/deviations, connectivity, slice bounds, seed integrality and ROI ranges are validated. ROI bounds are inclusive, integral, inside the image, and must contain a supplied slice. Coordinate inputs are **voxel coordinates**, not mouse pixels or millimetres.

`cancelled` and `progress` use the shared `AlgorithmControl`. Cancellation throws an `AlgorithmCancelledError` with `name:'AbortError'`; a partial result is never returned. Loops periodically poll the callback and check before/after progress notifications. Functions are synchronous; ordinary UI code cannot change a callback while a blocked main thread is computing, so use a worker and terminate/recreate it for an immediate user cancel, or provide a shared cancellation flag. Composed operations keep intermediates private. Progress is bounded [0,1], starts at 0 and ends at 1 on success.

Stable exports:

```ts
threshold(grid, lower, upper, {roi?, plane?, cancelled?, progress?}?)
regionGrow(grid, source, seed, {connectivity?: 6|26, roi?, plane?, ...control}?)
dynamicRegionGrow(grid, seed, {lowerDeviation, upperDeviation, updateMean?, connectivity?, roi?, plane?, ...control})
booleanMasks(a, b, 'union'|'intersection'|'subtract', control?)
morphology(grid, source, {operation:'erode'|'dilate'|'open'|'close', radius, connectivity:8|26, units?:'pixels'|'mm', limitMask?, plane?, ...control})
fillHoles(grid, source, options?: GrowOptions)
cavityFill(grid, source, seed, {...GrowOptions, includeSource?:boolean}?)
keepLargest(grid, source, options?: GrowOptions)
cropMask(grid, source, roi, control?)
maskStatistics(grid, mask, control?)
applySelection(grid, active, selection, {operation:'add'|'remove'|'threshold', lower?, upper?, ...control})
copySelectionSlices(grid, selection, plane, direction:-1|1, count, control?)
polygonRaster(grid, plane, points:readonly [number,number][], control?)
interpolateMaskSlices(grid, selection, axis, start, end, control?)
calculateLiveWire(grid, plane, seed, {gradientWeight?, attraction?, gradientCost?, laplacianCost?, allowedMask?, ...control}?)
liveWirePath(tree, target, control?) // seed → target Vec3[], includes endpoints
```

## Verification

Executed in this workspace:

```powershell
& 'C:\Program Files\nodejs\node.exe' --experimental-strip-types --test tests/mimics-segmentation.test.ts tests/mimics-livewire.test.ts
& 'C:\Program Files\nodejs\node.exe' node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler --allowImportingTsExtensions src/mimics/segmentation.ts src/mimics/livewire.ts
```

Result: **27 / 27 scoped tests passed**, strict TypeScript check passed. The scoped suite checks analytic and geometric outcomes, not a second copy of the implementation: strict vs closed endpoints, rejected DRG candidate after mean drift, face/corner topology, row wrapping, all orthogonal orientations, nonfinite intensities, thick slice exclusion, mm/pixel scales, open/closed cavities, diagonal leakage, largest ties, affine shear/density statistics, selected-only threshold removal, full-slice copy, known polygon voxel counts, nested signed-distance shapes, immutable inputs, cancellation, analytic LiveWire costs, low-cost detours, obstacles, cost-map ownership and corrupted predecessor loops.

Full application testing and worker/UI integration belong to the parent integration task. No native output comparison was available in the current read-only/no-target-execution scope. Dedicated organ workflows, Smart Expand, Smooth Mask's unrecovered filter, oblique-frame editing, native interpolation, LiveWire contour smoothing and 3D LiveWire cross-plane fusion remain exactness gaps rather than silently substituted implementations.
