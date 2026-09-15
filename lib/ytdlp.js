'use strict';

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { checkDeps, which } = require('./deps');
const {
  AppError,
  classifyYtDlpError,
  shouldRetryWithFormatFallback,
  shouldRetryWithCookies,
} = require('./errors');
const {
  getCookiesPathForDownload,
  getAcceptLowerQuality,
  getDownloadDir,
} = require('./appSettings');

const execFileAsync = promisify(execFile);

const FALLBACK_FORMAT = '18/best[ext=mp4]/best';

/**
 * @param {'android'|'web'|'mweb'|'tv'|'default'|null|undefined} client
 * @returns {string[]}
 */
function clientArgs(client) {
  if (!client || client === 'default') return [];
  const allowed = new Set(['android', 'web', 'mweb', 'tv']);
  const name = allowed.has(client) ? client : 'android';
  return ['--extractor-args', `youtube:player_client=${name}`];
}

/**
 * @param {string|null} cookiesPath
 * @returns {string[]}
 */
function cookiesArgs(cookiesPath) {
  if (!cookiesPath) return [];
  return ['--cookies', cookiesPath];
}

/**
 * @returns {string[]}
 */
function androidClientArgs() {
  return clientArgs('android');
}

/**
 * Insert extra args before the trailing URL argument.
 * @param {string[]} baseArgs
 * @param {string[]} extraArgs
 * @returns {string[]}
 */
function mergeYtDlpArgs(baseArgs, extraArgs) {
  if (!extraArgs || extraArgs.length === 0) return baseArgs.slice();
  if (baseArgs.length === 0) return extraArgs.slice();
  const url = baseArgs[baseArgs.length - 1];
  return [...baseArgs.slice(0, -1), ...extraArgs, url];
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return 'Unknown';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * @returns {string}
 */
function getOutputDir() {
  return getDownloadDir();
}

/**
 * @returns {string}
 */
function ensureOutputDir() {
  const dir = getOutputDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build a yt-dlp format selector for a max height.
 * Prefers MP4/m4a when practical, then falls back to the verified CLI pattern:
 * bestvideo[height<=N]+bestaudio/best[height<=N]
 * Does not include progressive format 18 — that is a last-resort download step only.
 * @param {number|'best'|string|null|undefined} qualityHeight
 * @returns {string}
 */
function formatSelectorForHeight(qualityHeight) {
  if (qualityHeight == null || qualityHeight === 'best' || qualityHeight === '') {
    return 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
  }
  const height = Number(qualityHeight);
  if (!Number.isFinite(height) || height <= 0) {
    return formatSelectorForHeight('best');
  }
  return (
    `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/` +
    `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`
  );
}

/**
 * Softer height-respecting selector used before forcing format 18.
 * @param {number|'best'|string|null|undefined} qualityHeight
 * @returns {string}
 */
function softFormatSelectorForHeight(qualityHeight) {
  if (qualityHeight == null || qualityHeight === 'best' || qualityHeight === '') {
    return 'bestvideo+bestaudio/best[ext=mp4]/best';
  }
  const height = Number(qualityHeight);
  if (!Number.isFinite(height) || height <= 0) {
    return softFormatSelectorForHeight('best');
  }
  return (
    `best[height<=${height}]/bestvideo[height<=${height}]+bestaudio/` +
    `bestvideo[height<=${height}]/best`
  );
}

/**
 * @param {Array<{ height?: number }>} qualities
 * @returns {number}
 */
function maxQualityHeight(qualities) {
  if (!Array.isArray(qualities) || qualities.length === 0) return 0;
  return Math.max(0, ...qualities.map((q) => Number(q.height) || 0));
}

/**
 * @param {unknown} qualityHeight
 * @returns {number|null}
 */
function parseRequestedHeight(qualityHeight) {
  if (qualityHeight == null || qualityHeight === '' || qualityHeight === 'best') return null;
  const n = Number(qualityHeight);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Prefer web client when user asks above 360p (android often "succeeds" at 360).
 * @param {number|null} requestedHeight
 * @returns {boolean}
 */
function preferWebFirst(requestedHeight) {
  return requestedHeight != null && requestedHeight > 360;
}

/**
 * @param {number|null} actualHeight
 * @param {number|null} requestedHeight
 * @returns {boolean}
 */
function isQualityTooLow(actualHeight, requestedHeight) {
  if (requestedHeight == null || actualHeight == null) return false;
  if (requestedHeight <= 360) return false;
  return actualHeight < 480 || actualHeight < requestedHeight * 0.7;
}

/**
 * @param {string} filePath
 * @returns {Promise<{ width: number|null, height: number|null }>}
 */
async function probeVideoDimensions(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { width: null, height: null };
  }
  const ffprobePath = await which('ffprobe');
  if (!ffprobePath) {
    return { width: null, height: null };
  }
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=s=x:p=0',
        filePath,
      ],
      { timeout: 30000 }
    );
    const parts = String(stdout || '')
      .trim()
      .split(/\s/)[0]
      .split('x');
    const width = Number(parts[0]);
    const height = Number(parts[1]);
    return {
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
    };
  } catch {
    return { width: null, height: null };
  }
}

