# Physical Polyline and affine density: independent actual-worker audit

This audit owns `tests/mimics-physical-migration-workflow.test.ts` and this note. It also updates the previously owned Reslice Project workflow's old Polyline-refusal expectation to the now-supported physical migration behavior. Root explicitly authorized the small normalized-boundary correction in the previously owned `mprContour.ts`, with one bounded negative regression added to its test. No other root/shared source, other agent's tests, original program, patient data or browser state was modified.

## Independent fixture and expected values

The source is a9×9×3 Float32 NIfTI with reflected/sheared affine:

```
X = 10 - 2i + j + .25k
Y = -20 + 3j + .5k
Z = 30 + 4k
I_world = 2X - Y + .5Z + 7 = 62 - 4i - j + 2k
```

The native k=1 Mask has a7×7 outer region, a5×5 hole and a3×3 nested island:49−25+9=33 source members. A second independent overlapping Mask, a historical Part, legacy native-IJK Polylines and native-IJK rectangle/ellipse density ROIs complete the source project. The native ROI covers i/j2..4 at k1. Its rectangle has9 sampled points, mean49, sampled area54mm² and geometric area24mm²; the ellipse has5 points, mean49, sampled area30mm² and geometric area6πmm². The raw affine area per parametric sample is6mm², not the product of nominal axis lengths.

Actual Reslice Project generation uses a32×32×9 world-covering grid,90° rotation and Update CS On. The expected coordinate change is hand-derived:

```
T(X,Y,Z) = (Y+23, 19.5-X, Z-30)
```

For the new-grid physical fill, the expected old parameters are independently computed as `j=(xout−3.5)/3`, `i=(yout+j−9.25)/2` at output layer4. The footprint is the closed outer[.5,7.5]², minus the closed hole[1.5,6.5]², plus the closed island[2.5,5.5]². The oracle does not call production affine inversion, resampling or polygon filling. Production contour extraction is used only to construct the input fixture from the hand-authored Mask, not to compute expected output membership.

## Ten actual-controller/Worker cases

1. Actual CS-on generation converts native Polylines into stored physical planes while retaining every ring parameter/metric, holes, island, per-layer historical revision and source object provenance. Density rectangles/ellipses keep transformed raw shear basis and world geometry. Source raw/header/affine/Masks/objects/history/revision/dirty state remain unchanged.
2. Actual generated-project Worker ZIP contains migrated Polyline and density metadata, the generated new volume and fixed transform TXT. Standard decode retains them. Opening the result and evaluating controller density statistics recovers the independent9/5-point means and full shear areas.
3. Physical fill on the original grid produces the exact hand-authored33-cell source shape as one new independent Mask/Undo transaction. The source Mask and raw image stay unchanged.
4. Physical fill on the new grid matches every voxel of the hand-derived old-parameter oracle. It does not merely reuse the newly nearest-resampled Mask as an oracle. Three exact outer/hole/island boundary examples are asserted separately.
5. Updating just one stored physical layer preserves the other layers and the exact saved basis. Mixed layer revisions leave the whole object stale; only after every layer reaches the current source Mask revision does its object-level revision advance. Historical Part provenance is not refreshed implicitly. Undo/Redo restores the full layer transaction.
6. Physical overlays emit exact world vertices, including full shear and closed ring paths. Locate opens an orthogonal fitted MPR view without altering saved contour/density frames or project history.
7. Rectangle and ellipse statistics use the full affine metric. Raw-source slice flips and MPR normal scrolling shift derived displayed density geometry/value while stored corners and density plane remain unchanged.
8. Batch density edits retain the stored affine frame, use plane/MPR fields only as view context, and create one Undo. Moving a single corner also creates one transaction and preserves source data and Masks.
9. Forged stored bases, copied orthogonal viewing frames, omitted stored density geometry, stale MPR poses, foreign Volume identity and off-plane corners cannot write ROI geometry or consume history.
10. Held actual physical-fill/update results cannot create a Mask or update stale objects after cancellation, deletion/source changes, or cancellation/restart. Old results/finally do not clear the replacement worker's busy ownership.

## Boundary issue found and authorized correction

The strengthened new-grid oracle initially found31 boundary mismatches after actual90° CS migration. `cos(90°)` is approximately6e−17, so mathematically horizontal/vertical transformed edges carry tiny numerical residue. The old normalized edge-collinearity tolerance scaled only with product magnitudes, and coordinate closeness had no unit scale floor at zero. It therefore excluded some intended closed outer/island borders and retained some hole-border members.

Minimal cases in output coordinates:

- `[26,3,4]` maps to old `(i=.625,j=7.5)`: outer border must be foreground, previously0.
- `[23,6,4]` maps to `(i=1.625,j=6.5)`: hole border must be excluded, previously1.
- `[20,9,4]` maps to `(i=2.875,j=5.5)`: island border must be foreground, previously0.

With root authorization, boundary predicates now use a32×Number.EPSILON floor **after contour normalization**. Non-collinearity validation retains its prior relative criterion. This is not a fixed world-mm or voxel-width blur. A separate sloped-edge regression verifies that an exterior point1e−11 beyond the boundary still stays outside. All three explicit boundary cases and the whole target array now match the independent oracle.

## Verification and evidence boundaries

The combined new audit10, affine/physical geometry17 and MPR contour21 tests pass **48/48**. The existing Reslice Project workflow now expects successful native-Polyline physical migration plus explicit image/Mask-only opt-out, replacing its obsolete rejection expectation. The final targeted command for that workflow passes11/11. `npx vue-tsc --noEmit` also passes after the concurrent shared-source integration.

These checks use real workers and synthetic input, not browser pointer events or an actual filesystem receipt. They validate the explicit application policies, not original Mimics contour migration/filling, original sheared-density interaction, all object kinds or clinical equivalence. Cross-layer hole isolation, closed half-layer support, strict parent/metric validation, budgets and allocation cancellation also retain their separate owned geometry tests; no all-angle claim follows from one transformed-grid case.
