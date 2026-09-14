# YouTube Downloader

Electron app for Ubuntu: paste a YouTube **video**, **playlist**, or **channel** URL, select videos, and download MP4s via **yt-dlp** and **FFmpeg**. Downloads share one queue on the **right**; **Parallel downloads** can be set to **1**, **2**, or **3** (default 1). Higher values may hit YouTube rate limits more often.

## Requirements

- Ubuntu (or similar Linux)
- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on `PATH`
- [FFmpeg](https://ffmpeg.org/) on `PATH`

```bash
sudo apt update
sudo apt install -y ffmpeg
pipx install yt-dlp   # or: pipx upgrade yt-dlp
```

## Run

```bash
cd /path/to/yt-downloader
npm install
npm start
```

`npm start` uses `--no-sandbox` for Ubuntu Electron. Fully quit any old app window before restarting so you get the latest UI.

## Usage

1. Paste a video, playlist, or channel URL.
2. **Analyze** (listing does not download).
3. Pick quality (or select videos for playlist/channel) → **Download** / **Download Selected**.
4. Files save to `~/Downloads/YouTube Downloader`.

The UI is two columns: controls on the left, **Download queue** on the right. Use **Pause** / **Resume** on individual queue rows. Pausing a running download holds that parallel slot so another video will not start in its place until you resume or clear it. **Clear queue** removes finished/waiting items; active and slot-holding paused downloads keep running.

Last single-video format and batch quality are remembered in the browser `localStorage`. Parallel downloads (1–3) is persisted with other app settings.

## Cookies.txt (bot check / age gate)

Public videos usually work with no cookies (android player client). If YouTube asks to sign in (“not a bot”), export a Netscape **cookies.txt** once and pick it in the app:

1. Install a **Get cookies.txt LOCALLY** browser extension in Chrome/Chromium.
2. While signed into YouTube in that browser, export cookies for `youtube.com`.
3. In the app, under **Cookies file**, click **Choose…** and select that file.

The app tries **android (no cookies)** first, then retries with `--cookies` + web client when needed. It does **not** use `--cookies-from-browser` (avoids Linux Chrome keyring / secretstorage failures).

If a high quality is missing (YouTube SABR), downloads fall back to progressive **360p** (`18`) / best MP4.

## Errors

Typed messages for bot check / auth, private, age-restricted, region, network, and unavailable videos. Expand **Technical details** under the status line for raw yt-dlp output.

## Scope

Two-column UI, single queue with per-job pause/resume (slot-holding), channel/playlist select, android-then-cookies ladder. No Chrome keyring path, DRM bypass, audio-only, Windows packaging, or YouTube Data API.
