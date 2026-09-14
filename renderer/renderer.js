'use strict';

const ROW_HEIGHT = 64;
const WINDOW_SIZE = 40;

const els = {
  depsYtdlp: document.querySelector('#deps-ytdlp .deps-status'),
  depsFfmpeg: document.querySelector('#deps-ffmpeg .deps-status'),
  urlInput: document.getElementById('url-input'),
  analyzeBtn: document.getElementById('analyze-btn'),
  meta: document.getElementById('meta'),
  thumb: document.getElementById('thumb'),
  title: document.getElementById('title'),
  duration: document.getElementById('duration'),
  quality: document.getElementById('quality'),
  downloadBtn: document.getElementById('download-btn'),
  collection: document.getElementById('collection'),
  collectionTitle: document.getElementById('collection-title'),
  selectAllBtn: document.getElementById('select-all-btn'),
  deselectAllBtn: document.getElementById('deselect-all-btn'),
  viewport: document.getElementById('video-list-viewport'),
  spacer: document.getElementById('video-list-spacer'),
  listWindow: document.getElementById('video-list-window'),
  selectionCount: document.getElementById('selection-count'),
  batchQuality: document.getElementById('batch-quality'),
  loadMoreBtn: document.getElementById('load-more-btn'),
  downloadSelectedBtn: document.getElementById('download-selected-btn'),
  progressBar: document.getElementById('progress-bar'),
  progressText: document.getElementById('progress-text'),
  queuePanel: document.getElementById('queue-panel'),
  queueList: document.getElementById('queue-list'),
  clearQueueBtn: document.getElementById('clear-queue-btn'),
  cookiesPath: document.getElementById('cookies-path'),
  cookiesChooseBtn: document.getElementById('cookies-choose-btn'),
  cookiesClearBtn: document.getElementById('cookies-clear-btn'),
  concurrency: document.getElementById('concurrency'),
  status: document.getElementById('status'),
  errorDetails: document.getElementById('error-details'),
  errorDetailsText: document.getElementById('error-details-text'),
  recentUrls: document.getElementById('recent-urls'),
  recentList: document.getElementById('recent-list'),
};

const RECENT_KEY = 'yt-downloader.recentUrls';
const RECENT_MAX = 5;
const LAST_SINGLE_FORMAT_KEY = 'yt-downloader.lastSingleFormatId';
const LAST_BATCH_QUALITY_KEY = 'yt-downloader.lastBatchQuality';

/** @type {{ formatId: string, height: number, label: string, needsAudioMerge: boolean }[]} */
let qualities = [];
/** @type {Array<object>} */
let collectionVideos = [];
/** @type {Set<string>} */
const selectedIds = new Set();
let collectionUrl = '';
let nextStart = null;
let hasMore = false;
let busy = false;
let singleVideo = null;

const depsOk = { ytdlp: false, ffmpeg: false };

/**
 * @returns {string[]}
 */
function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((u) => typeof u === 'string' && u.trim()).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/**
 * @param {string} url
 */
