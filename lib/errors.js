'use strict';

const DETAILS_MAX = 2000;

class AppError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string|null} [details]
   */
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details ? truncateDetails(details) : null;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncateDetails(text) {
  const trimmed = String(text).trim();
  if (trimmed.length <= DETAILS_MAX) return trimmed;
  return `${trimmed.slice(0, DETAILS_MAX)}\n…(truncated)`;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeNetworkFailure(text) {
  return (
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('network is unreachable') ||
    text.includes('name or service not known') ||
    text.includes('temporary failure in name resolution') ||
    text.includes('connection reset') ||
    text.includes('connection refused') ||
    text.includes('nodename nor servname') ||
    text.includes('getaddrinfo failed') ||
    text.includes('errno 104') ||
    text.includes('errno -3') ||
    text.includes('transporterror') ||
    (text.includes('unable to download') &&
      (text.includes('http error') || text.includes('urlopen') || text.includes('api page')))
  );
}

/**
 * Whether to retry download with progressive format fallback (18/best).
 * @param {string} stderr
 * @returns {boolean}
 */
function shouldRetryWithFormatFallback(stderr) {
  const text = (stderr || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('requested format is not available') ||
    text.includes('no video formats found') ||
    text.includes('only images are available') ||
    text.includes('format is not available')
  );
}

/**
 * Whether auth/cookies retry may help.
 * @param {string} stderr
 * @returns {boolean}
 */
function shouldRetryWithCookies(stderr) {
  const text = (stderr || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('sign in to confirm you’re not a bot') ||
    text.includes("sign in to confirm you're not a bot") ||
    text.includes('sign in to confirm you are not a bot') ||
    text.includes('confirm you’re not a bot') ||
    text.includes("confirm you're not a bot") ||
    text.includes('use --cookies') ||
    text.includes('cookies-from-browser') ||
    text.includes('sign in to confirm your age') ||
    text.includes('age-restricted') ||
    text.includes('age restricted') ||
    text.includes('login required') ||
    text.includes('private video')
  );
}

/**
 * Classify yt-dlp / network failure messages into distinct codes.
 * @param {string} stderr
 * @param {number|null} code
 * @returns {AppError}
 */
function classifyYtDlpError(stderr, code) {
  const raw = (stderr || '').trim();
  const text = raw.toLowerCase();
  const details = raw || `yt-dlp exited with code ${code ?? 'unknown'}`;

  if (looksLikeNetworkFailure(text) && !text.includes('this video is not available')) {
    return new AppError('NETWORK_ERROR', 'Network failure while contacting YouTube.', details);
  }

  if (
    text.includes('sign in to confirm you’re not a bot') ||
    text.includes("sign in to confirm you're not a bot") ||
    text.includes('sign in to confirm you are not a bot') ||
    text.includes('confirm you’re not a bot') ||
    text.includes("confirm you're not a bot") ||
    (text.includes('use --cookies') && text.includes('bot'))
  ) {
    return new AppError(
      'AUTH_REQUIRED',
      'YouTube asked for sign-in (bot check). Set a cookies.txt file in the app and try again.',
      details
    );
  }

  if (
    text.includes('private video') ||
    text.includes('this video is private') ||
    text.includes('login required to access this content')
  ) {
    return new AppError('VIDEO_PRIVATE', 'This video is private.', details);
  }

  if (
    text.includes('sign in to confirm your age') ||
    text.includes('age-restricted') ||
    text.includes('age restricted') ||
    text.includes('confirm your age') ||
    text.includes('inappropriate for some users')
  ) {
    return new AppError(
      'AGE_RESTRICTED',
      'This video requires age verification or sign-in. Set cookies.txt if needed.',
      details
    );
  }

  if (
    text.includes('not made this video available in your country') ||
    text.includes('not available in your country') ||
    text.includes('blocked it in your country') ||
    text.includes('uploader has not made this video available') ||
    (text.includes('geo') && text.includes('restrict'))
  ) {
    return new AppError(
      'REGION_RESTRICTED',
      'This video is not available in your region.',
      details
    );
  }

  if (
    text.includes('video unavailable') ||
    text.includes('this video is not available') ||
    text.includes('has been removed') ||
    text.includes('video has been removed') ||
    text.includes('account associated with this video has been terminated') ||
    text.includes('copyright strike') ||
    text.includes('no video formats found') ||
    text.includes('only images are available')
  ) {
    return new AppError(
      'VIDEO_UNAVAILABLE',
      'YouTube did not provide a downloadable stream for this video.',
      details
    );
  }

  if (
    text.includes('unsupported url') ||
    text.includes('is not a valid url') ||
    text.includes('no suitable extractor') ||
    text.includes('playlist does not exist')
  ) {
    return new AppError('UNSUPPORTED_URL', 'This URL is invalid or unsupported.', details);
  }

  return new AppError(
    'DOWNLOAD_FAILED',
    raw.split('\n').filter(Boolean).pop() || `Download failed (exit ${code ?? 'unknown'}).`,
    details
  );
}

/**
 * Serialize AppError or generic Error for IPC.
 * @param {unknown} err
 */
function toIpcError(err) {
  if (err instanceof AppError) {
    return {
      ok: false,
      code: err.code,
      message: err.message,
      details: err.details || null,
    };
  }
  if (err instanceof Error) {
    return {
      ok: false,
      code: 'DOWNLOAD_FAILED',
      message: err.message,
      details: err.stack || null,
    };
  }
  return {
    ok: false,
    code: 'DOWNLOAD_FAILED',
    message: String(err),
    details: null,
  };
}

module.exports = {
  AppError,
  classifyYtDlpError,
  toIpcError,
  truncateDetails,
  shouldRetryWithFormatFallback,
  shouldRetryWithCookies,
};
