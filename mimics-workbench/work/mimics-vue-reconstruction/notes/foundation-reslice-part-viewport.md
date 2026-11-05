# Selected RP plane in the Part viewport

## Scope and evidence

Changed `src/mimics/PartViewport.vue` and added `tests/mimics-part-reslice.test.ts`. Shared viewport tests were not edited. This note records source/help and automated SFC evidence only. No original Mimics process, native mapping trial, browser, or WebGL rendering session was executed in this subtask.

Reference help: `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/Along Plane2.txt` says Rotate supports rotation handles, moving their center moves the plane, and Resize highlights borders red with double-arrow cursors over dots. `Reslice Objects.txt` establishes RP objects and selected reslice layout behavior. These texts do not establish exact 3D axis/handle mapping, depth occlusion, or symmetric resizing policy.

## Component contract

Optional props:

```ts
reslicePlane?: MprPlane
resliceMode?: 'view' | 'rotate' | 'resize'
resliceId?: string
resliceRevision?: number
```

`updateReslicePlane` emits exactly one changed drop with:

```ts
{
  id: string,
  plane: MprPlane,
  action: 'move' | 'rotate' | 'resize',
  volume?: Volume,
  revision: number,
  resliceRevision: number
}
```

Both optional revision props default to zero in the captured event; the integrated workbench supplies real revisions. `action` is frozen from the selected handle kind, including center=`move` in either modify mode. The viewport does not mutate the input plane and emits no live preview event.

## Implemented interaction policy

- Selected RP support rectangle is projected into the existing SVG geometry overlay. Its transparent face, border and label pass pointer events through. View mode exposes no interactive handles, preserving mesh selection and navigation.
- Rotate shows a center handle and four support-corner handles. Center translates within the RP plane. Corners rotate around the RP's own physical normal at its fixed center. This does not change the normal; full 3D direction remains available through the workbench's numeric Euler controls. No guessed world-axis ring mapping is exposed.
- Resize shows a red border, center, four side dots and four corner dots. Side/corner cursors use the nearest projected double-arrow direction. Physical width/height resize symmetrically about the frozen center, with unchanged sample counts and directions, using `resliceGizmo.ts`. At zero distance the helper clamps to a positive minimum; beyond the center it expands symmetrically without reversing orientation.
- Resize preserves the initial physical grab offset within the handle hit area. Clicking off the exact dot center does not jump or dirty the plane.
- A gesture freezes the document identity, document revision, pose revision, selected RP id, input plane identity and values, mode/tool, physical frame, handle position and camera. Every candidate ray intersects that frozen RP plane. RP movement never snaps to any Part mesh.
- Escape, pointer cancellation, lost capture, primary-button loss, camera controls, resizing, busy state, tool/mode changes, document/object/frame/id/revision changes cancel and release capture. Invalid or edge-on planes cannot capture. No-movement drops and completed round trips emit nothing.
- No-Part scenes fit the selected RP's full half-pixel support, and an explicit fit includes both RP and Part geometry. Temporary previews never fit. Same-id committed geometry and its global revision echo preserve the camera, including compensation when GPU mesh vertices are uploaded with a changed origin. New selected RP id/presence/document can fit an empty Part scene.

## Validation

Executed:

```text
node --experimental-strip-types --test tests/mimics-part-reslice.test.ts tests/mimics-part-ellipse.test.ts
tests 27, pass 27, fail 0
```

This covers 13 new RP SFC-handler/SVG tests plus 14 existing Part ellipse tests, including oblique physical planes, metadata/action capture, no-Part display/fit, pointer pass-through, cancellation, exact no-op behavior, offset grabs and committed camera preservation. The harness compiles the actual Vue SFC and template with a CSS/capture fake; it does not prove browser/WebGL rendering.

`npx vue-tsc --noEmit` also passed after the component/event/watch changes. Root integration owns final full-suite/build and browser verification.
