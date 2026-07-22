/** ColorBrewer/Tableau-inspired palette checked into the repository for deterministic type colors. */
export const TYPE_COLOR_PALETTE = [
  '#4c78a8',
  '#f58518',
  '#e45756',
  '#72b7b2',
  '#54a24b',
  '#eeca3b',
  '#b279a2',
  '#ff9da6',
  '#9d755d',
  '#bab0ac',
] as const;

/** FNV-1a over UTF-8 bytes, with the required 32-bit overflow at each multiplication. */
export function fnv1a(value: string): number {
  let hash = 0x81_1c_9d_c5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return hash >>> 0;
}

export function colorForType(type: string): string {
  return TYPE_COLOR_PALETTE[fnv1a(type) % TYPE_COLOR_PALETTE.length] ?? TYPE_COLOR_PALETTE[0];
}
