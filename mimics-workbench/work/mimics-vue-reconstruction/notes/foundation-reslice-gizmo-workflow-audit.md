# RP Modify controller audit

Scope: independent controller review and synthetic real-worker regression tests in `tests/mimics-reslice-gizmo-workflow-audit.test.ts`. Production controller, viewport, geometry helper, requirement inventory and completion gate are owned by the coordinating agents. This audit does not use a browser, native program, license, network, or patient data.

## Native reference boundary

`Along Plane2.txt` establishes independent blue Ctrl crosshair translation/rotation in the 2D views, RP creation/persistence in the Reslice Objects tab, and Properties Rotate/Resize controls with physical dimensions. `Reslice Objects.txt` establishes active-object selection and layout-dependent display. These references establish workflow requirements, not a recovered rendering algorithm or exact native 3D drag policy. Curved reslices and selecting pre-existing Medcad/Normal plane definitions remain distinct unimplemented scope; a plane-only Modify addition does not establish those capabilities.

## Confirmed uncovered case

The existing MPR controller transform type requires a volume identity, document revision and pose revision. Its runtime guard delegated volume/revision checks to the legacy permissive `validGesture`, where `undefined` means absent context. A blue drop with a current pose but an omitted volume was accepted and committed geometry. The independent complete-epoch test failed with `true !== false` at `missing volume`, using an actual selected RP, closed source layout, clean save and real redo branch. The controller owner corrected the strict guard; the independent regression now passes. Production is not modified by this audit.

The test requires every omitted or explicitly undefined epoch field to reject without changing state identity, dirty state, document revision, pose, undo/redo branch or saved browsed view. An otherwise identical fully specified event must succeed once and clear redo. Source volume/header/affine, Masks, Part, attached historical MPR measurement and a second RP remain unchanged.

## Review findings

Prior RP tests already establish source-scroll and selected-object ABA rejection, independent source/white/blue positioning, failed commit rollback, successive three-point RP creation, Properties physical FOV versus output sample counts, and ZIP storage of separate saved RP and browsed MPR frames. New tests should target the new Modify boundary instead of duplicating that entire suite.

Closing MPR retains RP selection; the prior selected-geometry activation callback called `setPlane`, which opens MPR. The controller owner selected an explicit layout-preserving policy for 3D Modify: begin, release and geometry replay retain the existing enabled/disabled setting, step, interpolation and white crosshair. The hidden viewed plane can synchronize to the edited RP. Ordinary explicit activation may still open the layout. No native parity is inferred from this application policy.

## New Modify counterexamples

Six audit cases now cover the original strict-blue guard and the agreed `beginPlaneModify(mode,id?)` / `modifyPlane({id,plane,action,volume,revision,resliceRevision})` controller route:

1. Complete mandatory blue document/pose epochs, including omission and explicit `undefined`, with a fully specified accepted control case.
2. Resize on a hand-built oblique RP with unequal output counts `[7,5]`: physical FOV changes from 14 by 15 mm to 28 by 7.5 mm while sample counts, signed directions and world center remain fixed. Disabled-layout Undo/Redo and real-worker ZIP retain independent white crosshair, step and nearest interpolation. ZIP install invalidates the old source identity.
3. Mandatory Modify identity/action/epochs; wrong object/Part IDs, foreign volume identity, stale revisions, wrong mode/action, changed sample counts, shifted center, reversed directions and rotated axes reject atomically without disturbing a real redo branch. Selecting another RP and returning to identical coordinates cannot refresh a captured epoch.
4. In-plane center movement and an independent hand-calculated 90-degree normal rotation each create one reversible geometry transaction. A normal center displacement, shifted rotation pivot and resize through Rotate mode reject.
5. An intentional history allocation failure reaches exactly one valid Modify commit boundary and leaves selected RP, hidden view, pose, clean state, source objects and actual redo branch untouched. Retrying the same valid event after removing the failure commits once.
6. Transient mode lifecycle: blue edit entry on the same selected RP must exit 3D Modify; entering 3D Modify must exit blue editing; selecting another RP or installing a ZIP clears the transient Modify session. This identified a second concrete failure: entering same-RP blue editing left `resliceMode='resize'` and blue interaction enabled simultaneously. The targeted assertion failed with `'resize' !== 'view'`; the controller owner corrected blue entry to end 3D Modify first, and the regression now passes.

The oblique fixtures and expected candidates are hand-authored, rather than generated by the production gizmo helper being tested. Every accepted path retains the second RP and attached historical MPR measurement without retargeting them.

## Verification

Initial independent regression: 0/1 passing, confirming the omitted-volume counterexample before the owner correction. After the strict guard and Modify API landed, the original five audit cases passed 5/5; `npx vue-tsc --noEmit` also passed. The additional lifecycle case initially failed and then passed after its owner correction. Final independent run of `node --experimental-strip-types --test tests/mimics-reslice-gizmo-workflow-audit.test.ts`: **6/6 pass**, no skipped/cancelled tests. Root coordinates the broad regression/build and final report; this audit makes no browser or native-program runtime claim. No requirement completion or acceptance gate is changed by these tests.
