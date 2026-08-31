'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeModelName,
  getModelIdForKiro,
  extractModelFamily,
  ModelResolver,
} = require('../src/modelResolver');
const { ModelInfoCache } = require('../src/cache');

test('normalizeModelName: standard format with minor version', () => {
  assert.equal(normalizeModelName('claude-haiku-4-5'), 'claude-haiku-4.5');
  assert.equal(normalizeModelName('claude-sonnet-4-5'), 'claude-sonnet-4.5');
  assert.equal(normalizeModelName('claude-opus-4-5'), 'claude-opus-4.5');
});

test('normalizeModelName: strips date suffix', () => {
  assert.equal(normalizeModelName('claude-haiku-4-5-20251001'), 'claude-haiku-4.5');
  assert.equal(normalizeModelName('claude-sonnet-4-20250514'), 'claude-sonnet-4');
});

test('normalizeModelName: strips latest suffix', () => {
  assert.equal(normalizeModelName('claude-haiku-4-5-latest'), 'claude-haiku-4.5');
});

test('normalizeModelName: legacy format', () => {
  assert.equal(normalizeModelName('claude-3-7-sonnet'), 'claude-3.7-sonnet');
  assert.equal(normalizeModelName('claude-3-7-sonnet-20250219'), 'claude-3.7-sonnet');
});

test('normalizeModelName: dot format with date suffix', () => {
  assert.equal(normalizeModelName('claude-haiku-4.5-20251001'), 'claude-haiku-4.5');
  assert.equal(normalizeModelName('claude-3.7-sonnet-20250219'), 'claude-3.7-sonnet');
});

test('normalizeModelName: inverted format with suffix', () => {
  assert.equal(normalizeModelName('claude-4.5-opus-high'), 'claude-opus-4.5');
  assert.equal(normalizeModelName('claude-4.5-sonnet-low'), 'claude-sonnet-4.5');
  assert.equal(normalizeModelName('claude-4.5-opus-high-thinking'), 'claude-opus-4.5');
});

test('normalizeModelName: context window suffix is stripped', () => {
  assert.equal(normalizeModelName('claude-sonnet-4-5[200k]'), 'claude-sonnet-4.5');
});

test('normalizeModelName: passthrough for unknown models', () => {
  assert.equal(normalizeModelName('auto'), 'auto');
  assert.equal(normalizeModelName('gpt-4'), 'gpt-4');
  assert.equal(normalizeModelName(''), '');
  assert.equal(normalizeModelName(null), null);
});

test('getModelIdForKiro: hidden model mapping', () => {
  const hidden = { 'claude-3.7-sonnet': 'CLAUDE_3_7_SONNET_20250219_V1_0' };
  assert.equal(getModelIdForKiro('claude-3.7-sonnet', hidden), 'CLAUDE_3_7_SONNET_20250219_V1_0');
  assert.equal(getModelIdForKiro('claude-3-7-sonnet', hidden), 'CLAUDE_3_7_SONNET_20250219_V1_0');
  assert.equal(getModelIdForKiro('claude-haiku-4-5-20251001', hidden), 'claude-haiku-4.5');
});

test('extractModelFamily', () => {
  assert.equal(extractModelFamily('claude-haiku-4.5'), 'haiku');
  assert.equal(extractModelFamily('claude-sonnet-4-5'), 'sonnet');
  assert.equal(extractModelFamily('claude-3.7-opus'), 'opus');
  assert.equal(extractModelFamily('gpt-4'), null);
});

test('ModelResolver: alias resolution', () => {
  const cache = new ModelInfoCache();
  cache.update([{ modelId: 'claude-sonnet-4.5', tokenLimits: { maxInputTokens: 200000 } }]);

  const resolver = new ModelResolver(cache, {}, { 'auto-kiro': 'auto' }, ['auto']);

  const resolution = resolver.resolve('auto-kiro');
  assert.equal(resolution.internalId, 'auto');
  assert.equal(resolution.source, 'passthrough');
});

test('ModelResolver: cache resolution', () => {
  const cache = new ModelInfoCache();
  cache.update([{ modelId: 'claude-sonnet-4.5', tokenLimits: { maxInputTokens: 200000 } }]);

  const resolver = new ModelResolver(cache);

  const resolution = resolver.resolve('claude-sonnet-4-5');
  assert.equal(resolution.internalId, 'claude-sonnet-4.5');
  assert.equal(resolution.source, 'cache');
  assert.equal(resolution.isVerified, true);
});

test('ModelResolver: passthrough for unknown models', () => {
  const cache = new ModelInfoCache();
  const resolver = new ModelResolver(cache);

  const resolution = resolver.resolve('future-model-9.9');
  assert.equal(resolution.internalId, 'future-model-9.9');
  assert.equal(resolution.source, 'passthrough');
  assert.equal(resolution.isVerified, false);
});

test('ModelResolver: getAvailableModels excludes hidden_from_list and adds aliases', () => {
  const cache = new ModelInfoCache();
  cache.update([
    { modelId: 'auto' },
    { modelId: 'claude-sonnet-4.5', tokenLimits: { maxInputTokens: 200000 } },
  ]);

  const resolver = new ModelResolver(cache, {}, { 'auto-kiro': 'auto' }, ['auto']);

  const models = resolver.getAvailableModels();
  assert.ok(models.includes('claude-sonnet-4.5'));
  assert.ok(models.includes('auto-kiro'));
  assert.ok(!models.includes('auto'));
});

test('ModelResolver: family suggestions', () => {
  const cache = new ModelInfoCache();
  cache.update([
    { modelId: 'claude-sonnet-4.5' },
    { modelId: 'claude-opus-4.5' },
    { modelId: 'claude-haiku-4.5' },
  ]);

  const resolver = new ModelResolver(cache);
  const suggestions = resolver.getSuggestionsForModel('claude-sonnet-4.5');
  assert.deepEqual(suggestions, ['claude-sonnet-4.5']);
});