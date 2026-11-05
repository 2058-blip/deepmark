# MPR Mask editing: native help boundary and controller audit

This review searched the local extracted help text and CHM HTML for `editable`, `resliced`, `MPR`, `only`, `original`, edit/draw/erase/threshold associations, nearest-neighbor/interpolation and thickness/slab. It did not run the original program, access a license, inspect patient data, use a browser or use the network. Help prose is reference data, not operational instructions.

## Explicit help evidence

All paths in the following table are under `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/`. Line numbers refer to the local extracted `.txt` files.

| Reference | Explicit support or restriction | Boundary |
| --- | --- | --- |
| `Interpolated images.txt:3,13` | The toggle interpolates XZ and YZ reslices; only grey-value images are interpolated, the mask remains the same, and editing on that mask is possible. | Explicitly supports the orthogonal coronal/sagittal interpolation case. It does not name arbitrary Online Reslice planes. The mask staying the same concerns the interpolation toggle, not a prohibition on intentional editing. |
| `Edit Masks.txt:3,44,52` | All manual editing functions operate on the active mask; Draw adds and Erase removes from that mask. | Does not enumerate which kinds of 2D views can issue those edits. It does not authorize editing raw gray-value data or other masks. |
| `Edit Masks.txt:60,62,64,66` | Local threshold restores the edited zone; the active mask's default middle threshold cannot be changed; touched in-range pixels are added and existing out-of-range pixels removed. The operation is local to a particular area of one image, unlike global thresholding. | Establishes local membership semantics and immutable default threshold metadata. It does not specify a resampled-versus-source intensity kernel for an oblique view. |
| `Online reslice2.txt:3` | Reslicing along a curve or plane retains the original project, in contrast to Reslice Project. | Describes non-destructive creation/viewing of a reslice. It does not establish either permission or prohibition for source-Mask edits issued from that view. |
| `Along Plane2.txt:11` | Ctrl blue crosshair can move/rotate in all 2D images; it is independent of the intersection crosshair. | “All 2D images” modifies blue-axis manipulation. It must not be broadened into proof that every segmentation tool works in every MPR view. |
| `Measure Area.txt:25` | Editable area contour measurements work on normal and resliced MPR views. | Positive evidence for measurement contour control points, not source-Mask editing. |
| `Multiple slice edit.txt:3,5,7,9`; `The multiple slice edit interface.txt:55,71,82` | A temporary mask is copied/interpolated and finally added/removed or used for local threshold on the original active mask. Source view choices are explicitly Axial, Coronal or Sagittal. | Arbitrary MPR multiple-slice selection/copy/interpolation is outside this documented interface. This restriction is not a general prohibition on ordinary single-image Edit Masks. |
| `Reslicing preferences.txt:13,21,37` | Distances between cross-sections/parallels are view spacing; the documented thickness is the depth used for the parallel X-ray calculation. | Neither spacing nor X-ray depth specifies Mask-edit slab thickness. |
| `Reslice Project.txt:5,17,19,21` | Reslice Project creates a new project with image width/height/pixel size/slice distance and transformation/coordinate-system output. | This is a separate data-resampling workflow; it is not the writeback contract for an online RP view. |

No explicit permission or prohibition for arbitrary online MPR brush editing was found in the searched local help. Absence of a match is a bounded evidence gap, not evidence that native Mimics lacks the behavior.

## Unknown native algorithm details

The local references do not establish:

- Whether an arbitrary RP image accepts Draw, Erase, Local Threshold, Lasso, Flood Fill or LiveWire against the existing source-grid mask.
- Which source voxels correspond to an edited oblique displayed pixel: nearest sample, all cells intersected by the plane, voxel-center slab membership, partial-volume overlap, or another mapping.
- Editable slab thickness, half-open boundary/tie rules, treatment of shear/reflection/anisotropy, or repeated-sample deduplication.
- Whether oblique local threshold evaluates interpolated displayed gray values or original source voxel intensities, and which interpolation/tie kernel it uses.
- How native sampling resolution changes editing coverage, or which safety/work budgets it applies.

Therefore the new arbitrary-MPR paint/erase/local-threshold implementation must be labeled an independent source-grid editing policy. A documented source-cell slab/swept-brush rule and thresholding original source values can make the application behavior consistent and testable; they do not establish native kernel parity. Unsupported contour/multiple-slice tools must not silently fall through to a different slice or imply coverage merely because their toolbar names exist.

## Independent controller checks

The owned `tests/mimics-mpr-brush-workflow.test.ts` uses the real workbench and Worker exchange, synthetic source data and independent geometric expectations. The controller API is `e.mpr.beginBrush/brushStroke/endBrush/cancelBrushGesture`, with mandatory positive safe-integer `strokeId`, active Mask ID, physical plane, source Volume identity, document revision and MPR pose revision; Stroke additionally carries an on-plane world position. Gesture cancellation compares all frozen fields against the owned stroke and ignores foreign/incomplete events. `e.mpr.cancelBrush()` remains an explicit application-wide/manual cancellation route. The source Mask remains live and unchanged until a successful End commits a detached preview.

