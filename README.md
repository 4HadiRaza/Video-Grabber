# Video Grabber

Paste a video link, get the file. A small Express server wraps [yt-dlp](https://github.com/yt-dlp/yt-dlp) and streams live progress to a single-page UI.

Flow: paste link → look up (title, thumbnail, available qualities) → pick quality → download with a progress bar → the browser saves the file. Files are deleted from the server after 15 minutes.

## Run it locally

You need Node 20+, `ffmpeg`, and `yt-dlp`.

```bash
# macOS
brew install ffmpeg yt-dlp
# Windows
winget install yt-dlp.yt-dlp Gyan.FFmpeg
# Linux / anywhere with Python
pip install -U yt-dlp yt-dlp-ejs   # plus ffmpeg from your package manager

npm install
npm start          # http://localhost:3000
```

YouTube now needs a JavaScript runtime for yt-dlp. This app passes `--js-runtimes node` by default, so having Node installed is enough. Set `JS_RUNTIME=deno` if you prefer Deno.

## Run it with Docker

```bash
docker build -t video-grabber .
docker run -p 3000:3000 video-grabber
```

The image bundles ffmpeg and the latest yt-dlp. Rebuild it every few weeks: sites change their players and old yt-dlp versions break. Most "it stopped working" problems are fixed by updating yt-dlp.

## Configuration (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `ACCESS_TOKEN` | *(none)* | If set, the page asks for this access code before anything works. **Set this if the site is public.** |
| `MAX_FILESIZE` | `1G` | Largest file a job may download (`500M`, `2G`, …) |
| `MAX_CONCURRENT` | `2` | Downloads allowed at once; extra requests get a "busy" message |
| `FILE_TTL_MIN` | `15` | Minutes a finished file stays available |
| `JOB_TIMEOUT_MIN` | `20` | Kill a download that runs longer than this |
| `RATE_INFO_PER_10MIN` | `40` | Link look-ups per IP per 10 minutes |
| `RATE_DOWNLOAD_PER_10MIN` | `12` | Downloads per IP per 10 minutes |
| `TRUST_PROXY` | *(none)* | Set to `1` behind nginx, Render, Railway, Fly, etc. so rate limits see real client IPs |
| `COOKIES_FILE` | *(none)* | Path to a Netscape `cookies.txt` for sites that need a login or a bot check |
| `JS_RUNTIME` | `node` | JS runtime yt-dlp uses for YouTube |
| `YTDLP_PATH` | `yt-dlp` | Path to the yt-dlp binary |
| `WORK_DIR` | system temp dir | Where in-progress and finished files live |

## Deploying

It needs a real server process with `yt-dlp` and `ffmpeg`, so use the Dockerfile on Render, Railway, Fly.io, or a VPS. It will not run on serverless platforms (Vercel, Netlify functions) because downloads run for minutes and need disk space.

Things to know before putting it on the public internet:

- **Set `ACCESS_TOKEN`.** An open downloader gets abused fast, and bandwidth costs money.
- **Datacenter IPs get blocked.** YouTube and some other sites often refuse requests from cloud servers with a "sign in to confirm you're not a bot" error. Fixes: export cookies from a browser into `COOKIES_FILE`, or run the app on a home machine or a residential connection.
- **Disk and bandwidth.** Each download is stored temporarily on the server before it is sent to the browser.
- **Terms of service and copyright.** Many sites forbid downloading in their terms, and most videos are copyrighted. Use it for content you own, that is licensed for download, or that you otherwise have the right to save.

## How it's built

- `server.js`: Express API. `POST /api/info` reads video details, `POST /api/download` starts a job, `GET /api/progress/:id` streams progress (Server-Sent Events), `GET /api/file/:id` sends the finished file, `DELETE /api/jobs/:id` cancels.
- `public/`: plain HTML, CSS and JS. No build step.

Safety measures in the server: yt-dlp is launched with an argument array (no shell), links must be http(s), hostnames that resolve to private or local addresses are refused, playlists and live streams are rejected, and there are per-IP rate limits, a concurrency cap, a file size cap and a job timeout. The private-address check happens before yt-dlp starts, so a site that later redirects to an internal address is not caught; for strong isolation, run the container with no access to your internal network.
