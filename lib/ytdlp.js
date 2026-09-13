'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkDeps } = require('./deps');

class AppError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

/**
 * Accept single-video YouTube URLs only.
 * @param {string} url
 * @returns {boolean}
 */
function isValidYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be') {
    return false;
  }

  // Reject playlist / channel / user / feed style paths
  const pathname = parsed.pathname;
  if (
    pathname.startsWith('/playlist') ||
    pathname.startsWith('/channel/') ||
    pathname.startsWith('/c/') ||
    pathname.startsWith('/user/') ||
    pathname.startsWith('/@') ||
    pathname.startsWith('/feed')
  ) {
    return false;
  }

  if (host === 'youtu.be') {
    const id = pathname.slice(1).split('/')[0];
    return Boolean(id && /^[\w-]{11}$/.test(id));
  }

  if (pathname === '/watch') {
    const v = parsed.searchParams.get('v');
    return Boolean(v && /^[\w-]{11}$/.test(v));
  }

  if (pathname.startsWith('/shorts/')) {
    const id = pathname.split('/')[2];
    return Boolean(id && /^[\w-]{11}$/.test(id));
  }

  if (pathname.startsWith('/embed/')) {
    const id = pathname.split('/')[2];
    return Boolean(id && /^[\w-]{11}$/.test(id));
  }

  if (pathname.startsWith('/live/')) {
    const id = pathname.split('/')[2];
    return Boolean(id && /^[\w-]{11}$/.test(id));
  }

  return false;
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return 'Unknown';
  const total = Math.max(0, Math.floor(seconds));
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
 * Ensure output directory exists.
 * @returns {string}
 */
function ensureOutputDir() {
  const dir = getOutputDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run yt-dlp and collect stdout/stderr.
 * @param {string} ytdlpPath
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null }>}
 */
