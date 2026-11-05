# MPR project persistence and Properties contracts

Scope: independently implemented project/schema/history and measurement Properties contracts. No browser or native-program inspection, real patient files, resampling-kernel certification, or new dependency was used for this work.

## Stored data

- `types.ts` exports `MprPlane`: `origin`, `u`, `v` are ordinary finite world-mm triples; `u` and `v` are complete one-output-pixel steps, not unit direction vectors; `size` is the output `[width,height]`.
- `MeasurementObject.mprPlane` is optional and mutually exclusive with native `plane`. Persistence validates the frame through `validateMprPlane` from `mpr.ts`; measurement point coplanarity remains a controller policy. Existing kind/attachment/path rules remain intact.
- Optional `ProjectViewState.mpr` stores `{enabled,plane,step,interpolation,crosshair?}`. `step` is positive finite world mm, interpolation is `nearest` or `linear`, and the optional world-mm crosshair is a strict ordinary finite triple. It is neither clipped to the image nor rounded to IJK.
- `ProjectViewState.point` retains the old bounded integral native-IJK contract. Missing MPR fields stay missing on legacy-project load; no implicit defaults are inserted. Version 1, native volume header/affine/units/byte order, masks, and meshes are unchanged.

The shared frame validator rejects nonordinary objects/arrays, accessors, extra fields, sparse/typed vectors, nonfinite values, zero/tiny or nonorthogonal bases, invalid output dimensions, over-budget outputs, and overflowing support corners. View and measurement validation run in in-memory validation, encode, ZIP restore, and history schema checks. Invalid history pushes finish validation before changing either stack or clearing Redo.

## Snapshot and edit isolation

History and restore deeply copy all four MPR arrays and the precise crosshair. Explicit view cloning also accepts Vue-backed plain view state, avoiding `structuredClone` on reactive controls. Existing immutable voxel/mesh buffer sharing and history memory accounting remain in place.

Properties drafts deeply clone and freeze MPR geometry; `mprPlane` itself is nonwritable. Form patches remain limited to name, text, color, visible, and annotation style. Existing Apply uses the current live measurement, so newer points/plane/reference/label geometry survive metadata edits. Duplicate owns independent MPR arrays. Deferred creation, cancel, busy state, volume replacement, deletion, and explicit same-volume document cancellation retain the existing transaction lifecycle.

## Verification

`tests/mimics-mpr-project.test.ts`: 10/10 pass. Covers repeated ZIP roundtrip, all m/mm/micron and little/big-endian variants, precise outside-FOV crosshair, unchanged native header/affine/data, legacy omission, mixed-plane rejection, strict malformed frames/view state, atomic history/Redo, every plane-array clone, Vue-backed view state, deeply readonly Properties, live-frame preservation, duplicate, and cancellation/commit lifecycle.

Existing owned regression suites: 50/50 pass across `mimics-project`, `mimics-measurement-properties`, `mimics-measurement-attachments`, `mimics-measurement-label-offset`, and `mimics-part-provenance`.

Commands run:

```text
node --experimental-strip-types --test tests/mimics-mpr-project.test.ts
node --experimental-strip-types --test tests/mimics-project.test.ts tests/mimics-measurement-properties.test.ts tests/mimics-measurement-attachments.test.ts tests/mimics-measurement-label-offset.test.ts tests/mimics-part-provenance.test.ts
npx vue-tsc --noEmit
```

Typecheck passes with concurrent MPR helper/controller/viewport work present. The root agent coordinates full-suite, build, and UI verification; these checks certify data/schema/edit contracts only.
