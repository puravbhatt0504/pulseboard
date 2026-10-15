// npm run eval:triage → runs the real suggestTriage() over eval/triage.jsonl (100 real kubernetes issues with
// maintainer-set priority and kind labels; build with `node eval/build-triage.mjs`). Prints label F1 (micro) and
// priority accuracy next to the "always medium" baseline. Needs ASK_BEDROCK_MODEL + AWS credentials, or ANTHROPIC_API_KEY.
// Exit 1 if priority accuracy doesn't beat "always medium" or a metric drops > 5 points below eval/baseline.json.
//   npm run eval:triage:update   → write the measured metrics as the new baseline
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { llmConfigured, llmName } from "../src/ai/llm.js";
import { PRIORITIES, suggestTriage } from "../src/ai/triage.js";
import { readJsonl } from "./lib.js";

type Row = { key: string; title: string; description: string; labels: string[]; priority: (typeof PRIORITIES)[number] };
const rows = readJsonl<Row>("triage.jsonl");
const LABELS = ["bug", "test", "feature", "docs", "chore"];
const baselineUrl = new URL("../../../eval/baseline.json", import.meta.url);
if (!llmConfigured()) throw new Error("set ASK_BEDROCK_MODEL (Bedrock) or ANTHROPIC_API_KEY (root .env or environment)");

// 4 at a time; a failed call counts as an empty suggestion (and is listed).
const results: { row: Row; labels: string[]; priority: string | null }[] = [];
const errors: string[] = [];
for (let i = 0; i < rows.length; i += 4) {
  await Promise.all(
    rows.slice(i, i + 4).map(async (row) => {
      try {
        const s = await suggestTriage(row, { labels: LABELS, members: [] });
        results.push({ row, labels: s?.labels ?? [], priority: s?.priority ?? null });
        if (!s) errors.push(`${row.key}: no JSON in reply`);
      } catch (e) {
        results.push({ row, labels: [], priority: null });
        errors.push(`${row.key}: ${(e as Error).message.slice(0, 120)}`);
      }
    }),
  );
}

let tp = 0, fp = 0, fn = 0;
for (const r of results) {
  tp += r.labels.filter((l) => r.row.labels.includes(l)).length;
  fp += r.labels.filter((l) => !r.row.labels.includes(l)).length;
  fn += r.row.labels.filter((l) => !r.labels.includes(l)).length;
}
const precision = tp / Math.max(tp + fp, 1), recall = tp / Math.max(tp + fn, 1);
const metrics = {
  label_f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
  priority_accuracy: results.filter((r) => r.priority === r.row.priority).length / results.length,
};
const alwaysMedium = rows.filter((r) => r.priority === "medium").length / rows.length;

console.log(`${rows.length} cards, model ${llmName()}\n`);
console.log(`label F1 (micro)   ${metrics.label_f1.toFixed(3)}   (precision ${precision.toFixed(3)}, recall ${recall.toFixed(3)})`);
console.log(`priority accuracy  ${metrics.priority_accuracy.toFixed(3)}   always "medium": ${alwaysMedium.toFixed(3)}`);
console.log("\npriority confusion (rows = gold, columns = predicted)");
const cols = [...PRIORITIES, "none"];
console.log(`${"".padEnd(8)}${cols.map((c) => c.padStart(8)).join("")}`);
for (const gold of PRIORITIES) {
  const n = (p: string) => results.filter((r) => r.row.priority === gold && (r.priority ?? "none") === p).length;
  console.log(`${gold.padEnd(8)}${cols.map((c) => String(n(c)).padStart(8)).join("")}`);
}
if (errors.length) console.log(`\n${errors.length} failed:\n${errors.join("\n")}`);

const baseline: Partial<typeof metrics> = existsSync(baselineUrl) ? JSON.parse(readFileSync(baselineUrl, "utf8")).triage ?? {} : {};
let ok = metrics.priority_accuracy > alwaysMedium;
if (!ok) console.log(`\nFAIL: priority accuracy doesn't beat always "medium"`);
for (const [k, v] of Object.entries(metrics) as [keyof typeof metrics, number][]) {
  const base = baseline[k];
  if (base !== undefined && base - v > 0.05) {
    ok = false;
    console.log(`FAIL: ${k} ${v.toFixed(3)} is more than 5 points below baseline ${base.toFixed(3)}`);
  }
}
if (process.argv.includes("--update-baseline")) {
  const all = existsSync(baselineUrl) ? JSON.parse(readFileSync(baselineUrl, "utf8")) : {};
  writeFileSync(baselineUrl, JSON.stringify({ ...all, triage: metrics }, null, 2) + "\n");
  console.log("\nwrote eval/baseline.json");
}
process.exitCode = ok ? 0 : 1;
