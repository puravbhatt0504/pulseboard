import { readFileSync } from "node:fs";
import { embedNow } from "../src/ai/embed.js";

// RelayQ on this machine unless told otherwise (the root .env has no RELAYQ_URL: compose sets its own).
process.env.RELAYQ_URL ??= "http://localhost:3200";

export const readJsonl = <T>(name: string): T[] =>
  readFileSync(new URL(`../../../eval/${name}`, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** Embeds via embedNow (Bedrock Titan when EMBED_BEDROCK_MODEL is set, else RelayQ /embed), 16 per call, waiting out throttling. */
export async function embedAll(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const chunk = texts.slice(i, i + 16).map((t) => t.slice(0, 8000));
    let batch = await embedNow(chunk);
    for (let retry = 0; !batch && retry < 10; retry++) {
      await new Promise((r) => setTimeout(r, 15_000));
      batch = await embedNow(chunk);
    }
    if (!batch) throw new Error("embedding failed: set EMBED_BEDROCK_MODEL (with AWS credentials), or run RelayQ with VOYAGE_API_KEY");
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
