# Independent physical MPR brush candidate policy

Evidence boundaries: local `Mimics Reference Guide/Edit Masks.txt` establishes active-mask editing, rectangle/circle (ellipse) cursor shapes and independently adjustable width/height. Online reslice help establishes independent plane reslicing. These sources do not recover an arbitrary-RP edit kernel, source-voxel slab policy, or exact native edge ties. `mprBrush.ts` implements an explicitly independent physical reconstruction policy; it does not replace the original IJK brush kernel or write through resampled output pixels.

## Contract

`sweepMprBrush(grid, plane, stroke, options?)` accepts `MprBrushStroke = {from, to, widthMm, heightMm, shape: 'circle'|'square'}` with finite world endpoints and positive finite physical dimensions. `MprBrushOptions` supports `maxScanVisits`, `maxCandidates` and cooperative `cancelled()`. It returns `{indices: Uint32Array, candidateCount, scanVisits}`. Source indices are unique and ascending within each segment. Whole-stroke deduplication, totals and rollback remain controller responsibilities.

The helper reads source geometry and data length, never gray values or Mask memberships. It mutates no input. Every successful segment returns a complete owned index set. Invalid geometry, budget excess, allocation failure and cancellation throw without returning a partial set; cancellation uses `AbortError`.

## Physical membership

Source voxel centers are projected into the saved MPR plane's normalized stored `u`/`v` frame, in millimetres. The inverse Gram cross-term is retained for accepted rounded near-orthogonal frames. Finite normal offsets of stroke endpoints are ignored by projection; nonfinite endpoints reject. The normal slab remains frozen to the saved plane.

For plane unit normal `n` and all three complete voxel-to-world affine columns `c_i`, the source-cell half-thickness is `h = sum(abs(dot(n, c_i))) / 2`. A source center is included in the closed slab when `abs(dot(n, center - plane.origin)) <= h`, subject to small floating rounding tolerance. This accounts for anisotropy, rotation, reflection and shear; `grid.spacing` is not substituted for affine column geometry. Tangential source-cell contacts are included. A plane at an exact half-layer boundary may therefore touch two source layers. A plane through a normal IJK voxel-center slice reduces to exactly that single original slice.

For `circle`, width/height define an ellipse. Anisotropic normalization turns its continuous segment sweep into a capsule, with nearest distance to the complete normalized segment at most one. For `square`, the footprint is the union of continuously translated width-by-height rectangles, tested by overlapping segment-parameter intervals. Neither policy samples disconnected pointer dabs. Endpoints and footprint edges are included. Candidates are clipped to the MPR's complete half-pixel-support FOV, including nonzero physical support for a one-pixel dimension.

## Bounding and budgets

The clipped in-plane sweep rectangle and closed normal slab form a conservative physical prism. Its eight corners are transformed using the complete affine inverse, then clipped to source integer bounds. Only that source-index box is scanned. Thus a small edit does not scan or allocate for the entire source volume. `scanVisits` counts all box visits, while `candidateCount` counts actual geometric membership.

Default segment limits are 1,000,000 scan visits and 1,000,000 candidate indices. Configurable hard ceilings are 8,000,000 visits and 4,000,000 candidate indices. The conservative box can exceed the scan budget even when the exact footprint would be smaller; this rejects before scanning or allocating candidates. Candidate overflow rejects during the private scan. Typed buffers are capped at 16 MB each, with at most another 16 MB for a compact final copy. No volume-sized bitmap is allocated here. A controller can impose a tighter whole-stroke budget and roll back its draft if any segment fails.

## Verification

`node --experimental-strip-types --test tests/mimics-mpr-brush.test.ts` passes 16 analytic fixtures: anisotropic single-IJK-slice reduction, long unequal-axis ellipse and rectangle sweeps, diagonal shape differences, closed half-layer ties, tilted three-diagonal membership, reflected/sheared affine footprints, oblique full-affine-column thickness, half-pixel FOV clipping, finite off-plane projection, budget/cancellation atomicity, input/result ownership, invalid/nonrepresentable geometry and a 35-visit box inside a 1,048,576-voxel volume. Expected memberships are explicit independently derived source-index sets, not calls to a second copy of the kernel.
