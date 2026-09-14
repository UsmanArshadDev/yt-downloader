'use strict';

const { EventEmitter } = require('events');
const { downloadVideo, formatSelectorForHeight } = require('./ytdlp');
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
      holdsSlot: Boolean(j.holdsSlot),
      path: j.path || null,
      error: j.error || null,
      progress: j.progress || null,
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
   *   qualityHeight?: number|string|null
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
      const job = {
        jobId: `job-${jobSeq}`,
        id: raw.id || raw.url,
        url: raw.url,
        title: raw.title || 'Untitled',
        formatId: raw.formatId || null,
        needsAudioMerge: raw.needsAudioMerge !== false,
        qualityHeight: raw.qualityHeight != null ? raw.qualityHeight : null,
        status: 'queued',
        holdsSlot: false,
        pausing: false,
        cancel: null,
        path: null,
        error: null,
        progress: null,
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
      job.pausing = true;
      job.holdsSlot = true;
      if (typeof job.cancel === 'function') {
        job.cancel();
      } else {
        job.status = 'paused';
        job.pausing = false;
        this.emitUpdate();
        this._pump();
      }
      return this.snapshot();
    }

    if (job.status === 'queued') {
      job.status = 'paused';
      job.holdsSlot = false;
      this.emitUpdate();
      return this.snapshot();
    }

    throw new AppError('INVALID_URL', 'Only downloading or queued jobs can be paused.');
  }

  /**
   * Resume a paused job (same video; does not start a different one in its place).
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

    if (job.holdsSlot) {
      job.pausing = false;
      job.error = null;
      this._startJob(job);
      return this.snapshot();
    }

    job.status = 'queued';
    job.holdsSlot = false;
    job.pausing = false;
    job.error = null;
    this.emitUpdate();
    this._pump();
    return this.snapshot();
  }

  _pump() {
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
          job.progress = progress;
          this.emit('progress', { jobId: job.jobId, ...progress });
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

      if (job.formatId) {
        options.formatId = job.formatId;
        options.needsAudioMerge = job.needsAudioMerge;
      } else {
        options.formatSelector = formatSelectorForHeight(job.qualityHeight);
        options.needsAudioMerge = true;
      }

      const result = await downloadVideo(options);
      job.status = 'completed';
      job.path = result.path;
      job.progress = { percent: 100 };
      job.error = null;
      job.holdsSlot = false;
    } catch (err) {
      if (job.pausing || (err instanceof AppError && err.code === 'PAUSED')) {
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
