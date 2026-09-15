'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);

/**
 * Prepend common user binary dirs so GUI Electron can find yt-dlp, ffmpeg, and Deno.
 * Mutates process.env.PATH in place. Safe to call more than once.
 * @returns {string}
 */
function bootstrapPath() {
  const home = os.homedir();
  const extras = [
    path.join(home, '.deno', 'bin'),
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
  ].filter((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });

  const current = process.env.PATH || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  const seen = new Set(parts);
  const prepend = [];
  for (const dir of extras) {
    if (!seen.has(dir)) {
      prepend.push(dir);
      seen.add(dir);
    }
  }

  if (prepend.length > 0) {
    process.env.PATH = [...prepend, ...parts].join(path.delimiter);
  }
  return process.env.PATH || '';
}

/**
 * Resolve a binary on PATH via `which`.
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function which(name) {
  try {
    const { stdout } = await execFileAsync('which', [name]);
    const resolved = stdout.trim();
    return resolved || null;
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
 * Detect yt-dlp, ffmpeg, and Deno (Deno is optional but needed for YouTube EJS).
 * @returns {Promise<{
 *   ytdlp: boolean,
 *   ffmpeg: boolean,
 *   deno: boolean,
 *   ytdlpPath: string|null,
 *   ffmpegPath: string|null,
 *   denoPath: string|null,
 *   ytdlpVersion: string|null,
 *   ffmpegVersion: string|null,
 *   denoVersion: string|null
 * }>}
 */
async function checkDeps() {
  bootstrapPath();
  const [ytdlp, ffmpeg, deno] = await Promise.all([
    checkBinary('yt-dlp', ['--version']),
    checkBinary('ffmpeg', ['-version']),
    checkBinary('deno', ['--version']),
  ]);

  return {
    ytdlp: ytdlp.ok,
    ffmpeg: ffmpeg.ok,
    deno: deno.ok,
    ytdlpPath: ytdlp.path,
    ffmpegPath: ffmpeg.path,
    denoPath: deno.path,
    ytdlpVersion: ytdlp.version,
    ffmpegVersion: ffmpeg.version,
    denoVersion: deno.version,
  };
}

module.exports = {
  bootstrapPath,
  which,
  checkBinary,
  checkDeps,
};
