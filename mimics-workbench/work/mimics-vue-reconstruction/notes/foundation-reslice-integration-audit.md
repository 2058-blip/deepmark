# RP / MPR controller integration audit

Scope: independent read-only review of `useWorkbench` RP activation, interactive entry/transform, current-plane persistence, view-only scroll, and replay/install behaviour. Production controller/Workbench/helper files were not edited by this audit. Added `tests/mimics-reslice-integration-audit.test.ts` using the real workbench, worker export, synthetic source volume, source Mask/Part, and an existing historical MPR-attached measurement.

## Finding and correction

A completed new three-point definition reused the ordinary current-plane-save path. With an RP already selected, this updated that object's frame instead of adding another RP. The independent successive-definition case failed with one object where two were required, demonstrating that the previous RP was overwritten.

The controller owner corrected three-point completion to pass `forceNew=true` through its save path, including bypassing its existing-plane no-op shortcut. Ordinary Euler/pose adjustments retain their update-existing behaviour. Entering three-point definition exits blue interactive mode, avoiding overlapping creation and manipulation modes. The audit retains the new-object assertion, previous-object preservation, one transaction, source/history stability, and Undo/Redo selection checks.

## Independent counterexamples

Four tests extend the normal controller workflow coverage:

1. With an existing selected RP, another successful three-point definition creates a new selected RP while retaining the exact previous frame. One Undo removes only the new definition and restores old selection; Redo restores both definitions and the new selection.
2. Intentional `ProjectHistory.push` allocation failures occur at the actual commit boundary for Euler update, blue transform, and completed three-point creation. The tests require exactly one attempted commit and verify unchanged state identity, revision, dirty state, undo/redo names, independent browsed closed-view snapshot, source data/geometry, and historical measurements. Failed view-changing operations restore the previous view and invalidate the previous view epoch. A real Redo branch remains usable.
3. Failed first MPR open and interactive entry leave neither a phantom RP nor an altered view/selection. Source volume/header/affine, Masks, Part mesh, and existing measurement plane remain unchanged.
4. Selecting between two distinct RPs with identical frames and returning to the original RP does not change document revision or source-plane coordinates. The old blue payload must still reject because its pose epoch is stale; the same candidate with a fresh epoch succeeds once.

The review also confirmed that ordinary scroll only publishes MPR view state, RP activation watches selected identity/geometry, install suppresses activation while restoring its independent persisted browsed frame, and source-point changes invalidate blue pose epochs. Existing controller workflow tests cover source-slice navigation away and back, stopped interaction, active restoration through Undo/Redo, and real ZIP install preserving separate stored RP and browsed view frames.

## Verification

The controller owner ran the final four audit cases together with the five normal RP workflow cases: **9/9 pass** after the correction. This audit independently reran `npx vue-tsc --noEmit`: pass. The earlier 14-case RP schema/manager/Properties suite was left intact. No browser picking, visual rendering, original-program runtime, or patient-data claim is made.
