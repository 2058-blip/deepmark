# Independent physical MPR contour writeback geometry

`src/mimics/mprContour.ts` adds pure candidate generation for world-space Lasso/LiveWire contours. It does not read gray values, modify a Mask, or replace an original IJK contour kernel. The native arbitrary-RP source-Mask writeback kernel, slab and tie rules remain unknown; the following is an independent, testable application policy. It reuses `sweepMprBrush` for its already defined source-cell support, affine inverse, source clipping and FOV boundaries, without changing that module.

## Frozen API

```ts
interface MprContourOptions extends AlgorithmControl {
  maxScanVisits?: number;
  maxCandidates?: number;
  maxEdgeVisits?: number;
}
rasterizeMprContour(grid, plane, worldPoints, options?)
// -> {indices: Uint32Array, candidateCount, scanVisits, edgeVisits}
```

The returned source indices are unique, ascending and independently owned. `candidateCount` is the exact polygon membership count. `scanVisits` counts source-index visits in the conservative affine-inverse bounding box. `edgeVisits` counts input-point projection/deduplication visits, non-collinearity checks and actual candidate-to-polygon-edge tests. It is a bounded complexity counter, not an elapsed-time estimate.

Finite world contour points are projected into the frozen MPR plane's physical `u`/`v` coordinates. Normal offsets are ignored geometrically; the controller can enforce that gesture points themselves lie on its captured plane. Accepted rounded near-orthogonal MPR axes retain their Gram cross-term. The contour closes implicitly. Consecutive duplicate projected points and one repeated closing point are removed; nonconsecutive repeated vertices remain because they can change even-odd multiple-loop semantics. At least three distinct projected vertices and a non-collinear triple are required. Predicates normalize by contour extent to avoid overflowing orientation products and reject numerically collinear frames. A zero signed shoelace area is not used as a rejection rule: a self-intersecting bow tie remains valid.

Polygon membership uses even-odd ray crossings, with polygon edges and vertices included. The half-open Y crossing convention counts a shared vertex once. Boundary predicates use a small scale-relative floating-point tolerance. Clockwise and counterclockwise paths give the same fill; retracing a complete loop twice cancels the interior under even-odd while retaining its boundary.

## Source-grid support and bounds

Source voxel centers are projected into the physical polygon. They must also lie inside the closed source-cell normal slab and full half-pixel MPR FOV. For unit plane normal `n` and the three complete source affine columns `c_i`, the slab half-width is `sum(abs(dot(n,c_i))) / 2`. Thus reflection, shear and anisotropy retain the same support as physical MPR brush editing. Tangential cell contacts are included: an exact half-layer plane can touch two layers, while a normal IJK voxel-center plane reduces to its single original source slice. Membership is determined on source-grid centers, not by nearest-neighbor writing of resampled output pixels.

A minimally padded physical contour rectangle feeds the existing brush helper as one square dab. That helper clips to full FOV, maps the eight corners of the physical slab prism through the complete affine inverse, clips to source dimensions and scans only that local box. Polygon predicates filter this private rectangle superset in place. No full-volume bitmap or raw-intensity pass is needed.

## Budgets and failure behavior

- Default scan and final candidate limits are each 1,000,000; hard ceilings are 8,000,000 scans and 4,000,000 final candidates.
- Default edge budget is 8,000,000; its hard ceiling is 64,000,000.
- Input contours have a hard ceiling of 65,536 points before geometric allocation.
- The private bounding-rectangle superset also has the existing brush helper's 4,000,000-index hard ceiling. A small final polygon can be rejected if its conservative box or rectangle superset is too large.
- Before polygon filtering, `supersetCount * edgeCount + preprocessingVisits` must fit the edge budget. This is deliberately conservative: a contour whose boundary would short-circuit many tests can still be rejected by this upper-bound check. Actual returned `edgeVisits` can be smaller.
- `maxCandidates` applies to exact polygon membership, independently of the private rectangle count. A concave 16-voxel contour inside a 25-voxel rectangle succeeds with `maxCandidates:16`.

All successful calls return the whole set. Scan/candidate/edge excess, invalid finite geometry, source validation errors, allocation failure, thrown callbacks or cooperative cancellation return no partial set and leave input arrays unchanged. Cancellation uses `AbortError` and is checked during preprocessing, brush scanning, point-edge filtering and after progress callbacks, including final progress. Candidate typed arrays retain the existing 16 MB per-buffer ceiling; there is no source-volume-sized allocation. The intended caller runs this synchronous helper in `operations.worker` and owns the atomic source-Mask transaction and gesture context.

## Verification

`node --experimental-strip-types --test tests/mimics-mpr-contour.test.ts` passes 21 owned cases after the physical-migration phase's bounded boundary-rounding regression. Expected sets use explicit, independently derived source coordinates: anisotropic source-center slices; triangle boundary/vertex ties; a concave L; a zero-signed-area bow tie; duplicate points; a twice-traversed loop; two-layer tangencies; tilted three-diagonal source-cell membership; rotated/reflected plane frames; sheared reflected source affine; an oblique affine-column slab; one-pixel full FOV; off-plane projection; a 15-visit local box inside a 1,048,576-voxel source; exact/failing scan, candidate and edge budgets; progress/cancellation; intermediate and final allocation failures; NaN raw data not read; malformed/collinear/nonfinite inputs; numeric overflow; and exclusion of a point 1e-11 beyond a sloped boundary. No original target or patient data is executed or used. Boundary predicates now have a 32-EPSILON normalized unit-scale floor to absorb rigid-rotation rounding; non-collinearity validation retains its relative criterion. See `foundation-physical-migration-workflow-audit.md` for the three real outer/hole/island boundary counterexamples and fix.

## Independent root integration audit

A read-only review of `useMprContour.ts`, its actual workbench context and the two worker branches found no reproducible integration defect in commit ownership, old-result rejection, unrelated global work ownership, original-gray thresholding, independent Mask preservation or disconnected LiveWire closure. The root's 11 actual-worker workflow tests already exercise strict epochs, ABA cancellation/restart, delayed trees/rasters, invalid geometry, changes to relevant configuration, unreachable anchors, single commit/Undo/Redo, saved source data and history allocation failure.

`tests/mimics-mpr-contour-root-audit.test.ts` adds only two previously uncovered high-risk cases using actual workers and explicit source-index expectations:

1. Replace the active source buffer identity while a contour raster is pending without incrementing document revision. The contour alone cancels. Start an unrelated global threshold preview, then deliver the old contour result and old/manual contour cancellation. The new job retains busy ownership and completes its preview; source Mask, original gray and the independent overlapping Mask stay unchanged.
2. After submitting a Lasso raster, mutate the caller's points/epoch-plane and the published draft's nested points/anchors/plane. The committed polygon remains the captured private geometry. Mutating published LiveWire anchors/path similarly cannot alter later private anchors or the eventual source-Mask fill.

The recorded four-file command covering this audit, the root's workflow suite, contour geometry and MPR LiveWire passed **48/48** before the later additional boundary-rounding case, with no skipped/cancelled tests. Shared production files and the root's test were not modified during that audit. A generic `beforeBegin` callback could theoretically change settings between the composable's initial capture and session publication; the current workbench callback changes no contour settings, so this was not reported as an actual workflow defect. Original-program equivalence remains untested and is not inferred from these application integration checks.
