# Downloaded Reslice Project files: independent Python verification

Date: 2026-11-05. These checks read the already downloaded synthetic browser artifacts in `evidence/browser-file-exchange/`; this agent did not operate a browser or the original Mimics program. The files contain the application's own synthetic practice image, not patient data. Python runs with `-I -S` and uses only the standard library. Neither application JavaScript/TypeScript nor its parsers, samplers or converters is executed as an oracle.

## Exact transform-entry schema update

The older `verify-mimics-browser-exports.py` correctly rejected the new identity project as having an unreferenced archive entry because that independent parser predated the optional transform schema. Its previous `identity-independent-validation.json` false result was a stale-oracle format limitation, not evidence of corrupted reslice samples.

The parser now recognizes only the declared optional nonempty UTF-8 `ProjectState.resliceTransform` field, at most 65,536 bytes, mirrored exactly by fixed entry `reslice-transform.txt`. Missing, different, undeclared or arbitrary additional entries still reject. The declared text is also parsed independently: exact three matrix headings, four rows of four finite values, homogeneous last rows, explicit mm/column-vector/row-major/sample-center conventions, and one Update CS flag. The world transforms must be proper rigid mutual inverses; Update CS off requires identity world transforms. A supplied source project additionally verifies the sampling matrix against independently decoded source/target affines. Merely declaring matching text cannot bypass these checks.

The existing 27 literal tests remain, with 14 new literal schema/matrix positive and negative checks: **41/41 pass**. Their fixtures are hand-built with Python struct/ZIP and are not roundtripped through application code. The new known-oblique-case script `verify-mimics-reslice-browser.py` has **8/8** analytic self-tests for the frame, centers, interpolation, background, ties and point/vector distinction.

## Identity export

Re-running the independent verifier on source ZIP + source NIfTI Mask + source STL succeeds, and the same source NIfTI/STL agree with the identity ZIP. The separate identity-versus-source comparison checks complete arrays, not UI statistics:

- Source and identity: 96×96×64, affine `diag(1,1,1.5)` mm, Update CS off.
- **589,824** Float32 gray values: zero value differences and exact stored-byte equality; shared SHA-256 `7363f61814f44262a734ca77e2a74d0810584972b8d94eed833fd1d17ea7e3b8`.
- Every independent Mask byte matches; this fixture's one Mask has **56** members before/after, revision **2→3**, with threshold metadata unchanged.
- Stored Part position, normal and index bytes match exactly, including oriented triangle geometry; **284** faces.
- All three TXT matrices are identity; both mutual-inverse and independently derived sampling-map residuals are zero.

Reports: `source-independent-validation.json`, `identity-independent-validation.json`, and `identity-vs-source.json`, all `ok=true`.

## Recorded oblique export

The new script intentionally verifies only this recorded analytic case. Inputs supplied by the browser-task coordinator are start `(0,47.5,47.25)`, end `(95,47.5,47.25)`, up `(0,1,0)`, rotation 30°, physical width/height 96 mm, pixel size 2 mm, slice distance 1.5 mm, Update CS on, and copy physical objects. The independently decoded source confirms 96×96×64 and `diag(1,1,1.5)` mm; output confirms 48×48×64 and local `diag(2,2,1.5)` mm.

The independent expected basis is `u=(0,1/2,-sqrt(3)/2)`, `v=(0,sqrt(3)/2,1/2)`, `n=(1,0,0)`; first stored source-world sample `S=start-47(u+v)`. Every output `[x,y,z]` samples `S+2xu+2yv+1.5zn`, then source IJK is `(worldX,worldY,worldZ/1.5)`. Gray uses an independently summed trilinear source-value interpolant, rounded to Float32, with explicit finite background -1000 outside source center support. Mask sampling uses closed half-cell support and nearest half-up; ties within two Float64 ULP of a mathematical half go to the upper source cell. These are the documented independent application policy, not a recovered proprietary kernel.

Results in `oblique-independent-validation.json`:

