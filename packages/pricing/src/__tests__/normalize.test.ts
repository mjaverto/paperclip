import { describe, expect, it } from 'vitest';
import { entryFromLiteLLM, entryFromModelsDev, lookupKey, mergeCatalogs, normalizeKey } from '../normalize.js';
import { resolveBedrockAlias, STATIC_ALIASES } from '../aliases.js';

describe('normalizeKey', () => {
  it('lowercases and joins provider/model', () => {
    expect(normalizeKey('Anthropic', 'Claude-Opus-4-6')).toBe('anthropic/claude-opus-4-6');
  });

  it('does not double-prefix when model is already provider-qualified', () => {
    expect(normalizeKey('anthropic', 'anthropic/claude-sonnet-4-6')).toBe(
      'anthropic/claude-sonnet-4-6',
    );
  });

  it('returns empty string when model is missing', () => {
    expect(normalizeKey('anthropic', '')).toBe('');
  });
});

describe('resolveBedrockAlias', () => {
  it('collapses us. region prefix and -v1 suffix', () => {
    expect(resolveBedrockAlias('anthropic/us.anthropic.claude-opus-4-6-v1')).toBe(
      'anthropic/claude-opus-4-6',
    );
  });

  it('collapses eu. region prefix and -v1:0 suffix', () => {
    expect(resolveBedrockAlias('anthropic/eu.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(
      'anthropic/claude-sonnet-4-5-20250929',
    );
  });

  it('returns null when no region prefix is present', () => {
    expect(resolveBedrockAlias('anthropic/claude-opus-4-6')).toBeNull();
  });

  it('returns null when no slash is present', () => {
    expect(resolveBedrockAlias('us.anthropic.claude-opus-4-6')).toBeNull();
  });
});

describe('lookupKey', () => {
  it('returns null when provider is null', () => {
    expect(lookupKey(null, 'claude-sonnet-4-6')).toBeNull();
  });

  it('returns null when model is null (acpx-local case)', () => {
    expect(lookupKey('acpx', null)).toBeNull();
  });

  it('returns null when model is empty string', () => {
    expect(lookupKey('anthropic', '')).toBeNull();
  });

  it('does not double-prefix when model already includes provider (opencode-local)', () => {
    expect(lookupKey('anthropic', 'anthropic/claude-sonnet-4-6')).toBe(
      'anthropic/claude-sonnet-4-6',
    );
  });

  it('builds simple provider/model keys', () => {
    expect(lookupKey('openai', 'gpt-5.5')).toBe('openai/gpt-5.5');
  });

  it('collapses Bedrock region-prefixed model strings emitted by claude-local', () => {
    // claude-local execute.ts sets provider="anthropic", model="us.anthropic.claude-opus-4-6-v1".
    expect(lookupKey('anthropic', 'us.anthropic.claude-opus-4-6-v1')).toBe(
      'anthropic/claude-opus-4-6',
    );
  });

  it('applies STATIC_ALIASES after normalization', () => {
    // Sanity-check the curated alias map round-trips through lookupKey.
    const aliasFrom = Object.keys(STATIC_ALIASES)[0];
    if (!aliasFrom) return; // map may be empty in some snapshots
    const expected = STATIC_ALIASES[aliasFrom];
    const [provider, model] = aliasFrom.split('/');
    expect(lookupKey(provider!, model!)).toBe(expected);
  });

  it('lowercases provider and model', () => {
    expect(lookupKey('Anthropic', 'Claude-Sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
  });
});

describe('catalog entry construction', () => {
  it('leaves the cached rate unset when models.dev omits cache_read', () => {
    const entry = entryFromModelsDev({ providerId: 'p', modelId: 'm', cost: { input: 2, output: 8 } });
    expect(entry).toEqual({ input_per_mtok: 2, output_per_mtok: 8, source: 'models.dev' });
  });

  it('maps models.dev context_over_200k into the per-request tier', () => {
    const entry = entryFromModelsDev({
      providerId: 'p',
      modelId: 'm',
      cost: { input: 2, output: 8, cache_read: 0.2, context_over_200k: { input: 4, output: 12 } },
    });
    expect(entry).toMatchObject({
      cached_input_per_mtok: 0.2,
      tier_threshold_tokens: 200_000,
      over_threshold_input_per_mtok: 4,
      over_threshold_output_per_mtok: 12,
    });
  });

  it('keeps LiteLLM\'s cached rate when models.dev has none', () => {
    const modelsDev = { 'p/m': entryFromModelsDev({ providerId: 'p', modelId: 'm', cost: { input: 2, output: 8 } })! };
    const liteLLM = {
      'p/m': entryFromLiteLLM({
        key: 'p/m',
        data: { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008, cache_read_input_token_cost: 0.0000002 },
      })!,
    };
    expect(mergeCatalogs(modelsDev, liteLLM)['p/m']).toMatchObject({ input_per_mtok: 2, cached_input_per_mtok: 0.2, source: 'merged' });
  });
});
