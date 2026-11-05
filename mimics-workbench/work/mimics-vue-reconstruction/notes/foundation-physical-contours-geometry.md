# Affine planes and independent physical contour layers

This phase adds only `affinePlane.ts`, `physicalContours.ts` and their owned tests. Shared types/schema, project migration, worker dispatch and UI are integrated by their owners. Original Mimics arbitrary-grid contour migration/filling and sheared-density interaction rules remain unknown; these modules implement an explicit application geometry policy.

## Stored affine geometry

`AffinePlane` is imported from the shared types module. It stores `{origin,u,v,size}` exactly, with world-mm sample origin/full sample steps and integer parametric sizes. `validateAffinePlane` permits nonorthogonal independent axes, including reflection/shear, and returns a deep clone. Data-only plain objects and dense plain arrays are mandatory: accessors, sparse fields, extras, nonfinite values, zero/tiny steps, unstable Gram frames and excessive dimensions reject. Independent bounds are32767 per dimension and134,217,728 samples; normalized `sin(angle)^2` must exceed1e-12. Full-support corners must remain finite.

Pixel/world inversion uses normalized Gram coordinates rather than incorrectly projecting onto nominal spacing. The normal follows `u×v`, so its signed distance retains reflected orientation. `transformAffinePlane(plane,T)` accepts only a finite proper rigid3×4/4×4 transform; source frames themselves may be reflected, but the coordinate-change matrix cannot introduce reflection, scale or shear. Origin receives point translation, steps receive rotation only, and identity returns an exact numeric clone.

`affinePlaneViewingPlane` derives an orthogonal frame by Gram-Schmidt-equivalent unit axes, centers it on the original sample-center midpoint, and fits all four original **half-pixel-support** corners. It does not modify the saved geometry or parametric rings. When a stored frame exceeds the shared MPR display limits, only the derived viewing sample counts are reduced while preserving the full fitted physical support. `coplanarAffinePlanes` checks normals up to sign and physical plane distance; it is for display visibility. `sameAffinePlane` instead compares sizes exactly and origin/step components within an explicit absolute tolerance, for retained-frame identity checks.

## Physical contour schema and conversion

`PhysicalContourSet` has provenance `independent-world-plane-contours` and a `layers` array. Each layer stores `{plane:AffinePlane,rings:ContourRing[],componentCount,sourceRevision?}`; it has no extra layer provenance field. Existing ring parameters, signs, physical area/perimeter, parent and component indices retain their meanings. `sourceRevision` is a nonnegative safe integer when supplied. Its relationship to the current live Mask revision belongs to project schema validation, not this geometry module.

`isPhysicalContourSet` is a provenance descriptor discriminator, not full validation; it does not invoke a provenance getter. `validatePhysicalContourSet` returns an independently owned clone after dense/data-only validation, whole-set limits, full stored FOV bounds, recomputed affine metrics, ring orientation, parent cycles/depth/hole consistency, foreground component consistency and minimal actual containing-parent checks. Child vertices/edges must remain within the parent, including a concave parent; a probe inside the parent alone is insufficient. Boundary contacts are allowed. Exact duplicate stored planes reject. Parent and containment work is edge-budgeted.

`convertNativeContours(grid,set,sourceRevision?)` retains each raw native layer's exact two affine columns and physical origin. It does not orthogonalize a sheared source plane or substitute nominal spacings. `transformPhysicalContours(set,T)` applies the rigid matrix to each stored plane while preserving every ring parameter and metric in fresh arrays. Native input shape/provenance/layer directions and dimensions validate before conversion.

## Fill and layer-update policy

`physicalContoursToMask(grid,set,options?)` returns a new `{mask,count}`. Each ring's world polygon is rasterized through the existing `rasterizeMprContour`, using a derived viewing rectangle that encloses the saved full FOV. Thus it retains the existing complete-affine source-cell closed slab and source-grid center membership, including two touched target layers at an exact half-layer plane. It is not nearest writing of display pixels.

Within one layer, rings process by containing depth. Foreground outer/island boundaries are included, hole boundaries are excluded. A private sparse page-bitset combines that layer; only after its holes/islands are resolved is its foreground unioned into the output. A hole on a later layer cannot erase a voxel supplied by another plane. No complete-volume scan is repeated per ring or layer, and the final count increments only on newly set output members.

`updatePhysicalContourLayer(grid,sourceMask,set,index,options?)` interprets `index` as the stored layer array index. It samples source membership at that layer's original affine parametric integer centers, using complete affine inversion, closed half-cell support and the existing narrow half-integer nearest tie rule. A local two-dimensional Mask is traced with `extractSliceContours` using the exact stored `u/v` as its physical metric basis. The saved plane is retained exactly; only the selected layer's rings, component count and optional `sourceRevision=options.sourceRevision` change. Other layers are value-preserved in independent clones. Source gray values are never read, including NaN raw images.

## Budgets and atomic behavior

Options extend `AlgorithmControl` with cumulative `maxScanVisits`, `maxEdgeVisits` and `maxBytes`. Defaults are8M scan visits,32M edge visits and256MiB; hard ceilings are64M,256M and512MiB. Limits count validation/parent work, ring raster work, sparse page processing and update sampling/boundary work cumulatively. Metadata is conservatively charged per layer/ring/point; output storage, sparse pages and raster scratch are preflighted. Update additionally caps a local extraction at4,194,304 samples and accounts for local arrays plus a conservative256-byte boundary-edge estimate before extraction. Set limits are32767 layers,65536 rings and1,048,576 points. These are application safety limits, not native defaults or an exact JavaScript heap-size guarantee.

Fill/update never mutate raw data, source Masks or input contours. Validation, scan/edge/memory excess, callbacks, cancellation and allocation failures return no partial result; cancellation uses `AbortError`. Heavy work is intended for the worker. Sparse pages and local bounding boxes avoid unbudgeted volume×ring×layer loops.

## Verification

Owned tests: `tests/mimics-affine-plane.test.ts` (6) and `tests/mimics-physical-contours.test.ts` (11), **17/17 pass**. One test independently exercises every one of the512 binary3×3 cell-boundary patterns. Further fixtures cover full sheared/reflected affine identity round trips on all three native axes, holes/nested islands, rigid transformed planes with exact ring retention, cross-layer hole conflicts, half-layer ties, sheared metric-preserving single-layer updates/revisions, full-support view fitting, strict accessors/sparse arrays/Gram/topology/metrics, concave-parent escape, cumulative budgets, cancellation, NaN raw data and synthetic allocation failure.

Strict TypeScript checking of the two owned modules and imports passes. At the recorded integration check, repository-wide `vue-tsc` was awaiting root's `useAdvancedTools` native/physical union narrowing (six errors there, none in these owned modules); this is not reported as a passing global build. No new target execution, browser action or native-equivalence claim is made.