- **147,456** output gray values: exact Float32 equality throughout, **zero mismatch and maximum absolute error 0**. Although the verifier permits at most two Float32 ULP with a 1e-5 floor for independently ordered arithmetic, this artifact required no tolerance.
- Independent gray outside count **24,448**, valid count **123,008**. Independent Mask half-cell outside-support count **23,040** is separately reported; gray center support and Mask cell support are different predicates.
- Every Mask membership matches exactly. Source **56** members becomes **16** expected/actual output members, revision **2→3**, threshold metadata preserved.
- All **432** stored Part position components and **432** normal components equal the independent point `T` / vector `R` results after Float32 rounding, with maximum error 0. Index bytes unchanged, **284** faces. Historical Part source revision remains **2** against resampled Mask revision **3**, correctly stale.
- Copied RP origin and direction steps follow the analytic rigid transform; origin maximum error `1.60e-14`, steps at most `5.56e-17`; saved output sample counts retained.
- TXT matrices match analytic `T`, inverse `T` and `Aold^-1 * inverse(T) * Anew` with maximum residuals `2.84e-14`, `1.42e-14`, `1.42e-14` respectively.

`oblique-format-validation.json` separately reports successful CRC, schema, fixed transform text, finite image, geometry, binary membership and mesh-format inspection. The oblique file is not subjected to identity-only equal-value assertions against the old grid.

## Reproduction and file preservation

Run from the workspace root:

```powershell
python -I -S scripts/verify-mimics-browser-exports.py --self-test --output-json work/mimics-vue-reconstruction/evidence/browser-file-exchange/oracle-reslice-self-test.json
python -I -S scripts/verify-mimics-browser-exports.py --project work/mimics-vue-reconstruction/evidence/browser-file-exchange/identity.deepmark.zip --stl work/mimics-vue-reconstruction/evidence/browser-file-exchange/source.stl --mask work/mimics-vue-reconstruction/evidence/browser-file-exchange/source-mask.nii --output-json work/mimics-vue-reconstruction/evidence/browser-file-exchange/identity-independent-validation.json
python -I -S scripts/verify-mimics-browser-exports.py --source-project work/mimics-vue-reconstruction/evidence/browser-file-exchange/source.deepmark.zip --project work/mimics-vue-reconstruction/evidence/browser-file-exchange/identity.deepmark.zip --output-json work/mimics-vue-reconstruction/evidence/browser-file-exchange/identity-vs-source.json
python -I -S scripts/verify-mimics-reslice-browser.py --self-test --output-json work/mimics-vue-reconstruction/evidence/browser-file-exchange/oblique-oracle-self-test.json
python -I -S scripts/verify-mimics-browser-exports.py --project work/mimics-vue-reconstruction/evidence/browser-file-exchange/oblique.deepmark.zip --output-json work/mimics-vue-reconstruction/evidence/browser-file-exchange/oblique-format-validation.json
python -I -S scripts/verify-mimics-reslice-browser.py --source-project work/mimics-vue-reconstruction/evidence/browser-file-exchange/source.deepmark.zip --resliced-project work/mimics-vue-reconstruction/evidence/browser-file-exchange/oblique.deepmark.zip --output-json work/mimics-vue-reconstruction/evidence/browser-file-exchange/oblique-independent-validation.json
```

Only verifier scripts and JSON/Markdown records were written. Downloaded source, identity and oblique artifacts remain unchanged. SHA-256:

| File | SHA-256 |
| --- | --- |
| `source.deepmark.zip` | `6c67ea04c749027ef94d62a17d0ed82d3863854d01c17c9fd0af56ba988289b1` |
| `source-mask.nii` | `d9e5a96883d824b178cef835ecce3c904e98ea0b44773e652632537f8a7cd60d` |
| `source.stl` | `838de42bf97c83f18bb541ee62ea2c638f4986980c9fe8a7f782bceeb3eeabe8` |
| `identity.deepmark.zip` | `ffdfdccc434a288ad90b86da1c12dc1a64af8995f04143b35ce0df9280284add` |
| `oblique.deepmark.zip` | `f1af6625a1aba9985f9635bbeb16110a00de3ec41c6076b8a651cce904dd105c` |

These results establish the two downloaded synthetic files and their recorded configurations. They do not establish all orientations/imports, all object kinds, original Mimics file or interpolation equivalence, clinical validity, or independent proof of browser transport; browser actions remain in the coordinator's separate evidence record. No production source, other agents' tests, requirements or completion gate is changed.
