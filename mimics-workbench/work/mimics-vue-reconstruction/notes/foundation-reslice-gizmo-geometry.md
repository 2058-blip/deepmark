# RP physical geometry and handle policy

Evidence: `work/mimics-17-analysis/evidence/help/text/Mimics Reference Guide/Along Plane2.txt` describes rotation handles, moving their center to move the plane, and red borders with dotted resize controls. It does not define screen-to-world 3D drag mapping, handle counts, center symmetry, or minimum dimensions. The helper policies below are independent reconstruction choices.

`src/mimics/resliceGizmo.ts` validates and clones the existing `MprPlane` shape. Its physical support rectangle is centered at `mprPlaneCenter`, spans `size[0] * |u|` by `size[1] * |v|`, and includes the half-pixel exterior beyond the first and last sample centers. Corners are ordered `--`, `+-`, `++`, `-+`. Even a one-pixel dimension has nonzero physical extent. Reflections retain their orientation; accepted rounded near-orthogonal frames retain their actual step vectors.

Exports:

- `reslicePlaneFrame(plane)` returns physical center, unit `u`/`v`/normal, full dimensions, and the four world corners.
- `reslicePlaneHandles(plane, mode)` returns center plus four normal-axis corner rotation handles in Rotate mode; Resize mode returns center, four side handles and four corner handles. Resize IDs are `u-`, `u+`, `v-`, `v+`, `corner--`, `corner+-`, `corner++`, `corner-+`; rotation IDs are `rotate--`, `rotate+-`, `rotate++`, `rotate-+`.
- `translateReslicePlane(plane, deltaWorld)` applies a physical world displacement. The viewport chooses the frozen center-drag plane.
- `rotateReslicePlane(plane, fromWorld, toWorld, axis?)` rotates about the frozen physical center. The default axis is the plane normal; an explicit world axis supports geometric axis rotation without implying an undocumented native UI mapping. Both rays are projected perpendicular to the rotation axis.
- `resizeReslicePlane(plane, id, worldPosition, minimumFieldOfViewMm?)` resolves the world position in the frozen frame, including its accepted residual Gram cross-term. Normal displacement and unused side coordinates do not affect the result. Opposite sides resize symmetrically, orientation and sample counts stay fixed, and absolute distance beyond a center crossing re-expands the support. At the center, dimensions clamp to a positive minimum: default `1e-3` mm and at least `2e-9` mm per sample to satisfy shared MPR validation.

Every plane result is independently cloned and validated. A true no-op retains the exact original numbers rather than normalizing axes or reconstructing an origin. Degenerate rotation axes/rays, malformed/nonfinite coordinates, invalid planes, invalid minimum fields, and nonrepresentable physical geometry reject without mutating the input.

Verification: `node --experimental-strip-types --test tests/mimics-reslice-gizmo.test.ts` exercises explicit half-pixel support coordinates, one-pixel support, handle locations/ownership, a known 90-degree turn, world-axis tilt, side/corner resize, center crossing and maximum sample counts, exact rounded-frame no-ops, reflected/sheared physical-grid fixtures, and invalid/overflow inputs. Expected coordinates and rotations are analytic fixtures rather than copies of the helper formulas.
