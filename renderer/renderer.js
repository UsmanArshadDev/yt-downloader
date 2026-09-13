'use strict';

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
  progressBar: document.getElementById('progress-bar'),
  progressText: document.getElementById('progress-text'),
  status: document.getElementById('status'),
};

/** @type {{ formatId: string, height: number, label: string, needsAudioMerge: boolean }[]} */
let qualities = [];
let busy = false;

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status${kind ? ` ${kind}` : ''}`;
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
}

const depsOk = { ytdlp: false, ffmpeg: false };

function updateDepEl(el, ok, missingLabel) {
  el.textContent = ok ? 'OK' : missingLabel;
  el.className = `deps-status ${ok ? 'ok' : 'missing'}`;
}

async function refreshDeps() {
  const result = await window.api.checkDeps();
  if (!result.ok) {
    updateDepEl(els.depsYtdlp, false, 'Error');
    updateDepEl(els.depsFfmpeg, false, 'Error');
    setStatus(`Failed: ${result.message}`, 'failed');
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

function hideMeta() {
  els.meta.classList.add('hidden');
  qualities = [];
  els.quality.innerHTML = '';
  els.downloadBtn.disabled = true;
}

function showMeta(data) {
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
    opt.dataset.needsAudioMerge = q.needsAudioMerge ? '1' : '0';
    els.quality.appendChild(opt);
  }

  els.meta.classList.remove('hidden');
  els.downloadBtn.disabled = busy || qualities.length === 0;
}

function selectedQuality() {
  const formatId = els.quality.value;
  const q = qualities.find((item) => item.formatId === formatId);
  return q || null;
}

async function onAnalyze() {
  const url = els.urlInput.value.trim();
  if (!url) {
    setStatus('Failed: Please enter a YouTube video URL.', 'failed');
    return;
  }

  setBusy(true);
  hideMeta();
  setProgress(0, '');
  setStatus('Analyzing…', 'analyzing');

  const result = await window.api.analyze(url);
  setBusy(false);

  if (!result.ok) {
    setStatus(`Failed: ${result.message}`, 'failed');
    return;
  }

  showMeta(result);
  setStatus('Ready to download');
}

async function onDownload() {
  const url = els.urlInput.value.trim();
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
  setProgress(0, 'Starting…');
  setStatus('Downloading…', 'downloading');

  const result = await window.api.download(url, q.formatId, q.needsAudioMerge);
  setBusy(false);

  if (!result.ok) {
    setStatus(`Failed: ${result.message}`, 'failed');
    return;
  }

  setProgress(100, '100%');
  setStatus(`Completed: ${result.path}`, 'completed');
}

window.api.onDownloadProgress((progress) => {
  const parts = [];
  if (progress.percent != null) parts.push(`${Number(progress.percent).toFixed(1)}%`);
  if (progress.speed) parts.push(progress.speed);
  if (progress.eta) parts.push(`ETA ${progress.eta}`);
  if (progress.total) parts.push(`of ${progress.total}`);
  setProgress(progress.percent || 0, parts.join(' · '));
});

els.analyzeBtn.addEventListener('click', onAnalyze);
els.downloadBtn.addEventListener('click', onDownload);
els.urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !busy) {
    onAnalyze();
  }
});

hideMeta();
setProgress(0, '');
refreshDeps();
