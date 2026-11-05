/** Typed construction buffers avoid boxed JS numbers and release spare capacity
 * before adjacency/normal calculation begins. Coordinates retain double precision
 * until the same final Float32 conversion used by the original extractor. */
export class MeshNumberBuffer {
  data: Float64Array | Uint32Array;
  length = 0;
  private coordinates: boolean;
  constructor(coordinates: boolean) {
    this.coordinates = coordinates;
    this.data = coordinates ? new Float64Array(16384) : new Uint32Array(16384);
  }
  push(...values: number[]) {
    const size = this.length + values.length;
    if (size > this.data.length) {
      const capacity = Math.max(size, this.data.length * 2);
      const next = this.coordinates ? new Float64Array(capacity) : new Uint32Array(capacity);
      next.set(this.data); this.data = next;
    }
    this.data.set(values, this.length); this.length = size;
  }
  finishPositions(): Float32Array {
    const result = new Float32Array(this.data.subarray(0, this.length));
    this.data = new Float64Array(0); return result;
  }
  finishIndices(): Uint32Array {
    const result = new Uint32Array(this.data.subarray(0, this.length));
    this.data = new Uint32Array(0); return result;
  }
}
