'use strict';

/**
 * Dynamic model resolution system.
 *
 * Implements a 4-layer resolution pipeline:
 * 1. Normalize Name - convert client formats to Kiro format (dashes→dots, strip dates)
 * 2. Check Dynamic Cache - models from the model list
 * 3. Check Hidden Models - manual config for undocumented models
 * 4. Pass-through - unknown models sent to Kiro (let Kiro decide)
 *
 * Key principle: we are a gateway, not a gatekeeper. Kiro API is the final arbiter.
 * Mirrors `kiro/model_resolver.py`.
 */

const { FALLBACK_MODELS } = require('./config');

const VALID_RUNTIME_MODEL_IDS = new Set(FALLBACK_MODELS.map((m) => m.modelId));

/**
 * Pass-through function for the runtime endpoint model ID.
 *
 * Returns the model as-is and lets the Kiro API decide if it exists.
 *
 * @param {string} normalized - Normalized model name
 * @returns {string} Model name as-is
 */
function toRuntimeModelId(normalized) {
  return normalized;
}

/**
 * Normalizes a client model name to Kiro format.
 *
 * Transformations applied:
 * 1. claude-haiku-4-5 → claude-haiku-4.5 (dash to dot for minor version)
 * 2. claude-haiku-4-5-20251001 → claude-haiku-4.5 (strip date suffix)
 * 3. claude-sonnet-4-20250514 → claude-sonnet-4 (strip date, no minor)
 * 4. claude-3-7-sonnet → claude-3.7-sonnet (legacy format normalization)
 * 5. claude-4.5-opus-high → claude-opus-4.5 (inverted format with suffix)
 *
 * @param {string} name - External model name from the client
 * @returns {string} Normalized model name in Kiro format
 */
function normalizeModelName(name) {
  if (!name) return name;

  // Strip context window suffix (e.g., [1m], [200k])
  name = name.replace(/\[\d+[mk]\]$/i, '');

  const nameLower = name.toLowerCase();

  // Pattern 1: Standard format - claude-{family}-{major}-{minor}(-{suffix})?
  const standardPattern = /^(claude-(?:haiku|sonnet|opus)-\d+)-(\d{1,2})(?:-(?:\d{8}|latest|\d+))?$/;
  let match = nameLower.match(standardPattern);
  if (match) {
    return `${match[1]}.${match[2]}`;
  }

  // Pattern 2: Standard format without minor - claude-{family}-{major}(-{date})?
  const noMinorPattern = /^(claude-(?:haiku|sonnet|opus)-\d+)(?:-\d{8})?$/;
  match = nameLower.match(noMinorPattern);
  if (match) {
    return match[1];
  }

  // Pattern 3: Legacy format - claude-{major}-{minor}-{family}(-{suffix})?
  const legacyPattern = /^(claude)-(\d+)-(\d+)-(haiku|sonnet|opus)(?:-(?:\d{8}|latest|\d+))?$/;
  match = nameLower.match(legacyPattern);
  if (match) {
    return `${match[1]}-${match[2]}.${match[3]}-${match[4]}`;
  }

  // Pattern 4: Already normalized with dot but has date suffix
  const dotWithDatePattern = /^(claude-(?:\d+\.\d+-)?(?:haiku|sonnet|opus)(?:-\d+\.\d+)?)-\d{8}$/;
  match = nameLower.match(dotWithDatePattern);
  if (match) {
    return match[1];
  }

  // Pattern 5: Inverted format with suffix - claude-{major}.{minor}-{family}-{suffix}
  const invertedWithSuffixPattern = /^claude-(\d+)\.(\d+)-(haiku|sonnet|opus)-(.+)$/;
  match = nameLower.match(invertedWithSuffixPattern);
  if (match) {
    return `claude-${match[3]}-${match[1]}.${match[2]}`;
  }

  // No transformation needed - return as-is (preserving original case for passthrough)
  return name;
}

/**
 * Gets the model ID to send to Kiro API.
 *
 * Normalizes the name and checks hidden models.
 *
 * @param {string} modelName - External model name from the client
 * @param {object} hiddenModels - Map of display names to internal Kiro IDs
 * @returns {string} Model ID to send to Kiro API
 */
