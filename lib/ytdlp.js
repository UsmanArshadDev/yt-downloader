'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkDeps } = require('./deps');
const {
  AppError,
  classifyYtDlpError,
  shouldRetryWithFormatFallback,
  shouldRetryWithCookies,
} = require('./errors');
const { getCookiesPath } = require('./appSettings');

const FALLBACK_FORMAT = '18/best[ext=mp4]/best';

/**
 * @param {'android'|'web'} client
 * @returns {string[]}
 */
function clientArgs(client) {
  const name = client === 'web' ? 'web' : 'android';
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
  return path.join(os.homedir(), 'Downloads', 'YouTube Downloader');
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
 * Build a yt-dlp format selector for a max height (MP4-oriented), with progressive fallback.
 * @param {number|'best'|string|null|undefined} qualityHeight
 * @returns {string}
 */
function formatSelectorForHeight(qualityHeight) {
  const fallback = FALLBACK_FORMAT;
  if (qualityHeight == null || qualityHeight === 'best' || qualityHeight === '') {
    return (
      `bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best/${fallback}`
    );
  }
  const height = Number(qualityHeight);
  if (!Number.isFinite(height) || height <= 0) {
    return formatSelectorForHeight('best');
  }
  return (
    `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/` +
    `bestvideo[height<=${height}]+bestaudio/` +
    `best[height<=${height}][ext=mp4]/best[height<=${height}]/best/${fallback}`
  );
}

/**
 * Run yt-dlp and collect stdout/stderr.
 * @param {string} ytdlpPath
 * @param {string[]} baseArgs
 * @param {{ client?: 'android'|'web', cookiesPath?: string|null }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null }>}
 */
function runYtDlp(ytdlpPath, baseArgs, options = {}) {
  const client = options.client || 'android';
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
 * Android first; on bot/auth errors retry with cookies.txt + web client.
 * @param {string} ytdlpPath
 * @param {string[]} baseArgs
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null }>}
 */
async function runYtDlpWithAuthLadder(ytdlpPath, baseArgs) {
  const first = await runYtDlp(ytdlpPath, baseArgs, { client: 'android' });
  if (first.code === 0) return first;

  const errText = first.stderr || first.stdout || '';
  if (!shouldRetryWithCookies(errText)) return first;

  const cookiesPath = getCookiesPath();
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
 * Download a video at the selected quality (android client).
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.formatId]
 * @param {string} [options.formatSelector]
 * @param {boolean} [options.needsAudioMerge]
 * @param {(progress: object) => void} [options.onProgress]
 * @param {(controls: { kill: () => void }) => void} [options.onSpawn]
 * @returns {Promise<{ path: string }>}
 */
async function downloadVideo({
  url,
  formatId,
  formatSelector: explicitSelector,
  needsAudioMerge = true,
  onProgress,
  onSpawn,
}) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    throw new AppError('INVALID_URL', 'Please enter a valid YouTube video URL.');
  }

  let formatSelector = explicitSelector;
  if (!formatSelector) {
    if (!formatId) {
      throw new AppError('INVALID_URL', 'Please select a video quality.');
    }
    formatSelector = needsAudioMerge
      ? `${formatId}+bestaudio[ext=m4a]/bestaudio/best/${FALLBACK_FORMAT}`
      : `${formatId}/${FALLBACK_FORMAT}`;
  }

  const deps = await checkDeps();
  if (!deps.ytdlp) {
    throw new AppError('YTDLP_MISSING', 'yt-dlp is not installed or not on PATH.');
  }

  const willMerge =
    (needsAudioMerge && String(formatSelector).includes('+')) ||
    (explicitSelector && String(explicitSelector).includes('+'));
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
    url.trim(),
  ];

  const runAttempt = (client, cookiesPath, format) =>
    spawnDownload(
      deps.ytdlpPath,
      mergeYtDlpArgs(withFormat(baseArgs, format), [
        ...clientArgs(client),
        ...cookiesArgs(cookiesPath),
      ]),
      outDir,
      onProgress,
      { onSpawn }
    );

  try {
    return await runAttempt('android', null, formatSelector);
  } catch (err) {
    if (err instanceof AppError && err.code === 'PAUSED') throw err;

    const details = err instanceof AppError ? err.details || err.message : String(err);

    if (shouldRetryWithCookies(details)) {
      const cookiesPath = getCookiesPath();
      if (!cookiesPath) {
        if (err instanceof AppError && err.code === 'AUTH_REQUIRED') throw err;
        throw new AppError(
          'AUTH_REQUIRED',
          'YouTube asked for sign-in (bot check). Set a cookies.txt file in the app and try again.',
          details
        );
      }
      try {
        return await runAttempt('web', cookiesPath, formatSelector);
      } catch (cookieErr) {
        if (cookieErr instanceof AppError && cookieErr.code === 'PAUSED') throw cookieErr;
        const cookieDetails =
          cookieErr instanceof AppError ? cookieErr.details || cookieErr.message : String(cookieErr);
        if (shouldRetryWithFormatFallback(cookieDetails)) {
          return runAttempt('web', cookiesPath, FALLBACK_FORMAT);
        }
        throw cookieErr;
      }
    }

    if (shouldRetryWithFormatFallback(details)) {
      return runAttempt('android', null, FALLBACK_FORMAT);
    }

    throw err;
  }
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
        !trimmed.includes('[Merger]')
      ) {
        lastPath = trimmed;
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
            .filter((f) => f.endsWith('.mp4'))
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
  mergeYtDlpArgs,
  runYtDlp,
  runYtDlpWithAuthLadder,
  pickThumbnail,
  buildQualities,
  parseProgressLine,
  downloadVideo,
  classifyYtDlpError,
  AppError,
};
