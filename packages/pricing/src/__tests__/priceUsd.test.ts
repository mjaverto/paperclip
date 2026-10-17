import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalog, catalogVersion, priceUsd } from '../index.js';

/**
 * priceUsd integration tests against the vendored catalog snapshot.
 *
 * These tests deliberately reference real catalog keys (`anthropic/claude-opus-4-6`,
 * `anthropic/claude-4-sonnet-20250514`) so we both exercise the lookup path and
 * sanity-check that Lane B's snapshot still contains the entries Lane D will
 * rely on. If the snapshot rotates a key out from under us, the test will fail
 * loudly.
 */

describe('priceUsd', () => {
  it('returns null for unknown models', () => {
    expect(
      priceUsd({
        provider: 'cursor',
        model: 'some-totally-made-up-model-xyz',
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).toBeNull();
  });

  it('returns null when model is null (acpx-local emits provider="acpx", model=null)', () => {
    expect(
      priceUsd({
        provider: 'acpx',
        model: null,
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).toBeNull();
  });

  it('returns null when provider is null', () => {
    expect(
      priceUsd({
        provider: null,
        model: 'claude-opus-4-6',
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).toBeNull();
  });

  it('returns null when billingType is outside the allowlist (subscription_included)', () => {
    expect(
      priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        billingType: 'subscription_included',
      }),
    ).toBeNull();
  });

  it('returns null when billingType is "subscription_overage"', () => {
    expect(
      priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        billingType: 'subscription_overage',
      }),
    ).toBeNull();
  });

  it('returns null when billingType is "fixed"', () => {
    expect(
      priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        billingType: 'fixed',
      }),
    ).toBeNull();
  });

  it('treats undefined billingType as allowed (default)', () => {
    const result = priceUsd({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(0);
  });

  it('treats "metered_api" / "credits" / "unknown" billingType as allowed', () => {
    for (const billingType of ['metered_api', 'credits', 'unknown'] as const) {
      const result = priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1_000_000,
        outputTokens: 0,
        billingType,
      });
      expect(result, `billingType=${billingType}`).not.toBeNull();
      expect(result, `billingType=${billingType}`).toBeGreaterThan(0);
    }
  });

  it('returns 0 for a genuine zero-usage run (distinguishes free from unpriced)', () => {
    expect(
      priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  it('prices a basic claude-opus-4-6 run at the catalog rate', () => {
    const entry = catalog['anthropic/claude-opus-4-6']!;
    expect(entry).toBeDefined();
    const result = priceUsd({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 1M input @ input_per_mtok + 1M output @ output_per_mtok
    expect(result).toBeCloseTo(entry.input_per_mtok + entry.output_per_mtok, 6);
  });

  it('collapses Bedrock model IDs onto the base catalog entry', () => {
    const entry = catalog['anthropic/claude-opus-4-6']!;
    const result = priceUsd({
      provider: 'anthropic',
      model: 'us.anthropic.claude-opus-4-6-v1',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(result).toBeCloseTo(entry.input_per_mtok, 6);
  });

  it('does not double-prefix already-qualified model strings (opencode-local shape)', () => {
    const entry = catalog['anthropic/claude-sonnet-4-6']!;
    expect(entry).toBeDefined();
    const result = priceUsd({
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(result).toBeCloseTo(entry.input_per_mtok, 6);
  });

  it('prices cached input tokens at the cached rate, not the input rate', () => {
    const entry = catalog['anthropic/claude-opus-4-6']!;
    expect(entry.cached_input_per_mtok!).toBeLessThan(entry.input_per_mtok);

    // 1M total input tokens, 800k of which are cache reads.
    const result = priceUsd({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 800_000,
    });

    // Expected: 200k @ input rate + 800k @ cached rate.
    const expected = (200_000 / 1_000_000) * entry.input_per_mtok +
      (800_000 / 1_000_000) * entry.cached_input_per_mtok!;
    expect(result).toBeCloseTo(expected, 6);
  });

  it('charges nothing for cached tokens that exceed inputTokens (defensive)', () => {
    // If an upstream reports cached > input we should still produce a finite,
    // non-negative result (billedInput is clamped to 0).
    const result = priceUsd({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 100,
      outputTokens: 0,
      cachedInputTokens: 1000,
    });
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
  });

  describe('tier threshold pricing (per-request tiers, never split on a run aggregate)', () => {
    // A synthetic entry keeps these assertions deterministic as the vendored snapshot rotates.
    const KEY = 'tierprov/tiered-model';
    const THRESHOLD = 200_000;
    const input = { provider: 'tierprov', model: 'tiered-model' };

    beforeAll(() => {
      catalog[KEY] = {
        input_per_mtok: 3,
        cached_input_per_mtok: 0.3,
        output_per_mtok: 15,
        tier_threshold_tokens: THRESHOLD,
        over_threshold_input_per_mtok: 6,
        over_threshold_output_per_mtok: 22.5,
        source: 'litellm',
      };
    });
    afterAll(() => {
      delete catalog[KEY];
    });

    it('bills at base rates when total input is at or below the threshold', () => {
      const result = priceUsd({ ...input, inputTokens: THRESHOLD, outputTokens: 1_000_000 });
      expect(result).toBeCloseTo((THRESHOLD / 1_000_000) * 3 + 15, 6);
    });

    it('returns unpriced above the threshold when the request tier is unknown', () => {
      expect(priceUsd({ ...input, inputTokens: THRESHOLD + 1, outputTokens: 10 })).toBeNull();
    });

    it('bills a short-tier run at base rates however large the aggregate is', () => {
      const result = priceUsd({ ...input, inputTokens: 1_000_000, outputTokens: 1_000_000, contextTier: 'short' });
      expect(result).toBeCloseTo(3 + 15, 6);
    });

    it('bills the whole request, not just the excess, at over-threshold rates for a long-tier run', () => {
      const result = priceUsd({
        ...input,
        inputTokens: 1_000_000,
        cachedInputTokens: 500_000,
        outputTokens: 1_000_000,
        contextTier: 'long',
      });
      // 500k uncached @ 6 + 500k cached @ 0.3 (no long-context cache premium) + 1M output @ 22.5.
      expect(result).toBeCloseTo(0.5 * 6 + 0.5 * 0.3 + 22.5, 6);
    });

    it('returns unpriced for a long-tier run when the entry has no over-threshold rates', () => {
      catalog[KEY] = { ...catalog[KEY]!, over_threshold_input_per_mtok: undefined, over_threshold_output_per_mtok: undefined };
      expect(priceUsd({ ...input, inputTokens: 10, outputTokens: 10, contextTier: 'long' })).toBeNull();
    });

    it('falls back to the input rate when the catalog has no cached rate', () => {
      catalog[KEY] = { ...catalog[KEY]!, cached_input_per_mtok: undefined, tier_threshold_tokens: undefined };
      expect(priceUsd({ ...input, inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(3, 6);
    });
  });

  describe('catalogVersion', () => {
    it('is a stable 12-char content hash', () => {
      expect(catalogVersion()).toMatch(/^[0-9a-f]{12}$/);
      expect(catalogVersion()).toBe(catalogVersion());
    });
  });

  describe('reasoning tokens', () => {
    it('prices reasoning tokens separately when entry has reasoning_per_mtok', () => {
      // Find an entry that has reasoning_per_mtok defined.
      const entryKey = Object.entries(catalog).find(
        ([, e]) => typeof e.reasoning_per_mtok === 'number' && e.reasoning_per_mtok > 0,
      )?.[0];
      if (!entryKey) return; // skip if snapshot lacks any reasoning entries
      const entry = catalog[entryKey]!;
      const slash = entryKey.indexOf('/');
      const provider = entryKey.slice(0, slash);
      const model = entryKey.slice(slash + 1);

      const result = priceUsd({
        provider,
        model,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 1_000_000,
      });
      expect(result).toBeCloseTo(entry.reasoning_per_mtok!, 6);
    });

    it('ignores reasoningTokens when entry has no reasoning_per_mtok (caller folded into output)', () => {
      const entry = catalog['anthropic/claude-opus-4-6']!;
      // Confirm precondition for this test.
      expect(entry.reasoning_per_mtok).toBeUndefined();

      const result = priceUsd({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 0,
        outputTokens: 1_000_000,
        reasoningTokens: 500_000, // should NOT be billed separately
      });
      expect(result).toBeCloseTo(entry.output_per_mtok, 6);
    });
  });
});
