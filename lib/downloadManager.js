'use strict';

const { EventEmitter } = require('events');
const { downloadVideo, downloadAudio, formatSelectorForHeight } = require('./ytdlp');
const { AppError } = require('./errors');
const { getConcurrency } = require('./appSettings');

let jobSeq = 0;

/**
 * Shared download queue with configurable concurrency (1–3)
 * and per-job pause that holds concurrency slots.
 */
class DownloadManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Array<object>} */
    this.jobs = [];
    this.activeCount = 0;
    this._lastProgressEmit = 0;
  }

  /**
   * @returns {object[]}
   */
  snapshot() {
    return this.jobs.map((j) => ({
      jobId: j.jobId,
      id: j.id,
      url: j.url,
      title: j.title,
      status: j.status,
      mediaType: j.mediaType || 'video',
      holdsSlot: Boolean(j.holdsSlot),
      path: j.path || null,
      error: j.error || null,
      progress: j.progress || null,
      qualityWarning: j.qualityWarning || null,
      outputWidth: j.outputWidth != null ? j.outputWidth : null,
      outputHeight: j.outputHeight != null ? j.outputHeight : null,
      requestedHeight: j.requestedHeight != null ? j.requestedHeight : null,
      activeHeight: j.activeHeight != null ? j.activeHeight : null,
    }));
  }

  emitUpdate() {
    this.emit('update', this.snapshot());
  }

  /**
   * @returns {number}
   */
  occupiedSlots() {
    return this.jobs.filter(
      (j) => j.status === 'downloading' || (j.status === 'paused' && j.holdsSlot)
    ).length;
  }

  /**
   * Enqueue one or more download jobs.
   * @param {Array<{
   *   id?: string,
   *   url: string,
   *   title?: string,
   *   formatId?: string,
   *   needsAudioMerge?: boolean,
   *   qualityHeight?: number|string|null,
   *   mediaType?: 'video'|'audio'
   * }>} jobs
   * @returns {string[]}
   */
  enqueue(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) {
      throw new AppError('INVALID_URL', 'No videos selected to download.');
    }

    const created = [];
    for (const raw of jobs) {
      if (!raw || !raw.url) continue;
      jobSeq += 1;
      const mediaType = raw.mediaType === 'audio' ? 'audio' : 'video';
      const job = {
        jobId: `job-${jobSeq}`,
        id: raw.id || raw.url,
        url: raw.url,
        title: raw.title || 'Untitled',
        formatId: raw.formatId || null,
        needsAudioMerge: raw.needsAudioMerge !== false,
        qualityHeight: raw.qualityHeight != null ? raw.qualityHeight : null,
        mediaType,
        status: 'queued',
        holdsSlot: false,
        pausing: false,
        cancel: null,
        path: null,
        error: null,
        progress: null,
        qualityWarning: null,
        outputWidth: null,
        outputHeight: null,
        activeHeight: null,
        requestedHeight:
          mediaType === 'video' &&
          raw.qualityHeight != null &&
          raw.qualityHeight !== 'best'
            ? Number(raw.qualityHeight) || null
            : null,
      };
      this.jobs.push(job);
      created.push(job);
    }

    if (created.length === 0) {
      throw new AppError('INVALID_URL', 'No videos selected to download.');
    }

    this.emitUpdate();
    this._pump();
    return created.map((j) => j.jobId);
  }

  /**
   * Remove finished and waiting jobs; keep active and slot-holding paused.
   * @returns {object[]}
   */
  clear() {
    this.jobs = this.jobs.filter(
      (j) => j.status === 'downloading' || (j.status === 'paused' && j.holdsSlot)
    );
    this.emitUpdate();
    this._pump();
    return this.snapshot();
  }

  /**
   * Re-check the queue against the current concurrency setting.
   */
  refresh() {
    this._pump();
  }

  /**
   * Pause a job. Downloading jobs hold their concurrency slot.
   * @param {string} jobId
   * @returns {object[]}
   */
  pause(jobId) {
    const job = this.jobs.find((j) => j.jobId === jobId);
    if (!job) {
      throw new AppError('INVALID_URL', 'Queue job not found.');
    }

    if (job.status === 'downloading') {
      // Flip to paused immediately so pauseAll/resumeAll and the UI see it
      // before the yt-dlp process finishes exiting.
      job.status = 'paused';
      job.holdsSlot = true;
      job.pausing = true;
      this.emitUpdate();
      if (typeof job.cancel === 'function') {
        job.cancel();
      } else {
        job.pausing = false;
        this._pump();
      }
      return this.snapshot();
    }

    if (job.status === 'queued') {
      job.status = 'paused';
      job.holdsSlot = false;
      job.pausing = false;
      this.emitUpdate();
      return this.snapshot();
    }

    throw new AppError('INVALID_URL', 'Only downloading or queued jobs can be paused.');
  }

  /**
   * Resume a paused job (re-queues at front, respects concurrency).
   * @param {string} jobId
   * @returns {object[]}
   */
  resume(jobId) {
    const job = this.jobs.find((j) => j.jobId === jobId);
    if (!job) {
      throw new AppError('INVALID_URL', 'Queue job not found.');
    }
    if (job.status !== 'paused') {
      throw new AppError('INVALID_URL', 'Only paused jobs can be resumed.');
    }

    job.status = 'queued';
    job.holdsSlot = false;
    job.pausing = false;
    job.error = null;
    this.jobs = [job, ...this.jobs.filter((j) => j !== job)];
    this.emitUpdate();
    this._pump();
    return this.snapshot();
  }

  /**
   * Pause all downloading and queued jobs.
   * @returns {object[]}
   */
  pauseAll() {
    const targets = this.jobs.filter(
      (j) => j.status === 'downloading' || j.status === 'queued'
    );
    for (const job of targets) {
      try {
        this.pause(job.jobId);
      } catch {
        // ignore individual failures
      }
    }
    this.emitUpdate();
    return this.snapshot();
  }

  /**
   * Resume all paused jobs (front-of-queue order preserved by resume).
   * @returns {object[]}
   */
  resumeAll() {
    const paused = this.jobs.filter((j) => j.status === 'paused');
    for (const job of paused) {
      job.status = 'queued';
      job.holdsSlot = false;
      job.pausing = false;
      job.error = null;
    }
    // Keep relative order; move resumed jobs to the front as a block.
    if (paused.length > 0) {
      const pausedSet = new Set(paused);
      this.jobs = [...paused, ...this.jobs.filter((j) => !pausedSet.has(j))];
    }
    this.emitUpdate();
    this._pump();
    return this.snapshot();
  }

  _pump() {
    // Wait until kill/exit finishes so we do not steal slots mid-pause.
    if (this.jobs.some((j) => j.pausing)) return;

    const limit = getConcurrency();
    while (this.occupiedSlots() < limit) {
      const next = this.jobs.find((j) => j.status === 'queued');
      if (!next) break;
      this._startJob(next);
    }
  }

  /**
   * @param {object} job
   */
  async _startJob(job) {
    this.activeCount += 1;
    job.status = 'downloading';
    job.holdsSlot = false;
    job.pausing = false;
    job.cancel = null;
    if (!job.progress) job.progress = { percent: 0 };
    this.emitUpdate();

    try {
      const options = {
        url: job.url,
        onProgress: (progress) => {
          if (!progress || typeof progress !== 'object') return;
          if (progress.height != null && Number.isFinite(Number(progress.height))) {
            job.activeHeight = Number(progress.height);
          }
          const prev = job.progress || {};
          job.progress = {
            percent: progress.percent != null ? progress.percent : prev.percent,
            downloaded:
              progress.downloaded != null ? progress.downloaded : prev.downloaded,
            total: progress.total != null ? progress.total : prev.total,
            speed: progress.speed != null ? progress.speed : prev.speed,
            eta: progress.eta != null ? progress.eta : prev.eta,
          };
          this.emit('progress', {
            jobId: job.jobId,
            ...job.progress,
            activeHeight: job.activeHeight,
          });
          const now = Date.now();
          if (now - this._lastProgressEmit >= 250) {
            this._lastProgressEmit = now;
            this.emitUpdate();
          }
        },
        onSpawn: (controls) => {
          job.cancel = () => {
            if (controls && typeof controls.kill === 'function') {
              controls.kill();
            }
          };
        },
      };

      let result;
      if (job.mediaType === 'audio') {
        result = await downloadAudio(options);
      } else {
        if (job.qualityHeight != null && job.qualityHeight !== '') {
          options.qualityHeight = job.qualityHeight;
          options.formatSelector = formatSelectorForHeight(job.qualityHeight);
          options.needsAudioMerge = true;
        } else if (job.formatId) {
          options.formatId = job.formatId;
          options.needsAudioMerge = job.needsAudioMerge;
          options.qualityHeight = job.qualityHeight;
        } else {
          options.qualityHeight = job.qualityHeight;
          options.formatSelector = formatSelectorForHeight(job.qualityHeight);
          options.needsAudioMerge = true;
        }
        result = await downloadVideo(options);
      }

      job.status = 'completed';
      job.path = result.path;
      job.progress = {
        ...(job.progress || {}),
        percent: 100,
      };
      job.error = null;
      job.holdsSlot = false;
      job.qualityWarning = result.qualityWarning || null;
      job.outputWidth = result.width != null ? result.width : null;
      job.outputHeight = result.height != null ? result.height : null;
      if (result.height != null) job.activeHeight = result.height;
      if (result.requestedHeight != null) {
        job.requestedHeight = result.requestedHeight;
      }
    } catch (err) {
      if (
        job.status === 'paused' ||
        job.pausing ||
        (err instanceof AppError && err.code === 'PAUSED')
      ) {
        job.status = 'paused';
        job.holdsSlot = true;
        job.pausing = false;
        job.error = null;
      } else if (err instanceof AppError) {
        job.status = 'failed';
        job.holdsSlot = false;
        job.error = {
          code: err.code,
          message: err.message,
          details: err.details || null,
        };
      } else {
        job.status = 'failed';
        job.holdsSlot = false;
        job.error = {
          code: 'DOWNLOAD_FAILED',
          message: err && err.message ? err.message : String(err),
          details: null,
        };
      }
    } finally {
      this.activeCount -= 1;
      job.cancel = null;
      this.emitUpdate();
      this._pump();
    }
  }
}

const downloadManager = new DownloadManager();

module.exports = {
  DownloadManager,
  downloadManager,
};
