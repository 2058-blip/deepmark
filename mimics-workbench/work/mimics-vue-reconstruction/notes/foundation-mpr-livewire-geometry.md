# MPR LiveWire: bounded resampling adapter

`src/mimics/mprLivewire.ts` is a pure adapter from a saved physical MPR plane to the existing `calculateLiveWire` kernel. It changes neither `livewire.ts`, `mpr.ts`, source Masks nor worker/controller behavior. It does not recover an original arbitrary-RP source-Mask writeback algorithm. Native discrete-Gaussian coefficient generation/truncation remains unconfirmed; returned trees retain `preprocessing: 'recovered-gradient-crossing-independent-gaussian'` rather than claiming full native equivalence.

## Frozen API and coordinates

```ts
const MAX_MPR_LIVEWIRE_PIXELS = 1_048_576;
interface MprLiveWireOptions extends AlgorithmControl {
  interpolation?: 'linear' | 'nearest';
  gradientWeight?: number;
  attraction?: number;
}
calculateMprLiveWire(grid, plane, seed, options?): LiveWireTree
```

`seed` is an integer MPR output coordinate `[x,y,0]`, not source IJK and not a world point. The result is an ordinary `LiveWireTree` with `{plane:{axis:2,index:0}, axes:[0,1], width:w, height:h}`. Its paths remain local integer `[x,y,0]` samples; the caller must map accepted paths through the frozen physical MPR plane. Trees keep ordinary unreachable semantics: `distance=Infinity`, `predecessor=-1`, and `liveWirePath(tree,target)` returns `[]`. This adapter never substitutes a straight endpoint chord. An unsupported/nonfinite seed rejects instead of creating a tree.

The adapter uses `sampleMprSlice(grid, plane, [], {interpolation})` with no Masks. Default gray interpolation is linear; nearest can be selected explicitly. The raw sampled Float32 gray array is the local volume's data, `sampled.valid` is its allowed-mask barrier, local dimensions are `[w,h,1]`, and local physical spacing is `[norm(plane.u), norm(plane.v), 1]`. Thus feature derivatives use the actual two physical sample lengths. Full affine inversion, source reflection/shear and center-support rules come from the existing sampler. A source cell that intersects the displayed plane is not automatically a valid gray sample: samples outside finite source-center gray support stay barriers even when nearest interpolation could otherwise clamp an edge.

## Validation, budget and cancellation

Output planes use shared strict `validateMprPlane`; output area greater than 1,048,576 throws before sampling or progress callbacks. It never changes output sampling size silently. Source dimensions/spacing/data length and Float32 type are validated without scanning or changing raw gray. Optional affine input must be a finite 3×4 or affine 4×4 matrix, invertible under the sampler, with finite source-support corners. Nonfinite raw intensities remain legitimate barriers. The seed must lie inside the local output and have finite sampled gray support.

Interpolation names and callback types validate before resampling. Gradient weight must be finite in `[0,1]`, default `.6`; attraction must be finite in `[-50,50]`, default `0`. That attraction interval is the existing implementation's explicit numerical bound, not a recovered native UI range.

Cancellation is forwarded to both resampling and LiveWire; the adapter's sampler callback actively throws `AbortError`, preserving a consistent cancellation type despite the sampler's generic cancellation message. Progress reports start `0`, then `.25` after resampling, and map the existing kernel's progress to `.25..1`. Callbacks are followed by cancellation checks, including final progress, so cancellation cannot publish a completed tree. Input arrays and saved plane/seed fields remain unchanged on success or failure. Pixel limits bound sampled arrays and tree sizes, not a promise that every memory allocator can satisfy the request; allocation exceptions produce no partial returned tree. The intended caller runs this synchronous operation in its worker.

## Verification

`node --experimental-strip-types --test tests/mimics-mpr-livewire.test.ts` passes 15 independent cases. Analytic fixtures check the axial linear-ramp gradient/Laplacian maps and shortest cost; parameter propagation to the recovered edge formula; true oblique world-linear gray; a reflected/sheared source affine; physical anisotropic derivative ratios; distinct known linear/nearest interpolation cost maps; NaN walls and honest unreachable paths; unsupported/half-voxel gray-invalid FOV; constant-field shortest-step cost; source/result ownership; exact resource limit and excess rejection; cancellation during resampling, at stage boundaries and after final progress; malformed seeds/options/callbacks; and source/plane validation. Expected costs and barriers are independently derived, rather than obtained from a second call to `sampleMprSlice` or `calculateLiveWire` as the oracle. No original program or patient input is executed.
