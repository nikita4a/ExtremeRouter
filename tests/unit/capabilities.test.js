import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("getCapabilitiesForModel", () => {
  const claudeSonnet5Expected = {
    contextWindow: 1000000,
    maxOutput: 128000,
    thinkingFormat: "claude-adaptive",
    reasoning: true,
    vision: true,
    search: true,
  };

  it("reports Kiro Claude Opus 4.8 as a 1M context model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8-thinking").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8-thinking").contextWindow).toBe(1000000);
  });

  it("reports Kiro Claude Sonnet 5 as a 1M adaptive-thinking model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-agentic")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking-agentic")).toMatchObject(claudeSonnet5Expected);
  });

  it("reports Claude Fable 5.1 as permanently adaptive (1M context, thinking cannot be disabled)", () => {
    const caps = getCapabilitiesForModel("claude", "claude-fable-5-1");
    expect(caps).toMatchObject({ ...claudeSonnet5Expected, thinkingCanDisable: false });
  });

  it("reports Codex GPT 6.0 Astra as a vision and thinking capable model", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6-astra")).toMatchObject({
      vision: true,
      reasoning: true,
      search: true,
      thinkingFormat: "openai",
      contextWindow: 272000,
      maxOutput: 128000,
    });
    // The generic *gpt-6* pattern covers future 6.x ids on any provider. Its window is
    // the live upstream one — openrouter.ai/api/v1/models (2026-10-03) reports 1050000
    // for all eight gpt-6 ids, matching xkiro's hand-written entry. Codex above keeps
    // its own 272000 via its provider-exact row, so this value is not a global claim.
    expect(getCapabilitiesForModel("openai", "gpt-6-future-variant")).toMatchObject({
      vision: true,
      reasoning: true,
      search: true,
      thinkingFormat: "openai",
      contextWindow: 1050000,
      maxOutput: 128000,
    });
  });

  it("reports Opus 5 / 5.5 as adaptive 1M on live-discovery lanes", () => {
    // Gateways whose catalog comes from /v1/models (opencode, venice, commandcode,
    // inxorastudio, agentrouter, 1min, infron, openrouter) have no hand-written
    // PROVIDER_CAPABILITIES entry — they must not fall through to the generic
    // *claude*opus* pattern, which is claude-budget with a 200k window.
    const expected = {
      contextWindow: 1000000,
      maxOutput: 128000,
      thinkingFormat: "claude-adaptive",
      reasoning: true,
      vision: true,
      search: true,
    };
    for (const [provider, model] of [
      ["opencode", "claude-opus-5"],
      ["opencode", "claude-opus-5-5"],
      ["venice", "claude-opus-5-5-fast"],
      ["commandcode", "claude-opus-5"],
      ["inxorastudio", "ixlabs/claude-opus-5-thinking"],
      ["agentrouter", "claude-opus-5"],
      ["openrouter", "anthropic/claude-opus-5.5"],
    ]) {
      expect(getCapabilitiesForModel(provider, model), `${provider}/${model}`).toMatchObject(expected);
    }
    // "opus-5" must not swallow Opus 4.5 — that one stays on the budget pattern.
    expect(getCapabilitiesForModel("cc", "claude-opus-4-5-20251101")).toMatchObject({
      contextWindow: 200000,
      thinkingFormat: "claude-budget",
    });
  });
});
