'use strict';

/**
 * Model metadata cache with TTL support.
 *
 * Mirrors `kiro/cache.py`. JS is single-threaded, so no lock is needed.
 */

const { MODEL_CACHE_TTL, DEFAULT_MAX_INPUT_TOKENS } = require('./config');

class ModelInfoCache {
  /**
   * Creates a model cache.
   *
   * @param {number} [cacheTtl=MODEL_CACHE_TTL] - Cache TTL in seconds
   */
  constructor(cacheTtl = MODEL_CACHE_TTL) {
    this._cache = new Map();
    this._lastUpdate = null;
    this._cacheTtl = cacheTtl;
  }

  /**
   * Replaces the cache contents with new model data.
   *
   * @param {Array<object>} modelsData - Model list, each entry needs "modelId"
   */
  update(modelsData) {
    this._cache = new Map();
    for (const model of modelsData) {
      if (model && model.modelId) {
        this._cache.set(model.modelId, model);
      }
    }
    this._lastUpdate = Date.now() / 1000;
  }

  /**
   * Returns model information.
   *
   * @param {string} modelId - Model ID
   * @returns {object|null} Model info or null
   */
  get(modelId) {
    return this._cache.get(modelId) || null;
  }

  /**
   * Checks if the model exists in the dynamic cache.
   *
   * @param {string} modelId - Model ID
   * @returns {boolean} True if the model exists
   */
  isValidModel(modelId) {
    return this._cache.has(modelId);
  }

  /**
   * Adds a hidden model (undocumented but functional models).
   *
   * @param {string} displayName - Model name to display
   * @param {string} internalId - Internal Kiro model ID
   */
  addHiddenModel(displayName, internalId) {
    if (!this._cache.has(displayName)) {
      this._cache.set(displayName, {
        modelId: displayName,
        modelName: displayName,
        description: `Hidden model (internal: ${internalId})`,
        tokenLimits: { maxInputTokens: DEFAULT_MAX_INPUT_TOKENS },
        _internalId: internalId,
        _isHidden: true,
      });
    }
  }

  /**
   * Returns maxInputTokens for a model.
   *
   * @param {string} modelId - Model ID
   * @returns {number} Maximum input tokens (default if unknown)
   */
  getMaxInputTokens(modelId) {
    const model = this._cache.get(modelId);
    if (model && model.tokenLimits && model.tokenLimits.maxInputTokens) {
      return model.tokenLimits.maxInputTokens;
    }
    return DEFAULT_MAX_INPUT_TOKENS;
  }

  /**
   * @returns {boolean} True if the cache is empty
   */
  isEmpty() {
    return this._cache.size === 0;
  }

  /**
   * @returns {boolean} True if the cache is stale (TTL passed or never updated)
   */
  isStale() {
    if (this._lastUpdate === null) return true;
    return Date.now() / 1000 - this._lastUpdate > this._cacheTtl;
  }

  /**
   * @returns {string[]} All model IDs in the cache
   */
  getAllModelIds() {
    return Array.from(this._cache.keys());
  }

  /** @returns {number} Number of models in the cache */
  get size() {
    return this._cache.size;
  }

  /** @returns {number|null} Last update timestamp (seconds) or null */
  get lastUpdateTime() {
    return this._lastUpdate;
  }
}

module.exports = { ModelInfoCache };