function getModelIdForKiro(modelName, hiddenModels) {
  const normalized = normalizeModelName(modelName);
  const internal = hiddenModels[normalized] !== undefined ? hiddenModels[normalized] : normalized;
  return toRuntimeModelId(internal);
}

/**
 * Extracts the model family from a model name.
 *
 * @param {string} modelName - Model name
 * @returns {string|null} Family ("haiku", "sonnet", "opus") or null
 */
function extractModelFamily(modelName) {
  const match = /(haiku|sonnet|opus)/i.exec(modelName);
  return match ? match[1].toLowerCase() : null;
}

class ModelResolver {
  /**
   * Dynamic model resolver with normalization and pass-through.
   *
   * @param {ModelInfoCache} cache - Model cache for dynamic lookup
   * @param {object} [hiddenModels={}] - Map of display names to internal Kiro IDs
   * @param {object} [aliases={}] - Map of alias names to real model IDs
   * @param {string[]} [hiddenFromList=[]] - Model IDs to hide from /v1/models
   */
  constructor(cache, hiddenModels = {}, aliases = {}, hiddenFromList = []) {
    this.cache = cache;
    this.hiddenModels = hiddenModels || {};
    this.aliases = aliases || {};
    this.hiddenFromList = new Set(hiddenFromList || []);
  }

  /**
   * Resolves an external model name to an internal Kiro ID.
   *
   * Never throws - unknown models are passed through to Kiro.
   *
   * @param {string} externalModel - Model name from the client request
   * @returns {{internalId: string, source: string, originalRequest: string,
   *            normalized: string, isVerified: boolean}}
   */
  resolve(externalModel) {
    // Layer 0: Resolve alias (if exists)
    let resolvedModel = this.aliases[externalModel];
    if (resolvedModel === undefined) resolvedModel = externalModel;

    // Layer 1: Normalize name
    const normalized = normalizeModelName(resolvedModel);

    // Layer 2: Check dynamic cache
    if (this.cache.isValidModel(normalized)) {
      return {
        internalId: toRuntimeModelId(normalized),
        source: 'cache',
        originalRequest: externalModel,
        normalized,
        isVerified: true,
      };
    }

    // Layer 3: Check hidden models
    if (Object.prototype.hasOwnProperty.call(this.hiddenModels, normalized)) {
      const internalId = this.hiddenModels[normalized];
      return {
        internalId: toRuntimeModelId(internalId),
        source: 'hidden',
        originalRequest: externalModel,
        normalized,
        isVerified: true,
      };
    }

    // Layer 4: Pass-through - let Kiro decide
    return {
      internalId: toRuntimeModelId(normalized),
      source: 'passthrough',
      originalRequest: externalModel,
      normalized,
      isVerified: false,
    };
  }

  /**
   * Gets all available model IDs for /v1/models.
   *
   * @returns {string[]} Sorted list of model IDs
   */
  getAvailableModels() {
    const models = new Set(this.cache.getAllModelIds());
    for (const displayName of Object.keys(this.hiddenModels)) {
      models.add(displayName);
    }
    for (const id of this.hiddenFromList) {
      models.delete(id);
    }
    for (const alias of Object.keys(this.aliases)) {
      models.add(alias);
    }
    return Array.from(models).sort();
  }

  /**
   * Gets available models filtered by family.
   *
   * @param {string} family - Model family ('haiku', 'sonnet', 'opus')
   * @returns {string[]} Models from the given family
   */
  getModelsByFamily(family) {
    return this.getAvailableModels().filter((m) => m.toLowerCase().includes(family.toLowerCase()));
  }

  /**
   * Gets available models from the same family (for error suggestions).
   *
   * @param {string} modelName - The requested model name
   * @returns {string[]} Suggestions
   */
  getSuggestionsForModel(modelName) {
    const family = extractModelFamily(modelName);
    if (family) {
      return this.getModelsByFamily(family);
    }
    return this.getAvailableModels();
  }
}

module.exports = {
  VALID_RUNTIME_MODEL_IDS,
  toRuntimeModelId,
  normalizeModelName,
  getModelIdForKiro,
  extractModelFamily,
  ModelResolver,
};