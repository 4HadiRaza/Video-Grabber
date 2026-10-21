const $ = (sel) => document.querySelector(sel);

const el = {
  form: $('#lookup'), url: $('#url'), paste: $('#paste'), go: $('#go'),
  access: $('#access'), code: $('#code'), error: $('#error'),
  card: $('#card'), thumb: $('#thumb'), title: $('#title'), site: $('#site'),
  uploader: $('#uploader'), duration: $('#duration'), pills: $('#pills'), download: $('#download'),
  progress: $('#progress'), stage: $('#stage'), eta: $('#eta'), timeline: $('#timeline'),
  pct: $('#pct'), speed: $('#speed'), size: $('#size'), cancel: $('#cancel'),
  done: $('#done'), doneName: $('#doneName'), saveLink: $('#saveLink'), again: $('#again'),
  ttl: $('#ttl'),
};

const baseTitle = document.title;
const state = { url: '', info: null, jobId: null, events: null, authRequired: false };

// ---------------------------------------------------------------- helpers ---
const token = () => (state.authRequired ? el.code.value.trim() : '');

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token()) headers['x-access-token'] = token();
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Something went wrong. Try again.');
  return data;
}

const withToken = (path) => (token() ? `${path}?token=${encodeURIComponent(token())}` : path);

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtBytes(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

function show(...names) {
  for (const key of ['card', 'progress', 'done']) el[key].hidden = !names.includes(key);
}

function showError(msg) {
  el.error.textContent = msg || '';
  el.error.hidden = !msg;
}

function setBusy(btn, busy, idle, working) {
  btn.disabled = busy;
  btn.textContent = busy ? working : idle;
}

function looksLikeUrl(v) {
  try { return /^https?:$/.test(new URL(v.trim()).protocol); } catch { return false; }
}

// ----------------------------------------------------------------- lookup ---
async function lookup() {
  const url = el.url.value.trim();
  showError('');
  if (!looksLikeUrl(url)) {
    showError('Paste a full video link, starting with https://');
    el.url.focus();
    return;
  }
  setBusy(el.go, true, 'Look up', 'Looking up…');
  show();
  try {
    const info = await api('/api/info', { method: 'POST', body: { url } });
    state.url = info.url;
    state.info = info;
    renderCard(info);
  } catch (e) {
    showError(e.message);
  } finally {
    setBusy(el.go, false, 'Look up', 'Looking up…');
  }
}

function qualityOptions(heights) {
  const max = heights[0] || 0;
  const opts = [{ value: 'best', label: max ? `Best (${max}p)` : 'Best available' }];
  for (const h of [2160, 1440, 1080, 720, 480, 360]) {
    if (max && h < max * 0.95 && opts.length < 5) opts.push({ value: String(h), label: `${h}p` });
  }
  opts.push({ value: 'audio', label: 'Audio only (MP3)' });
  return opts;
}

function renderCard(info) {
  el.title.textContent = info.title;
  el.site.textContent = info.site || '';
  el.uploader.textContent = info.uploader || '';
  el.duration.textContent = info.duration ? fmtTime(info.duration) : '';
  if (info.thumbnail) {
    el.thumb.src = info.thumbnail;
    el.thumb.hidden = false;
  } else {
    el.thumb.removeAttribute('src');
    el.thumb.hidden = true;
  }
  el.pills.replaceChildren(...qualityOptions(info.heights).map((o, i) => {
    const label = document.createElement('label');
    label.className = 'pill';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'quality';
    input.value = o.value;
    input.checked = i === 0;
    const span = document.createElement('span');
    span.textContent = o.label;
    label.append(input, span);
    return label;
  }));
  show('card');
  el.download.focus({ preventScroll: true });
  el.card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// --------------------------------------------------------------- download ---
async function startDownload() {
  const quality = document.querySelector('input[name="quality"]:checked')?.value || 'best';
  showError('');
  setBusy(el.download, true, 'Download', 'Starting…');
  try {
    const { id } = await api('/api/download', { method: 'POST', body: { url: state.url, quality } });
    state.jobId = id;
    resetProgress();
    show('progress');
    listen(id);
  } catch (e) {
    showError(e.message);
  } finally {
    setBusy(el.download, false, 'Download', 'Starting…');
  }
}

function resetProgress() {
  el.stage.textContent = 'Starting';
  el.eta.textContent = '--:--';
  el.pct.textContent = '0%';
  el.speed.textContent = '';
  el.size.textContent = '';
  setTimeline(0, true);
}

function setTimeline(percent, indeterminate) {
  if (indeterminate) el.timeline.setAttribute('data-indeterminate', '');
  else el.timeline.removeAttribute('data-indeterminate');
  const p = Math.min(100, Math.max(0, percent || 0));
  el.timeline.style.setProperty('--p', `${p}%`);
  el.timeline.setAttribute('aria-valuenow', indeterminate ? '' : String(Math.round(p)));
}

function listen(id) {
  closeEvents();
  const es = new EventSource(withToken(`/api/progress/${id}`));
  state.events = es;
  es.onmessage = (ev) => render(JSON.parse(ev.data));
  es.onerror = () => {
    // EventSource retries on its own; only give up if the server closed it for good.
    if (es.readyState === EventSource.CLOSED && state.jobId === id) {
      closeEvents();
      document.title = baseTitle;
      showError('Lost the connection to the server. Try the download again.');
      show('card');
    }
  };
}

function closeEvents() {
  state.events?.close();
  state.events = null;
}

function render(job) {
  if (job.status === 'error') {
    closeEvents();
    state.jobId = null;
    document.title = baseTitle;
    showError(job.error);
    show('card');
    return;
  }
  if (job.status === 'done') {
    closeEvents();
    finish(job);
    return;
  }
  const known = job.percent != null;
  el.stage.textContent = job.stage;
  setTimeline(job.percent, !known);
  el.pct.textContent = known ? `${Math.floor(job.percent)}%` : '';
  el.eta.textContent = job.eta != null ? fmtTime(job.eta) : '--:--';
  el.speed.textContent = job.speed ? `${fmtBytes(job.speed)}/s` : '';
  el.size.textContent = job.downloaded != null
    ? (job.total ? `${fmtBytes(job.downloaded)} of ${fmtBytes(job.total)}` : fmtBytes(job.downloaded))
    : '';
  document.title = known ? `${Math.floor(job.percent)}% · ${baseTitle}` : baseTitle;
}

function finish(job) {
  document.title = baseTitle;
  const href = withToken(`/api/file/${job.id}`);
  el.doneName.textContent = `${job.fileName} (${fmtBytes(job.fileSize)})`;
  el.saveLink.href = href;
  el.saveLink.setAttribute('download', job.fileName || '');
  show('done');
  // Kick off the browser download.
  const a = document.createElement('a');
  a.href = href;
  a.download = job.fileName || '';
  document.body.append(a);
  a.click();
  a.remove();
}

async function cancel() {
  const id = state.jobId;
  state.jobId = null;
  closeEvents();
  document.title = baseTitle;
  show('card');
  if (id) await api(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
}

function reset() {
  state.jobId = null;
  state.info = null;
  el.url.value = '';
  showError('');
  show();
  el.url.focus();
}

// ----------------------------------------------------------------- wiring ---
el.form.addEventListener('submit', (e) => { e.preventDefault(); lookup(); });
el.download.addEventListener('click', startDownload);
el.cancel.addEventListener('click', cancel);
el.again.addEventListener('click', reset);

el.paste.addEventListener('click', async () => {
  try {
    el.url.value = (await navigator.clipboard.readText()).trim();
    if (looksLikeUrl(el.url.value)) lookup();
    else el.url.focus();
  } catch {
    el.url.focus();
    showError('Your browser blocked clipboard access. Paste into the box with Ctrl+V or Cmd+V instead.');
  }
});

el.url.addEventListener('paste', () => {
  setTimeout(() => { if (looksLikeUrl(el.url.value) && !el.go.disabled) lookup(); }, 0);
});

el.url.addEventListener('input', () => {
  if (state.info && el.url.value.trim() !== state.url) {
    state.info = null;
    if (!state.jobId) show();
  }
});

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    state.authRequired = cfg.authRequired;
    el.access.hidden = !cfg.authRequired;
    if (cfg.fileTtlMin) el.ttl.textContent = cfg.fileTtlMin;
  })
  .catch(() => {});
