'use strict';

/**
 * Lightweight leveled logger for the gateway.
 *
 * Mirrors the loguru-style logging used by the Python implementation:
 * - DEBUG: detailed diagnostic information
 * - INFO: general informational messages
 * - WARNING: warning messages (non-critical issues)
 * - ERROR: error messages (failures)
 */

const { LOG_LEVEL } = require('./config');

const LEVELS = { TRACE: 0, DEBUG: 1, INFO: 2, WARNING: 3, ERROR: 4, CRITICAL: 5 };

function normalizeLevel(level) {
  const upper = String(level || 'INFO').toUpperCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, upper) ? upper : 'INFO';
}

class Logger {
  /**
   * Creates a logger with the given minimum level.
   *
   * @param {string} [level=LOG_LEVEL] - Minimum level to emit ("TRACE".."CRITICAL")
   */
  constructor(level = LOG_LEVEL) {
    this.level = normalizeLevel(level);
  }

  /**
   * Sets the minimum level.
   *
   * @param {string} level - Minimum level to emit ("TRACE".."CRITICAL")
   */
  setLevel(level) {
    this.level = normalizeLevel(level);
  }

  _shouldLog(level) {
    return LEVELS[level] >= LEVELS[this.level];
  }

  _format(level, args) {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const msg = args
      .map((arg) => {
        if (arg instanceof Error) {
          return arg.stack || arg.message;
        }
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(' ');
    return `${now} | ${level.padEnd(7)} | ${msg}`;
  }

  _emit(level, args) {
    if (!this._shouldLog(level)) return;
    const line = this._format(level, args);
    if (LEVELS[level] >= LEVELS.ERROR) {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  trace(...args) { this._emit('TRACE', args); }
  debug(...args) { this._emit('DEBUG', args); }
  info(...args) { this._emit('INFO', args); }
  warning(...args) { this._emit('WARNING', args); }
  error(...args) { this._emit('ERROR', args); }
  critical(...args) { this._emit('CRITICAL', args); }
}

module.exports = { Logger };