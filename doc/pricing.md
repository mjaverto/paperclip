# Pricing

The pricing service is a fallback estimator that converts `(provider, model, usage)` to USD when an adapter run reports tokens but no cost.

**Key principle: fallback only, never override.** A reported `costUsd` / `costUsdExact` / `cacheAdjustedCostUsd` always wins, and the reviewed Anthropic and OpenAI rate cards (`server/src/services/anthropic-pricing.ts`, `codex-pricing.ts`) keep ownership of their providers. If the catalog also has no entry, the receipt keeps the existing `costStatus: "unpriced"` — it is never coerced to `0`.

---

## Where it lives

- `packages/pricing/` — the workspace package.
  - `src/index.ts` — `priceUsd(...)` entry point.
  - `src/normalize.ts` — provider/model identifier normalization, alias handling.
  - `src/aliases.ts` — Bedrock region map and other static alias rules.
  - `src/refresh.ts` — script that rebuilds `data/catalog.json`.
  - `data/catalog.json` — vendored snapshot, committed to the repo.
- Server consumer: `server/src/services/catalog-pricing.ts` (`priceCatalogReceipt`), chained after `priceCodexReceipt` / `priceAnthropicReceipt` in `server/src/services/usage-receipts.ts`. It applies only to complete, per-run receipts with token counts, no cost, an explicit USD-denominated billing type, and a provider other than `anthropic` / `openai`. A hit sets `costStatus: "estimated"` and `pricingProvenance: { source: "rate_card", version: "pricing-catalog/v1", ... }`; cache writes are billed at the input rate.

Runtime never makes a network call. All lookups read the vendored snapshot.

---

## Catalog shape

Each entry in `data/catalog.json` is keyed by the normalized `${provider}/${model}` and has the following shape:

```ts
type CatalogEntry = {
  // Required pricing rates, in USD per million tokens.
  input_per_mtok: number;
  cached_input_per_mtok: number;
  output_per_mtok: number;

  // Optional rates. Omitted when the provider does not charge separately.
  cache_write_per_mtok?: number;   // Anthropic-style cache writes
  reasoning_per_mtok?: number;     // Claude extended thinking, o1-style reasoning

  // Optional long-context tier. When usage exceeds tier_threshold_tokens,
  // input/output bill at the over_threshold_* rates instead.
  tier_threshold_tokens?: number;
  over_threshold_input_per_mtok?: number;
  over_threshold_output_per_mtok?: number;

  // Optional alias list. Keys in this array resolve to the parent entry.
  // Used for Bedrock regional prefixes (us./eu./apac.) — see "Known
  // approximations" below.
  region_aliases?: string[];

  // Provenance for catalog diffs.
  source: "models.dev" | "litellm";
};
```

Example:

```json
{
  "anthropic/claude-opus-4-6": {
    "input_per_mtok": 15.00,
    "cached_input_per_mtok": 1.50,
    "cache_write_per_mtok": 18.75,
    "output_per_mtok": 75.00,
    "reasoning_per_mtok": 75.00,
    "region_aliases": ["us.anthropic.claude-opus-4-6", "eu.anthropic.claude-opus-4-6"],
    "source": "models.dev"
  }
}
```

---

## Sources

The catalog is built from two MIT-licensed public sources:

1. **[models.dev](https://models.dev/api.json)** — primary. Public CDN-cached JSON, no auth, no rate limits.
2. **[LiteLLM `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)** — fallback for any model not in models.dev.

Attribution lives in `THIRD_PARTY_LICENSES.md` at the repo root.

---

## Refresh process

The catalog is regenerated weekly by a GitHub Action (`.github/workflows/pricing-refresh.yml`) which opens a **pull request** with the diff for review. We do not auto-merge — the diff is small enough to eyeball, and a bad upstream change should not silently land.

Manual refresh:

```sh
pnpm --filter @paperclipai/pricing refresh
```

This fetches both sources, normalizes them, writes `packages/pricing/data/catalog.json`, and exits. The diff against the previous snapshot is the reviewable artifact.

---

## Lookup semantics

`priceUsd({ provider, model, inputTokens, outputTokens, cachedInputTokens?, reasoningTokens?, billingType? })` returns `number | null` (USD):

1. **Normalize** the key. `normalize.ts` strips redundant provider prefixes, lowercases, resolves aliases, handles Bedrock regional IDs, and tolerates `model = null` (acpx-local). The lookup key is `${provider}/${model}` after normalization.
2. **Check the `billingType` allowlist.** Only `["metered_api", "credits", "unknown"]` are eligible. Anything else returns `null` immediately without a catalog read. See "billingType eligibility" below.
3. **Look up the catalog entry.** Miss → return `null`.
4. **Compute USD** from the entry and the token counts. `inputTokens` is the total prompt size including cache reads; cache reads are billed at the cached rate and the remainder at the input rate. If `tier_threshold_tokens` is set and input exceeds it, the over-threshold rates apply. A run with all-zero counts prices to `0`.

---

## billingType eligibility

`priceUsd` only prices calls whose `billingType` is `metered_api`, `credits`, `unknown`, or unset. Subscription (`subscription`, `subscription_included`, `subscription_overage`) and `fixed` calls return `null`: subscription cost is not USD-denominated per run, so a token-derived number would be misleading.

The server estimator (below) is stricter than `priceUsd`: it requires an explicit `api`, `metered_api` or `credits` billing type on the receipt, so a receipt whose billing mode is `unknown` stays `unpriced`, matching the Anthropic and OpenAI rate cards.

---

## Known approximations

These are real and intentional. Documented here so maintainers and users do not have to rediscover them.

### Bedrock region collapse

Bedrock model IDs like `us.anthropic.claude-opus-4-6-v1` and `eu.anthropic.claude-opus-4-6-v1` are collapsed to the base `anthropic/claude-opus-4-6` rate via `region_aliases`. Bedrock's regional surcharges (e.g. EU and APAC are typically priced higher than US) are **not** modeled. If you operate primarily in a non-US region and need exact billing, reconcile against the AWS bill rather than relying on this catalog.

### opencode-local reasoning merge

`packages/adapters/opencode-local/src/server/parse.ts` merges reasoning tokens into `outputTokens` before reporting usage. When the catalog estimates an opencode row, those merged reasoning tokens are priced at the **output** rate. For Claude extended-thinking runs (where `reasoning_per_mtok` may differ from output, and where reasoning volume can dominate output) this **undercounts** real spend. Fixing it requires opencode to emit reasoning tokens separately.

### cursor-local heuristic provider

`resolveProviderFromModel()` in cursor-local can return `provider = "cursor"` when it cannot identify the upstream provider. There is no catalog entry under `cursor/*`, so those rows stay unpriced. This is preferable to guessing the wrong provider.

### acpx-local null model

The acpx adapter hard-codes `model: null`, `provider: "acpx"`. These rows are always unpriced by design. `normalize.ts` tolerates the null model — it does not throw — but no catalog lookup is attempted.
