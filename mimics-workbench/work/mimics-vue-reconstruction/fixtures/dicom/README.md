# Synthetic DICOM import fixtures

All 15 DICOM files are generated numerical phantoms, with PatientName **SYNTHETIC^NO_PATIENT^PHANTOM**. No real patient or scanner images are used. Dates, equipment names and identifiers are synthetic constants. Not for clinical use.

## Valid import folders

- Choose **valid/** in the folder picker to load 10 files and offer **two series**. Its CT/ and MR/ children contain no duplicated instances.
- Choose **valid/CT/** for one classic CT series: 16×16×6, spacing 1/1/2 mm, origin LPS (10,20,30), orientation (1,0,0,0,1,0). Background -1000 HU (1253 voxels), sphere 600 HU (256 voxels), separate cube 1200 HU (27 voxels). Raw unsigned 12-bit pixels use slope 2/intercept -1024.
- Choose **valid/MR/** for one classic MR series: 12×10×4, spacing 1.5/2/3 mm, orientation (0,1,0,0,0,1), origin LPS (-30,40,50). GV=100+7x+11y+31z, range 100..369, mean 234.5. MONOCHROME1 display inversion must not change quantitative values.

Filenames and InstanceNumber are deliberately **not** physical slice order. Use ImagePositionPatient/orientation. CT world RAS = (-10-x,-20-y,30+2z); MR world RAS = (30-3z,-40-1.5x,50+2y). Full formulas, per-file physical slice indices, SHA256 and CLI assertions are in generation.json.

Valid files have Part 10 preamble, complete conventional file-meta group (version, matching SOP Class/Instance, transfer syntax, implementation UID/version and correct group length), Study/Series/Frame UIDs, orientation/position/pixel spacing, conventional patient/study/equipment/image attributes, Bits and linear Rescale tags. This is not a comprehensive DICOM conformance certification.

## Separate refusal cases

Do not choose the dicom/ root as a valid-series folder: it also contains these explicitly invalid/unsupported cases. Select only the indicated leaf folder for each refusal test.

- invalid/truncated/: one deliberately truncated Pixel Data file; expected TRUNCATED_DATASET.
- unsupported/jpeg2000-marker/: one JPEG2000 transfer-syntax-marked file with an explicitly fake, non-decodable encapsulated payload; expected UNSUPPORTED_TRANSFER_SYNTAX. It is not a valid JPEG2000 sample.
- invalid/irregular-spacing/: three otherwise parseable slices at physical z=30/32/35.5 mm in one separate Series UID; conversion must refuse IRREGULAR_SLICE_SPACING rather than guessing/resampling.

## Reproduce and evidence boundary

Run: node --experimental-strip-types scripts/create-mimics-dicom-fixtures.mjs

The script writes files, reads them back, checks conventional file-meta bytes, then invokes the application's parse/group/convert kernel against independent explicit dimensions/intensity/world-coordinate formulas. All valid voxels and expected refusals are checked. This proves fixture preparation and CLI parsing only. Browser import/folder UI, multi-series selection and UI error presentation are **not verified** by this generation run. No external DICOM conformance tool or new dependency is used.
