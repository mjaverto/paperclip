import { centsToUsd, unitsToCents, usdToUnits } from "@paperclipai/shared";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { catalogVersion, priceUsd } from "@paperclipai/pricing";

// Providers whose rate cards live in anthropic-pricing.ts / codex-pricing.ts.
// Those modules deliberately leave unqualified models unpriced; the vendored
// catalog must not second-guess them.
const RATE_CARD_PROVIDERS = new Set(["anthropic", "openai"]);
// Explicit USD-denominated billing modes. `unknown` stays unpriced, matching
// the strict receipt pricers: an estimate for a run that may be subscription-
// billed would invent spend.
const CATALOG_BILLING_TYPES = new Set(["api", "metered_api", "credits"]);

/** Provenance version: pins the exact catalog snapshot (content hash) a price was computed from. */
export function catalogPricingVersion(): string {
  return `pricing-catalog/${catalogVersion()}`;
}

/**
 * Fallback estimator for receipts that carry token counts but no cost and whose
 * provider is not covered by the reviewed Anthropic/OpenAI rate cards. Returns
 * the receipt unchanged (still `unpriced`) when the catalog has no price.
 */
export function priceCatalogReceipt(receipt: AdapterUsageCheckpoint): AdapterUsageCheckpoint {
  const provider = receipt.provider?.trim().toLowerCase();
  const model = receipt.model?.trim();
  if (
    !receipt.complete || !receipt.usage || receipt.usageBasis !== "per_run"
    || !provider || provider === "unknown" || RATE_CARD_PROVIDERS.has(provider) || !model
    || !CATALOG_BILLING_TYPES.has(receipt.billingType ?? "")
    || receipt.usageByModel?.length
    || receipt.costUsd != null || receipt.costUsdExact != null || receipt.cacheAdjustedCostUsd != null
  ) return receipt;
  const usage = receipt.usage;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const counts = [usage.inputTokens, cachedInputTokens, usage.outputTokens];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return receipt;
  const contextTier = receipt.pricingContext?.contextTier ?? null;
  const usd = priceUsd({
    provider,
    model,
    // Receipt inputTokens exclude cache reads; priceUsd expects the total
    // prompt size and subtracts the cached portion itself.
    inputTokens: usage.inputTokens + cachedInputTokens,
    cachedInputTokens,
    outputTokens: usage.outputTokens,
    contextTier,
    billingType: receipt.billingType === "api" ? "metered_api" : receipt.billingType,
  });
  if (usd === null || !Number.isFinite(usd)) return receipt;
  return {
    ...receipt,
    costUsdExact: centsToUsd(unitsToCents(usdToUnits(usd.toFixed(9)))),
    costStatus: "estimated",
    pricingProvenance: {
      source: "rate_card",
      version: catalogPricingVersion(),
      evidence: "Vendored models.dev + LiteLLM catalog (packages/pricing); list price estimate, not an invoice; cache writes billed at the input rate; long-context premium only when the receipt reports a long context tier",
      ...(contextTier ? { contextTier } : {}),
    },
  };
}
