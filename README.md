# YouTube Downloader

Electron app for Ubuntu: paste a YouTube **video**, **playlist**, or **channel** URL, select videos, and download **MP4** or **audio-only M4A** via **yt-dlp** and **FFmpeg**. Downloads share one queue on the **right**; **Parallel downloads** can be set to **1**, **2**, or **3** (default 1).

## Requirements

- Ubuntu (or similar Linux)
- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on `PATH`
- [FFmpeg](https://ffmpeg.org/) on `PATH` (also provides `ffprobe`)
- [Deno](https://deno.land/) recommended on `PATH` (yt-dlp uses it for YouTube JS / EJS challenges)

```bash
sudo apt update
sudo apt install -y ffmpeg
pipx install yt-dlp   # or: pipx upgrade yt-dlp
# Deno: https://deno.land/#installation  (often ~/.deno/bin)
```

The app prepends common user bins (`~/.deno/bin`, `~/.local/bin`, `/usr/local/bin`) to `PATH` so GUI launches can find the same tools as your terminal.

## Run

```bash
cd /path/to/yt-downloader
npm install
npm start
```

`npm start` uses `--no-sandbox` for Ubuntu Electron. **Fully quit** any old app window and start again after code changes — reload alone does not pick up main-process updates.

## Usage

1. Paste a video, playlist, or channel URL.
2. **Analyze** (listing does not download).
3. Pick quality / format → **Download** / **Download Selected**.
4. Files save to the **Download folder** you choose (default `~/Downloads/YouTube Downloader`).

### Queue

- Each active job shows its own progress bar, **MiB downloaded / total** (when yt-dlp reports it), speed, and ETA.
- Rows show the **actual** stream height while downloading (e.g. `360p`) and warn if it is far below your requested max (e.g. wanted 720).
- **Pause all** / **Resume all** / **Clear queue** are on the queue header. Per-row Pause/Resume still work. Pausing a running job holds that parallel slot so another video does not replace it.
- Click a **Failed:** status to expand the full error under the row and in **Technical details**.

### Quality & format

- Downloads use height-capped selectors, e.g. `bestvideo[height<=1080]+bestaudio/best[height<=1080]` (MP4/m4a preferred when practical). FFmpeg merges separate video+audio streams into MP4.
- **Single video:** quality list comes from formats yt-dlp reports for that URL; the selected **height** drives the selector (not a hardcoded format id like `137+140`). Format: **Video (MP4)** or **Audio only (M4A)**.
- **Playlist/channel:** **Max quality** caps (`up to 1080p` … `up to 144p`, or best) plus Format **Video (MP4)** / **Audio only (M4A)**. Caps mean “best ≤ that height,” not a guarantee.
- Checkbox **If selected quality unavailable, keep best available**: when on, a low-resolution success is kept with a warning instead of failing the job (default off).

The app prefers the **web** client (with cookies when set) when you ask for **above 360p**, then tries alternate clients. Cookies are passed on every attempt when configured. After each video download it checks resolution with **ffprobe**. Completed rows show e.g. `Completed · 720p` or `Completed · 360p (wanted 720)`.

## Cookies.txt (bot check / age gate)

1. Install a **Get cookies.txt LOCALLY** browser extension.
2. While signed into YouTube, export cookies for `youtube.com`.
3. In the app, **Choose…** that file.

**480p / 720p / 1080p** usually need a fresh cookies.txt. Progressive **360p** (`18`) is only a last resort. The app does **not** use `--cookies-from-browser`.

## Errors

Typed messages for bot check / auth, private, age-restricted, region, network, and unavailable videos. Click a failed queue row status (or expand **Technical details** under the status line) for the full message and raw yt-dlp output.

## Scope

Two-column UI, queue with sizes / quality labels / pause-all, MP4 + M4A audio, channel/playlist select, web-preferring high-quality ladder. No Chrome keyring path, DRM bypass, or Windows packaging.
