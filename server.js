import express from 'express';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- config ---
const cfg = {
  port: Number(process.env.PORT) || 3000,
  workDir: process.env.WORK_DIR || path.join(os.tmpdir(), 'video-grabber'),
  ytdlp: process.env.YTDLP_PATH || 'yt-dlp',
  jsRuntime: process.env.JS_RUNTIME || 'node', // runtime yt-dlp uses to solve YouTube challenges
  cookiesFile: process.env.COOKIES_FILE || '', // optional Netscape cookies.txt
  maxConcurrent: Number(process.env.MAX_CONCURRENT) || 2,
  maxFilesize: process.env.MAX_FILESIZE || '1G', // yt-dlp syntax: 500M, 2G ...
  jobTimeoutMs: (Number(process.env.JOB_TIMEOUT_MIN) || 20) * 60_000,
  fileTtlMs: (Number(process.env.FILE_TTL_MIN) || 15) * 60_000,
  accessToken: process.env.ACCESS_TOKEN || '', // set to require a password
  trustProxy: process.env.TRUST_PROXY || '', // e.g. "1" behind nginx / a PaaS
  infoLimit: Number(process.env.RATE_INFO_PER_10MIN) || 40,
  downloadLimit: Number(process.env.RATE_DOWNLOAD_PER_10MIN) || 12,
  allowPrivateHosts: process.env.ALLOW_PRIVATE_HOSTS === '1', // dev/testing only
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------ URL safety ---
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd') || /^fe[89ab]/.test(l)) return true;
    const dotted = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  return true; // not an IP at all: refuse
}

async function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new HttpError(400, 'Paste a link to a video page.');
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, 'That doesn’t look like a link. Include the full address, starting with https://');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Only http and https links work.');
  if (cfg.allowPrivateHosts) return u.toString();

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || /\.(localhost|local|internal)$/i.test(host)) {
    throw new HttpError(400, 'That address isn’t allowed.');
  }
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host }];
  } else {
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      throw new HttpError(400, 'Couldn’t find that website. Check the link for typos.');
    }
  }
  if (addrs.some((a) => isPrivateIp(a.address))) throw new HttpError(400, 'That address isn’t allowed.');
  return u.toString();
}

const QUALITIES = new Set(['best', 'audio', '2160', '1440', '1080', '720', '480', '360', '240', '144']);

// ----------------------------------------------------------------- yt-dlp ---
function baseArgs() {
  const a = [
    '--ignore-config',
    '--no-playlist',
    '--no-warnings',
    '--no-cache-dir',
    '--socket-timeout', '30',
    '--retries', '5',
    '--js-runtimes', cfg.jsRuntime,
  ];
  if (cfg.cookiesFile) a.push('--cookies', cfg.cookiesFile);
  return a;
}

function formatArgs(quality) {
  if (quality === 'audio') return ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  const h = quality === 'best' ? '' : `[height<=${quality}]`;
  // Prefer mp4/m4a so the merged file plays everywhere, fall back to anything.
  const f = `bv*${h}[ext=mp4]+ba[ext=m4a]/b${h}[ext=mp4]/bv*${h}+ba/b${h}/b`;
  return ['-f', f, '--merge-output-format', 'mp4'];
}

function friendlyError(text) {
  const lines = text.split('\n').filter((l) => l.includes('ERROR:'));
  const raw = (lines.pop() || text.trim().split('\n').pop() || '').replace(/^.*?ERROR:\s*/, '').trim();
  const all = raw + ' ' + text;
  if (/Unsupported URL/i.test(all)) return 'That link doesn’t point to a video this site can read.';
  if (/Sign in to confirm|not a bot|cookies/i.test(all)) return 'The site is asking for a login or bot check. Ask the server owner to configure a cookies file.';
  if (/Private video|members[- ]only|login required|This video is private/i.test(all)) return 'That video is private or needs a login.';
  if (/not available in your country|geo.?restrict/i.test(all)) return 'That video is blocked in the server’s country.';
  if (/Video unavailable|has been removed|does not exist|404/i.test(all)) return 'That video is unavailable or has been removed.';
  if (/HTTP Error 429|Too Many Requests/i.test(all)) return 'The site is rate-limiting the server. Try again later.';
  if (/Unable to (download|connect)|Connection (refused|reset|aborted)|timed out|Name or service not known|getaddrinfo|SSL|certificate|ProxyError/i.test(all)) {
    return 'Couldn’t reach that site. Check the link and try again.';
  }
  return (raw || 'The download failed.')
    .replace(/;?\s*please report this issue.*$/is, '')
    .replace(/^\[[\w:.+-]+\]\s+[^\s:]+:\s*/, '')
    .split(cfg.workDir).join('')
    .trim()
    .slice(0, 300);
}

