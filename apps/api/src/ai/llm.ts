import Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

// ASK_BEDROCK_MODEL set (any Bedrock model id, e.g. GLM or Nemotron) → Amazon Bedrock's Converse API, signed with the
// AWS credential chain (the ECS task role in prod, AWS_PROFILE locally): no key anywhere.
// Otherwise Claude on the Anthropic API with ANTHROPIC_API_KEY.
const CLAUDE_MODEL = "claude-sonnet-5-5";
const CLAUDE_USD_PER_TOKEN = { input: 2 / 1e6, output: 10 / 1e6 };
export const bedrockModel = () => process.env.ASK_BEDROCK_MODEL;
export const llmConfigured = () => !!bedrockModel() || !!process.env.ANTHROPIC_API_KEY;
export const llmName = () => (bedrockModel() ? `${bedrockModel()} (Amazon Bedrock)` : `${CLAUDE_MODEL} (Claude API)`);

export type Generation = { text: string; refused: boolean; inputTokens: number; outputTokens: number; costUsd: number | null };
type Opts = { system: string; prompt: string; maxTokens: number; onText?: (t: string) => void; signal?: AbortSignal };

let anthropic: Anthropic | undefined;
let bedrock: BedrockRuntimeClient | undefined;

/** One system + user turn, streamed through onText. No tools are ever offered. */
export async function generate({ system, prompt, maxTokens, onText = () => {}, signal }: Opts): Promise<Generation> {
  const modelId = bedrockModel();
  if (modelId) {
    bedrock ??= new BedrockRuntimeClient({});
    const res = await bedrock.send(
      new ConverseStreamCommand({
        modelId,
        system: [{ text: system }],
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens },
      }),
      { abortSignal: signal },
    );
    let text = "", stop = "", inputTokens = 0, outputTokens = 0;
    for await (const ev of res.stream ?? []) {
      const t = ev.contentBlockDelta?.delta?.text; // reasoning deltas (reasoningContent) are not part of the answer
      if (t) {
        text += t;
        onText(t);
      }
      if (ev.messageStop) stop = ev.messageStop.stopReason ?? "";
      if (ev.metadata?.usage) ({ inputTokens = 0, outputTokens = 0 } = ev.metadata.usage);
    }
    // ponytail: no per-model price table for Bedrock models; tokens are logged, cost is left null.
    return { text, refused: stop === "content_filtered" || stop === "guardrail_intervened", inputTokens, outputTokens, costUsd: null };
  }

  anthropic ??= new Anthropic();
  const stream = anthropic.beta.messages.stream(
    {
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      output_config: { effort: "low" }, // latency-sensitive answers over a dozen short cards
      system,
      messages: [{ role: "user", content: prompt }],
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // a safety decline re-runs on Anthropic's recommended fallback model
    },
    { signal },
  );
  stream.on("text", onText);
  const message = await stream.finalMessage();
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const { input_tokens: inputTokens, output_tokens: outputTokens } = message.usage;
  // ponytail: priced at Sonnet rates even when a fallback model answered; use usage.iterations if that matters.
  const costUsd = inputTokens * CLAUDE_USD_PER_TOKEN.input + outputTokens * CLAUDE_USD_PER_TOKEN.output;
  return { text, refused: message.stop_reason === "refusal", inputTokens, outputTokens, costUsd };
}
