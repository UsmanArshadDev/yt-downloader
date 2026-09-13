'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/**
 * Resolve a binary on PATH via `which`.
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function which(name) {
  try {
    const { stdout } = await execFileAsync('which', [name]);
    const path = stdout.trim();
    return path || null;
  } catch {
    return null;
  }
}

/**
 * Check that a binary exists and responds to a version flag.
 * @param {string} name
 * @param {string[]} [versionArgs=['--version']]
 * @returns {Promise<{ ok: boolean, path: string|null, version: string|null }>}
 */
async function checkBinary(name, versionArgs = ['--version']) {
  const binPath = await which(name);
  if (!binPath) {
    return { ok: false, path: null, version: null };
  }

  try {
    const { stdout, stderr } = await execFileAsync(binPath, versionArgs, {
      timeout: 10000,
    });
    const version = (stdout || stderr).trim().split('\n')[0] || null;
    return { ok: true, path: binPath, version };
  } catch {
    return { ok: false, path: binPath, version: null };
  }
}

/**
 * Detect yt-dlp and ffmpeg.
 * @returns {Promise<{
 *   ytdlp: boolean,
 *   ffmpeg: boolean,
 *   ytdlpPath: string|null,
 *   ffmpegPath: string|null,
 *   ytdlpVersion: string|null,
 *   ffmpegVersion: string|null
 * }>}
 */
async function checkDeps() {
  const [ytdlp, ffmpeg] = await Promise.all([
    checkBinary('yt-dlp', ['--version']),
    checkBinary('ffmpeg', ['-version']),
  ]);

  return {
    ytdlp: ytdlp.ok,
    ffmpeg: ffmpeg.ok,
    ytdlpPath: ytdlp.path,
    ffmpegPath: ffmpeg.path,
    ytdlpVersion: ytdlp.version,
    ffmpegVersion: ffmpeg.version,
  };
}

module.exports = {
  which,
  checkBinary,
  checkDeps,
};
