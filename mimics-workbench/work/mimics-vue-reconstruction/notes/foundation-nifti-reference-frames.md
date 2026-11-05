# Application-local coordinates and external NIfTI reference coordinates

Scope: assigned `core.ts`, `project.ts`, `resliceProjectData.ts`, `segmentationImport.ts`, new pure helper `niftiReference.ts`, and owned reference tests. Existing density/physical-Polyline geometry is retained. No controller, viewport, worker, downloaded artifact, requirement inventory or acceptance gate is changed here.

## Reason for the separation

The official NIfTI [qform/sform specification](https://nifti.nimh.nih.gov/nifti-1/documentation/nifti1fields/nifti1fields_pages/qsform.html/document_view.html) distinguishes scanner-anatomical code 1, file/anatomically aligned code 2 and arbitrary code 0. A local image-coordinate frame is not made scanner-anatomical by storing a diagonal matrix with code 1, nor does changing the code alone restore a lost patient-space transform. Setting both codes to zero would also discard a general reference affine. The implementation therefore preserves an explicit map instead of relabeling local coordinates as anatomical coordinates.

`Volume.affine` continues to describe application world coordinates, normalized to mm through the existing `volumeGrid`. All stored samples, internal annotation positions, density bases, Polylines and Part coordinates use that same application frame. The optional new metadata is:

```text
niftiReference: {
  applicationToReference: proper-rigid 4x4 mm matrix L,
  frame: 'RAS' | 'source-aligned'
}
```

The header's sform instead describes the external NIfTI reference affine. For old-app → new-app coordinate change `T`:

```text
Lnew = Lsource * inverse(T)
Aref,new = Lnew * Aapp,new
```

The reference affine is encoded as Float32 NIfTI coefficients; application affine/annotation coordinates retain their mathematical Float64 values. CS off preserves the inherited `L`, even if an earlier reslice already used local application coordinates. Repeat CS on composes the mapping rather than discarding the earlier reference.

## Source-reference and code policy

- An existing valid `niftiReference` keeps its frame and reference code; its header/matrix correspondence is validated before composition.
- An ordinary source with a recognized effective sform/qform reference code 1–5, no legacy local indication and no missing-parent reslice marker uses identity source `L` and preserves that reference code. A qform-only source can emit a new sform using the same reference code.
- A source with unknown codes, legacy `dicom.coordinateSystem='reslice-local'` without `L`, or a legacy resliced-project marker without an explicit patient-RAS DICOM source is conservatively `source-aligned`, with code 2 and a warning. Its coordinates are aligned to the old file's numeric frame; the original patient reference is not fabricated or claimed to have been reconstructed.
- An explicit DICOM RAS source or a reliable inherited reference retains its known reference. `dicom.coordinateSystem` still describes the application's frame, so CS-on DICOM is `reslice-local` internally while external `niftiReference.frame` may remain RAS.
- Strict frame/code combinations reject contradictory declarations: RAS needs a recognized nonzero reference code; the application's `source-aligned` representation uses code 2. A reflected voxel-index affine is allowed, but `L` itself must be a proper rotation/translation, not a reflection, scale or shear.

## Strict project and precision contract

The optional field is strictly whitelisted in Volume serialization. It requires exactly the two declared fields, ordinary dense data-only 4×4 arrays, finite entries, homogeneous last row and proper-rigid rotation. ZIP restore deeply clones both the mapping and affine/header data. Legacy files without the field retain their previous header/affine behavior.

For a new Ref volume, project validation checks the header's reference affine against `L * Aapp`. Sform comparison uses the **exact Float32 coefficient encoding certificate**: each expected reference coefficient is converted into the header's native unit, rounded to Float32, and must equal the stored coefficient. It does not use a large-world-origin relative tolerance. A qform-derived matrix uses only a bounded 32-EPSILON allowance for the quaternion's Float64 arithmetic. App spacing is checked against app basis lengths; app obliqueness is checked against app axes, independently of the rotated external header.

Float32 cannot express every small translation at extreme world origins. The module computes the actual maximum reference-header encoding error over full voxel-support corners and records it in the transform text. Errors over `max(1e-5 mm, 0.1% of the smallest pixel spacing)` produce an explicit warning. This is file encoding precision, not a physical movement of the internal annotation geometry; no claim is made that sub-encoding-resolution changes can always be distinguished.

## Standalone Mask roundtrip

`exportNifti` already copies the header, so it now naturally writes the proper external reference geometry with unchanged label ordering. Parsing that standalone file yields reference-world coordinates, with no private local-coordinate map needed.

`sameImageGeometry` compares reference geometry rather than app geometry or dimensions alone. For new Ref volumes, `exchangeGeometry` uses the **verified actual header encoding** so the exported file and its active project share precisely the same stored geometry despite Float32 rounding. `referenceAffineMm` separately returns the mathematical `L*Aapp` map. Legacy non-Ref volumes retain the old millimetre support-corner comparison and its existing whole-voxel-translation rejection tests.

The transform TXT keeps the three previous application-world/sampling matrix headings, explicitly states that old/new world means application world, and adds both `application-world-mm -> NIfTI-reference-world-mm (L)` and its inverse. It records the external frame, code and header precision error. Thus applying a single local CS step is not misrepresented as a complete patient-space transform.

## Verification

`tests/mimics-nifti-reference.test.ts`: **15/15 pass**. Covers strict proper-rigid/data-only metadata; valid codes and metre/mm/micron/byte orders; qform-only source preservation; CS on/off identical sampled arrays with distinct app/reference coordinates; repeated mapping composition; actual synthetic DICOM HU, MONOCHROME1 and patient-RAS preservation; unknown and old missing-parent checkpoints; standalone Mask export/reimport and wrong-reference rejection; malformed schema/frames/header mismatches; exact sform certificate including a one-Float32-step corruption; disclosed large-coordinate quantization with successful actual-file reimport; ZIP isolation and stability across object-history operations; false frame labels; reflected voxel axes versus forbidden reflected `L`; and all transform-text directions.

The final reference suite plus existing Project, Storage/Import, Reslice Data and physical-schema suites pass **78/78**, no skipped/cancelled tests. Global `npx vue-tsc --noEmit` passes. Final full regression/build is coordinated by root.

The previously downloaded 717 checkpoint files and their independent identity/oblique reports remain historical evidence for the earlier format. They were not rewritten or silently relabeled by this work. New reference-aware files need their own current browser/file evidence before extending those historical claims.
