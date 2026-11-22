// Pure editor/build bookkeeping (no DOM) so it can be unit-tested from Node.

/** Small, fast, well-distributed 53-bit string hash (cyrb53). Used to track "does the box match the running build". */
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * What the compile controls should show.
 *  - text matches the running build  -> quiet "Up to date" label, NO compile button
 *  - text differs                    -> "Compile and run" button
 *  - a compile is in flight          -> disabled "Compiling..." state
 */
export function compileControls({ text, runningHash, building }) {
  const dirty = runningHash == null || cyrb53(text) !== runningHash;
  if (building) return { showButton: false, showUpToDate: false, building: true, dirty };
  return { showButton: dirty, showUpToDate: !dirty, building: false, dirty };
}

/** Client-side build cache keyed by source hash: reverting an edit re-runs instantly with no server round trip. */
export class BuildCache {
  constructor() { this.map = new Map(); }
  get(text) { return this.map.get(cyrb53(text)); }
  set(text, result) { this.map.set(cyrb53(text), result); }
}
