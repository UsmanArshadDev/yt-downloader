'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ALLOWED_CONCURRENCY = new Set([1, 2, 3]);
const RECENT_MAX = 5;
const ALLOWED_RECENT_TYPES = new Set(['video', 'playlist', 'channel']);

/**
 * @returns {string}
 */
function defaultDownloadDir() {
  return path.join(os.homedir(), 'Downloads', 'YouTube Downloader');
}

/**
 * @typedef {{ url: string, title: string, type: 'video'|'playlist'|'channel' }} RecentEntry
 */

/** @type {{
 *   cookiesPath: string|null,
 *   downloadDir: string,
 *   concurrency: number,
 *   acceptLowerQuality: boolean,
 *   showSettings: boolean,
 *   recentEntries: RecentEntry[]
 * }} */
let state = {
  cookiesPath: null,
  downloadDir: defaultDownloadDir(),
  concurrency: 1,
  acceptLowerQuality: false,
  showSettings: false,
  recentEntries: [],
};

/** @type {string|null} */
let settingsFile = null;

/** @type {string|null} */
let userDataPath = null;

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
 * @param {unknown} value
 * @returns {boolean}
 */
function toBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeDownloadDir(value) {
  if (typeof value === 'string' && value.trim()) {
    return path.resolve(value.trim());
  }
  return defaultDownloadDir();
}

/**
 * @param {unknown} raw
 * @returns {RecentEntry|null}
 */
function normalizeRecentEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url) return null;
  const title =
    typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : url;
  const type = ALLOWED_RECENT_TYPES.has(raw.type) ? raw.type : 'video';
  return { url, title, type };
}

/**
 * @param {unknown} value
 * @returns {RecentEntry[]}
 */
