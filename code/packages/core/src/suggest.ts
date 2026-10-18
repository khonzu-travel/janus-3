import { compareStrings } from './canonical.js';

/** The closest candidate, when one is plausibly what was meant ("prot" → "port", "tommorow" → "tomorrow"). */
export function suggest(name: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of [...candidates].sort(compareStrings)) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    const limit = Math.max(1, Math.floor(candidate.length / 3));
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Optimal string alignment distance: Levenshtein plus adjacent transpositions ("prot" → "port" is 1). */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[] = Array.from({ length: rows * cols }, () => 0);
  const get = (i: number, j: number): number => d[i * cols + j] ?? 0;
  for (let i = 0; i < rows; i++) d[i * cols] = i;
  for (let j = 0; j < cols; j++) d[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(get(i - 1, j) + 1, get(i, j - 1) + 1, get(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, get(i - 2, j - 2) + 1);
      d[i * cols + j] = value;
    }
  }
  return get(a.length, b.length);
}
