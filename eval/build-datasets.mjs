// Builds the Phase 10 eval sets from real GitHub issues that maintainers closed as duplicates
// ("Duplicate of #N" in a comment), so the labels aren't ours. Uses your `gh` login.
//   node eval/build-datasets.mjs        → eval/corpus.jsonl, eval/duplicates.jsonl, eval/search.jsonl
// corpus:     {key, title, description}         the originals (cards on the eval board)
// duplicates: {a, b, duplicate}                 a = dup issue text, b = an original; ~50% true pairs
// search:     {query, expected}                 query = dup issue title, expected = key of its original
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const SOURCES = [
  { repo: "facebook/react", label: "Resolution: Duplicate", pages: 3 },
  { repo: "microsoft/vscode", label: "*duplicate", pages: 2 },
];
const BODY_CHARS = 600;
const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 << 20 }));
// Issue templates repeat in every body; drop markdown headings/comments/checkboxes so the text is the user's words.
const clean = (body) =>
  (body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/^#+ .*$/gm, "").replace(/^\s*- \[[ x]\].*$/gm, "").replace(/\s+/g, " ").trim().slice(0, BODY_CHARS);
const text = (i) => `${i.title}\n${clean(i.body)}`;

let seed = 7;
const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);

const pairs = []; // {repo, dup, original}
for (const { repo, label, pages } of SOURCES) {
  for (let page = 1; page <= pages; page++) {
    const issues = gh(`repos/${repo}/issues?state=closed&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`).filter((i) => !i.pull_request);
    for (const dup of issues) {
      const comments = gh(`repos/${repo}/issues/${dup.number}/comments?per_page=100`);
      const m = comments.map((c) => /duplicate of #(\d+)/i.exec(c.body ?? "")).find(Boolean);
      if (!m || Number(m[1]) === dup.number) continue;
      let original;
      try {
        original = gh(`repos/${repo}/issues/${m[1]}`);
      } catch {
        continue; // deleted or transferred
      }
      if (original.pull_request) continue;
      pairs.push({ repo, dup, original });
      process.stderr.write(`\r${pairs.length} pairs`);
    }
  }
}
process.stderr.write("\n");

const key = (repo, n) => `${repo}#${n}`;
const originals = new Map(pairs.map((p) => [key(p.repo, p.original.number), p]));
const corpus = [...originals.entries()].map(([k, p]) => ({ key: k, title: p.original.title, description: clean(p.original.body) }));
const duplicates = pairs.flatMap((p) => {
  const others = pairs.filter((o) => o.repo === p.repo && o.original.number !== p.original.number);
  const neg = others[rand(others.length)];
  return [
    { a: text(p.dup), b: text(p.original), duplicate: true, source: key(p.repo, p.dup.number) },
    ...(neg ? [{ a: text(p.dup), b: text(neg.original), duplicate: false, source: key(p.repo, p.dup.number) }] : []),
  ];
});
const search = pairs.map((p) => ({ query: p.dup.title, expected: key(p.repo, p.original.number) }));

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(new URL("./corpus.jsonl", import.meta.url), jsonl(corpus));
writeFileSync(new URL("./duplicates.jsonl", import.meta.url), jsonl(duplicates));
writeFileSync(new URL("./search.jsonl", import.meta.url), jsonl(search));
console.log(`${pairs.length} duplicate issues → corpus ${corpus.length}, duplicates ${duplicates.length} (${duplicates.filter((d) => d.duplicate).length} true), search ${search.length}`);
