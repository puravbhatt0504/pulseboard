// Stand-in for Voyage's embeddings API while there's no VOYAGE_API_KEY: RelayQ calls it through VOYAGE_BASE_URL.
//   node deploy/voyage-stub.mjs            → http://localhost:8099
//   RelayQ .env: VOYAGE_BASE_URL=http://localhost:8099  VOYAGE_API_KEY=stub
// Vectors are feature hashing of words + character trigrams (1024 dims, L2-normalised): similar wording → similar
// vectors, but no sense of meaning ("charged twice" ≠ "duplicate payment"). Search/duplicate numbers measured on it
// are placeholders; re-run the evals with the real key.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const DIMS = 1024;

export function embed(text) {
  const v = new Float64Array(DIMS);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const features = [...words, ...words.flatMap((w) => [...`#${w}#`].slice(0, -2).map((_, i) => `#${w}#`.slice(i, i + 3)))];
  for (const f of features) {
    const h = createHash("md5").update(f).digest();
    v[h.readUInt16LE(0) % DIMS] += h[2] & 1 ? 1 : -1; // signed hashing keeps collisions from all adding up
  }
  const norm = Math.hypot(...v) || 1;
  return [...v].map((x) => x / norm);
}

if (process.argv[1]?.endsWith("voyage-stub.mjs")) {
  const port = Number(process.env.PORT ?? 8099);
  createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/embeddings") return res.writeHead(404).end();
      const { input } = JSON.parse(raw);
      const texts = Array.isArray(input) ? input : [input];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: texts.map((t, index) => ({ index, embedding: embed(t) })), model: "stub" }));
    });
  }).listen(port, () => console.log(`voyage stub on :${port}`));
}
