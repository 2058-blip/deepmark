# Stored affine density and world-plane Polyline schema

Scope: the assigned `types.ts`, `project.ts`, `useMeasurementProperties.ts`, `resliceProjectData.ts`, new schema tests, and the two revised expectations in the owned reslice-data tests. Geometry kernels are owned by the geometry agent; evaluation, controller, Advanced tools and viewports are coordinated separately. No original Mimics process, browser or patient data was used. This is an independent retention policy; the earlier local-help gap about native Reslice Project object inheritance remains.

## Data contract

`types.ts` adds `AffinePlane {origin,u,v,size}`. It stores the exact world-mm sample basis and can retain linearly independent nonorthogonal steps. The geometry agent's strict `validateAffinePlane` clones that shape without orthogonalization; it is distinct from the orthogonal sampled `MprPlane` used for viewing.

`MeasurementObject.densityPlane?:AffinePlane` is allowed only for `density-rectangle` and `density-ellipse`, and is mutually exclusive with native `plane` and orthogonal `mprPlane`. Its two world corners must be finite, dense ordinary arrays on the saved plane, with nonzero parameter width/height beyond floating roundoff. Neither stored plane size nor corner extents are tied to the new source-grid dimensions. In particular, a historical ROI may extend past the saved sample FOV; evaluation can separately clip the actual sampling region without rewriting its geometric area.

`PolylineObject.set` now discriminates between legacy `ContourSet` and `PhysicalContourSet`:

```text
PhysicalContourSet = {
  provenance: 'independent-world-plane-contours',
  layers: [{plane: AffinePlane, rings: ContourRing[], componentCount, sourceRevision?}]
}
```

There is no per-layer provenance field in the physical shape. Ring vertices remain exact two-dimensional parameters in their saved layer basis; holes, parents, components and signed/physical metrics remain part of the strict contract. Physical layer geometry is independent of the current source-grid dimensions. The geometry validator checks plain dense data, finite geometry, basis stability, metrics/topology and resource bounds; project validation additionally rejects a layer source revision later than a known referenced live Mask.

Legacy native v1 layer `SlicePlane`, axis, dimensions and provenance validation remain intact. A new physical set is not accepted by simply loosening the old native fields or changing old-grid dimensions.

## I/O, history and Properties

Both new shapes participate in strict save and restore whitelists, in-memory validation and history snapshots. Physical sets are validated and cloned on restore. Density plane origin/steps/sample sizes are independently cloned during restore and history. Unknown fields, wrong measurement kind, competing plane fields, accessors, sparse/nonfinite arrays, collapsed bases and degenerate/off-plane density corners reject. Source-version checks apply before history stack mutation, not only while restoring ZIP data.

Measurement Properties clones the new basis, freezes its arrays and object, and makes the `densityPlane` property read-only in the draft. Metadata Apply cannot patch it. Apply still merges editable metadata onto the newest live geometry; Duplicate deep-copies the basis and corners rather than sharing them with the source measurement. Cancel remains deferred and history-free.

## Reslice Project migration

World-object copy no longer rejects native Polylines or sheared native density ROI:

- An IJK density ROI uses the **raw** two affine source columns and source slice origin/size as `densityPlane`; no Gram-Schmidt step changes its rectangle/parallelogram or ellipse shape. Corner points receive the same rigid coordinate change as its origin; steps receive only rotation. A previously stored `densityPlane` undergoes that same transform on repeated reslices.
- Ordinary non-density native measurements retain the existing physical orthogonal MPR conversion, because their explicit world points determine their geometry.
- A legacy native Polyline converts through `convertNativeContours(oldGrid,set,sourceRevision)` and then `transformPhysicalContours(T)`. Existing physical sets transform directly. Parameter rings are cloned unchanged; they are not regenerated from a new voxel mask or projected onto new-grid slice indices.
- Overall Polyline and per-layer source revisions remain historical while the resampled Mask advances once, so retained geometry remains stale. Repeat conversion preserves earlier per-layer provenance and never stamps it fresh.
- Explicit image-and-all-Masks mode still excludes all physical groups with counts and clears selected references. Its behavior is an explicit user choice, not silent loss during conversion.

Live object preflight remains metadata-only. It checks plane metadata and source-revision relations without reading image/Mask cells. Full source/output validation still occurs at actual build boundaries.

## Independent verification

`tests/mimics-physical-project-schema.test.ts`: **11/11 pass**. A reflected, fully sheared source uses affine `[[-2,.75,.25,10],[0,3,.5,-20],[.4,.2,4,30]]`. A 9×9×3 mask has an outer 7×7 ring, a 5×5 hole and a nested 3×3 island, producing parameter signed areas 49, -25 and 9 with two foreground components. Tests compare transformed world vertices against independently stated affine/rigid equations while preserving the exact source ring arrays and physical metrics.

The suite includes native v1 ZIP compatibility; sheared rectangle/ellipse and out-of-new-grid extents; hole/island retention; two successive CS migrations and repeat ZIP restore; nested isolation in ZIP/history; wrong kinds/contexts/bases/corners; malformed fields/getters/sparse arrays; layer source-version rejection; read-only Properties, metadata merge and Duplicate; no voxel reads during preflight; and explicit physical-object opt-out. The initial negative matrix exposed a layer future-revision rejection present on full restore but missing on history entry; the schema-level check now makes both paths reject consistently.

The new suite plus existing owned Reslice Data, Properties and Project suites pass **56/56**, no skipped/cancelled tests. The owned data suite's previous reject expectations were updated to assert the newly requested exact migration; its other 14 cases remain intact. At the last global typecheck, the only outstanding errors were the coordinator-owned `useAdvancedTools.ts` union narrowing, still being integrated; no owned schema/data type errors were reported. Root coordinates final integrated checks.

## Read-only NIfTI coordinate-code finding

The official NIfTI [qform/sform documentation](https://nifti.nimh.nih.gov/nifti-1/documentation/nifti1fields/nifti1fields_pages/qsform.html/document_view.html) was checked directly. It defines code 1 as scanner-based anatomical coordinates, code 2 as coordinates aligned to another file/anatomical reference, and code 0 as arbitrary coordinates. It also describes the subject-based RAS meaning of nonzero qform/sform world axes. Thus a fixed scanner-anatomical code for an explicitly arbitrary image-local CS overstates that coordinate provenance; merely changing 1 to 2 does not itself restore a subject-RAS interpretation.

The recommendation sent to the coordinator is to choose an explicit export policy separately: retain a scanner/world affine for interoperable NIfTI and keep local-object coordinates as application metadata, or deliberately mark a local-only arbitrary frame with appropriately unknown coordinate semantics while preserving its numeric mapping. No header code was changed in this schema task, and the existing downloaded files are not reinterpreted as native scanner-anatomical evidence.
