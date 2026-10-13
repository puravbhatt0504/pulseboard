import { readFileSync } from "node:fs";
import { embedNow } from "../src/ai/embed.js";

// RelayQ on this machine unless told otherwise (the root .env has no RELAYQ_URL: compose sets its own).
process.env.RELAYQ_URL ??= "http://localhost:3200";

export const readJsonl = <T>(name: string): T[] =>
  readFileSync(new URL(`../../../eval/${name}`, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** Embeds through RelayQ POST /embed (16 per call, its limit). Needs RELAYQ_URL + RELAYQ_API_KEY and RelayQ running. */
export async function embedAll(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = await embedNow(texts.slice(i, i + 16).map((t) => t.slice(0, 8000)));
    if (!batch) throw new Error("POST /embed failed: is RelayQ up, with VOYAGE_API_KEY (or VOYAGE_BASE_URL → deploy/voyage-stub.mjs)?");
    out.push(...batch);
  }
  return out;
}

export const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
};
