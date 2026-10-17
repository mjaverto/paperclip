import { describe, expect, it } from "vitest";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { priceCatalogReceipt, CATALOG_PRICING_VERSION } from "./catalog-pricing.js";
import { priceAnthropicReceipt } from "./anthropic-pricing.js";
import { priceCodexReceipt } from "./codex-pricing.js";

const receipt: AdapterUsageCheckpoint = {
  complete: true, usageBasis: "per_run", provider: "deepseek", biller: "deepseek",
  billingType: "metered_api", model: "deepseek-chat", costUsd: null, costStatus: "unpriced",
  usage: { inputTokens: 800_000, cachedInputTokens: 200_000, outputTokens: 100_000 },
};

describe("catalog fallback receipt pricing", () => {
  it("estimates unpriced receipts from the vendored catalog with rate-card provenance", () => {
    const priced = priceCatalogReceipt(receipt);
    // 800k uncached @ $0.14 + 200k cached @ $0.028 + 100k output @ $0.28 per Mtok.
    expect(priced.costUsdExact).toBe("0.145600000");
    expect(priced.costStatus).toBe("estimated");
    expect(priced.pricingProvenance).toMatchObject({ source: "rate_card", version: CATALOG_PRICING_VERSION });
    expect(priced.usage).toBe(receipt.usage);
    expect(receipt.costStatus).toBe("unpriced");
  });

  it("treats the legacy `api` billing type as metered", () => {
    expect(priceCatalogReceipt({ ...receipt, billingType: "api" }).costStatus).toBe("estimated");
  });

  it("keeps unpriced when the catalog has no price for the model", () => {
    const original = { ...receipt, model: "some-totally-made-up-model-xyz" };
    expect(priceCatalogReceipt(original)).toBe(original);
  });

  it.each([
    { complete: false }, { billingType: "unknown" }, { billingType: null }, { billingType: "subscription_included" },
    { billingType: "fixed" }, { provider: "unknown" }, { provider: null }, { model: null },
    { usageBasis: "session_cumulative" }, { costUsd: 0.12 }, { costUsdExact: "0.12" }, { cacheAdjustedCostUsd: 0.12 },
    { usageByModel: [{ model: "other", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }] },
    { usage: undefined }, { usage: { inputTokens: -1, outputTokens: 1 } },
    // Providers owned by the reviewed Anthropic/OpenAI rate cards stay unpriced when those decline.
    { provider: "anthropic", model: "claude-opus-4-6" }, { provider: "openai", model: "gpt-4o" },
  ] as Partial<AdapterUsageCheckpoint>[])("preserves ineligible or already priced receipts: %j", (override) => {
    const original = { ...receipt, ...override };
    expect(priceCatalogReceipt(original)).toBe(original);
  });

  it("does not re-price a receipt the Anthropic or Codex rate cards already priced", () => {
    const anthropic = priceAnthropicReceipt({
      complete: true, usageBasis: "per_run", provider: "anthropic", biller: "anthropic", billingType: "metered_api",
      model: "claude-sonnet-5", usage: { inputTokens: 22462, cachedInputTokens: 208218, cacheWriteTokens: 22450, outputTokens: 2450 },
    });
    expect(anthropic.costStatus).toBe("estimated");
    expect(priceCatalogReceipt(anthropic)).toBe(anthropic);
    const codex = priceCodexReceipt({
      complete: true, usageBasis: "per_run", provider: "openai", biller: "openai", billingType: "metered_api",
      model: "gpt-6-sol", usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 },
    });
    expect(codex.costStatus).toBe("estimated");
    expect(priceCatalogReceipt(codex)).toBe(codex);
  });
});
