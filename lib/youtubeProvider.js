'use strict';

const { checkDeps } = require('./deps');
const { AppError, classifyYtDlpError } = require('./errors');
const {
  runYtDlpWithAuthLadder,
  formatDuration,
  pickThumbnail,
  buildQualities,
} = require('./ytdlp');

const PAGE_SIZE = 100;

/**
 * @param {string} url
 * @returns {'video'|'playlist'|'channel'|'invalid'}
 */
function detectUrlType(url) {
  if (!url || typeof url !== 'string') return 'invalid';
  const trimmed = url.trim();
  if (!trimmed) return 'invalid';

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'invalid';
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be') {
    return 'invalid';
  }

  const pathname = parsed.pathname;

  if (
    pathname.startsWith('/playlist') ||
    (pathname === '/watch' && !parsed.searchParams.get('v') && parsed.searchParams.get('list'))
  ) {
    if (parsed.searchParams.get('list')) return 'playlist';
    return 'invalid';
  }

  if (
    pathname.startsWith('/channel/') ||
    pathname.startsWith('/c/') ||
    pathname.startsWith('/user/') ||
    pathname.startsWith('/@')
  ) {
    return 'channel';
  }

  if (pathname.startsWith('/feed')) {
    return 'invalid';
  }

  if (host === 'youtu.be') {
    const id = pathname.slice(1).split('/')[0];
    return id && /^[\w-]{11}$/.test(id) ? 'video' : 'invalid';
  }

  if (pathname === '/watch') {
    const v = parsed.searchParams.get('v');
    return v && /^[\w-]{11}$/.test(v) ? 'video' : 'invalid';
  }

  for (const prefix of ['/shorts/', '/embed/', '/live/']) {
    if (pathname.startsWith(prefix)) {
      const id = pathname.split('/')[2];
      return id && /^[\w-]{11}$/.test(id) ? 'video' : 'invalid';
    }
  }

  return 'invalid';
}

/**
 * @param {object} entry
 */
function mapFlatEntry(entry) {
  if (!entry) return null;
  const id = entry.id || entry.url || null;
  if (!id) return null;

  const videoId = String(id).replace(/^.*v=/, '').slice(0, 11);
  const url =
    entry.url && String(entry.url).startsWith('http')
      ? entry.url
      : entry.webpage_url && String(entry.webpage_url).startsWith('http')
        ? entry.webpage_url
        : `https://www.youtube.com/watch?v=${videoId}`;

  let uploadDate = null;
  if (entry.upload_date && /^\d{8}$/.test(String(entry.upload_date))) {
    const d = String(entry.upload_date);
    uploadDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  } else if (entry.release_date && /^\d{8}$/.test(String(entry.release_date))) {
    const d = String(entry.release_date);
    uploadDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }

  return {
    id: videoId.length === 11 ? videoId : String(id),
    url,
    title: entry.title || 'Untitled',
    duration: formatDuration(entry.duration),
    durationSeconds: entry.duration != null ? Number(entry.duration) : null,
    thumbnail: pickThumbnail(entry),
    uploadDate,
  };
}

/**
 * @param {string} url
 */
async function analyzeVideo(url) {
  const deps = await checkDeps();
  if (!deps.ytdlp) {
    throw new AppError('YTDLP_MISSING', 'yt-dlp is not installed or not on PATH.');
  }

  const { stdout, stderr, code } = await runYtDlpWithAuthLadder(deps.ytdlpPath, [
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
    throw new AppError(
      'DOWNLOAD_FAILED',
      'Failed to parse video metadata from yt-dlp.',
      stdout || stderr
    );
  }

  if (info._type === 'playlist') {
    throw new AppError(
      'INVALID_URL',
      'Expected a single video URL.',
      'yt-dlp returned a playlist for a video analyze request'
    );
  }

  const qualities = buildQualities(info.formats || []);
  if (qualities.length === 0) {
    throw new AppError(
      'VIDEO_UNAVAILABLE',
      'YouTube did not provide a downloadable stream for this video.',
      'No MP4-compatible video qualities were found.'
    );
  }

  return {
    type: 'video',
    title: info.title || 'Untitled',
    thumbnail: pickThumbnail(info),
    duration: formatDuration(info.duration),
    durationSeconds: info.duration ?? null,
    videoId: info.id || null,
    url: info.webpage_url || url.trim(),
    qualities,
  };
}

/**
 * @param {string} url
 * @param {number} [start=1]
 * @param {number} [pageSize=PAGE_SIZE]
 */
async function listCollection(url, start = 1, pageSize = PAGE_SIZE) {
  const deps = await checkDeps();
  if (!deps.ytdlp) {
    throw new AppError('YTDLP_MISSING', 'yt-dlp is not installed or not on PATH.');
  }

  const safeStart = Math.max(1, Number(start) || 1);
  const end = safeStart + pageSize - 1;

  const { stdout, stderr, code } = await runYtDlpWithAuthLadder(deps.ytdlpPath, [
    '--flat-playlist',
    '-J',
    '--no-warnings',
    '--playlist-start',
    String(safeStart),
    '--playlist-end',
    String(end),
    url.trim(),
  ]);

  if (code !== 0) {
    throw classifyYtDlpError(stderr || stdout, code);
  }

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new AppError(
      'DOWNLOAD_FAILED',
      'Failed to parse playlist/channel metadata from yt-dlp.',
      stdout || stderr
    );
  }

  const entries = Array.isArray(info.entries) ? info.entries : [];
  const videos = entries.map(mapFlatEntry).filter(Boolean);
  const hasMore = entries.length >= pageSize;
  const nextStart = hasMore ? end + 1 : null;

  return {
    type: detectUrlType(url) === 'channel' ? 'channel' : 'playlist',
    title: info.title || info.channel || info.uploader || 'Playlist',
    videos,
    nextStart,
    hasMore,
    pageSize,
  };
}

/**
 * @param {string} url
 */
async function analyze(url) {
  const type = detectUrlType(url);
  if (type === 'invalid') {
    throw new AppError(
      'INVALID_URL',
      'Please enter a valid YouTube video, playlist, or channel URL.'
    );
  }

  if (type === 'video') {
    return analyzeVideo(url);
  }

  const list = await listCollection(url, 1, PAGE_SIZE);
  return { ...list, type };
}

/**
 * @param {string} url
 * @param {number} start
 */
async function loadMore(url, start) {
  const type = detectUrlType(url);
  if (type !== 'playlist' && type !== 'channel') {
    throw new AppError('UNSUPPORTED_URL', 'Load more is only supported for playlists and channels.');
  }
  const list = await listCollection(url, start, PAGE_SIZE);
  return { ...list, type };
}

module.exports = {
  PAGE_SIZE,
  detectUrlType,
  analyze,
  loadMore,
  analyzeVideo,
  listCollection,
  mapFlatEntry,
};