function runYtDlp(ytdlpPath, args) {
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
 * Classify yt-dlp failure messages.
 * @param {string} stderr
 * @param {number|null} code
 * @returns {AppError}
 */
function classifyYtDlpError(stderr, code) {
  const text = (stderr || '').toLowerCase();
  if (
    text.includes('video unavailable') ||
    text.includes('private video') ||
    text.includes('this video is not available') ||
    text.includes('has been removed') ||
    text.includes('copyright') ||
    text.includes('sign in to confirm') ||
    text.includes('age-restricted') ||
    text.includes('geo') ||
    text.includes('not made this video available in your country')
  ) {
    return new AppError('VIDEO_UNAVAILABLE', 'This video is unavailable or restricted.');
  }
  return new AppError(
    'DOWNLOAD_FAILED',
    stderr.trim() || `yt-dlp exited with code ${code ?? 'unknown'}`
  );
}

/**
 * Pick best thumbnail URL from metadata.
 * @param {object} info
 * @returns {string|null}
 */
function pickThumbnail(info) {
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
    // Prefer mp4 / H.264 containers; allow m4v and formats that remux to mp4
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

  // Prefer progressive (has audio) when same height; else video-only
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
    // Prefer formats with audio already muxed
    if (hasAudio && !existingHasAudio) {
      byHeight.set(height, f);
      continue;
    }
    if (hasAudio === existingHasAudio) {
      // Prefer higher tbr / filesize
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
 * Analyze a YouTube video URL.
 * @param {string} url
 * @returns {Promise<{
 *   title: string,
 *   thumbnail: string|null,
 *   duration: string,
 *   durationSeconds: number|null,
 *   videoId: string|null,
 *   qualities: Array<{ formatId: string, height: number, label: string, needsAudioMerge: boolean }>
 * }>}
 */
async function analyzeVideo(url) {
  if (!isValidYouTubeUrl(url)) {
    throw new AppError('INVALID_URL', 'Please enter a valid YouTube video URL.');
  }

  const deps = await checkDeps();
  if (!deps.ytdlp) {
    throw new AppError('YTDLP_MISSING', 'yt-dlp is not installed or not on PATH.');
  }

  const { stdout, stderr, code } = await runYtDlp(deps.ytdlpPath, [
    '-J',
    '--no-playlist',
    '--no-warnings',
    url.trim(),
  ]);

  if (code !== 0) {
    throw classifyYtDlpError(stderr || stdout, code);
  }

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new AppError('DOWNLOAD_FAILED', 'Failed to parse video metadata from yt-dlp.');
  }

  if (info._type === 'playlist') {
    throw new AppError('INVALID_URL', 'Playlists are not supported. Paste a single video URL.');
  }

  const qualities = buildQualities(info.formats || []);
  if (qualities.length === 0) {
    throw new AppError(
      'VIDEO_UNAVAILABLE',
      'No MP4-compatible video qualities were found for this video.'
    );
  }

  return {
    title: info.title || 'Untitled',
    thumbnail: pickThumbnail(info),
    duration: formatDuration(info.duration),
    durationSeconds: info.duration ?? null,
    videoId: info.id || null,
    qualities,
  };
}

/**
 * Parse a yt-dlp progress line.
 * Example: [download]  45.2% of  12.34MiB at  1.23MiB/s ETA 00:08
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

  const ofMatch = line.match(
    /of\s+(~?\s*[\d.]+\s*[KMGT]?i?B)/i
  );
  const atMatch = line.match(
    /at\s+([\d.]+\s*[KMGT]?i?B\/s)/i
  );
  const etaMatch = line.match(/ETA\s+(\S+)/i);
  const downloadedMatch = line.match(
    /\[download\]\s+[\d.]+%\s+of\s+~?\s*[\d.]+\s*[KMGT]?i?B/i
  );

  // Also try "X of Y" style sizes from the percent line
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

  void downloadedMatch;

  return {
    percent: Math.min(100, parseFloat(percentMatch[1])),
    downloaded,
    total,
    speed: atMatch ? atMatch[1].trim() : null,
    eta: etaMatch ? etaMatch[1].trim() : null,
  };
}

/**
 * Download a video at the selected quality.
 * @param {object} options
 * @param {string} options.url
 * @param {string} options.formatId
 * @param {boolean} [options.needsAudioMerge]
 * @param {(progress: object) => void} [options.onProgress]
 * @returns {Promise<{ path: string }>}
 */
async function downloadVideo({ url, formatId, needsAudioMerge = true, onProgress }) {
  if (!isValidYouTubeUrl(url)) {
    throw new AppError('INVALID_URL', 'Please enter a valid YouTube video URL.');
  }
  if (!formatId) {
    throw new AppError('INVALID_URL', 'Please select a video quality.');
  }

  const deps = await checkDeps();
  if (!deps.ytdlp) {
    throw new AppError('YTDLP_MISSING', 'yt-dlp is not installed or not on PATH.');
  }
  if (needsAudioMerge && !deps.ffmpeg) {
    throw new AppError(
      'FFMPEG_MISSING',
      'FFmpeg is required to merge video and audio. Install ffmpeg and try again.'
    );
  }

  const outDir = ensureOutputDir();
  const outTemplate = path.join(outDir, '%(title)s [%(id)s].%(ext)s');

  const formatSelector = needsAudioMerge
    ? `${formatId}+bestaudio[ext=m4a]/bestaudio/best`
    : formatId;

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
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

  return new Promise((resolve, reject) => {
    const child = spawn(deps.ytdlpPath, args, { env: process.env });
    let stderr = '';
    let lastPath = null;
    let stdoutBuf = '';

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Absolute paths printed by --print
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
      reject(new AppError('DOWNLOAD_FAILED', err.message));
    });

    child.on('close', (code) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf);

      if (code !== 0) {
        reject(classifyYtDlpError(stderr, code));
        return;
      }

      if (!lastPath) {
        // Fallback: try to find newest file in output dir
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
        reject(new AppError('DOWNLOAD_FAILED', 'Download finished but output file was not found.'));
        return;
      }

      if (typeof onProgress === 'function') {
        onProgress({ percent: 100, downloaded: null, total: null, speed: null, eta: null });
      }

      resolve({ path: lastPath });
    });
  });
}

module.exports = {
  AppError,
  isValidYouTubeUrl,
  formatDuration,
  getOutputDir,
  ensureOutputDir,
  analyzeVideo,
  downloadVideo,
  buildQualities,
  parseProgressLine,
};
