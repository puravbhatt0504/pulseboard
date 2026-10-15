// Builds the Phase 12 triage eval set from real kubernetes/kubernetes issues, whose maintainers set `priority/*`
// and `kind/*` labels, so the gold answers aren't ours. Uses your `gh` login.
//   node eval/build-triage.mjs   → eval/triage.jsonl  {key, title, description, labels, priority}
// Mapping: priority/critical-urgent → urgent, important-soon → high, important-longterm → medium, backlog → low;
// kind/bug and kind/regression → bug, kind/failing-test and kind/flake → test, kind/feature → feature,
// kind/documentation → docs, kind/cleanup → chore. The eval board's labels are those five.
// 25 issues per priority (balanced, so "always medium" scores 0.25), newest first, bodies cut to 1,500 chars.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const PRIORITY = { "priority/critical-urgent": "urgent", "priority/important-soon": "high", "priority/important-longterm": "medium", "priority/backlog": "low" };
const KIND = { "kind/bug": "bug", "kind/regression": "bug", "kind/failing-test": "test", "kind/flake": "test", "kind/feature": "feature", "kind/documentation": "docs", "kind/cleanup": "chore" };
const PER_PRIORITY = 25;

const gh = (q) =>
  JSON.parse(execFileSync("gh", ["api", "-X", "GET", "search/issues", "-f", `q=${q}`, "-f", "per_page=60", "-f", "sort=created"], { encoding: "utf8" })).items;

const rows = [];
for (const [ghLabel, priority] of Object.entries(PRIORITY)) {
  const items = gh(`repo:kubernetes/kubernetes is:issue label:${ghLabel}`)
    .filter((i) => i.labels.filter((l) => l.name in PRIORITY).length === 1) // exactly one priority label
    .filter((i) => (i.body ?? "").trim().length > 40)
    .slice(0, PER_PRIORITY);
  if (items.length < PER_PRIORITY) throw new Error(`only ${items.length} issues for ${ghLabel}`);
  for (const i of items) {
    rows.push({
      key: `k8s-${i.number}`,
      title: i.title,
      // Strip the issue template's HTML comments; they're boilerplate, not the reporter's words.
      description: i.body.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1500),
      labels: [...new Set(i.labels.map((l) => KIND[l.name]).filter(Boolean))],
      priority,
    });
  }
}
writeFileSync(new URL("./triage.jsonl", import.meta.url), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`wrote ${rows.length} cards to eval/triage.jsonl`);
