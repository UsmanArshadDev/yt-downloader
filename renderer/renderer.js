'use strict';

const ROW_HEIGHT = 64;
const WINDOW_SIZE = 40;

const els = {
  depsYtdlp: document.querySelector('#deps-ytdlp .deps-status'),
  depsFfmpeg: document.querySelector('#deps-ffmpeg .deps-status'),
  depsDeno: document.querySelector('#deps-deno .deps-status'),
  urlInput: document.getElementById('url-input'),
  analyzeBtn: document.getElementById('analyze-btn'),
  meta: document.getElementById('meta'),
  thumb: document.getElementById('thumb'),
  title: document.getElementById('title'),
  duration: document.getElementById('duration'),
  quality: document.getElementById('quality'),
  singleFormat: document.getElementById('single-format'),
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
  batchFormat: document.getElementById('batch-format'),
  loadMoreBtn: document.getElementById('load-more-btn'),
  downloadSelectedBtn: document.getElementById('download-selected-btn'),
  progressBar: document.getElementById('progress-bar'),
  progressText: document.getElementById('progress-text'),
  queuePanel: document.getElementById('queue-panel'),
  queueList: document.getElementById('queue-list'),
  clearQueueBtn: document.getElementById('clear-queue-btn'),
  pauseAllBtn: document.getElementById('pause-all-btn'),
  resumeAllBtn: document.getElementById('resume-all-btn'),
  cookiesPath: document.getElementById('cookies-path'),
  cookiesChooseBtn: document.getElementById('cookies-choose-btn'),
  cookiesClearBtn: document.getElementById('cookies-clear-btn'),
  downloadDir: document.getElementById('download-dir'),
  downloadDirChooseBtn: document.getElementById('download-dir-choose-btn'),
  concurrency: document.getElementById('concurrency'),
  acceptLowerQuality: document.getElementById('accept-lower-quality'),
  settingsPanel: document.getElementById('settings-panel'),
  status: document.getElementById('status'),
  errorDetails: document.getElementById('error-details'),
  errorDetailsText: document.getElementById('error-details-text'),
};

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

const depsOk = { ytdlp: false, ffmpeg: false, deno: false };

/**
 * @param {{ url: string, title?: string, type?: string }} entry
 */
async function saveRecent(entry) {
  if (!entry || !entry.url) return;
  try {
    await window.api.addRecent({
      url: entry.url,
      title: entry.title || entry.url,
      type: entry.type || 'video',
    });
  } catch {
    // ignore
  }
}

/**
 * @param {boolean} show
 */
function applyShowSettings(show) {
  if (!els.settingsPanel) return;
  els.settingsPanel.classList.toggle('hidden', !show);
}

/**
 * @param {string|null|undefined} cookiesPath
 */
function renderCookiesPath(cookiesPath) {
  els.cookiesPath.value = cookiesPath || '';
  els.cookiesPath.placeholder = cookiesPath ? '' : 'No cookies.txt selected';
}

/**
 * @param {string|null|undefined} downloadDir
 */
function renderDownloadDir(downloadDir) {
  if (!els.downloadDir) return;
  els.downloadDir.value = downloadDir || '';
  els.downloadDir.placeholder = downloadDir ? '' : '~/Downloads/YouTube Downloader';
}

/**
 * @param {{
 *   cookiesPath?: string|null,
 *   downloadDir?: string|null,
 *   cookiesHealth?: object,
 *   concurrency?: number,
 *   acceptLowerQuality?: boolean,
 *   showSettings?: boolean
 * }|null|undefined} result
 */
function applyCookiesSettings(result) {
  if (!result) return;
  renderCookiesPath(result.cookiesPath);
  renderDownloadDir(result.downloadDir);
  if (typeof result.showSettings === 'boolean') {
    applyShowSettings(result.showSettings);
  }
  if (els.acceptLowerQuality) {
    els.acceptLowerQuality.checked = Boolean(result.acceptLowerQuality);
  }
}

