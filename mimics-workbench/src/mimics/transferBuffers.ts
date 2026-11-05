/** Transfer worker-owned result arrays instead of structured-cloning a second copy.
 * The resident source grid must stay attached for subsequent operations. */
export function resultTransfers(value: unknown, excluded: Set<ArrayBufferLike> = new Set()): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>(), seen = new Set<object>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    const buffer = ArrayBuffer.isView(item) ? item.buffer : item instanceof ArrayBuffer ? item : null;
    if (buffer) { if (buffer instanceof ArrayBuffer && !excluded.has(buffer)) buffers.add(buffer); return; }
    for (const child of Object.values(item)) visit(child);
  };
  visit(value); return [...buffers];
}