function normalizeRecentEntries(value) {
  if (!Array.isArray(value)) return [];
  /** @type {RecentEntry[]} */
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const entry = normalizeRecentEntry(item);
    if (!entry || seen.has(entry.url)) continue;
    seen.add(entry.url);
    out.push(entry);
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

/**
 * @param {string} nextUserDataPath
 */
function init(nextUserDataPath) {
  userDataPath = nextUserDataPath;
  settingsFile = path.join(nextUserDataPath, 'app-settings.json');
  try {
    if (fs.existsSync(settingsFile)) {
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.cookiesPath === 'string' && raw.cookiesPath.trim()) {
          state.cookiesPath = raw.cookiesPath.trim();
        } else {
          state.cookiesPath = null;
        }
        if (Object.prototype.hasOwnProperty.call(raw, 'downloadDir')) {
          state.downloadDir = normalizeDownloadDir(raw.downloadDir);
        } else {
          state.downloadDir = defaultDownloadDir();
        }
        state.concurrency = clampConcurrency(raw.concurrency);
        if (Object.prototype.hasOwnProperty.call(raw, 'acceptLowerQuality')) {
          state.acceptLowerQuality = toBool(raw.acceptLowerQuality);
        }
        if (Object.prototype.hasOwnProperty.call(raw, 'showSettings')) {
          state.showSettings = toBool(raw.showSettings);
        }
        if (Object.prototype.hasOwnProperty.call(raw, 'recentEntries')) {
          state.recentEntries = normalizeRecentEntries(raw.recentEntries);
        }
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
 * @returns {{
 *   cookiesPath: string|null,
 *   downloadDir: string,
 *   concurrency: number,
 *   acceptLowerQuality: boolean,
 *   showSettings: boolean,
 *   recentEntries: RecentEntry[]
 * }}
 */
function getSettings() {
  return {
    cookiesPath: state.cookiesPath,
    downloadDir: state.downloadDir || defaultDownloadDir(),
    concurrency: state.concurrency,
    acceptLowerQuality: Boolean(state.acceptLowerQuality),
    showSettings: Boolean(state.showSettings),
    recentEntries: state.recentEntries.slice(),
  };
}

/**
 * Configured path if the file exists (may be read-only).
 * @returns {string|null}
 */
function getCookiesPath() {
  if (!state.cookiesPath) return null;
  if (!fs.existsSync(state.cookiesPath)) return null;
  return state.cookiesPath;
}

/**
 * @returns {{
 *   configured: boolean,
 *   exists: boolean,
 *   readable: boolean,
 *   writable: boolean,
 *   path: string|null,
 *   message: string|null
 * }}
 */
function getCookiesHealth() {
  const configuredPath = state.cookiesPath;
  if (!configuredPath) {
    return {
      configured: false,
      exists: false,
      readable: false,
      writable: false,
      path: null,
      message:
        'No cookies.txt selected — 480p/720p/1080p need cookies. Fully restart the app after updates (reload is not enough).',
    };
  }
  const exists = fs.existsSync(configuredPath);
  if (!exists) {
    return {
      configured: true,
      exists: false,
      readable: false,
      writable: false,
      path: configuredPath,
      message: 'Cookies file missing — re-export and Choose… again.',
    };
  }

  let readable = false;
  let writable = false;
  try {
    fs.accessSync(configuredPath, fs.constants.R_OK);
    readable = true;
  } catch {
    readable = false;
  }
  try {
    fs.accessSync(configuredPath, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }

  if (!readable) {
    return {
      configured: true,
      exists: true,
      readable: false,
      writable,
      path: configuredPath,
      message: 'Cookies file is not readable.',
    };
  }

  return {
    configured: true,
    exists: true,
    readable: true,
    writable,
    path: configuredPath,
    message: writable
      ? null
      : 'Cookies file is read-only — app will use a writable copy for yt-dlp.',
  };
}

/**
 * Copy cookies to a writable temp file so yt-dlp can update them without PermissionError.
 * @returns {string|null}
 */
function getCookiesPathForDownload() {
  const src = getCookiesPath();
  if (!src) return null;

  try {
    fs.accessSync(src, fs.constants.R_OK);
  } catch {
    return null;
  }

  const baseDir = userDataPath || path.join(os.tmpdir(), 'yt-downloader');
  const dir = path.join(baseDir, 'cookies-work');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return src;
  }

  const dest = path.join(dir, 'cookies.txt');
  try {
    fs.copyFileSync(src, dest);
    try {
      fs.chmodSync(dest, 0o600);
    } catch {
      // ignore chmod failures
    }
    return dest;
  } catch {
    // Fall back to original if copy fails (may still hit write errors).
    return src;
  }
}

/**
 * @returns {string}
 */
function getDownloadDir() {
  return state.downloadDir || defaultDownloadDir();
}

/**
 * @returns {number}
 */
function getConcurrency() {
  return clampConcurrency(state.concurrency);
}

/**
 * When true, keep the best downloaded file if requested height is unavailable.
 * @returns {boolean}
 */
function getAcceptLowerQuality() {
  return Boolean(state.acceptLowerQuality);
}

/**
 * @returns {boolean}
 */
function getShowSettings() {
  return Boolean(state.showSettings);
}

/**
 * @returns {RecentEntry[]}
 */
function getRecentEntries() {
  return state.recentEntries.slice();
}

/**
 * @param {string|null} cookiesPath
 * @returns {ReturnType<typeof getSettings>}
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
 * @param {unknown} downloadDir
 * @returns {ReturnType<typeof getSettings>}
 */
function setDownloadDir(downloadDir) {
  state.downloadDir = normalizeDownloadDir(downloadDir);
  save();
  return getSettings();
}

/**
 * @param {unknown} concurrency
 * @returns {ReturnType<typeof getSettings>}
 */
function setConcurrency(concurrency) {
  state.concurrency = clampConcurrency(concurrency);
  save();
  return getSettings();
}

/**
 * @param {unknown} acceptLowerQuality
 * @returns {ReturnType<typeof getSettings>}
 */
function setAcceptLowerQuality(acceptLowerQuality) {
  state.acceptLowerQuality = toBool(acceptLowerQuality);
  save();
  return getSettings();
}

/**
 * @param {unknown} showSettings
 * @returns {ReturnType<typeof getSettings>}
 */
function setShowSettings(showSettings) {
  state.showSettings = toBool(showSettings);
  save();
  return getSettings();
}

/**
 * @param {{ url?: string, title?: string, type?: string }} entry
 * @returns {ReturnType<typeof getSettings>}
 */
function addRecentEntry(entry) {
  const normalized = normalizeRecentEntry(entry);
  if (!normalized) return getSettings();
  state.recentEntries = [
    normalized,
    ...state.recentEntries.filter((item) => item.url !== normalized.url),
  ].slice(0, RECENT_MAX);
  save();
  return getSettings();
}

/**
 * @returns {ReturnType<typeof getSettings>}
 */
function clearRecentEntries() {
  state.recentEntries = [];
  save();
  return getSettings();
}

/**
 * Update only provided fields.
 * @param {{
 *   cookiesPath?: string|null,
 *   downloadDir?: string,
 *   concurrency?: number,
 *   acceptLowerQuality?: boolean,
 *   showSettings?: boolean,
 *   recentEntries?: RecentEntry[]
 * }} patch
 * @returns {ReturnType<typeof getSettings>}
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

  if (Object.prototype.hasOwnProperty.call(patch, 'downloadDir')) {
    state.downloadDir = normalizeDownloadDir(patch.downloadDir);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'concurrency')) {
    state.concurrency = clampConcurrency(patch.concurrency);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'acceptLowerQuality')) {
    state.acceptLowerQuality = toBool(patch.acceptLowerQuality);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'showSettings')) {
    state.showSettings = toBool(patch.showSettings);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'recentEntries')) {
    state.recentEntries = normalizeRecentEntries(patch.recentEntries);
  }

  save();
  return getSettings();
}

module.exports = {
  init,
  getSettings,
  getCookiesPath,
  getCookiesPathForDownload,
  getCookiesHealth,
  getDownloadDir,
  defaultDownloadDir,
  getConcurrency,
  getAcceptLowerQuality,
  getShowSettings,
  getRecentEntries,
  setCookiesPath,
  setDownloadDir,
  setConcurrency,
  setAcceptLowerQuality,
  setShowSettings,
  addRecentEntry,
  clearRecentEntries,
  setSettings,
  clampConcurrency,
  RECENT_MAX,
};