function fetchInfo(url) {
  return new Promise((resolve, reject) => {
    const p = spawn(cfg.ytdlp, [...baseArgs(), '-J', '--flat-playlist', '--', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      done(reject, new HttpError(504, 'Reading that link took too long. Try again.'));
    }, 45_000);
    p.stdout.on('data', (d) => {
      out += d;
      if (out.length > 30e6) p.kill('SIGKILL');
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => done(reject, new HttpError(500, 'yt-dlp isn’t installed on the server.')));
    p.on('close', (code) => {
      if (code !== 0) return done(reject, new HttpError(422, friendlyError(err)));
      try {
        const info = JSON.parse(out);
        if (info._type === 'playlist') throw new HttpError(400, 'That’s a playlist. Paste the link to a single video.');
        if (info.is_live) throw new HttpError(400, 'Live streams can’t be downloaded.');
        const heights = [...new Set((info.formats || [])
          .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
          .map((f) => f.height))].sort((a, b) => b - a);
        done(resolve, {
          title: info.title || 'Untitled video',
          thumbnail: typeof info.thumbnail === 'string' && /^https?:\/\//.test(info.thumbnail) ? info.thumbnail : null,
          duration: info.duration || null,
          uploader: info.uploader || info.channel || null,
          site: info.extractor_key || null,
          heights,
        });
      } catch (e) {
        done(reject, e instanceof HttpError ? e : new HttpError(502, 'Couldn’t read the details for that link.'));
      }
    });
  });
}

// ------------------------------------------------------------------- jobs ---
const jobs = new Map();
const ACTIVE = new Set(['starting', 'downloading', 'processing']);

const num = (s) => {
  const n = Number(s);
  return s === undefined || s === 'NA' || s === 'None' || !Number.isFinite(n) ? null : n;
};

function publicJob(j) {
  return {
    id: j.id,
    status: j.status,
    stage: j.stage,
    percent: j.percent,
    speed: j.speed,
    eta: j.eta,
    downloaded: j.downloaded,
    total: j.total,
    fileName: j.fileName,
    fileSize: j.fileSize,
    error: j.error,
  };
}

function broadcast(j, force = false) {
  const now = Date.now();
  if (!force && now - j.lastSent < 250) return;
  j.lastSent = now;
  const msg = `data: ${JSON.stringify(publicJob(j))}\n\n`;
  for (const res of j.listeners) res.write(msg);
  if (j.status === 'done' || j.status === 'error') {
    for (const res of j.listeners) res.end();
    j.listeners.clear();
  }
}

function overallPercent(j, cur) {
  if (cur == null) return null;
  if (j.expected >= 2) {
    // video is the bulk of the bytes, audio the rest
    const idx = Math.min(Math.max(j.streamIdx, 0), 1);
    return (idx === 0 ? 0 : 0.85) * 100 + (idx === 0 ? 0.85 : 0.15) * cur;
  }
  return cur;
}

function startJob(url, quality) {
  const id = randomUUID();
  const dir = path.join(cfg.workDir, id);
  fs.mkdirSync(dir, { recursive: true });

  const job = {
    id, dir, quality,
    status: 'starting', stage: 'Starting', percent: 0,
    speed: null, eta: null, downloaded: null, total: null,
    fileName: null, fileSize: null, filePath: null, error: null,
    expected: 1, streamIdx: -1,
    createdAt: Date.now(), expiresAt: null, lastSent: 0,
    listeners: new Set(), proc: null, cancelled: false,
  };
  jobs.set(id, job);

  const args = [
    ...baseArgs(),
    ...formatArgs(quality),
    '--newline', '--progress',
    '--progress-template',
    'download:[prog] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s',
    '--max-filesize', cfg.maxFilesize,
    '--max-downloads', '1',
    '--windows-filenames',
    '-o', path.join(dir, '%(title).120B [%(id)s].%(ext)s'),
    '--', url,
  ];

  const p = spawn(cfg.ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = p;
  let stdoutTail = '';
  let stderr = '';

  const timer = setTimeout(() => {
    job.timedOut = true;
    p.kill('SIGKILL');
  }, cfg.jobTimeoutMs);

  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    stdoutTail = (stdoutTail + '\n' + line).slice(-4000);
    let m;
    if ((m = line.match(/^\[prog\] (\S+) (\S+) (\S+) (\S+) (\S+)/))) {
      const dl = num(m[1]);
      const total = num(m[2]) ?? num(m[3]);
      const cur = dl != null && total ? Math.min(100, (dl / total) * 100) : null;
      job.status = 'downloading';
      job.stage = job.expected >= 2 ? (job.streamIdx <= 0 ? 'Downloading video' : 'Downloading audio') : 'Downloading';
      job.percent = overallPercent(job, cur);
      job.downloaded = dl;
      job.total = total;
      job.speed = num(m[4]);
      job.eta = num(m[5]);
      broadcast(job);
    } else if ((m = line.match(/Downloading (\d+) format\(s\):\s*(.+)$/))) {
      job.expected = m[2].split('+').length;
    } else if (line.startsWith('[download] Destination:')) {
      job.streamIdx += 1;
    } else if (/^\[(Merger|ExtractAudio|VideoRemuxer|VideoConvertor|Fixup\w*)\]/.test(line)) {
      job.status = 'processing';
      job.stage = line.startsWith('[ExtractAudio]') ? 'Converting to MP3' : 'Finishing up';
      job.percent = 99;
      job.speed = null;
      job.eta = null;
      broadcast(job, true);
    }
  });
  p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));

  p.on('error', () => fail(job, 'yt-dlp isn’t installed on the server.'));
  p.on('close', async (code) => {
    clearTimeout(timer);
    if (job.cancelled) return;
    if (job.timedOut) return fail(job, 'That took too long and was stopped.');
    try {
      const names = (await fsp.readdir(dir)).filter((n) => !/\.(part|ytdl|temp)$|\.part-Frag|^\./.test(n));
      let best = null;
      for (const n of names) {
        const st = await fsp.stat(path.join(dir, n));
        if (st.isFile() && (!best || st.size > best.size)) best = { name: n, size: st.size };
      }
      if ((code !== 0 && code !== 101) || !best) {
        if (/larger than max-filesize/i.test(stdoutTail)) {
          return fail(job, `That file is bigger than this server’s limit (${cfg.maxFilesize.toUpperCase()}B). Try a lower quality.`);
        }
        return fail(job, friendlyError(stderr));
      }
      job.filePath = path.join(dir, best.name);
      job.fileName = best.name.replace(/ \[[^\]]+\](?=\.[^.]+$)/, '');
      job.fileSize = best.size;
      job.status = 'done';
      job.stage = 'Ready';
      job.percent = 100;
      job.speed = job.eta = null;
      job.expiresAt = Date.now() + cfg.fileTtlMs;
      broadcast(job, true);
    } catch {
      fail(job, 'Something went wrong saving the file.');
    }
  });

  return job;
}