The eight cases cover:

1. Paint and erase against a hand-authored plane `z=x/2+0.13` on an identity source grid. Under the chosen source-cell slab, source-center membership simplifies to `2z-x` in `{-1,0,1}`. This independent integer condition determines the expected edited indices without calling the production brush helper. Samples modify only the private preview; one release creates one project/Mask revision and exactly one Undo/Redo transaction.
2. Local threshold reads original source intensity 211 at a touched source center even though its projected displayed gray value differs. The expected source-mask result is unchanged across Linear and Nearest display and two different output sampling grids. Global threshold controls and stored Mask threshold metadata remain unchanged. Real-worker ZIP export preserves the result and the independent overlapping mask.
3. Missing, undefined, null, stale or foreign context rejects at Begin, Stroke and End; invalid continuation cancels the entire prior preview. Other-Mask and Part IDs, foreign Volume identity, shifted/currently different planes and output sizes, off-plane positions, NaN and incomplete points cannot edit the source.
4. Explicit Cancel, a same-coordinate pose cycle, switching active Masks away and back, changing brush size and back, and closing MPR discard the prior preview without partial source writes or history.
5. Selected local-range changes cancel the stroke; inactive range edits and unrelated global threshold controls preserve its frozen source-value behavior.
6. An intentional `ProjectHistory.push` allocation failure reaches one genuine commit boundary, clears private preview, and preserves state identity, clean state, source, and a real redo branch. Retrying with the failure removed commits once.
7. A 64-cubed source with a broad oblique brush repeatedly scans overlapping but distinct segments. The whole-stroke 8-million visit budget is exceeded after a valid changed preview; all preview work is discarded and no partial Mask/history mutation is published.
8. Cancel and restart with exactly the same plane, volume, document revision, pose and Mask must distinguish the new stroke from the old one. Old Begin/Stroke/End/CancelGesture payloads reject without changing the new preview's identity, bytes or preview revision, or any state/history/source data; the fresh End still commits. Accepted-stroke high-water IDs reject replayed Begin events, while a valid foreign stroke's continuation/release must be ignored rather than canceling the new preview. Missing/corrupt current-event Stroke/End context still cancels the current stroke. Gesture Cancel instead requires an exact complete match to all owned frozen fields: null/undefined, each missing/undefined field, invalid IDs and wrong mask/volume/revision/pose/plane ignore without touching preview. A complete current CancelGesture clears its own draft without history or writes.

Every accepted path retains the raw intensity buffer/header/affine, the independent overlapping Mask, Parts, historical attached measurement, saved RP frames, source-IJK point and white crosshair. Native sampling, visual picking and the unsupported MPR contour/multiple-slice tools remain excluded.

## Findings and verification

The first complete seven-case run passed after correcting a test-harness call to the existing `setBrushSize(width,height)` signature. Final read then identified a genuine missing-release-context gap: the controller reused `current(change?)`, whose omitted argument is valid for its internal watcher. `endBrush(undefined)` and `endBrush(null)` consequently could commit an existing changed preview. Extending the existing strict-context case to missing/null/undefined release payloads reproduced `true !== false`. The controller owner corrected End to require a payload before using that shared current-state check.

The initial seven-case command passed 7/7 after that correction. A later root review identified a separate stroke-identity ABA hole: cancellation does not change the document/pose epoch, so an old End event could commit a newly begun stroke with the same otherwise valid context. The root owner added required monotonic `strokeId` and accepted-stroke high-water replay rejection. The independent eighth case verifies both rejection and preservation of the replacement preview. The strict matrix additionally exposed that a truthy negative/fractional/non-finite/string ID was being treated as a foreign valid stroke. The owner corrected the foreign-event guard to require a positive safe-integer ID, so malformed IDs follow the invalid-current-event cancellation path.

The root owner subsequently identified a late no-argument Cancel event as another way to clear a replacement stroke. Gesture cancellation is now separated from manual cancellation through `cancelBrushGesture(frozenEpoch)`, and the existing eighth case covers stale, malformed and matching events. Independent read confirmed that the gesture route compares the positive safe-integer stroke ID, Mask ID, Volume identity, document revision, pose revision and validated frozen plane against its owned stroke before clearing anything. It intentionally does not require that the global document context still match the frozen values. The Workbench binds viewport cancellation to this qualified route, while no-argument `cancelBrush()` remains available for intentional application cancellation.

Final independent command after qualified cancellation landed: `node --experimental-strip-types --test tests/mimics-mpr-brush-workflow.test.ts`. Result: **8/8 pass**, no skipped/cancelled tests, approximately 601 ms. The old CancelGesture and all missing/foreign-field cancel events retain the new preview's exact identity, bytes and revision; complete matching cancellation clears its own preview without a transaction. Root coordinates the final combined regression/build. This audit changes no production source, tool inventory, requirements or completion/acceptance gate.
