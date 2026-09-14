'use strict';

const fs = require('fs');
const path = require('path');

const ALLOWED_CONCURRENCY = new Set([1, 2, 3]);

/** @type {{ cookiesPath: string|null, concurrency: number }} */
let state = {
  cookiesPath: null,
  concurrency: 1,
};

/** @type {string|null} */
let settingsFile = null;

/**
 * @param {unknown} value
 * @returns {number}
 */
function clampConcurrency(value) {
  const n = Number(value);
  if (ALLOWED_CONCURRENCY.has(n)) return n;
  return 1;
}

/**
 * @param {string} userDataPath
 */
function init(userDataPath) {
  settingsFile = path.join(userDataPath, 'app-settings.json');
  try {
    if (fs.existsSync(settingsFile)) {
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.cookiesPath === 'string' && raw.cookiesPath.trim()) {
          state.cookiesPath = raw.cookiesPath.trim();
        } else {
          state.cookiesPath = null;
        }
        state.concurrency = clampConcurrency(raw.concurrency);
      }
    }
  } catch {
    // keep defaults
  }
}

function save() {
  if (!settingsFile) return;
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

/**
 * @returns {{ cookiesPath: string|null, concurrency: number }}
 */
function getSettings() {
  return {
    cookiesPath: state.cookiesPath,
    concurrency: state.concurrency,
  };
}

/**
 * @returns {string|null}
 */
function getCookiesPath() {
  if (!state.cookiesPath) return null;
  if (!fs.existsSync(state.cookiesPath)) return null;
  return state.cookiesPath;
}

/**
 * @returns {number}
 */
function getConcurrency() {
  return clampConcurrency(state.concurrency);
}

/**
 * @param {string|null} cookiesPath
 * @returns {{ cookiesPath: string|null, concurrency: number }}
 */
function setCookiesPath(cookiesPath) {
  if (cookiesPath && typeof cookiesPath === 'string' && cookiesPath.trim()) {
    state.cookiesPath = path.resolve(cookiesPath.trim());
  } else {
    state.cookiesPath = null;
  }
  save();
  return getSettings();
}

/**
 * @param {unknown} concurrency
 * @returns {{ cookiesPath: string|null, concurrency: number }}
 */
function setConcurrency(concurrency) {
  state.concurrency = clampConcurrency(concurrency);
  save();
  return getSettings();
}

/**
 * Update only provided fields.
 * @param {{ cookiesPath?: string|null, concurrency?: number }} patch
 * @returns {{ cookiesPath: string|null, concurrency: number }}
 */
function setSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();

  if (Object.prototype.hasOwnProperty.call(patch, 'cookiesPath')) {
    const cookiesPath = patch.cookiesPath;
    if (cookiesPath && typeof cookiesPath === 'string' && cookiesPath.trim()) {
      state.cookiesPath = path.resolve(cookiesPath.trim());
    } else {
      state.cookiesPath = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'concurrency')) {
    state.concurrency = clampConcurrency(patch.concurrency);
  }

  save();
  return getSettings();
}

module.exports = {
  init,
  getSettings,
  getCookiesPath,
  getConcurrency,
  setCookiesPath,
  setConcurrency,
  setSettings,
  clampConcurrency,
};