async function refreshCookiesSettings() {
  const result = await window.api.getSettings();
  if (result && result.ok) {
    applyCookiesSettings(result);
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
    els.errorDetails.open = true;
  } else {
    els.errorDetails.classList.add('hidden');
    els.errorDetailsText.textContent = '';
    els.errorDetails.open = false;
  }
}

/**
 * Show full queue error in the status / technical-details panel.
 * @param {{ message?: string, details?: string|null }|null|undefined} error
 */
function showQueueError(error) {
  if (!error) return;
  const msg = error.message || 'Unknown error';
  const details = [error.message, error.details].filter(Boolean).join('\n\n');
  setStatus(`Failed: ${msg}`, 'failed', details);
  if (els.errorDetails && typeof els.errorDetails.scrollIntoView === 'function') {
    els.errorDetails.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  els.urlInput.disabled = next;
  els.downloadSelectedBtn.disabled = next || selectedIds.size === 0;
  els.loadMoreBtn.disabled = next;
  els.selectAllBtn.disabled = next;
  els.deselectAllBtn.disabled = next;
  if (els.batchFormat) els.batchFormat.disabled = next;
  if (els.singleFormat) els.singleFormat.disabled = next;
  syncSingleFormatUi();
  syncBatchFormatUi();
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
    if (els.depsDeno) updateDepEl(els.depsDeno, false, 'Error');
    showError(result);
    setBusy(false);
    return;
  }

  depsOk.ytdlp = Boolean(result.ytdlp);
  depsOk.ffmpeg = Boolean(result.ffmpeg);
  depsOk.deno = Boolean(result.deno);
  updateDepEl(els.depsYtdlp, depsOk.ytdlp, 'Missing');
  updateDepEl(els.depsFfmpeg, depsOk.ffmpeg, 'Missing');
  if (els.depsDeno) {
    if (depsOk.deno) {
      els.depsDeno.textContent = 'OK';
      els.depsDeno.className = 'deps-status ok';
    } else {
      els.depsDeno.textContent = 'Optional (YouTube EJS)';
      els.depsDeno.className = 'deps-status warn';
    }
  }
  els.analyzeBtn.disabled = !depsOk.ytdlp || busy;

  if (!depsOk.ytdlp) {
    setStatus('Failed: yt-dlp is not installed or not on PATH.', 'failed');
  } else if (!depsOk.ffmpeg) {
    setStatus('Warning: FFmpeg missing — merges may fail. Install ffmpeg.', 'failed');
  } else if (!depsOk.deno) {
    setStatus('Ready (Deno not on PATH — high-quality YouTube may need it).');
  } else {
    setStatus('Ready');
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
  syncSingleFormatUi();
}

function syncSingleFormatUi() {
  if (!els.singleFormat) return;
  const audio = els.singleFormat.value === 'm4a';
  els.quality.disabled = busy || audio || qualities.length === 0;
  els.downloadBtn.disabled = busy || (!audio && qualities.length === 0);
}

function syncBatchFormatUi() {
  if (!els.batchFormat || !els.batchQuality) return;
  const audio = els.batchFormat.value === 'm4a';
  els.batchQuality.disabled = busy || audio;
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

  await saveRecent({
    url,
    title: result.title || url,
    type: result.type || 'video',
  });

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

  const mediaType = els.singleFormat && els.singleFormat.value === 'm4a' ? 'audio' : 'video';

  if (mediaType === 'audio') {
    if (!depsOk.ffmpeg) {
      setStatus(
        'Failed: FFmpeg is required for audio extraction. Install ffmpeg and try again.',
        'failed'
      );
      return;
    }
    setBusy(true);
    setProgress(0, 'Queued…');
    setStatus('Downloading audio…', 'downloading');
    const result = await window.api.enqueue([
      {
        id: singleVideo.videoId,
        url: singleVideo.url || els.urlInput.value.trim(),
        title: singleVideo.title,
        mediaType: 'audio',
      },
    ]);
    setBusy(false);
    if (!result.ok) {
      showError(result);
      return;
    }
    setStatus(`Queued audio download (${els.concurrency.value} parallel).`, 'downloading');
    return;
  }

  const q = selectedQuality();
  if (!q) {
    setStatus('Failed: Please select a quality.', 'failed');
    return;
  }

  if (!depsOk.ffmpeg) {
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
      qualityHeight: q.height,
      needsAudioMerge: true,
      mediaType: 'video',
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
  const mediaType = els.batchFormat && els.batchFormat.value === 'm4a' ? 'audio' : 'video';
  const jobs = collectionVideos
    .filter((v) => selectedIds.has(v.id))
    .map((v) => ({
      id: v.id,
      url: v.url,
      title: v.title,
      mediaType,
      qualityHeight: mediaType === 'video' ? els.batchQuality.value : null,
    }));

  if (jobs.length === 0) {
    setStatus('Failed: Select at least one video.', 'failed');
    return;
  }

  if (!depsOk.ffmpeg) {
    setStatus(
      'Failed: FFmpeg is required to merge video/audio or extract M4A. Install ffmpeg and try again.',
      'failed'
    );
    return;
  }

  if (mediaType === 'video') {
    saveLastBatchQuality(els.batchQuality.value);
  }

  setBusy(true);
  setStatus(`Enqueueing ${jobs.length} download(s)…`, 'downloading');

  const result = await window.api.enqueue(jobs);
  setBusy(false);

  if (!result.ok) {
    showError(result);
    return;
  }

  setStatus(
    `Queued ${jobs.length} ${mediaType === 'audio' ? 'audio' : 'video'} item(s).`,
    'downloading'
  );
}

function formatSizeProgress(progress) {
  if (!progress) return '';
  if (progress.downloaded && progress.total) {
    return `${progress.downloaded} / ${progress.total}`;
  }
  if (progress.total) return `of ${progress.total}`;
  if (progress.downloaded) return progress.downloaded;
  return '';
}

function qualityLabelForJob(job) {
  if (job.mediaType === 'audio') return 'Audio · M4A';
  const height = job.activeHeight || job.outputHeight;
  if (height) return `${height}p`;
  if (job.requestedHeight) return `≤${job.requestedHeight}p`;
  return '';
}

function isQualityWarning(job) {
  if (job.mediaType === 'audio') return false;
  const height = job.activeHeight || job.outputHeight;
  const wanted = job.requestedHeight;
  if (!height || !wanted || wanted <= 360) return false;
  return height < 480 || height < wanted * 0.7;
}

function renderQueue(queue) {
  if (!queue || queue.length === 0) {
    els.queuePanel.classList.add('hidden');
    els.queueList.innerHTML = '';
    return;
  }

  els.queuePanel.classList.remove('hidden');
  els.queueList.innerHTML = '';

  for (const job of queue) {
    const li = document.createElement('li');
    li.dataset.jobId = job.jobId;

    const top = document.createElement('div');
    top.className = 'q-top';

    const title = document.createElement('span');
    title.className = 'q-title';
    title.textContent = job.title || job.url;
    const tipParts = [job.title || job.url];
    if (job.requestedHeight && job.mediaType !== 'audio') {
      tipParts.push(`wanted up to ${job.requestedHeight}p`);
    }
    title.title = tipParts.join('\n');

    const actions = document.createElement('div');
    actions.className = 'q-actions';

    const status = document.createElement('span');
    status.className = `q-status ${job.status}`;
    if (isQualityWarning(job) && (job.status === 'downloading' || job.status === 'completed')) {
      status.classList.add('quality-warn');
    }

    const qLabel = qualityLabelForJob(job);
    if (job.status === 'downloading') {
      const pct =
        job.progress && job.progress.percent != null
          ? `${Number(job.progress.percent).toFixed(0)}%`
          : '';
      status.textContent = [qLabel, pct].filter(Boolean).join(' · ') || 'downloading';
    } else if (job.status === 'paused') {
      const pct =
        job.progress && job.progress.percent != null
          ? ` ${Number(job.progress.percent).toFixed(0)}%`
          : '';
      status.textContent = `Paused${qLabel ? ` · ${qLabel}` : ''}${pct}`;
    } else if (job.status === 'failed' && job.error) {
      status.textContent = `Failed: ${job.error.message}`;
      status.title = 'Click to show full error';
      status.classList.add('q-error-clickable');
      status.setAttribute('role', 'button');
      status.tabIndex = 0;
      const reveal = () => {
        const existing = li.querySelector('.q-error-full');
        if (existing) {
          existing.remove();
          return;
        }
        const full = document.createElement('pre');
        full.className = 'q-error-full';
        const parts = [job.error.message];
        if (job.error.details) parts.push(String(job.error.details));
        full.textContent = parts.join('\n\n');
        li.appendChild(full);
        showQueueError(job.error);
      };
      status.addEventListener('click', (ev) => {
        ev.preventDefault();
        reveal();
      });
      status.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          reveal();
        }
      });
    } else if (job.status === 'completed') {
      if (job.mediaType === 'audio') {
        status.textContent = 'Completed · Audio M4A';
      } else if (job.outputHeight) {
        const wanted =
          job.requestedHeight && job.requestedHeight > job.outputHeight
            ? ` (wanted ${job.requestedHeight}p)`
            : '';
        status.textContent = `Completed · ${job.outputHeight}p${wanted}`;
      } else if (job.qualityWarning) {
        status.textContent = 'Completed (low quality)';
      } else {
        status.textContent = 'Completed';
      }
      const doneTips = [];
      if (job.outputWidth && job.outputHeight) {
        doneTips.push(`${job.outputWidth}x${job.outputHeight}`);
      }
      if (job.qualityWarning) doneTips.push(job.qualityWarning);
      if (job.path) doneTips.push(job.path);
      status.title = doneTips.join('\n');
    } else {
      status.textContent = qLabel ? `${job.status} · ${qLabel}` : job.status;
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

    top.appendChild(title);
    top.appendChild(actions);
    li.appendChild(top);

    if (
      (job.status === 'downloading' || job.status === 'paused') &&
      job.progress &&
      job.progress.percent != null
    ) {
      const track = document.createElement('div');
      track.className = 'q-progress-track';
      const bar = document.createElement('div');
      bar.className = 'q-progress-bar';
      bar.style.width = `${Math.max(0, Math.min(100, Number(job.progress.percent)))}%`;
      track.appendChild(bar);
      li.appendChild(track);

      const meta = document.createElement('p');
      meta.className = 'q-progress-meta';
      const metaParts = [];
      const size = formatSizeProgress(job.progress);
      if (size) metaParts.push(size);
      if (job.progress.speed) metaParts.push(job.progress.speed);
      if (job.progress.eta) metaParts.push(`ETA ${job.progress.eta}`);
      meta.textContent = metaParts.join(' · ');
      if (metaParts.length) li.appendChild(meta);
    }

    els.queueList.appendChild(li);
  }

  const active = queue.filter((j) => j.status === 'downloading');
  const paused = queue.filter((j) => j.status === 'paused').length;
  const failed = queue.filter((j) => j.status === 'failed').length;
  const completed = queue.filter((j) => j.status === 'completed').length;
  const queued = queue.filter((j) => j.status === 'queued').length;

  if (active.length > 0) {
    const percents = active
      .map((j) => (j.progress && j.progress.percent != null ? Number(j.progress.percent) : 0))
      .filter((n) => Number.isFinite(n));
    const avg =
      percents.length > 0 ? percents.reduce((a, b) => a + b, 0) / percents.length : 0;
    const parts = [`avg ${avg.toFixed(0)}%`, `${active.length} downloading`];
    if (paused) parts.push(`${paused} paused`);
    parts.push(`${completed} done`);
    parts.push(`${failed} failed`);
    parts.push(`${queued} waiting`);
    setProgress(avg, parts.join(' · '));
  } else if (paused > 0 && queued === 0 && active.length === 0) {
    setProgress(
      0,
      `${paused} paused · ${completed} done · ${failed} failed · ${queued} waiting`
    );
  } else if (queued === 0 && paused === 0 && queue.length > 0) {
    setProgress(100, `100% · ${completed} completed · ${failed} failed`);
    const warned = queue.filter((j) => j.status === 'completed' && j.qualityWarning).length;
    if (failed === 0) {
      if (warned > 0) {
        setStatus(
          `Completed: ${completed} download(s). ${warned} below requested quality (see queue).`,
          'completed'
        );
      } else {
        setStatus(`Completed: ${completed} download(s).`, 'completed');
      }
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
if (els.singleFormat) {
  els.singleFormat.addEventListener('change', () => {
    syncSingleFormatUi();
  });
}
if (els.batchFormat) {
  els.batchFormat.addEventListener('change', () => {
    syncBatchFormatUi();
  });
}
els.cookiesChooseBtn.addEventListener('click', async () => {
  const result = await window.api.pickCookiesFile();
  if (!result || !result.ok) {
    showError(result || { message: 'Could not pick cookies file.' });
    return;
  }
  if (!result.canceled) {
    applyCookiesSettings(result);
    setStatus('Cookies file saved.');
  }
});
els.cookiesClearBtn.addEventListener('click', async () => {
  const result = await window.api.setCookiesPath(null);
  if (!result || !result.ok) {
    showError(result || { message: 'Could not clear cookies path.' });
    return;
  }
  applyCookiesSettings(result);
  setStatus('Cookies file cleared.');
});
if (els.downloadDirChooseBtn) {
  els.downloadDirChooseBtn.addEventListener('click', async () => {
    const result = await window.api.pickDownloadDir();
    if (!result || !result.ok) {
      showError(result || { message: 'Could not pick download folder.' });
      return;
    }
    if (!result.canceled) {
      applyCookiesSettings(result);
      setStatus(`Download folder set to ${result.downloadDir}.`);
    }
  });
}
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
if (els.acceptLowerQuality) {
  els.acceptLowerQuality.addEventListener('change', async () => {
    const acceptLowerQuality = Boolean(els.acceptLowerQuality.checked);
    const result = await window.api.setSettings({ acceptLowerQuality });
    if (!result || !result.ok) {
      showError(result || { message: 'Could not save quality fallback setting.' });
      els.acceptLowerQuality.checked = !acceptLowerQuality;
      return;
    }
    els.acceptLowerQuality.checked = Boolean(result.acceptLowerQuality);
    setStatus(
      result.acceptLowerQuality
        ? 'Will keep best available quality if the selected one is unavailable.'
        : 'Will fail if selected quality is unavailable.'
    );
  });
}
els.clearQueueBtn.addEventListener('click', async () => {
  const result = await window.api.clearQueue();
  if (!result || !result.ok) {
    showError(result || { message: 'Could not clear queue.' });
    return;
  }
  renderQueue(result.queue || []);
  setStatus('Queue cleared (active and paused downloads kept).');
});
if (els.pauseAllBtn) {
  els.pauseAllBtn.addEventListener('click', async () => {
    const result = await window.api.pauseAll();
    if (!result || !result.ok) {
      showError(result || { message: 'Could not pause queue.' });
      return;
    }
    renderQueue(result.queue || []);
    setStatus('Paused all downloading and queued items.');
  });
}
if (els.resumeAllBtn) {
  els.resumeAllBtn.addEventListener('click', async () => {
    const result = await window.api.resumeAll();
    if (!result || !result.ok) {
      showError(result || { message: 'Could not resume queue.' });
      return;
    }
    renderQueue(result.queue || []);
    setStatus('Resumed paused items.');
  });
}

hidePanels();
setProgress(0, '');
restoreBatchQuality();
syncBatchFormatUi();
refreshDeps();
refreshCookiesSettings();

window.api.onUiVisibility((data) => {
  if (data && typeof data.showSettings === 'boolean') {
    applyShowSettings(data.showSettings);
  }
});

window.api.onRecentOpen((data) => {
  if (!data || !data.url) return;
  els.urlInput.value = data.url;
  els.urlInput.focus();
  setStatus('Loaded from Recent');
});
