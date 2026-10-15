// npm run eval:dup → precision/recall of "cosine ≥ t means duplicate" on eval/duplicates.jsonl, t = 0.50…0.95.
// Picks the lowest threshold with precision ≥ 0.90 (most recall at that precision). Exit 1 if none gets there.
import { cosine, embedAll, readJsonl } from "./lib.js";

const pairs = readJsonl<{ a: string; b: string; duplicate: boolean }>("duplicates.jsonl");
const texts = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
const vectors = new Map((await embedAll(texts)).map((v, i) => [texts[i], v]));
const scored = pairs.map((p) => ({ sim: cosine(vectors.get(p.a)!, vectors.get(p.b)!), duplicate: p.duplicate }));

console.log(`${pairs.length} pairs, ${pairs.filter((p) => p.duplicate).length} duplicates\n\nthreshold  precision  recall  flagged`);
let chosen: { t: number; precision: number; recall: number } | undefined;
for (let t = 0.5; t <= 0.951; t += 0.05) {
  const flagged = scored.filter((s) => s.sim >= t);
  const tp = flagged.filter((s) => s.duplicate).length;
  const precision = flagged.length ? tp / flagged.length : 1;
  const recall = tp / scored.filter((s) => s.duplicate).length;
  console.log(`${t.toFixed(2).padStart(9)}  ${precision.toFixed(3).padStart(9)}  ${recall.toFixed(3).padStart(6)}  ${String(flagged.length).padStart(7)}`);
  if (!chosen && precision >= 0.9 && flagged.length > 0) chosen = { t, precision, recall };
}
if (!chosen) {
  console.log("\nno threshold in 0.50-0.95 reaches precision 0.90");
  process.exit(1);
}
console.log(`\nchosen DUP_THRESHOLD=${chosen.t.toFixed(2)}: precision ${chosen.precision.toFixed(3)}, recall ${chosen.recall.toFixed(3)}`);
