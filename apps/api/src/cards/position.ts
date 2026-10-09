// Fractional string positions over digits a..z. Keys sort lexicographically and never end
// in "a", so there is always room below any key. Siblings are never renumbered.
const A = 97;
const BASE = 26;

export function between(lo: string | null, hi: string | null): string {
  if (lo === null && hi === null) return "m"; // first card in an empty column
  if (lo !== null && hi !== null && lo >= hi) throw new RangeError(`between: "${lo}" >= "${hi}"`);
  const low = lo ?? "";
  let out = "";
  let bounded = hi !== null;
  for (let i = 0; ; i++) {
    const l = i < low.length ? low.charCodeAt(i) - A : 0;
    const h = bounded && i < hi!.length ? hi!.charCodeAt(i) - A : BASE;
    if (h - l >= 2) return out + String.fromCharCode(((l + h) >> 1) + A);
    // No gap at this digit: keep lo's digit and search deeper. If we stepped below hi's
    // digit, everything after is already < hi, so the upper bound is gone.
    out += String.fromCharCode(l + A);
    if (l < h) bounded = false;
  }
}