function saveRecent(url) {
  const trimmed = (url || '').trim();
  if (!trimmed) return;
  const next = [trimmed, ...loadRecent().filter((u) => u !== trimmed)].slice(0, RECENT_MAX);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

function renderRecent() {
  const urls = loadRecent();
  els.recentList.innerHTML = '';
  if (urls.length === 0) {
    els.recentUrls.classList.add('hidden');
    return;
  }

  els.recentUrls.classList.remove('hidden');
  for (const url of urls) {
    const li = document.createElement('li');
    li.textContent = url;
    li.title = url;
    li.addEventListener('click', () => {
      els.urlInput.value = url;
      els.urlInput.focus();
    });
    els.recentList.appendChild(li);
  }
}

/**
 * @param {string|null|undefined} cookiesPath
 */
function renderCookiesPath(cookiesPath) {
  els.cookiesPath.value = cookiesPath || '';
  els.cookiesPath.placeholder = cookiesPath ? '' : 'No cookies.txt selected';
}

async function refreshCookiesSettings() {
  const result = await window.api.getSettings();
  if (result && result.ok) {
    renderCookiesPath(result.cookiesPath);
    const n = Number(result.concurrency);
    if (n === 1 || n === 2 || n === 3) {
      els.concurrency.value = String(n);
    } else {
      els.concurrency.value = '1';
    }
  }
}

function loadLastSingleFormatId() {
  try {
    return localStorage.getItem(LAST_SINGLE_FORMAT_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * @param {string} formatId
 */
function saveLastSingleFormatId(formatId) {
  if (!formatId) return;
  try {
    localStorage.setItem(LAST_SINGLE_FORMAT_KEY, formatId);
  } catch {
    // ignore
  }
}

function loadLastBatchQuality() {
  try {
    return localStorage.getItem(LAST_BATCH_QUALITY_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * @param {string} quality
 */
function saveLastBatchQuality(quality) {
  if (!quality) return;
  try {
    localStorage.setItem(LAST_BATCH_QUALITY_KEY, quality);
  } catch {
    // ignore
  }
}

function restoreBatchQuality() {
  const last = loadLastBatchQuality();
  if (!last) return;
  const option = Array.from(els.batchQuality.options).find((o) => o.value === last);
  if (option) els.batchQuality.value = last;
}

function setStatus(text, kind = '', details = null) {
  els.status.textContent = text;
  els.status.className = `status${kind ? ` ${kind}` : ''}`;
  if (details) {
    els.errorDetails.classList.remove('hidden');
    els.errorDetailsText.textContent = details;
  } else {
    els.errorDetails.classList.add('hidden');
    els.errorDetailsText.textContent = '';
  }
}

function showError(result) {
  const msg = result && result.message ? result.message : 'Unknown error';
  const details = result && result.details ? result.details : null;
  setStatus(`Failed: ${msg}`, 'failed', details);
}

function setProgress(percent, detail = '') {
  const value = Math.max(0, Math.min(100, percent || 0));
  els.progressBar.style.width = `${value}%`;
  els.progressText.textContent = detail || (percent ? `${value.toFixed(1)}%` : '');
}

function setBusy(next) {
  busy = next;
  els.analyzeBtn.disabled = next || !depsOk.ytdlp;
  els.downloadBtn.disabled = next || qualities.length === 0;
  els.urlInput.disabled = next;
  els.quality.disabled = next;
  els.downloadSelectedBtn.disabled = next || selectedIds.size === 0;
  els.loadMoreBtn.disabled = next;
  els.selectAllBtn.disabled = next;
  els.deselectAllBtn.disabled = next;
  els.batchQuality.disabled = next;
}


function updateDepEl(el, ok, missingLabel) {
  el.textContent = ok ? 'OK' : missingLabel;
  el.className = `deps-status ${ok ? 'ok' : 'missing'}`;
}

async function refreshDeps() {
  const result = await window.api.checkDeps();
  if (!result.ok) {
    updateDepEl(els.depsYtdlp, false, 'Error');
    updateDepEl(els.depsFfmpeg, false, 'Error');
    showError(result);
    setBusy(false);
    return;
  }

  depsOk.ytdlp = Boolean(result.ytdlp);
  depsOk.ffmpeg = Boolean(result.ffmpeg);
  updateDepEl(els.depsYtdlp, depsOk.ytdlp, 'Missing');
  updateDepEl(els.depsFfmpeg, depsOk.ffmpeg, 'Missing');
  els.analyzeBtn.disabled = !depsOk.ytdlp || busy;

  if (!depsOk.ytdlp) {
    setStatus('Failed: yt-dlp is not installed or not on PATH.', 'failed');
  } else if (!depsOk.ffmpeg) {
    setStatus('Warning: FFmpeg missing — merges may fail. Install ffmpeg.', 'failed');
  } else {
    setStatus('Idle');
  }
}

function hidePanels() {
  els.meta.classList.add('hidden');
  els.collection.classList.add('hidden');
  qualities = [];
  singleVideo = null;
  collectionVideos = [];
  selectedIds.clear();
  els.quality.innerHTML = '';
  els.listWindow.innerHTML = '';
  els.downloadBtn.disabled = true;
  els.downloadSelectedBtn.disabled = true;
}

function selectedQuality() {
  const formatId = els.quality.value;
  return qualities.find((item) => item.formatId === formatId) || null;
}

function showVideoMeta(data) {
  singleVideo = data;
  els.title.textContent = data.title;
  els.duration.textContent = `Duration: ${data.duration}`;
  if (data.thumbnail) {
    els.thumb.src = data.thumbnail;
    els.thumb.hidden = false;
  } else {
    els.thumb.removeAttribute('src');
    els.thumb.hidden = true;
  }

  qualities = data.qualities || [];
  els.quality.innerHTML = '';
  for (const q of qualities) {
    const opt = document.createElement('option');
    opt.value = q.formatId;
    opt.textContent = q.label;
    els.quality.appendChild(opt);
  }

  const lastFormatId = loadLastSingleFormatId();
  if (lastFormatId && qualities.some((q) => q.formatId === lastFormatId)) {
    els.quality.value = lastFormatId;
  }

  els.collection.classList.add('hidden');
  els.meta.classList.remove('hidden');
  els.downloadBtn.disabled = busy || qualities.length === 0;
}

function updateSelectionCount() {
  const n = selectedIds.size;
  const m = collectionVideos.length;
  const more = hasMore ? ' (more available)' : '';
  els.selectionCount.textContent = `${n} of ${m} selected${more}`;
  els.downloadSelectedBtn.disabled = busy || n === 0;
}

function renderWindow() {
  const total = collectionVideos.length;
  els.spacer.style.height = `${total * ROW_HEIGHT}px`;

  const scrollTop = els.viewport.scrollTop;
  let start = Math.floor(scrollTop / ROW_HEIGHT) - 5;
  if (start < 0) start = 0;
  let end = start + WINDOW_SIZE;
  if (end > total) end = total;

  els.listWindow.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
  els.listWindow.innerHTML = '';

  for (let i = start; i < end; i += 1) {
    const video = collectionVideos[i];
    const row = document.createElement('div');
    row.className = 'video-row';
    row.dataset.id = video.id;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedIds.has(video.id);
    cb.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(video.id);
      else selectedIds.delete(video.id);
      updateSelectionCount();
    });

    const toggleRow = () => {
      if (selectedIds.has(video.id)) selectedIds.delete(video.id);
      else selectedIds.add(video.id);
      cb.checked = selectedIds.has(video.id);
      updateSelectionCount();
    };

    row.addEventListener('click', toggleRow);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleRow();
      }
    });

    const img = document.createElement('img');
    img.alt = '';
    if (video.thumbnail) img.src = video.thumbnail;

    const text = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'row-title';
    title.textContent = video.title;
    const meta = document.createElement('p');
    meta.className = 'row-meta';
    const parts = [video.duration];
    if (video.uploadDate) parts.push(video.uploadDate);
    meta.textContent = parts.join(' · ');
    text.appendChild(title);
    text.appendChild(meta);

    row.appendChild(cb);
    row.appendChild(img);
    row.appendChild(text);
    els.listWindow.appendChild(row);
  }
}

function showCollection(data, { append = false } = {}) {
  if (!append) {
    collectionVideos = [];
    selectedIds.clear();
  }

  const incoming = data.videos || [];
  const seen = new Set(collectionVideos.map((v) => v.id));
  for (const v of incoming) {
    if (!seen.has(v.id)) {
      collectionVideos.push(v);
      seen.add(v.id);
    }
  }

  nextStart = data.nextStart;
  hasMore = Boolean(data.hasMore);
  els.collectionTitle.textContent = data.title || (data.type === 'channel' ? 'Channel' : 'Playlist');
  els.loadMoreBtn.classList.toggle('hidden', !hasMore);
  els.meta.classList.add('hidden');
  els.collection.classList.remove('hidden');
  restoreBatchQuality();
  updateSelectionCount();
  renderWindow();
}

async function onAnalyze() {
  const url = els.urlInput.value.trim();
  if (!url) {
    setStatus('Failed: Please enter a YouTube URL.', 'failed');
    return;
  }

  setBusy(true);
  hidePanels();
  setProgress(0, '');
  setStatus('Analyzing…', 'analyzing');
  collectionUrl = url;

  const result = await window.api.analyze(url);
  setBusy(false);

  if (!result.ok) {
    showError(result);
    return;
  }

  saveRecent(url);
  renderRecent();

  if (result.type === 'video') {
    showVideoMeta(result);
    setStatus('Ready to download');
    return;
  }

  showCollection(result, { append: false });
  setStatus(`Loaded ${collectionVideos.length} video(s). Select items to download.`);
}

async function onLoadMore() {
  if (!hasMore || nextStart == null) return;
  setBusy(true);
  setStatus('Loading more…', 'analyzing');

  const result = await window.api.loadMore(collectionUrl, nextStart);
  setBusy(false);

  if (!result.ok) {
    showError(result);
    return;
  }

  showCollection(result, { append: true });
  setStatus(`Loaded ${collectionVideos.length} video(s).`);
}

async function onDownloadSingle() {
  if (!singleVideo) return;
  const q = selectedQuality();
  if (!q) {
    setStatus('Failed: Please select a quality.', 'failed');
    return;
  }

  if (q.needsAudioMerge && !depsOk.ffmpeg) {
    setStatus(
      'Failed: FFmpeg is required to merge video and audio. Install ffmpeg and try again.',
      'failed'
    );
    return;
  }

  setBusy(true);
  setProgress(0, 'Queued…');
  setStatus('Downloading…', 'downloading');
  saveLastSingleFormatId(q.formatId);

  const result = await window.api.enqueue([
    {
      id: singleVideo.videoId,
      url: singleVideo.url || els.urlInput.value.trim(),
      title: singleVideo.title,
      formatId: q.formatId,
      needsAudioMerge: q.needsAudioMerge,
    },
  ]);

  setBusy(false);

  if (!result.ok) {
    showError(result);
    return;
  }

  setStatus(`Queued for download (${els.concurrency.value} parallel).`, 'downloading');
}

async function onDownloadSelected() {
  const jobs = collectionVideos
    .filter((v) => selectedIds.has(v.id))
    .map((v) => ({
      id: v.id,
      url: v.url,
      title: v.title,
      qualityHeight: els.batchQuality.value,
    }));

  if (jobs.length === 0) {
    setStatus('Failed: Select at least one video.', 'failed');
    return;
  }

  if (!depsOk.ffmpeg) {
    setStatus(
      'Failed: FFmpeg is required to merge video and audio. Install ffmpeg and try again.',
      'failed'
    );
    return;
  }

  saveLastBatchQuality(els.batchQuality.value);

  setBusy(true);
  setStatus(`Enqueueing ${jobs.length} download(s)…`, 'downloading');

  const result = await window.api.enqueue(jobs);
  setBusy(false);

  if (!result.ok) {
    showError(result);
    return;
  }

  setStatus(`Queued ${jobs.length} video(s). Failed items will not stop the rest.`, 'downloading');
}

function renderQueue(queue) {
  if (!queue || queue.length === 0) {
    els.queuePanel.classList.add('hidden');
    els.queueList.innerHTML = '';
    return;
  }

  els.queuePanel.classList.remove('hidden');
  els.queueList.innerHTML = '';

  const recent = queue.slice(-40);
  for (const job of recent) {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'q-title';
    title.textContent = job.title || job.url;
    title.title = job.title || job.url;

    const actions = document.createElement('div');
    actions.className = 'q-actions';

    const status = document.createElement('span');
    status.className = `q-status ${job.status}`;
    if (job.status === 'downloading' && job.progress && job.progress.percent != null) {
      status.textContent = `${Number(job.progress.percent).toFixed(0)}%`;
    } else if (job.status === 'paused') {
      const pct =
        job.progress && job.progress.percent != null
          ? ` ${Number(job.progress.percent).toFixed(0)}%`
          : '';
      status.textContent = `Paused${pct}`;
    } else if (job.status === 'failed' && job.error) {
      status.textContent = `Failed: ${job.error.message}`;
      status.title = job.error.details || job.error.message;
    } else if (job.status === 'completed') {
      status.textContent = 'Completed';
      status.title = job.path || '';
    } else {
      status.textContent = job.status;
    }

    actions.appendChild(status);

    if (job.status === 'downloading' || job.status === 'queued') {
      const pauseBtn = document.createElement('button');
      pauseBtn.type = 'button';
      pauseBtn.className = 'btn-secondary q-btn';
      pauseBtn.textContent = 'Pause';
      pauseBtn.addEventListener('click', async () => {
        const result = await window.api.pauseJob(job.jobId);
        if (!result || !result.ok) {
          showError(result || { message: 'Could not pause job.' });
          return;
        }
        renderQueue(result.queue || []);
      });
      actions.appendChild(pauseBtn);
    }

    if (job.status === 'paused') {
      const resumeBtn = document.createElement('button');
      resumeBtn.type = 'button';
      resumeBtn.className = 'btn-secondary q-btn';
      resumeBtn.textContent = 'Resume';
      resumeBtn.addEventListener('click', async () => {
        const result = await window.api.resumeJob(job.jobId);
        if (!result || !result.ok) {
          showError(result || { message: 'Could not resume job.' });
          return;
        }
        renderQueue(result.queue || []);
      });
      actions.appendChild(resumeBtn);
    }

    li.appendChild(title);
    li.appendChild(actions);
    els.queueList.appendChild(li);
  }

  const active = queue.filter((j) => j.status === 'downloading');
  const paused = queue.filter((j) => j.status === 'paused').length;
  const failed = queue.filter((j) => j.status === 'failed').length;
  const completed = queue.filter((j) => j.status === 'completed').length;
  const queued = queue.filter((j) => j.status === 'queued').length;

  if (active.length > 0) {
    const pct =
      active[0].progress && active[0].progress.percent != null
        ? Number(active[0].progress.percent)
        : 0;
    const parts = [
      `${pct.toFixed(1)}%`,
      `${active.length} downloading`,
    ];
    if (paused) parts.push(`${paused} paused`);
    parts.push(`${completed} done`);
    parts.push(`${failed} failed`);
    parts.push(`${queued} waiting`);
    setProgress(pct, parts.join(' · '));
  } else if (paused > 0 && queued === 0 && active.length === 0) {
    setProgress(
      0,
      `${paused} paused · ${completed} done · ${failed} failed · ${queued} waiting`
    );
  } else if (queued === 0 && paused === 0 && queue.length > 0) {
    setProgress(100, `100% · ${completed} completed · ${failed} failed`);
    if (failed === 0) {
      setStatus(`Completed: ${completed} download(s).`, 'completed');
    } else {
      setStatus(`Finished with ${failed} failed of ${queue.length}.`, 'failed');
    }
  }
}

window.api.onQueueUpdate((data) => {
  renderQueue(data.queue || []);
});

window.api.onQueueProgress((payload) => {
  if (payload && payload.percent != null) {
    const parts = [`${Number(payload.percent).toFixed(1)}%`];
    if (payload.speed) parts.push(payload.speed);
    if (payload.eta) parts.push(`ETA ${payload.eta}`);
    setProgress(payload.percent, parts.join(' · '));
  }
});

els.analyzeBtn.addEventListener('click', onAnalyze);
els.downloadBtn.addEventListener('click', onDownloadSingle);
els.downloadSelectedBtn.addEventListener('click', onDownloadSelected);
els.loadMoreBtn.addEventListener('click', onLoadMore);
els.selectAllBtn.addEventListener('click', () => {
  for (const v of collectionVideos) selectedIds.add(v.id);
  updateSelectionCount();
  renderWindow();
});
els.deselectAllBtn.addEventListener('click', () => {
  selectedIds.clear();
  updateSelectionCount();
  renderWindow();
});
els.viewport.addEventListener('scroll', () => {
  renderWindow();
});
els.urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !busy) onAnalyze();
});
els.quality.addEventListener('change', () => {
  saveLastSingleFormatId(els.quality.value);
});
els.batchQuality.addEventListener('change', () => {
  saveLastBatchQuality(els.batchQuality.value);
});
els.cookiesChooseBtn.addEventListener('click', async () => {
  const result = await window.api.pickCookiesFile();
  if (!result || !result.ok) {
    showError(result || { message: 'Could not pick cookies file.' });
    return;
  }
  if (!result.canceled) {
    renderCookiesPath(result.cookiesPath);
    setStatus('Cookies file saved.');
  }
});
els.cookiesClearBtn.addEventListener('click', async () => {
  const result = await window.api.setCookiesPath(null);
  if (!result || !result.ok) {
    showError(result || { message: 'Could not clear cookies path.' });
    return;
  }
  renderCookiesPath(null);
  setStatus('Cookies file cleared.');
});
els.concurrency.addEventListener('change', async () => {
  const concurrency = Number(els.concurrency.value);
  const result = await window.api.setSettings({ concurrency });
  if (!result || !result.ok) {
    showError(result || { message: 'Could not save parallel downloads setting.' });
    return;
  }
  els.concurrency.value = String(result.concurrency || 1);
  setStatus(`Parallel downloads set to ${result.concurrency}.`);
});
els.clearQueueBtn.addEventListener('click', async () => {
  const result = await window.api.clearQueue();
  if (!result || !result.ok) {
    showError(result || { message: 'Could not clear queue.' });
    return;
  }
  renderQueue(result.queue || []);
  setStatus('Queue cleared (active and paused downloads kept).');
});

hidePanels();
setProgress(0, '');
restoreBatchQuality();
refreshDeps();
refreshCookiesSettings();
renderRecent();
