# YouTube Downloader

Minimal Electron app for Ubuntu: paste a YouTube URL, analyze metadata, pick a quality, and download an MP4 via **yt-dlp** (with **FFmpeg** for video/audio merges).

## Requirements

- Ubuntu (or similar Linux)
- Node.js 18+ (Node 24 works)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your `PATH`
- [FFmpeg](https://ffmpeg.org/) on your `PATH` (needed when video and audio streams are merged)

### Install yt-dlp (Ubuntu)

```bash
sudo apt update
sudo apt install -y pipx
pipx ensurepath
pipx install yt-dlp
```

Or follow the [official yt-dlp install guide](https://github.com/yt-dlp/yt-dlp#installation).

### Install FFmpeg

```bash
sudo apt update
sudo apt install -y ffmpeg
```

Confirm both tools:

```bash
yt-dlp --version
ffmpeg -version
```

## Run the app

```bash
cd /path/to/yt-downloader
npm install
npm start
```

`npm start` launches Electron with `--no-sandbox` so it works on Ubuntu without reconfiguring Chromium’s SUID helper after every `npm install`. App security (`contextIsolation`, no Node in the renderer) is unchanged.

To use the SUID sandbox instead, remove `--no-sandbox` from the scripts in `package.json` and run:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Usage

1. Paste a single YouTube video URL (`youtube.com/watch`, `youtu.be`, or `youtube.com/shorts`).
2. Click **Analyze** to load title, thumbnail, duration, and available MP4 qualities.
3. Choose a quality and click **Download**.
4. Files are saved to `~/Downloads/YouTube Downloader`.

Progress shows while downloading. Status becomes **Completed** (with the file path) or **Failed** with an error message.

## Smoke checks

- Invalid URL → clear error
- yt-dlp / FFmpeg missing → shown in the dependency strip and status line
- Public video analyze + download → MP4 under `~/Downloads/YouTube Downloader`
- Restricted / unavailable video → failure message

## Milestone 1 scope

Single video, MP4 only, basic UI and progress. No queue, channel downloads, audio-only, settings, or packaging.
