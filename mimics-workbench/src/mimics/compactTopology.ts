/** Stable counting sort of directed triangle corners by their undirected edge.
 * Two flat arrays replace per-edge strings, objects, Sets and face arrays. */
export function sortedMeshEdges(indices: Uint32Array, vertexCount: number): Uint32Array {
  let source = new Uint32Array(indices.length), target = new Uint32Array(indices.length);
  const counts = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < source.length; i++) source[i] = i;
  for (const high of [true, false]) {
    counts.fill(0);
    for (let i = 0; i < indices.length; i++) {
      const a = indices[i]!, b = indices[i - i % 3 + (i + 1) % 3]!;
      counts[(high ? Math.max(a, b) : Math.min(a, b)) + 1]++;
    }
    for (let v = 1; v < counts.length; v++) counts[v] += counts[v - 1]!;
    for (const i of source) {
      const a = indices[i]!, b = indices[i - i % 3 + (i + 1) % 3]!;
      target[counts[high ? Math.max(a, b) : Math.min(a, b)]!++] = i;
    }
    [source, target] = [target, source];
  }
  return source;
}

export function edgeEndpoints(indices: Uint32Array, corner: number): [number, number] {
  const a = indices[corner]!, b = indices[corner - corner % 3 + (corner + 1) % 3]!;
  return a < b ? [a, b] : [b, a];
}

export function manifoldFaceNeighbours(indices: Uint32Array, vertexCount: number): Int32Array {
  const order = sortedMeshEdges(indices, vertexCount), adjacent = new Int32Array(indices.length).fill(-1);
  for (let i = 0; i < order.length;) {
    const start = i, [a, b] = edgeEndpoints(indices, order[i]!);
    while (++i < order.length) {
      const [c, d] = edgeEndpoints(indices, order[i]!);
      if (a !== c || b !== d) break;
    }
    if (i - start === 2) {
      const x = order[start]!, y = order[start + 1]!;
      adjacent[x] = Math.floor(y / 3); adjacent[y] = Math.floor(x / 3);
    }
  }
  return adjacent;
}
