import { describe, it, expect } from "vitest";
import { classifyComboThinking } from "../../src/shared/utils/comboThinking";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// The classification gate in ComboCard must mirror what the runtime
// (thinkingUnified.applyFormat) can honor — never a stale hardcoded format
// list. These tests pin the mapping against REAL capabilities.

function caps(provider, model) {
  return getCapabilitiesForModel(provider, model);
}
function member(provider, model) {
  return { model: `${provider}/${model}`, caps: caps(provider, model) };
}

describe("combo thinking classification (runtime-truth mapping)", () => {
  it("effort mode is available whenever ANY member reasons (all formats translate effort)", () => {
    // claude-adaptive / claude-budget / gemini / zai formats all translate
    // reasoning_effort at runtime — previously a hardcoded list wrongly
    // excluded them from the effort option.
    for (const m of [
      member("anthropic", "claude-sonnet-5"),   // claude-adaptive
      member("anthropic", "claude-opus-5"),     // claude-adaptive
      member("google", "gemini-2.5-pro"),       // gemini-budget
      member("zai", "glm-5.2"),                 // zai
      member("openai", "gpt-5.3"),              // openai
      member("deepseek", "deepseek-v4"),        // deepseek
    ]) {
      const r = classifyComboThinking([m]);
      expect(r.hasEffort, `${m.model} (fmt=${m.caps.thinkingFormat})`).toBe(true);
    }
  });

  it("extended (budget) mode requires a budget-capable format", () => {
    // Budget-capable: claude-adaptive, claude-budget, gemini, zai, qwen...
    expect(classifyComboThinking([member("anthropic", "claude-sonnet-5")]).hasExtended).toBe(true);
    expect(classifyComboThinking([member("anthropic", "claude-opus-5")]).hasExtended).toBe(true);
    expect(classifyComboThinking([member("google", "gemini-2.5-pro")]).hasExtended).toBe(true);
    expect(classifyComboThinking([member("zai", "glm-5.2")]).hasExtended).toBe(true);
    // OpenAI-style effort formats drop a budget config → not extended-capable.
    expect(classifyComboThinking([member("openai", "gpt-5.3")]).hasExtended).toBe(false);
    expect(classifyComboThinking([member("deepseek", "deepseek-v4")]).hasExtended).toBe(false);
  });

  it("unknown thinkingFormat is treated permissively (legacy/back-compat)", () => {
    const unknown = { model: "custom/x", caps: { reasoning: true, thinkingFormat: undefined } };
    const r = classifyComboThinking([unknown]);
    expect(r.hasEffort).toBe(true);
    expect(r.hasExtended).toBe(true);
  });

  it("hasMaxEffort reflects real caps (gpt-5.6-sol yes, gpt-5.3 no)", () => {
    expect(classifyComboThinking([member("codex", "gpt-5.6-sol")]).hasMaxEffort).toBe(true);
    expect(classifyComboThinking([member("openai", "gpt-5.3")]).hasMaxEffort).toBe(false);
  });

  it("unsupportedForCurrent warns for extended mode with effort-only members", () => {
    const combo = [member("anthropic", "claude-sonnet-5"), member("openai", "gpt-5.3")];
    const effort = classifyComboThinking(combo, "effort");
    const extended = classifyComboThinking(combo, "extended");
    expect(effort.unsupportedForCurrent).toEqual([]); // everyone honors effort
    expect(extended.unsupportedForCurrent.map((m) => m.model)).toEqual(["openai/gpt-5.3"]);
  });

  it("non-reasoning members are flagged unresolvable, not silently treated as supporting", () => {
    const combo = [
      member("anthropic", "claude-sonnet-5"),
      { model: "openai/gpt-4o-mini", caps: caps("openai", "gpt-4o-mini") },
    ];
    const r = classifyComboThinking(combo, "extended");
    expect(r.unresolvableModels.map((m) => m.model)).toEqual(["openai/gpt-4o-mini"]);
  });
});
