import { describe, expect, it } from "vitest";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

// Opus 5.5 is billed $4/$20 upstream (openrouter.ai/api/v1/models, 2026-10-03),
// but the prefix-anchored `claude-opus-*` pattern priced every opus at $5/$25 and
// never matched Bedrock-style ids at all (`us.anthropic.claude-opus-5-5` on 1min),
// which returned null and made calculateCostFromTokens report those calls as free.
describe("Claude Opus 5 / 5.5 pricing", () => {
  it("prices the 5.5 spellings at the published rate, not the generic opus rate", () => {
    // opencode.ai/docs/zen + openrouter.ai (2026-10-03): Opus 5.5 $4/$20,
    // cached read $0.20, cached write $5.00 — flat across context length.
    const rate = { input: 4, output: 20, cached: 0.2, reasoning: 30, cache_creation: 5 };
    expect(getPricingForModel("openrouter", "anthropic/claude-opus-5.5")).toMatchObject(rate);
    expect(getPricingForModel("openrouter", "claude-opus-5.5")).toMatchObject(rate);
    expect(getPricingForModel("opencode", "claude-opus-5-5")).toMatchObject(rate);
    expect(getPricingForModel("venice", "claude-opus-5-5-fast")).toMatchObject(rate);
    expect(getPricingForModel("commandcode", "claude-opus-5-5")).toMatchObject(rate);
  });

  it("prices vendor-prefixed ids the prefix-anchored pattern never matched", () => {
    const bedrock55 = getPricingForModel("1min", "us.anthropic.claude-opus-5-5");
    expect(bedrock55).not.toBeNull();
    expect(bedrock55).toMatchObject({ input: 4, output: 20 });
    const bedrock5 = getPricingForModel("1min", "us.anthropic.claude-opus-5");
    expect(bedrock5).not.toBeNull();
    expect(bedrock5).toMatchObject({ input: 5, output: 25 });
    expect(getPricingForModel("digitalocean", "anthropic-claude-opus-5")).toMatchObject({ input: 5, output: 25 });
  });

  it("leaves Opus 5 and the rest of the opus family on the generic rate", () => {
    expect(getPricingForModel("openrouter", "claude-opus-5")).toMatchObject({ input: 5, output: 25 });
    expect(getPricingForModel("opencode", "claude-opus-5")).toMatchObject({ input: 5, output: 25 });
    expect(getPricingForModel("venice", "claude-opus-5-fast")).toMatchObject({ input: 5, output: 25 });
    expect(getPricingForModel("cc", "claude-opus-4-5-20251101")).toMatchObject({ input: 5, output: 25 });
    expect(getPricingForModel("cc", "claude-opus-4.8")).toMatchObject({ input: 5, output: 25 });
  });
});