function fail(job, message) {
  if (job.status === 'error' || job.status === 'done') return;
  job.status = 'error';
  job.stage = 'Failed';
  job.error = message;
  job.expiresAt = Date.now() + 60_000;
  broadcast(job, true);
  fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

async function dropJob(job) {
  job.proc?.kill('SIGKILL');
  for (const res of job.listeners) res.end();
  job.listeners.clear();
  jobs.delete(job.id);
  await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

// --------------------------------------------------------------- middleware ---
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let e = hits.get(req.ip);
    if (!e || e.reset < now) hits.set(req.ip, (e = { count: 0, reset: now + windowMs }));
    if (++e.count > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Wait a few minutes and try again.' });
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!cfg.accessToken) return next();
  const given = String(req.get('x-access-token') || req.query.token || '');
  const a = Buffer.from(given);
  const b = Buffer.from(cfg.accessToken);
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Wrong or missing access code.' });
}

// -------------------------------------------------------------------- app ---
const app = express();
if (cfg.trustProxy) app.set('trust proxy', /^\d+$/.test(cfg.trustProxy) ? Number(cfg.trustProxy) : cfg.trustProxy);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
  });
  next();
});
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ authRequired: Boolean(cfg.accessToken), maxFilesize: cfg.maxFilesize.toUpperCase() + 'B', fileTtlMin: cfg.fileTtlMs / 60_000 });
});

app.post('/api/auth', requireAuth, (req, res) => res.json({ ok: true }));

app.post('/api/info', requireAuth, rateLimit({ windowMs: 600_000, max: cfg.infoLimit }), async (req, res, next) => {
  try {
    const url = await validateUrl(req.body?.url);
    res.json({ url, ...(await fetchInfo(url)) });
  } catch (e) {
    next(e);
  }
});

app.post('/api/download', requireAuth, rateLimit({ windowMs: 600_000, max: cfg.downloadLimit }), async (req, res, next) => {
  try {
    const url = await validateUrl(req.body?.url);
    const quality = String(req.body?.quality ?? 'best');
    if (!QUALITIES.has(quality)) throw new HttpError(400, 'Unknown quality option.');
    const active = [...jobs.values()].filter((j) => ACTIVE.has(j.status)).length;
    if (active >= cfg.maxConcurrent) throw new HttpError(429, 'The server is busy with other downloads. Try again in a minute.');
    res.status(202).json({ id: startJob(url, quality).id });
  } catch (e) {
    next(e);
  }
});

app.get('/api/progress/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'That download has expired. Start it again.' });
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);
  if (job.status === 'done' || job.status === 'error') return res.end();
  job.listeners.add(res);
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(beat);
    job.listeners.delete(res);
  });
});

app.get('/api/file/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'That file has expired. Download it again.' });
  res.download(job.filePath, job.fileName);
});

app.delete('/api/jobs/:id', requireAuth, async (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) {
    job.cancelled = true;
    await dropJob(job);
  }
  res.status(204).end();
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// --------------------------------------------------------------- lifecycle ---
await fsp.rm(cfg.workDir, { recursive: true, force: true });
await fsp.mkdir(cfg.workDir, { recursive: true });

setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.expiresAt && job.expiresAt < now) dropJob(job);
  }
}, 30_000).unref();

const server = app.listen(cfg.port, () => {
  console.log(`Video Grabber on http://localhost:${cfg.port}` + (cfg.accessToken ? ' (access code required)' : ''));
});

function shutdown() {
  for (const job of jobs.values()) job.proc?.kill('SIGKILL');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