/**
 * Run yt-dlp and collect stdout/stderr.
 * @param {string} ytdlpPath
 * @param {string[]} baseArgs
 * @param {{ client?: 'android'|'web'|'mweb'|'tv'|'default'|null, cookiesPath?: string|null }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null }>}
 */
function runYtDlp(ytdlpPath, baseArgs, options = {}) {
  const client = Object.prototype.hasOwnProperty.call(options, 'client')
    ? options.client
    : 'default';
  const cookiesPath = options.cookiesPath || null;
  const args = mergeYtDlpArgs(baseArgs, [
    ...clientArgs(client),
    ...cookiesArgs(cookiesPath),
  ]);

  return new Promise((resolve, reject) => {
    const child = spawn(ytdlpPath, args, {
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Prefer cookies + default yt-dlp clients (Deno/EJS) first; fall back to android.
 * @param {string} ytdlpPath
 * @param {string[]} baseArgs
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null }>}
 */
async function runYtDlpWithAuthLadder(ytdlpPath, baseArgs) {
  const cookiesPath = getCookiesPathForDownload();
  if (cookiesPath) {
    const withCookies = await runYtDlp(ytdlpPath, baseArgs, {
      client: 'default',
      cookiesPath,
    });
    if (withCookies.code === 0) return withCookies;
    const errText = withCookies.stderr || withCookies.stdout || '';
    if (!shouldRetryWithCookies(errText) && withCookies.code !== 0) {
      // Still try android below for format/availability quirks.
    }
  }

  const first = await runYtDlp(ytdlpPath, baseArgs, { client: 'android' });
  if (first.code === 0) return first;

  const errText = first.stderr || first.stdout || '';
  if (!shouldRetryWithCookies(errText)) return first;

  if (!cookiesPath) {
    throw classifyYtDlpError(errText, first.code);
  }

  return runYtDlp(ytdlpPath, baseArgs, { client: 'web', cookiesPath });
}

/**
 * Pick best thumbnail URL from metadata.
 * @param {object} info
 * @returns {string|null}
 */
function pickThumbnail(info) {
  if (!info) return null;
  if (info.thumbnail) return info.thumbnail;
  if (Array.isArray(info.thumbnails) && info.thumbnails.length > 0) {
    const sorted = [...info.thumbnails].sort(
      (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
    );
    return sorted[0].url || null;
  }
  return null;
}

/**
 * Build quality options from yt-dlp formats (MP4 video preferred).
 * @param {Array<object>} formats
 * @returns {Array<{ formatId: string, height: number, label: string, needsAudioMerge: boolean }>}
 */
function buildQualities(formats) {
  if (!Array.isArray(formats)) return [];

  const videoFormats = formats.filter((f) => {
    if (!f || f.vcodec === 'none' || !f.vcodec) return false;
    if (!f.height) return false;
    const ext = (f.ext || '').toLowerCase();
    const vcodec = (f.vcodec || '').toLowerCase();
    const isMp4Family =
      ext === 'mp4' ||
      ext === 'm4v' ||
      vcodec.includes('avc1') ||
      vcodec.includes('h264') ||
      (f.container || '').toLowerCase().includes('mp4');
    return isMp4Family;
  });

  /** @type {Map<number, object>} */
  const byHeight = new Map();

  for (const f of videoFormats) {
    const height = f.height;
    const hasAudio = f.acodec && f.acodec !== 'none';
    const existing = byHeight.get(height);

    if (!existing) {
      byHeight.set(height, f);
      continue;
    }

    const existingHasAudio = existing.acodec && existing.acodec !== 'none';
    if (hasAudio && !existingHasAudio) {
      byHeight.set(height, f);
      continue;
    }
    if (hasAudio === existingHasAudio) {
      const score = (x) => (x.tbr || 0) + (x.filesize || x.filesize_approx || 0) / 1e9;
      if (score(f) > score(existing)) {
        byHeight.set(height, f);
      }
    }
  }

  return [...byHeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([height, f]) => {
      const needsAudioMerge = !(f.acodec && f.acodec !== 'none');
      const fps = f.fps ? ` ${Math.round(f.fps)}fps` : '';
      return {
        formatId: String(f.format_id),
        height,
        label: `${height}p${fps}${needsAudioMerge ? ' (merge)' : ''}`,
        needsAudioMerge,
      };
    });
}

/**
 * Parse a yt-dlp progress line.
 * @param {string} line
 * @returns {{ percent: number, downloaded: string|null, total: string|null, speed: string|null, eta: string|null }|null}
 */
function parseProgressLine(line) {
  if (!line || !line.includes('[download]')) return null;
  if (line.includes('Destination:') || line.includes('has already been downloaded')) {
    return null;
  }

  const percentMatch = line.match(/(\d+(?:\.\d+)?)%/);
  if (!percentMatch) return null;

  const ofMatch = line.match(/of\s+(~?\s*[\d.]+\s*[KMGT]?i?B)/i);
  const atMatch = line.match(/at\s+([\d.]+\s*[KMGT]?i?B\/s)/i);
  const etaMatch = line.match(/ETA\s+(\S+)/i);

  let downloaded = null;
  let total = null;
  const sizePair = line.match(
    /([\d.]+\s*[KMGT]?i?B)\s+of\s+(~?\s*[\d.]+\s*[KMGT]?i?B)/i
  );
  if (sizePair) {
    downloaded = sizePair[1].trim();
    total = sizePair[2].replace('~', '').trim();
  } else if (ofMatch) {
    total = ofMatch[1].replace('~', '').trim();
  }

  return {
    percent: Math.min(100, parseFloat(percentMatch[1])),
    downloaded,
    total,
    speed: atMatch ? atMatch[1].trim() : null,
    eta: etaMatch ? etaMatch[1].trim() : null,
  };
}

/**
 * Replace -f value in a yt-dlp args array.
 * @param {string[]} args
 * @param {string} formatSelector
 * @returns {string[]}
 */
function withFormat(args, formatSelector) {
  const next = args.slice();
  const idx = next.indexOf('-f');
  if (idx >= 0 && idx + 1 < next.length) {
    next[idx + 1] = formatSelector;
  }
  return next;
}

/**
 * Download a video at the selected quality.
 * High quality (>360): web/cookies-first with alternate clients; fail if still too low.
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.formatId]
 * @param {string} [options.formatSelector]
 * @param {number|string|null} [options.qualityHeight]
 * @param {boolean} [options.needsAudioMerge]
 * @param {(progress: object) => void} [options.onProgress]
 * @param {(controls: { kill: () => void }) => void} [options.onSpawn]
 * @returns {Promise<{
 *   path: string,
 *   qualityWarning: string|null,
 *   width: number|null,
 *   height: number|null,
 *   requestedHeight: number|null,
 *   mediaType: 'video'
 * }>}
 */
async function downloadVideo({
  url,
  formatId,
  formatSelector: explicitSelector,
  qualityHeight = null,
  needsAudioMerge = true,
  onProgress,
  onSpawn,
}) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    throw new AppError('INVALID_URL', 'Please enter a valid YouTube video URL.');
  }

  let formatSelector = explicitSelector;
  if (!formatSelector) {
    if (formatId) {
      formatSelector = needsAudioMerge
        ? `${formatId}+bestaudio[ext=m4a]/bestaudio/best`
        : String(formatId);
    } else {
      formatSelector = formatSelectorForHeight(qualityHeight);
    }
  }

  const requestedHeight = parseRequestedHeight(qualityHeight);
  const softSelector = softFormatSelectorForHeight(
    qualityHeight != null && qualityHeight !== '' ? qualityHeight : 'best'
  );
  const highQuality = preferWebFirst(requestedHeight);

  const deps = await checkDeps();
  if (!deps.ytdlp) {
    throw new AppError('YTDLP_MISSING', 'yt-dlp is not installed or not on PATH.');
  }

  const willMerge =
    (needsAudioMerge && String(formatSelector).includes('+')) ||
    String(formatSelector).includes('+');
  if (willMerge && !deps.ffmpeg) {
    throw new AppError(
      'FFMPEG_MISSING',
      'FFmpeg is required to merge video and audio. Install ffmpeg and try again.'
    );
  }

  const outDir = ensureOutputDir();
  const outTemplate = path.join(outDir, '%(title)s [%(id)s].%(ext)s');

  const baseArgs = [
    '--continue',
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',
    '-f',
    formatSelector,
    '--merge-output-format',
    'mp4',
    '-o',
    outTemplate,
    '--print',
    'after_move:filepath',
    '--print',
    'filepath',
    '--print',
    'before_dl:%(height)s',
    url.trim(),
  ];

  /**
   * @param {'android'|'web'|'mweb'|'tv'|'default'|null} client
   * @param {string|null} cookiesPath
   * @param {string} format
   * @param {{ forceOverwrite?: boolean }} [opts]
   */
  const runAttempt = (client, cookiesPath, format, opts = {}) => {
    const extra = [...clientArgs(client), ...cookiesArgs(cookiesPath)];
    if (opts.forceOverwrite) {
      extra.push('--force-overwrites', '--no-continue');
    }
    return spawnDownload(
      deps.ytdlpPath,
      mergeYtDlpArgs(withFormat(baseArgs, format), extra),
      outDir,
      onProgress,
      { onSpawn }
    );
  };

  const cookiesPath = getCookiesPathForDownload();
  const acceptLowerQuality = getAcceptLowerQuality();

  if (highQuality && !cookiesPath) {
    throw new AppError(
      'AUTH_REQUIRED',
      'High quality (above 360p) needs a readable cookies.txt file. Export cookies while signed into YouTube, then Choose… in the app.',
      null
    );
  }

  /** @type {unknown} */
  let lastErr = null;
  /** @type {{ path: string }|null} */
  let got = null;
  /** @type {{ path: string, height: number|null, width: number|null }|null} */
  let bestLow = null;

  /**
   * @param {{ path: string }} result
   * @param {{ width: number|null, height: number|null }} dims
   */
  const rememberBestLow = (result, dims) => {
    if (!result || !result.path) return;
    const h = dims.height != null ? Number(dims.height) : null;
    if (!bestLow) {
      bestLow = { path: result.path, height: h, width: dims.width };
      return;
    }
    const prev = bestLow.height != null ? bestLow.height : -1;
    const next = h != null ? h : -1;
    if (next >= prev) {
      bestLow = { path: result.path, height: h, width: dims.width };
    }
  };

  /** @type {Array<() => Promise<{ path: string }>>} */
  const attempts = [];

  // Match verified CLI: cookies + default clients (Deno/EJS) first — no player_client pin.
  if (highQuality) {
    attempts.push(() => runAttempt('default', cookiesPath, formatSelector));
    attempts.push(() => runAttempt('default', cookiesPath, softSelector));
    attempts.push(() => runAttempt('mweb', cookiesPath, formatSelector));
    attempts.push(() => runAttempt('tv', cookiesPath, formatSelector));
    attempts.push(() => runAttempt('android', cookiesPath, formatSelector));
  } else {
    attempts.push(() => runAttempt('default', cookiesPath, formatSelector));
    attempts.push(() => runAttempt('android', cookiesPath, formatSelector));
    attempts.push(() => runAttempt('web', cookiesPath, formatSelector));
  }

  for (const attempt of attempts) {
    try {
      got = await attempt();
      const dims = await probeVideoDimensions(got.path);
      if (!highQuality || !isQualityTooLow(dims.height, requestedHeight)) {
        break;
      }
      // Too low for requested height — keep trying better clients.
      rememberBestLow(got, dims);
      lastErr = new AppError(
        'DOWNLOAD_FAILED',
        `Got ${dims.height}p; still below requested ${requestedHeight}p.`,
        got.path
      );
      got = null;
    } catch (err) {
      if (err instanceof AppError && err.code === 'PAUSED') throw err;
      lastErr = err;
      const details = err instanceof AppError ? err.details || err.message : String(err);
      if (shouldRetryWithCookies(details) && !cookiesPath) {
        if (err instanceof AppError && err.code === 'AUTH_REQUIRED') throw err;
        throw new AppError(
          'AUTH_REQUIRED',
          'YouTube asked for sign-in (bot check). Set a cookies.txt file in the app and try again.',
          details
        );
      }
    }
  }

  if (!got && !highQuality) {
    const details =
      lastErr instanceof AppError ? lastErr.details || lastErr.message : String(lastErr);
    if (shouldRetryWithFormatFallback(details)) {
      try {
        got = await runAttempt('web', cookiesPath, softSelector);
      } catch (err) {
        if (err instanceof AppError && err.code === 'PAUSED') throw err;
        lastErr = err;
      }
    }
    if (!got) {
      try {
        got = await runAttempt('android', cookiesPath, FALLBACK_FORMAT);
      } catch (err) {
        if (err instanceof AppError && err.code === 'PAUSED') throw err;
        throw err;
      }
    }
  }

  if (!got && highQuality && acceptLowerQuality && bestLow) {
    got = { path: bestLow.path };
  }

  if (!got) {
    throw (
      lastErr instanceof Error
        ? lastErr
        : new AppError(
            'DOWNLOAD_FAILED',
            `Could not download at ${requestedHeight || 'requested'}p. Refresh cookies.txt and try again.`,
            null
          )
    );
  }

  // One more forced overwrite if still low (high quality only).
  let dims = await probeVideoDimensions(got.path);
  if (highQuality && isQualityTooLow(dims.height, requestedHeight)) {
    rememberBestLow(got, dims);
    for (const client of /** @type {const} */ (['default', 'mweb', 'tv'])) {
      try {
        const better = await runAttempt(client, cookiesPath, softSelector, {
          forceOverwrite: true,
        });
        const betterDims = await probeVideoDimensions(better.path);
        if (
          betterDims.height != null &&
          (dims.height == null || betterDims.height > dims.height)
        ) {
          got = better;
          dims = betterDims;
        }
        rememberBestLow(better, betterDims);
        if (!isQualityTooLow(dims.height, requestedHeight)) break;
      } catch (err) {
        if (err instanceof AppError && err.code === 'PAUSED') throw err;
      }
    }
  }

  dims = await probeVideoDimensions(got.path);

  if (highQuality && isQualityTooLow(dims.height, requestedHeight)) {
    if (acceptLowerQuality) {
      if (bestLow && (dims.height == null || (bestLow.height != null && bestLow.height > dims.height))) {
        got = { path: bestLow.path };
        dims = await probeVideoDimensions(got.path);
      }
      const gotLabel =
        dims.width && dims.height ? `${dims.width}x${dims.height}` : `${dims.height || '?'}p`;
      return {
        path: got.path,
        qualityWarning: `Got ${gotLabel}; ${requestedHeight}p unavailable — kept best available.`,
        width: dims.width,
        height: dims.height,
        requestedHeight,
        mediaType: 'video',
      };
    }

    const gotLabel =
      dims.width && dims.height ? `${dims.width}x${dims.height}` : `${dims.height}p`;
    throw new AppError(
      'DOWNLOAD_FAILED',
      `Only got ${gotLabel}; ${requestedHeight}p was unavailable. Re-export a fresh cookies.txt while signed into YouTube and try again.`,
      got.path
    );
  }

  return {
    path: got.path,
    qualityWarning: null,
    width: dims.width,
    height: dims.height,
    requestedHeight,
    mediaType: 'video',
  };
}

/**
 * Download audio only as M4A.
 * @param {object} options
 * @param {string} options.url
 * @param {(progress: object) => void} [options.onProgress]
 * @param {(controls: { kill: () => void }) => void} [options.onSpawn]
 * @returns {Promise<{
 *   path: string,
 *   qualityWarning: string|null,
 *   width: null,
 *   height: null,
 *   requestedHeight: null,
 *   mediaType: 'audio'
 * }>}
 */
async function downloadAudio({ url, onProgress, onSpawn }) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    throw new AppError('INVALID_URL', 'Please enter a valid YouTube video URL.');
  }

  const deps = await checkDeps();
  if (!deps.ytdlp) {
    throw new AppError('YTDLP_MISSING', 'yt-dlp is not installed or not on PATH.');
  }
  if (!deps.ffmpeg) {
    throw new AppError(
      'FFMPEG_MISSING',
      'FFmpeg is required to extract audio. Install ffmpeg and try again.'
    );
  }

  const outDir = ensureOutputDir();
  const outTemplate = path.join(outDir, '%(title)s [%(id)s].%(ext)s');
  const cookiesPath = getCookiesPathForDownload();

  const baseArgs = [
    '--continue',
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',
    '-f',
    'ba/b',
    '-x',
    '--audio-format',
    'm4a',
    '--audio-quality',
    '0',
    '-o',
    outTemplate,
    '--print',
    'after_move:filepath',
    '--print',
    'filepath',
    url.trim(),
  ];

  /**
   * @param {'android'|'web'|'mweb'|'default'|null} client
   * @param {string|null} cookies
   */
  const runAttempt = (client, cookies) =>
    spawnDownload(
      deps.ytdlpPath,
      mergeYtDlpArgs(baseArgs, [...clientArgs(client), ...cookiesArgs(cookies)]),
      outDir,
      onProgress,
      { onSpawn }
    );

  /** @type {unknown} */
  let lastErr = null;
  const order = [
    () => runAttempt('default', cookiesPath),
    () => runAttempt('mweb', cookiesPath),
    () => runAttempt('android', cookiesPath),
  ];

  for (const attempt of order) {
    try {
      const result = await attempt();
      if (result.path && !/\.m4a$/i.test(result.path)) {
        // Prefer .m4a if extract renamed nearby
        const maybe = result.path.replace(/\.[^.]+$/, '.m4a');
        if (fs.existsSync(maybe)) {
          return {
            path: maybe,
            qualityWarning: null,
            width: null,
            height: null,
            requestedHeight: null,
            mediaType: 'audio',
          };
        }
      }
      return {
        path: result.path,
        qualityWarning: null,
        width: null,
        height: null,
        requestedHeight: null,
        mediaType: 'audio',
      };
    } catch (err) {
      if (err instanceof AppError && err.code === 'PAUSED') throw err;
      lastErr = err;
      const details = err instanceof AppError ? err.details || err.message : String(err);
      if (shouldRetryWithCookies(details) && !cookiesPath) {
        throw new AppError(
          'AUTH_REQUIRED',
          'YouTube asked for sign-in (bot check). Set a cookies.txt file in the app and try again.',
          details
        );
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new AppError('DOWNLOAD_FAILED', 'Audio download failed.', null);
}

/**
 * @param {string} ytdlpPath
 * @param {string[]} args
 * @param {string} outDir
 * @param {(progress: object) => void} [onProgress]
 * @param {{ onSpawn?: (controls: { kill: () => void }) => void }} [options]
 * @returns {Promise<{ path: string }>}
 */
function spawnDownload(ytdlpPath, args, outDir, onProgress, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlpPath, args, { env: process.env });
    let stderr = '';
    let lastPath = null;
    let stdoutBuf = '';
    let intentionalPause = false;
    let settled = false;

    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    if (typeof options.onSpawn === 'function') {
      options.onSpawn({
        kill: () => {
          intentionalPause = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        },
      });
    }

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      if (
        (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) &&
        !trimmed.includes('[download]') &&
        !trimmed.includes('[Merger]') &&
        !trimmed.includes('[ExtractAudio]')
      ) {
        lastPath = trimmed;
        return;
      }

      // before_dl:%(height)s or %(height)sx%(width)s style prints
      if (/^\d{2,4}$/.test(trimmed) && typeof onProgress === 'function') {
        onProgress({ height: Number(trimmed) });
        return;
      }
      const dimMatch = trimmed.match(/^(\d{2,4})x(\d{2,4})$/);
      if (dimMatch && typeof onProgress === 'function') {
        onProgress({ height: Number(dimMatch[2]), width: Number(dimMatch[1]) });
        return;
      }

      const progress = parseProgressLine(trimmed);
      if (progress && typeof onProgress === 'function') {
        onProgress(progress);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const lines = text.split('\n');
      for (const line of lines) {
        const progress = parseProgressLine(line.trim());
        if (progress && typeof onProgress === 'function') {
          onProgress(progress);
        }
      }
    });

    child.on('error', (err) => {
      if (intentionalPause) {
        settleReject(new AppError('PAUSED', 'Download paused.', null));
        return;
      }
      const msg = err && err.message ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (
        lower.includes('enoent') ||
        lower.includes('eai_again') ||
        lower.includes('enotfound') ||
        lower.includes('econnreset') ||
        lower.includes('etimedout')
      ) {
        settleReject(new AppError('NETWORK_ERROR', 'Network failure while contacting YouTube.', msg));
        return;
      }
      settleReject(new AppError('DOWNLOAD_FAILED', msg, msg));
    });

    child.on('close', (code) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf);

      if (intentionalPause) {
        settleReject(new AppError('PAUSED', 'Download paused.', null));
        return;
      }

      if (code !== 0) {
        settleReject(classifyYtDlpError(stderr, code));
        return;
      }

      if (!lastPath) {
        try {
          const files = fs
            .readdirSync(outDir)
            .filter((f) => f.endsWith('.mp4') || f.endsWith('.m4a') || f.endsWith('.webm'))
            .map((f) => {
              const full = path.join(outDir, f);
              return { full, mtime: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
          if (files[0]) lastPath = files[0].full;
        } catch {
          // ignore
        }
      }

      if (!lastPath) {
        settleReject(
          new AppError(
            'DOWNLOAD_FAILED',
            'Download finished but output file was not found.',
            stderr || null
          )
        );
        return;
      }

      if (typeof onProgress === 'function') {
        onProgress({ percent: 100, downloaded: null, total: null, speed: null, eta: null });
      }

      settleResolve({ path: lastPath });
    });
  });
}

module.exports = {
  FALLBACK_FORMAT,
  androidClientArgs,
  clientArgs,
  cookiesArgs,
  formatDuration,
  getOutputDir,
  ensureOutputDir,
  formatSelectorForHeight,
  softFormatSelectorForHeight,
  maxQualityHeight,
  parseRequestedHeight,
  preferWebFirst,
  isQualityTooLow,
  probeVideoDimensions,
  mergeYtDlpArgs,
  runYtDlp,
  runYtDlpWithAuthLadder,
  pickThumbnail,
  buildQualities,
  parseProgressLine,
  downloadVideo,
  downloadAudio,
  classifyYtDlpError,
  AppError,
};
