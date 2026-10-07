import { describe, expect, it } from "vitest";
import { MODEL_PRICING, getPricingForModel } from "../../open-sse/providers/pricing.js";

// GPT-6 variants served by the live-discovery gateways (openrouter, kilocode,
// venice, opencode, infron, 1min — catalogs read 2026-10-03) had no exact
// MODEL_PRICING row and no PATTERN_PRICING match, so getPricingForModel returned
// null and cost tracking silently recorded $0. Rates mirror
// openrouter.ai/api/v1/models; reasoning = 1.5x output and cache_creation =
// input follow the convention used by every other GPT row in this table.
describe("GPT-6 family pattern pricing", () => {
  const cases = [
    ["openrouter", "openai/gpt-6-sol", { input: 2, output: 10, cached: 0.2, reasoning: 15 }],
    ["kilocode", "openai/gpt-6-sol-pro", { input: 2, output: 10, cached: 0.2, reasoning: 15 }],
    ["openrouter", "gpt-6.1-sol", { input: 2, output: 10, cached: 0.1, reasoning: 15 }],
    ["infron", "gpt-6.1-sol", { input: 2, output: 10, cached: 0.1, reasoning: 15 }],
    ["infron", "gpt-6-luna", { input: 0.1, output: 0.5, cached: 0.01, reasoning: 0.75 }],
    ["openrouter", "gpt-6-luna-pro", { input: 0.1, output: 0.5, cached: 0.01, reasoning: 0.75 }],
    ["openrouter", "gpt-6-astra-pro", { input: 10, output: 50, cached: 1, reasoning: 75 }],
    ["venice", "openai-gpt-6-astra", { input: 10, output: 50, cached: 1, reasoning: 75 }],
    ["venice", "openai-gpt-6-astra-pro", { input: 10, output: 50, cached: 1, reasoning: 75 }],
    ["venice", "openai-gpt-6-luna", { input: 0.1, output: 0.5, cached: 0.01, reasoning: 0.75 }],
    ["commandcode", "gpt-6-sol", { input: 2, output: 10, cached: 0.2, reasoning: 15 }],
  ];

  it.each(cases)("%s / %s resolves a real rate", (provider, model, rate) => {
    expect(getPricingForModel(provider, model)).toMatchObject(rate);
  });

  it("keeps the deliberate gpt-6-astra parity rate — exact entry beats pattern", () => {
    expect(MODEL_PRICING["gpt-6-astra"]).toMatchObject({ input: 8, output: 32 });
    expect(getPricingForModel("codex", "gpt-6-astra")).toMatchObject({ input: 8, output: 32 });
  });

  it("leaves the 5.x family and the claude-opus pattern untouched", () => {
    expect(getPricingForModel("openrouter", "gpt-5.6-sol")).toMatchObject({ input: 8, output: 32 });
    expect(getPricingForModel("openrouter", "claude-opus-5")).toMatchObject({ input: 5, output: 25 });
  });
});
