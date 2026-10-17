import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { catalog } from "@paperclipai/pricing";
import { priceCatalogReceipt, catalogPricingVersion } from "./catalog-pricing.js";
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
    expect(priced.pricingProvenance).toMatchObject({ source: "rate_card", version: catalogPricingVersion() });
    expect(priced.usage).toBe(receipt.usage);
    expect(receipt.costStatus).toBe("unpriced");
  });

  it("pins the catalog snapshot in the provenance version", () => {
    expect(catalogPricingVersion()).toMatch(/^pricing-catalog\/[0-9a-f]{12}$/);
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

describe("tiered catalog models", () => {
  const KEY = "tierprov/tiered-model";
  const tiered: AdapterUsageCheckpoint = {
    complete: true, usageBasis: "per_run", provider: "tierprov", billingType: "metered_api", model: "tiered-model",
    usage: { inputTokens: 300_000, outputTokens: 100_000 },
  };
  beforeAll(() => {
    catalog[KEY] = {
      input_per_mtok: 3, cached_input_per_mtok: 0.3, output_per_mtok: 15,
      tier_threshold_tokens: 200_000, over_threshold_input_per_mtok: 6, over_threshold_output_per_mtok: 22.5, source: "litellm",
    };
  });
  afterAll(() => {
    delete catalog[KEY];
  });

  it("stays unpriced when a run exceeds the threshold and the receipt does not report its context tier", () => {
    expect(priceCatalogReceipt(tiered)).toBe(tiered);
  });

  it("bills at base rates for a short-tier run and records the tier", () => {
    const priced = priceCatalogReceipt({ ...tiered, pricingContext: { contextTier: "short" } });
    // 300k @ 3 + 100k @ 15 per Mtok.
    expect(priced.costUsdExact).toBe("2.400000000");
    expect(priced.pricingProvenance).toMatchObject({ contextTier: "short" });
  });

  it("bills the whole request at the premium rates for a long-tier run", () => {
    const priced = priceCatalogReceipt({ ...tiered, pricingContext: { contextTier: "long" } });
    // 300k @ 6 + 100k @ 22.5 per Mtok.
    expect(priced.costUsdExact).toBe("4.050000000");
  });
});
