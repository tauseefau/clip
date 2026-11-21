import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = import.meta.dirname;
const PUBLIC = join(ROOT, 'public');
const DATA = join(ROOT, 'data');
const MEDIA = join(DATA, 'media');
const TMP = join(DATA, 'tmp');
const BRAND = join(DATA, 'brand');
const MUSIC = join(BRAND, 'music');
const WATERMARK = join(BRAND, 'watermark.png');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
// Bundled DejaVu fonts, so captions work on any OS without a font install.
const FONT_DIR = process.env.FONT_DIR || join(import.meta.dirname, 'fonts');
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_UPLOAD = 500 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
const MAX_WATERMARK = 5 * 1024 * 1024;
const MAX_MUSIC = 20 * 1024 * 1024;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const MAX_RENDER_SECONDS = 3600;
// The compressor evens out peaky speech first; without it loudnorm's limiter stops 2-4 LU short of the target.
const LOUDNORM = 'acompressor=threshold=-20dB:ratio=3:attack=5:release=120,loudnorm=I=-14:TP=-1.5:LRA=11';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ASPECTS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };
const AUDIO = {
  mp3: { mime: 'audio/mpeg', demuxer: 'mp3' },
  m4a: { mime: 'audio/mp4', demuxer: 'mov' },
  wav: { mime: 'audio/wav', demuxer: 'wav' },
  ogg: { mime: 'audio/ogg', demuxer: 'ogg' },
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.CLIP_TOKEN;
if (!TOKEN && !/^(localhost|::1|127\.\d+\.\d+\.\d+)$/.test(HOST)) {
  console.error(`Refusing to listen on HOST=${HOST} without CLIP_TOKEN: anyone on the network could read and delete recordings. Set CLIP_TOKEN, or unset HOST to stay on 127.0.0.1.`);
  process.exit(1);
}

mkdirSync(MEDIA, { recursive: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(MUSIC, { recursive: true });
const db = new DatabaseSync(join(DATA, 'clip.db'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comments_recording ON comments(recording_id, id);
  CREATE TABLE IF NOT EXISTS music (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL
  );
`);

const columns = db.prepare('PRAGMA table_info(recordings)').all().map(({ name }) => name);
for (const name of ['captions', 'source_id', 'edit']) {
  if (!columns.includes(name)) db.exec(`ALTER TABLE recordings ADD COLUMN ${name} TEXT`);
}

const commentColumns = db.prepare('PRAGMA table_info(comments)').all().map(({ name }) => name);
if (!commentColumns.includes('t')) db.exec('ALTER TABLE comments ADD COLUMN t REAL');

// The whole-clip transcript, kept so auto-captions do not re-run Whisper on every edit.
if (!columns.includes('transcript')) db.exec('ALTER TABLE recordings ADD COLUMN transcript TEXT');

const sql = {
  insert: db.prepare(`
    INSERT INTO recordings (id, title, created_at, duration_ms, size, mime, captions, source_id, edit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  list: db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM comments c WHERE c.recording_id = r.id) AS comments
    FROM recordings r ORDER BY r.created_at DESC, r.rowid DESC`),
  get: db.prepare('SELECT * FROM recordings WHERE id = ?'),
  transcriptSet: db.prepare('UPDATE recordings SET transcript = ? WHERE id = ?'),
  rename: db.prepare('UPDATE recordings SET title = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM recordings WHERE id = ?'),
  comments: db.prepare('SELECT * FROM comments WHERE recording_id = ? ORDER BY id'),
  comment: db.prepare(
    'INSERT INTO comments (recording_id, author, body, created_at, t) VALUES (?, ?, ?, ?, ?) RETURNING *'),
  musicInsert: db.prepare('INSERT INTO music VALUES (?, ?, ?, ?)'),
  musicList: db.prepare('SELECT id, name, size FROM music ORDER BY rowid'),
  musicGet: db.prepare('SELECT * FROM music WHERE id = ?'),
  musicRemove: db.prepare('DELETE FROM music WHERE id = ?'),
};

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const cleanTitle = (title) => title.trim().slice(0, 200) || 'Untitled recording';

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function getRecording(id) {
  return sql.get.get(id) ?? fail(404, 'Recording not found');
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req.setEncoding('utf8')) {
    raw += chunk;
    if (raw.length > MAX_JSON) fail(413, 'Body too large');
  }
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object') return value;
  } catch { /* falls through to the 400 below */ }
  fail(400, 'Body must be a JSON object');
}

async function readBody(req, max, tooLarge) {
  if (Number(req.headers['content-length']) > max) fail(413, tooLarge);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) fail(413, tooLarge);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Counts bytes itself because chunked uploads carry no Content-Length to check up front.
async function* limitSize(source, onSize) {
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > MAX_UPLOAD) fail(413, 'Upload exceeds 500 MB');
    onSize(size);
    yield chunk;
  }
}

// Returns the real duration in ms (0 if the file has none, as MediaRecorder WebM does), or rejects non-video.
// The whitelist does the real work: ffprobe calls a PNG a video stream, and playlists can read other files.
async function probeUpload(file) {
  const output = await run(FFPROBE, ['-v', 'error', '-format_whitelist', 'matroska,mov', '-protocol_whitelist', 'file',
    '-select_streams', 'v', '-show_entries', 'stream=index:stream_disposition=attached_pic:format=duration', '-of', 'json', file]);
  if (output === null) fail(400, 'Upload is not a video');
  const { streams, format } = JSON.parse(output);
  if (!streams?.some((stream) => !stream.disposition?.attached_pic)) fail(400, 'Upload is not a video');
  return Math.round(parseFloat(format?.duration) * 1000) || 0;
}

async function createRecording(req, res) {
  if (Number(req.headers['content-length']) > MAX_UPLOAD) fail(413, 'Upload exceeds 500 MB');

  const id = randomUUID();
  const file = join(MEDIA, `${id}.webm`);
  const partial = `${file}.part`;
  // Node decodes headers as latin1; recover the UTF-8 bytes curl and browsers actually send.
  const title = Buffer.from(req.headers['x-title'] ?? '', 'latin1').toString('utf8');
  const claimedMs = Math.min(Math.max(parseInt(req.headers['x-duration-ms'], 10) || 0, 0), MAX_DURATION_MS);
  let size = 0;

  try {
    await pipeline(req, (source) => limitSize(source, (n) => { size = n; }), createWriteStream(partial));
    if (size === 0) fail(400, 'Empty upload');
    const durationMs = await probeUpload(partial) || claimedMs;
    await rename(partial, file); // only complete uploads ever appear under the .webm name
    sql.insert.run(id, cleanTitle(title), Date.now(), durationMs, size, 'video/webm', null, null, null);
  } catch (err) {
    await Promise.all([rm(partial, { force: true }), rm(file, { force: true })]);
    throw err;
  }
  json(res, 201, { id, url: `/watch/${id}` });
}

async function serveMedia(req, res, id) {
  const info = await stat(join(MEDIA, `${id}.webm`)).catch(() => fail(404, 'Not found'));
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'video/webm',
    'X-Content-Type-Options': 'nosniff',
  };
  let status = 200;
  let start = 0;
  let end = info.size - 1;

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), end);
    } else {
      start = Math.max(info.size - Number(range[2]), 0); // suffix form: last N bytes
    }
    if (start > end) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }

  res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
  // Browsers abort range requests on every seek, so a closed socket here is normal.
  await pipeline(createReadStream(join(MEDIA, `${id}.webm`), { start, end }), res).catch(() => {});
}

const building = new Map();

// Builds a derived file once: concurrent callers share one ffmpeg, and readers only ever see a finished file.
function buildOnce(out, format, args, failure) {
  if (existsSync(out)) return Promise.resolve();
  if (building.has(out)) return building.get(out);
  const partial = `${out}.part`;
  const job = (async () => {
    try {
      const done = await run(FFMPEG, ['-y', ...args, '-f', format, partial]); // -f: ffmpeg cannot infer it from .part
      const info = done === null ? null : await stat(partial).catch(() => null);
      if (!info?.size) fail(500, failure); // a seek past the end can exit 0 with an empty file
      await rename(partial, out);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    } finally {
      building.delete(out);
    }
  })();
  building.set(out, job);
  return job;
}

// MP4 is transcoded once on first request and cached beside the webm.
// shortcut: whole-file transcode, so a long recording blocks that request; move to a job queue past ~10 min clips.
async function serveMp4(res, id) {
  const src = join(MEDIA, `${id}.webm`);
  const out = join(MEDIA, `${id}.mp4`);
  if (!existsSync(src)) return fail(404, 'Not found');
  await buildOnce(out, 'mp4', ['-i', src,
    // Canvas capture is RGB (gbrp) full range; YouTube wants 4:2:0, 8-bit, BT.709 limited range.
    '-vf', 'format=yuv420p',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-profile:v', 'high', '-level', '4.2',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart'], 'Transcode failed');
  const info = await stat(out);
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': info.size,
    'Content-Disposition': `attachment; filename="clip-${id}.mp4"`,
  });
  await pipeline(createReadStream(out), res).catch(() => {});
}

async function serveThumbnail(res, id) {
  const src = join(MEDIA, `${id}.webm`);
  const out = join(MEDIA, `${id}.jpg`);
  const { duration_ms: durationMs } = getRecording(id);
  if (!existsSync(src)) return fail(404, 'Not found');
  const seek = String(Math.min(1, durationMs / 2000)); // a clip under a second has no frame at 1s
  await buildOnce(out, 'mjpeg', ['-ss', seek, '-i', src, '-frames:v', '1', '-vf', 'scale=640:-2'], 'Thumbnail failed');
  const info = await stat(out);
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff' });
  await pipeline(createReadStream(out), res).catch(() => {});
}

// YouTube's recommended thumbnail is 1280x720 JPEG. The frame is letterboxed on the app background
// rather than cropped, so screen content and lower thirds stay whole.
async function serveYouTubeThumbnail(res, id, params) {
  const src = join(MEDIA, `${id}.webm`);
  if (!existsSync(src)) return fail(404, 'Not found');
  const recording = getRecording(id);
  const requested = Number(params.get('t'));
  const seek = Number.isFinite(requested)
    ? Math.max(0, Math.min(requested, recording.duration_ms / 1000))
    : Math.min(1, recording.duration_ms / 2000);
  const aspect = params.get('aspect') ?? '16:9';
  const [w, h] = ASPECTS[aspect] ?? ASPECTS['16:9'];
  const key = randomUUID();
  const out = join(TMP, `thumb-${key}.jpg`);
  // Headline text: big bold white with a black edge, stacked up from the bottom. One drawtext per line (see captionFilters).
  const size = Math.round(h * (aspect === '9:16' ? 0.055 : 0.12));
  const text = (params.get('text') ?? '').trim().slice(0, 80);
  const lines = text ? wrap(text, Math.floor(w * 0.9 / (size * 0.68))).split('\n') : [];
  const lineFiles = lines.map((_, i) => `thumb-${key}-${i}.txt`);
  const headline = lineFiles.map((file, i) => `,drawtext=fontfile=${FONT_DIR}/DejaVuSans-Bold.ttf:textfile=${file}:expansion=none`
    + `:fontsize=${size}:fontcolor=white:borderw=${Math.round(size / 8)}:bordercolor=black:y_align=font`
    + `:x=(w-text_w)/2:y=h*0.94-${Math.round((lines.length - i) * size * 1.2)}`).join('');
  try {
    await Promise.all(lines.map((line, i) => writeFile(join(TMP, lineFiles[i]), line)));
    const done = await run(FFMPEG, ['-y', '-ss', String(seek), '-i', src, '-frames:v', '1',
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0b0b0c${headline}`,
      '-q:v', '2', '-f', 'mjpeg', out], { cwd: TMP });
    if (done === null) fail(500, 'Thumbnail failed');
    const info = await stat(out);
    const name = cleanTitle(recording.title).replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 60) || 'thumbnail';
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename="${name}${aspect === '9:16' ? '-shorts' : ''}.jpg"`,
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(createReadStream(out), res).catch(() => {});
  } finally {
    await Promise.all([out, ...lineFiles.map((file) => join(TMP, file))].map((file) => rm(file, { force: true })));
  }
}

// Resolves to stdout, or null if the command could not run or exited non-zero.
function run(command, args, options) {
  return new Promise((done) => {
    let stdout = '';
    const p = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], ...options });
    p.stdout.on('data', (chunk) => { stdout += chunk; });
    p.on('error', () => done(null));
    p.on('close', (code) => done(code === 0 ? stdout : null));
  });
}

// Runs ffmpeg and reports progress from -progress lines; aborting the signal kills the process.
function runProgress(command, args, { signal, onProgress, cwd } = {}) {
  return new Promise((done) => {
    let stdout = '';
    let buffer = '';
    const p = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], cwd });
    p.stdout.on('data', (chunk) => {
      stdout += chunk;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        // out_time_ms is microseconds despite the name.
        const seconds = /^out_time_ms=(\d+)$/.exec(line)?.[1];
        if (seconds && onProgress) onProgress(Number(seconds) / 1e6);
      }
    });
    const abort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    p.on('error', () => done(null));
    p.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      done(code === 0 && !signal?.aborted ? stdout : null);
    });
  });
}

// Like run(), but keeps stderr: silencedetect and volumedetect report there, at info level, and exit 0.
function runStderr(command, args) {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    const p = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (chunk) => { stdout += chunk; });
    p.stderr.on('data', (chunk) => { stderr += chunk; });
    p.on('error', () => done({ code: null, stdout, stderr }));
    p.on('close', (code) => done({ code, stdout, stderr }));
  });
}

// Inverts [start, end) silences (source seconds, end may be Infinity) to keep-ranges on the 0..end-start trim.
function keepRanges(silences, start, end) {
  const merged = [];
  for (const [a, b] of silences) {
    const last = merged.at(-1);
    if (last && a - last[1] < 0.4) last[1] = Math.max(last[1], b); // a click or breath between two silences is not speech
    else merged.push([a, b]);
  }
  const length = end - start;
  const keep = [];
  let cursor = 0;
  for (const [a, b] of merged) {
    const from = Math.min(Math.max(a + 0.15 - start, 0), length); // 150 ms of air stays beside every word
    const to = Math.min(Math.max(b - 0.15 - start, 0), length);
    if (to <= from) continue;
    if (from > cursor) keep.push([cursor, from]);
    cursor = Math.max(cursor, to);
  }
  if (cursor < length) keep.push([cursor, length]);
  const cuts = keep.filter(([a, b]) => b - a >= 0.1).map((range) => range.map((t) => Math.round(t * 1000) / 1000));
  while (cuts.length > 200) { // the render's cap: close the shortest removed gap until it fits
    let i = 0;
    for (let j = 1; j < cuts.length - 1; j++) if (cuts[j + 1][0] - cuts[j][1] < cuts[i + 1][0] - cuts[i][1]) i = j;
    cuts.splice(i, 2, [cuts[i][0], cuts[i + 1][1]]);
  }
  return cuts;
}

async function detectSilence(res, id, query) {
  const { duration_ms: durationMs } = getRecording(id);
  const src = join(MEDIA, `${id}.webm`);
  if (!existsSync(src)) fail(404, 'Not found');
  const start = query.has('start') ? Number(query.get('start')) : 0;
  const end = query.has('end') ? Number(query.get('end')) : durationMs / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) fail(400, 'Start and end must be numbers, with end after start');

  const volume = await runStderr(FFMPEG, ['-hide_banner', '-nostats', '-i', src, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const peak = parseFloat(/max_volume: (-?[\d.]+) dB/.exec(volume.stderr)?.[1]);
  if (volume.code !== 0 || !Number.isFinite(peak)) fail(400, 'This recording has no audio to analyse');
  // Relative to this file's peak: an absolute threshold would call every word on a quiet mic silence.
  const noise = Math.min(Math.max(peak - 20, -45), -20);
  const detect = await runStderr(FFMPEG, ['-hide_banner', '-nostats', '-i', src, '-vn', '-af', `silencedetect=noise=${noise}dB:d=0.7`, '-f', 'null', '-']);
  if (detect.code !== 0) fail(500, 'Silence detection failed');

  const silences = [];
  for (const [, kind, value] of detect.stderr.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const last = silences.at(-1);
    if (kind === 'start') silences.push([Math.max(Number(value), 0), Infinity]); // Infinity: silent to EOF unless an end follows
    else if (last?.[1] === Infinity) last[1] = Number(value);
    else silences.push([0, Number(value)]); // an end with no start: silent from the top
  }
  const cuts = keepRanges(silences, start, end);
  const total = Math.round((end - start) * 1000) / 1000;
  const kept = cuts.reduce((n, [a, b]) => n + (b - a), 0);
  json(res, 200, { cuts, removed: Math.round((total - kept) * 1000) / 1000, total });
}

// Derived and disposable, so a module Map is the whole cache. Holds the promise, so concurrent loads share one ffmpeg.
// shortcut: never evicted, ~30 KB per recording opened; bound it if the process lives across thousands of recordings.
const waveforms = new Map();

function waveform(id) {
  if (!waveforms.has(id)) waveforms.set(id, (async () => {
    const src = join(MEDIA, `${id}.webm`);
    const audio = await run(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src]);
    if (!audio?.trim()) return null;
    const out = join(TMP, `${id}-${randomUUID()}.png`);
    try {
      // -c:v png -update 1: image2 otherwise picks the codec from the name, and a .part name gets a JPEG.
      const done = await run(FFMPEG, ['-y', '-i', src, '-filter_complex', 'showwavespic=s=1600x120:colors=#6b6b74',
        '-frames:v', '1', '-c:v', 'png', '-f', 'image2', '-update', '1', out]);
      const body = done === null ? null : await readFile(out).catch(() => null);
      return body?.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ? `data:image/png;base64,${body.toString('base64')}` : null;
    } finally {
      await rm(out, { force: true });
    }
  })());
  return waveforms.get(id);
}

async function saveWatermark(req, res) {
  const body = await readBody(req, MAX_WATERMARK, 'Watermark exceeds 5 MB');
  if (!body.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) fail(400, 'Watermark must be a PNG');
  const partial = `${WATERMARK}.part`;
  await writeFile(partial, body);
  await rename(partial, WATERMARK); // a render reading the old logo must never see half a new one
  json(res, 200, { ok: true });
}

async function serveWatermark(res) {
  const body = await readFile(WATERMARK).catch(() => fail(404, 'No watermark'));
  res.writeHead(200, { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function audioType(body, filename) {
  const tag = (start, end) => body.toString('latin1', start, end);
  if (tag(0, 3) === 'ID3' || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0)) return 'mp3';
  if (tag(0, 4) === 'OggS') return 'ogg';
  if (tag(0, 4) === 'RIFF' && tag(8, 12) === 'WAVE') return 'wav';
  if (tag(4, 8) === 'ftyp') return 'm4a';
  const ext = extname(filename).slice(1).toLowerCase();
  return Object.hasOwn(AUDIO, ext) ? ext : fail(400, 'Music must be mp3, m4a, wav or ogg');
}

// The client percent-encodes the name because fetch rejects non-latin1 header values.
function headerFilename(value = '') {
  try { return decodeURIComponent(value); } catch { return value; }
}

async function saveMusic(req, res) {
  const body = await readBody(req, MAX_MUSIC, 'Music exceeds 20 MB');
  if (body.length === 0) fail(400, 'Empty upload');
  const filename = headerFilename(req.headers['x-filename']).trim().slice(0, 200);
  const ext = audioType(body, filename);
  const id = randomUUID();
  const name = filename || 'Untitled track';
  await writeFile(join(MUSIC, `${id}.${ext}`), body);
  sql.musicInsert.run(id, name, ext, body.length);
  json(res, 201, { id, name });
}

function getMusic(id) {
  return sql.musicGet.get(id) ?? fail(404, 'Track not found');
}

async function serveMusic(res, id) {
  const { ext, size } = getMusic(id);
  res.writeHead(200, { 'Content-Type': AUDIO[ext].mime, 'Content-Length': size, 'X-Content-Type-Options': 'nosniff' });
  await pipeline(createReadStream(join(MUSIC, `${id}.${ext}`)), res).catch(() => {});
}

// Keep-ranges in trimmed-source seconds (0 = trim start). Missing means the whole trim, so every render takes one path.
function normaliseCuts(cuts, length) {
  cuts ??= [[0, length]];
  if (!Array.isArray(cuts)) fail(400, 'Cuts must be an array');
  if (cuts.length > 200) fail(400, 'At most 200 cuts');
  let previous = 0;
  for (const range of cuts) {
    const [a, b] = Array.isArray(range) && range.length === 2 ? range : [];
    if (!Number.isFinite(a) || !Number.isFinite(b)) fail(400, 'Each cut must be a [start, end] pair of numbers');
    if (b <= a) fail(400, 'Each cut must end after it starts');
    if (b - a < 0.1 - 1e-6) fail(400, 'Each cut must be at least 0.1 seconds long');
    if (a < 0 || b > length + 1e-6) fail(400, 'Cuts must lie inside the trimmed clip');
    if (a < previous - 1e-6) fail(400, 'Cuts must be in ascending order and must not overlap');
    previous = b;
  }
  if (cuts.length === 0) fail(400, 'Cuts must keep at least part of the clip');
  return cuts.map(([a, b]) => [a, Math.min(b, length)]);
}

// Every value here ends up in an ffmpeg filter string, so nothing passes unchecked.
function validateEdit({ trim, cuts: rawCuts, background = '#0b0b0c', overlays = [], captions = [], zooms = [], captionStyle = {}, aspect = '16:9', fit = 'pad', speed = 1, normalize = true, denoise = false, duck = true, watermark = null, music = null }) {
  const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
  const { start, end } = trim ?? {};
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) fail(400, 'Trim start and end must be numbers');
  if (end <= start) fail(400, 'Trim end must be after start');
  if (end - start > MAX_RENDER_SECONDS) fail(400, `Trimmed length cannot exceed ${MAX_RENDER_SECONDS} seconds`);
  const cuts = normaliseCuts(rawCuts, end - start);
  const kept = cuts.reduce((n, [a, b]) => n + (b - a), 0);
  if (!COLOR.test(background)) fail(400, 'Background must be a #rrggbb colour');
  if (!Array.isArray(overlays)) fail(400, 'Overlays must be an array');
  if (overlays.length > 20) fail(400, 'At most 20 overlays');
  for (const overlay of overlays) {
    const { text, x, y, size, color, font, start: from = null, end: to = null } = overlay ?? {};
    // Optional timing, in edited-clip seconds like captions; without it the text stays up for the whole clip.
    if ((from === null) !== (to === null)) fail(400, 'Overlay start and end must be set together');
    if (from !== null && (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from)) fail(400, 'Overlay start and end must be numbers, with end after start');
    if (typeof text !== 'string' || !text.trim() || text.length > 200) fail(400, 'Overlay text must be 1-200 characters');
    if (!inRange(x, 0, 1) || !inRange(y, 0, 1)) fail(400, 'Overlay x and y must be between 0 and 1');
    if (!inRange(size, 8, 200)) fail(400, 'Overlay size must be between 8 and 200');
    if (!COLOR.test(color)) fail(400, 'Overlay colour must be a #rrggbb colour');
    if (!['sans', 'sans-bold', 'serif'].includes(font)) fail(400, 'Overlay font must be sans, sans-bold or serif');
  }
  if (!Object.hasOwn(ASPECTS, aspect)) fail(400, 'Aspect must be 16:9, 9:16 or 1:1');
  if (!['pad', 'crop'].includes(fit)) fail(400, 'Fit must be pad or crop');
  if (typeof normalize !== 'boolean') fail(400, 'Normalize must be true or false');
  if (typeof denoise !== 'boolean') fail(400, 'Denoise must be true or false');
  if (typeof duck !== 'boolean') fail(400, 'Duck must be true or false');
  if (!inRange(speed, 0.5, 2)) fail(400, 'Speed must be between 0.5 and 2');
  if (!Array.isArray(captions)) fail(400, 'Captions must be an array');
  if (captions.length > 100) fail(400, 'At most 100 captions');
  for (const caption of captions) {
    const { start: from, end: to, text } = caption ?? {};
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) fail(400, 'Caption start and end must be numbers, with end after start');
    if (to > kept + 1e-6) fail(400, 'Caption ends past the trimmed clip'); // edited time, after cuts. 1e-6: 3.3 - 1.1 is 2.1999999999999997
    if (typeof text !== 'string' || !text.trim() || text.length > 200) fail(400, 'Caption text must be 1-200 characters');
  }
  if (!Array.isArray(zooms)) fail(400, 'Zooms must be an array');
  if (zooms.length > 20) fail(400, 'At most 20 zooms');
  for (const zoom of zooms) {
    const { start: from, end: to, level, x, y } = zoom ?? {};
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) fail(400, 'Zoom start and end must be numbers, with end after start');
    if (!inRange(level, 1.1, 5)) fail(400, 'Zoom level must be between 1.1 and 5');
    if (!inRange(x, 0, 1) || !inRange(y, 0, 1)) fail(400, 'Zoom x and y must be between 0 and 1');
  }
  const style = { size: 'm', position: 'bottom', look: 'box', ...captionStyle };
  if (!Object.hasOwn(CAPTION_SIZE, style.size)) fail(400, 'Caption size must be s, m or l');
  if (!['bottom', 'middle', 'top'].includes(style.position)) fail(400, 'Caption position must be bottom, middle or top');
  if (!['box', 'outline', 'highlight'].includes(style.look)) fail(400, 'Caption look must be box, outline or highlight');
  if (watermark !== null) {
    const { corner, size, opacity, margin } = watermark;
    if (!['tl', 'tr', 'bl', 'br'].includes(corner)) fail(400, 'Watermark corner must be tl, tr, bl or br');
    if (!inRange(size, 0.05, 0.3)) fail(400, 'Watermark size must be between 0.05 and 0.3');
    if (!inRange(opacity, 0.1, 1)) fail(400, 'Watermark opacity must be between 0.1 and 1');
    if (!inRange(margin, 0, 0.1)) fail(400, 'Watermark margin must be between 0 and 0.1');
    if (!existsSync(WATERMARK)) fail(400, 'No watermark uploaded');
  }
  let track = null;
  if (music !== null) {
    if (typeof music.id !== 'string') fail(400, 'Music id must be a string');
    if (!inRange(music.volume, 0, 1)) fail(400, 'Music volume must be between 0 and 1');
    track = sql.musicGet.get(music.id) ?? fail(400, 'Music track not found');
  }
  const edit = JSON.stringify({
    trim: { start, end },
    cuts,
    background,
    overlays: overlays.map(({ text, x, y, size, color, font, bold, start: from = null, end: to = null }) => ({ text, x, y, size, color, font, bold: bold === true, start: from, end: to })),
    zooms: zooms.map(({ start: from, end: to, level, x, y }) => ({ start: from, end: to, level, x, y })),
    captionStyle: { size: style.size, position: style.position, look: style.look },
    captions: captions.map(({ start: from, end: to, text }) => ({ start: from, end: to, text })),
    aspect,
    fit,
    speed,
    normalize,
    denoise,
    duck,
    watermark: watermark && { corner: watermark.corner, size: watermark.size, opacity: watermark.opacity, margin: watermark.margin },
    music: music && { id: music.id, volume: music.volume },
  });
  return { start, end, cuts, kept, background, overlays, captions, zooms, captionStyle: style, aspect, fit, speed, normalize, denoise, duck, watermark, track, volume: music?.volume, edit };
}

function drawtext({ x, y, size, color, bold, font, start = null, end = null }, textfile, scale) {
  const fontfile = `${font === 'serif' ? 'DejaVuSerif' : 'DejaVuSans'}${bold === true || font === 'sans-bold' ? '-Bold' : ''}.ttf`;
  // expansion=none: drawtext otherwise treats % in the text as a template, even from a textfile.
  return `drawtext=fontfile=${FONT_DIR}/${fontfile}:textfile=${textfile}:expansion=none`
    + `:fontsize=${Math.round(size * scale)}:fontcolor=${color}:x=(w-text_w)*${x}:y=(h-text_h)*${y}`
    + `:box=1:boxcolor=black@0.35:boxborderw=${Math.round(12 * scale)}`
    + (start === null ? '' : `:enable='between(t,${start},${end})'`);
}

// shortcut: breaks on spaces only, so one word wider than the frame still clips; hard-split if that shows up.
function wrap(text, chars) {
  const lines = [''];
  for (const word of text.trim().split(/\s+/)) {
    const line = lines.at(-1);
    if (line && line.length + 1 + word.length > chars) lines.push(word);
    else lines[lines.length - 1] = line ? `${line} ${word}` : word;
  }
  return lines.join('\n');
}

const CAPTION_SIZE = { s: 0.035, m: 0.045, l: 0.06 }; // of the frame height

// One drawtext per line: this ffmpeg draws a missing-glyph box for a newline read from a textfile.
function captionFilters({ start, end }, lineFiles, size, { position, look }) {
  const lineHeight = Math.round(size * 1.35);
  const block = lineFiles.length * lineHeight;
  const top = position === 'top' ? 'h*0.08' : position === 'middle' ? `(h-${block})/2` : `h*0.92-${block}`;
  const pad = Math.round(size / 4);
  const paint = look === 'outline' ? `fontcolor=white:borderw=${Math.max(2, Math.round(size / 9))}:bordercolor=black`
    : `fontcolor=${look === 'highlight' ? 'black' : 'white'}:box=1:boxcolor=${look === 'highlight' ? '0xffd60a' : 'black'}:boxborderw=${pad}`;
  // y_align=font: every line sits on the font's own metrics, so lines without tall letters don't drift.
  return lineFiles.map((file, i) => `drawtext=fontfile=${FONT_DIR}/DejaVuSans${look === 'box' ? '' : '-Bold'}.ttf:textfile=${file}:expansion=none`
    + `:fontsize=${size}:${paint}:y_align=font:x=(w-text_w)/2:y=${top}+${i * lineHeight}:enable='between(t,${start},${end})'`);
}

// Eased punch-ins on the source picture, before scaling and text, so overlays and captions stay put.
// fps=30 first: zoompan stamps frames at a fixed rate, and browser recordings are variable-rate.
function zoomFilter(zooms, width, height) {
  const ramp = ({ start, end }) => `clip((it-${start})/0.4,0,1)*clip((${end}-it)/0.4,0,1)`;
  const level = `min(5,1+${zooms.map((zoom) => `${zoom.level - 1}*${ramp(zoom)}`).join('+')})`;
  const at = (key) => zooms.map((zoom) => `${zoom[key]}*between(it,${zoom.start},${zoom.end})`).join('+');
  return `fps=30,zoompan=z='${level}':x='(iw-iw/zoom)*(${at('x')})':y='(ih-ih/zoom)*(${at('y')})':d=1:s=${width}x${height}:fps=30`;
}

// loudnorm's measuring pass. One pass alone lands 3-4 LU under the target on speech; fed these numbers
// the real pass hits it. Resolves to '' when measuring fails, which leaves the old one-pass behaviour.
function measureLoudness(inputs, agraph, label) {
  return new Promise((done) => {
    let stderr = '';
    const p = spawn(FFMPEG, ['-hide_banner', '-nostats', ...inputs, '-filter_complex', agraph.join(';'), '-map', label, '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'], cwd: TMP });
    p.stderr.on('data', (chunk) => { stderr += chunk; });
    p.on('error', () => done(''));
    p.on('close', () => {
      try {
        const m = JSON.parse(stderr.slice(stderr.lastIndexOf('{')));
        const values = [m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset].map(Number);
        if (!values.every(Number.isFinite)) return done(''); // silence measures as -inf
        const [i, tp, lra, thresh, offset] = values;
        done(`:measured_I=${i}:measured_TP=${tp}:measured_LRA=${lra}:measured_thresh=${thresh}:offset=${offset}:linear=true`);
      } catch {
        done('');
      }
    });
  });
}

// The suffix survives truncation so renders of a long title still differ. Older suffixes are dropped so chains don't pile up.
function renderTitle(title, aspect, speed) {
  const suffix = ` — ${aspect} ${speed}x`;
  const base = title.replace(/(?: \(edited\)| — (?:16:9|9:16|1:1) [\d.]+x)+$/, '');
  return base.slice(0, 120 - suffix.length) + suffix;
}

function srtTime(seconds) {
  const ms = Math.round(seconds * 1000); // whole ms first, so .9996 carries instead of printing ,1000
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function toSrt(captions) {
  return captions.toSorted((a, b) => a.start - b.start)
    // A blank line ends an SRT cue, so one inside the text would cut it short.
    .map(({ start, end, text }, i) => `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text.trim().replace(/\s*[\r\n]+\s*/g, '\n')}`)
    .join('\n\n') + '\n';
}

// Render jobs: ffmpeg runs in the background, so a long edit neither holds an HTTP connection nor blocks a cancel.
const renders = new Map(); // shortcut: in memory, a restart forgets running jobs

async function startRender(req, res, sourceId) {
  const source = getRecording(sourceId);
  const validated = validateEdit(await readJson(req)); // bad edits are a 400 now, not a failed job later
  const jobId = randomUUID();
  const job = { state: 'queued', step: 'queued', progress: 0 };
  renders.set(jobId, job);
  runRender(job, source, validated); // never rejects: failures land on the job
  json(res, 202, { jobId });
}

async function runRender(job, source, { start, end, cuts, kept, background, overlays, captions, zooms, captionStyle, aspect, fit, speed, normalize, denoise, duck, watermark, track, volume, edit: validEdit }) {
  const controller = new AbortController();
  job.cancel = () => controller.abort();
  const step = (name, progress) => Object.assign(job, { state: 'running', step: name, ...(progress !== undefined && { progress }) });
  const id = randomUUID();
  const file = join(MEDIA, `${id}.webm`);
  const partial = `${file}.part`;
  const src = join(MEDIA, `${source.id}.webm`);
  const outputSeconds = kept / speed;

  const audioStreams = await run(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src]);
  if (audioStreams === null) fail(500, 'Render failed');

  const [width, height] = ASPECTS[aspect];
  const scale = width / 1280; // overlay sizes are pixels on a 1280-wide frame, which is what the preview draws
  const captionSize = Math.round(height * CAPTION_SIZE[captionStyle.size]);
  // DejaVu Sans averages about 0.6em per character, its bold a little more.
  const captionChars = Math.floor(width * 0.9 / (captionSize * (captionStyle.look === 'box' ? 0.6 : 0.68)));
  const captionLines = captions.map((caption) => wrap(caption.text, captionChars).split('\n'));
  // Relative names, run with cwd=TMP, so the install path never needs filter-string escaping.
  const textFiles = overlays.map((_, i) => `${id}-${i}.txt`);
  const captionFiles = captionLines.map((lines, i) => lines.map((_, j) => `${id}-c${i}-${j}.txt`));
  let zoom = [];
  if (zooms.length) {
    const size = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src]);
    const [w, h] = (size ?? '').trim().split(',').map((n) => Math.floor(Number(n) / 2) * 2);
    if (!(w > 0 && h > 0)) fail(500, 'Render failed');
    zoom = [zoomFilter(zooms, w, h)];
  }
  const filters = [
    ...zoom,
    ...(fit === 'crop'
      ? [`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`]
      : [`scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${background}`]),
    ...overlays.map((overlay, i) => drawtext(overlay, textFiles[i], scale)),
    // After the cuts, before setpts: caption times are on the edited clip, so they stay on their words at any speed.
    ...captions.flatMap((caption, i) => captionFilters(caption, captionFiles[i], captionSize, captionStyle)),
    `setpts=PTS/${speed}`,
  ];

  const inputs = ['-ss', String(start), '-to', String(end), '-i', src];
  // trim/atrim + concat, not select/aselect: aselect silently keeps all the audio of an Opus source.
  const graph = [
    ...cuts.map(([a, b], i) => `[0:v:0]trim=${a}:${b},setpts=PTS-STARTPTS[v${i}]`),
    `${cuts.map((_, i) => `[v${i}]`).join('')}concat=n=${cuts.length}:v=1:a=0[vcat]`,
    `[vcat]${filters.join(',')}[base]`,
  ];
  let video = '[base]';
  if (watermark) {
    const left = watermark.corner[1] === 'l';
    const top = watermark.corner[0] === 't';
    const margin = Math.round(watermark.margin * width);
    inputs.push('-i', WATERMARK);
    // format=rgba: an opaque PNG has no alpha channel for aa to act on.
    graph.push(`[1:v]scale=${Math.round(watermark.size * width)}:-1,format=rgba,colorchannelmixer=aa=${watermark.opacity}[mark]`,
      `[base][mark]overlay=${left ? margin : `W-w-${margin}`}:${top ? margin : `H-h-${margin}`}[marked]`);
    video = '[marked]';
  }
  const agraph = []; // audio chains, kept apart so the loudness pass can run them without the picture
  let voice = null;
  if (audioStreams.trim()) {
    // 30 ms fades at every join, or each cut clicks.
    agraph.push(...cuts.map(([a, b], i) => `[0:a:0]atrim=${a}:${b},asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st=${b - a - 0.03}:d=0.03[a${i}]`),
      `${cuts.map((_, i) => `[a${i}]`).join('')}concat=n=${cuts.length}:v=0:a=1,atempo=${speed}[voice]`);
    voice = '[voice]';
    if (denoise) {
      // FFT denoise before mixing, so the music bed is not touched.
      agraph.push('[voice]afftdn=nf=-25[voiceclean]');
      voice = '[voiceclean]';
    }
  }
  const audio = [];
  if (voice) audio.push(voice);
  if (track) {
    // -f: uploads may pass on extension alone, so never let ffmpeg pick a demuxer (HLS playlists read local files).
    inputs.push('-stream_loop', '-1', '-f', AUDIO[track.ext].demuxer, '-i', join(MUSIC, `${track.id}.${track.ext}`));
    agraph.push(`[${watermark ? 2 : 1}:a:0]atrim=duration=${outputSeconds},volume=${volume}[bed]`);
    if (voice && duck) {
      // Sidechain the bed to the voice: music drops only while someone is speaking.
      agraph.push(`${voice}asplit=2[voiceMix][duckKey]`,
        `[bed][duckKey]sidechaincompress=threshold=0.02:ratio=8:attack=5:release=300[bedDuck]`);
      audio.length = 0;
      audio.push('[voiceMix]', '[bedDuck]');
    } else {
      audio.push('[bed]');
    }
  }
  if (audio.length === 2) agraph.push(`${audio[0]}${audio[1]}amix=inputs=2:duration=longest:normalize=0[mix]`); // normalize would halve the voice
  let finalAudio = audio.length === 2 ? '[mix]' : audio[0];
  if (finalAudio && normalize) {
    // shortcut: the measuring pass ignores Cancel; it is audio-only and takes a few seconds per minute of clip.
    const measured = await measureLoudness(inputs, [...agraph, `${finalAudio}${LOUDNORM}:print_format=json[measure]`], '[measure]');
    agraph.push(`${finalAudio}${LOUDNORM}${measured},aresample=48000[loud]`); // loudnorm outputs 192 kHz, which opus rejects
    finalAudio = '[loud]';
  }
  graph.push(...agraph);
  const maps = ['-map', video];
  if (finalAudio) maps.push('-map', finalAudio);
  if (track) maps.push('-shortest'); // a trim end past the source must not let the bed outlast the picture

  try {
    step('preparing', 0);
    await Promise.all([
      ...overlays.map((overlay, i) => writeFile(join(TMP, textFiles[i]), overlay.text)),
      ...captionLines.flatMap((lines, i) => lines.map((line, j) => writeFile(join(TMP, captionFiles[i][j]), line))),
    ]);
    step('rendering', 0);
    const rendered = await runProgress(FFMPEG, ['-y', ...inputs, '-filter_complex', graph.join(';'), ...maps,
      '-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', '-progress', 'pipe:1', '-nostats', '-f', 'webm', partial], {
      cwd: TMP,
      signal: controller.signal,
      onProgress: (seconds) => { job.progress = Math.min(0.99, seconds / outputSeconds); },
    });
    if (rendered === null) throw new Error(controller.signal.aborted ? 'Render canceled' : 'Render failed');

    // ffmpeg exits 0 with an empty file when the trim starts past the end of the source.
    const probed = parseFloat(await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', partial]));
    if (!(probed > 0)) fail(400, 'Trim starts past the end of the recording');
    if (controller.signal.aborted) throw new Error('Render canceled');

    step('finishing', 0.99);
    const { size } = await stat(partial);
    await rename(partial, file);
    const durationMs = Math.round(Math.min(probed, outputSeconds) * 1000); // a trim end past the source yields less
    // Stored on the output timeline: edit times are before the speed change, SRT players need them after it.
    const storedCaptions = captions.length
      ? JSON.stringify(captions.map((c) => ({ start: c.start / speed, end: c.end / speed, text: c.text })))
      : null;
    sql.insert.run(id, renderTitle(source.title, aspect, speed), Date.now(), durationMs, size, 'video/webm', storedCaptions, source.id, validEdit);
    Object.assign(job, { state: 'done', step: 'done', progress: 1, id, url: `/watch/${id}` });
  } catch (err) {
    await Promise.all([rm(partial, { force: true }), rm(file, { force: true })]);
    if (controller.signal.aborted) {
      Object.assign(job, { state: 'canceled', step: 'canceled', progress: 0, error: 'Render canceled' });
    } else {
      Object.assign(job, { state: 'error', step: 'error', error: err.message });
      console.error(`Render ${source.id} failed: ${err.message}`);
    }
  } finally {
    await Promise.all([...textFiles, ...captionFiles.flat()].map((name) => rm(join(TMP, name), { force: true })));
  }
}

// Optional auto-captions through a VoiceStudio (OmniVoice) server. Config is read per request so the key never sits in code.
const LANGUAGES = { en: 'English', es: 'Spanish', hi: 'Hindi', ur: 'Urdu', ar: 'Arabic', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian' };
const MAX_TRANSCRIBE_MS = 60 * 60 * 1000;

function voiceStudioKey() {
  return process.env.VOICE_STUDIO_KEY || fail(503, 'VoiceStudio is not configured');
}

// Any network error, timeout or non-2xx becomes an Error carrying VoiceStudio's own detail/error text.
async function voiceStudio(method, path, { json: payload, body, headers = {}, timeout = 120_000, raw = false } = {}) {
  const base = (process.env.VOICE_STUDIO_URL || 'http://localhost:3000').replace(/\/+$/, '');
  let response;
  try {
    response = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${voiceStudioKey()}`, ...(payload && { 'Content-Type': 'application/json' }), ...headers },
      body: payload ? JSON.stringify(payload) : body,
      duplex: body ? 'half' : undefined, // a streamed request body
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `no answer in ${timeout / 1000} s` : (err.cause?.message ?? err.message);
    throw new Error(`VoiceStudio ${path}: ${reason}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let detail = text.slice(0, 300);
    try { const parsed = JSON.parse(text); detail = parsed.detail ?? parsed.error ?? detail; } catch { /* plain-text body */ }
    throw new Error(`VoiceStudio ${path} returned ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return raw ? response : response.json();
}

// Hand-built multipart: text fields then one streamed file part, so a long clip is never held in memory.
async function* multipart(boundary, fields, file) {
  for (const [name, value] of Object.entries(fields)) {
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="clip.webm"\r\nContent-Type: video/webm\r\n\r\n`);
  yield* createReadStream(file);
  yield Buffer.from(`\r\n--${boundary}--\r\n`);
}

async function waitForTask(taskId, everyMs, minutes, doing) {
  const deadline = Date.now() + minutes * 60 * 1000;
  for (;;) {
    await sleep(everyMs);
    const task = await voiceStudio('GET', `/jobs/${encodeURIComponent(taskId)}`);
    if (task.status === 'done') return;
    if (task.status === 'failed') throw new Error(task.error || `VoiceStudio failed while ${doing}`);
    if (Date.now() > deadline) throw new Error(`VoiceStudio did not finish ${doing} within ${minutes} minutes`);
  }
}

// Auto-captions: VoiceStudio transcribes the clip, and the segments are kept
// on the recording so the editor can turn them into captions without re-running Whisper.
// shortcut: in-memory, single-user; a restart forgets every job. Persist in SQLite if that bites.
const transcribeJobs = new Map();

async function runTranscribe(job, source, sourceLang) {
  try {
    Object.assign(job, { state: 'running', step: 'upload' });
    const boundary = `clip${randomUUID().replaceAll('-', '')}`;
    const { job_id: vsJob, task_id: prepTask } = await voiceStudio('POST', '/dub/upload', {
      body: multipart(boundary, { input_type: 'video', source_lang: sourceLang }, join(MEDIA, `${source.id}.webm`)),
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      timeout: 300_000,
    });
    if (!vsJob) throw new Error('VoiceStudio upload returned no job id');
    if (prepTask) await waitForTask(prepTask, 1000, 15, 'preparing the upload');

    Object.assign(job, { step: 'transcribe' });
    const transcript = await voiceStudio('POST', `/dub/transcribe/${encodeURIComponent(vsJob)}`, { timeout: 900_000 });
    const segments = (transcript.segments ?? [])
      .filter(({ start, end, text }) => Number.isFinite(start) && Number.isFinite(end) && end > start && typeof text === 'string' && text.trim())
      .map(({ start, end, text }) => ({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: text.trim() }));
    if (!segments.length) throw new Error('VoiceStudio heard no speech in this clip');
    sql.transcriptSet.run(JSON.stringify(segments), source.id);
    Object.assign(job, { state: 'done', segments });
  } catch (err) {
    Object.assign(job, { state: 'error', error: err.message });
    console.error(`Transcribe ${source.id} failed: ${err.message}`);
  }
}

async function startTranscribe(req, res, sourceId) {
  voiceStudioKey();
  const source = getRecording(sourceId);
  const { sourceLang = 'en', force = false } = await readJson(req).catch(() => ({}));
  if (!Object.hasOwn(LANGUAGES, sourceLang)) fail(400, `Unknown source language; use one of ${Object.keys(LANGUAGES).join(', ')}`);
  if (typeof force !== 'boolean') fail(400, 'Force must be true or false');
  if (!existsSync(join(MEDIA, `${source.id}.webm`))) fail(404, 'Not found');
  // A stored transcript answers immediately, so re-opening an edit and asking again is free.
  if (source.transcript && !force) return json(res, 200, { segments: JSON.parse(source.transcript), cached: true });
  if (source.duration_ms > MAX_TRANSCRIBE_MS) fail(400, 'Auto-captions are limited to clips of 60 minutes or less');
  const jobId = randomUUID();
  const job = { state: 'queued', step: 'upload' };
  transcribeJobs.set(jobId, job);
  runTranscribe(job, source, sourceLang); // never rejects: failures land on the job
  json(res, 202, { jobId });
}

function formatChapterTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function buildChapters(captions) {
  const base = (captions && captions.length)
    ? captions.map((c) => ({ t: c.start, title: String(c.text).split(/[.!?\n]/)[0].trim().slice(0, 60) || 'Chapter' }))
    : [{ t: 0, title: 'Intro' }];
  if (base[0].t > 0) base.unshift({ t: 0, title: 'Intro' });
  const out = [base[0]];
  for (const chapter of base.slice(1)) {
    if (chapter.t - out.at(-1).t >= 10) out.push(chapter);
  }
  return out;
}

async function serveMetadata(res, id, format) {
  const recording = getRecording(id);
  const captions = recording.captions ? JSON.parse(recording.captions) : [];
  const chapters = buildChapters(captions);
  if (format === 'json') {
    return json(res, 200, { title: recording.title, description: '', tags: [], chapters });
  }
  const lines = [
    recording.title,
    '',
    ...chapters.map((c) => `${formatChapterTime(c.t)} ${c.title}`),
    '',
    '---',
    'Generated by Clip',
  ];
  const body = lines.join('\n');
  const name = cleanTitle(recording.title).replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 60) || 'metadata';
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}-description.txt"`,
    'X-Content-Type-Options': 'nosniff',
  });
  return res.end(body);
}
async function stitchRecordings(ids, title) {
  if (!Array.isArray(ids) || ids.length < 2) fail(400, 'At least two recordings are required');
  if (ids.length > 20) fail(400, 'At most 20 recordings');
  const recordings = ids.map(getRecording);
  for (const recording of recordings) {
    if (!existsSync(join(MEDIA, `${recording.id}.webm`))) fail(404, 'Not found');
  }
  const id = randomUUID();
  const file = join(MEDIA, `${id}.webm`);
  const partial = `${file}.part`;
  const sources = recordings.map((r) => join(MEDIA, `${r.id}.webm`));
  // Takes can differ in size (a 9:16 render, another quality) or lack audio, which the concat demuxer cannot join,
  // so each is fitted into the first one's frame and silent takes get a silent track.
  const probes = await Promise.all(sources.map(async (source) => {
    const out = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', source]);
    const { streams = [], format = {} } = JSON.parse(out || '{}');
    return { video: streams.find((s) => s.codec_type === 'video'), audio: streams.some((s) => s.codec_type === 'audio'), duration: parseFloat(format.duration) };
  }));
  if (probes.some((p) => !p.video?.width)) fail(400, 'Every recording must have a video track');
  const w = Math.floor(probes[0].video.width / 2) * 2;
  const h = Math.floor(probes[0].video.height / 2) * 2;
  const graph = probes.flatMap(({ audio, duration }, i) => [
    `[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`,
    audio ? `[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${Number.isFinite(duration) ? duration : 0.1}[a${i}]`,
  ]);
  graph.push(`${probes.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${probes.length}:v=1:a=1[v][a]`);
  try {
    const done = await run(FFMPEG, ['-y', ...sources.flatMap((s) => ['-i', s]), '-filter_complex', graph.join(';'), '-map', '[v]', '-map', '[a]',
      '-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', '-f', 'webm', partial], { cwd: TMP });
    if (done === null) fail(500, 'Stitch failed');
    const probed = parseFloat(await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', partial]));
    if (!(probed > 0)) fail(500, 'Stitch produced no output');
    const { size } = await stat(partial);
    await rename(partial, file);
    const durationMs = Math.round(probed * 1000);
    sql.insert.run(id, (title || 'Stitched clip').slice(0, 200), Date.now(), durationMs, size, 'video/webm', null, recordings[0].id, null);
    return { id, url: `/watch/${id}` };
  } catch (err) {
    await Promise.all([rm(partial, { force: true }), rm(file, { force: true })]);
    throw err;
  }
}

async function servePackage(res, id) {
  const recording = getRecording(id);
  const stage = join(TMP, `pkg-${randomUUID()}`);
  mkdirSync(stage, { recursive: true });
  const cleanup = async () => rm(stage, { recursive: true, force: true });
  const zipPath = `${stage}.zip`;
  try {
    const srcWebm = join(MEDIA, `${id}.webm`);
    if (!existsSync(srcWebm)) fail(404, 'Not found');
    const mp4 = join(MEDIA, `${id}.mp4`);
    const hasMp4 = existsSync(mp4);
    const videoPath = hasMp4 ? mp4 : srcWebm;
    const videoName = `${(cleanTitle(recording.title).replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 60) || 'clip')}.${hasMp4 ? 'mp4' : 'webm'}`;
    await copyFile(videoPath, join(stage, videoName));

    const thumb = join(stage, 'thumbnail.jpg');
    await run(FFMPEG, ['-y', '-ss', '1', '-i', srcWebm, '-frames:v', '1',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0b0b0c',
      '-q:v', '2', '-f', 'mjpeg', thumb]);

    const captions = recording.captions ? JSON.parse(recording.captions) : [];
    const chapters = buildChapters(captions);
    const meta = [recording.title, '', ...chapters.map((c) => `${formatChapterTime(c.t)} ${c.title}`), '', '---', 'Generated by Clip'].join('\n');
    await writeFile(join(stage, 'description.txt'), meta);
    if (captions.length) await writeFile(join(stage, 'captions.srt'), toSrt(captions));

    const made = await run('python3', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])', stage, stage]);
    if (made === null) fail(500, 'Could not build the package');
    const info = await stat(zipPath);
    const name = cleanTitle(recording.title).replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 60) || 'package';
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename="${name}.zip"`,
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(createReadStream(zipPath), res).catch(() => {});
    await rm(zipPath, { force: true });
  } finally {
    await cleanup();
  }
}

async function serveStatic(res, pathname) {
  try {
    const path = resolve(PUBLIC, `.${decodeURIComponent(pathname)}`);
    if (path.startsWith(PUBLIC + sep) && MIME[extname(path)]) {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] });
      return res.end(body);
    }
  } catch { /* bad escapes and missing files are all 404s */ }
  json(res, 404, { error: 'Not found' });
}

const digest = (value) => createHash('sha256').update(value).digest();
const isToken = (value) => typeof value === 'string' && timingSafeEqual(digest(value), digest(TOKEN));

function authorize(req, res, query) {
  const fromQuery = isToken(query.get('token'));
  const cookie = /(?:^|;\s*)clip_token=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
  if (!fromQuery && !isToken(req.headers['x-clip-token']) && !isToken(cookie && headerFilename(cookie))) {
    fail(401, 'Missing or wrong token. Open this server once with ?token=<CLIP_TOKEN>.');
  }
  // The cookie is what lets <video>, <img>, downloads and this page's own CSS through: none of them can send a header.
  if (fromQuery) res.setHeader('Set-Cookie', `clip_token=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
}

async function route(req, res) {
  const { method } = req;
  const pathname = req.url.split('?')[0];

  if (TOKEN) authorize(req, res, new URLSearchParams(req.url.slice(pathname.length + 1)));

  // Stop other websites driving this API from a visitor's browser.
  if (method !== 'GET' && req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site request');

  if (pathname === '/api/recordings') {
    if (method === 'POST') return createRecording(req, res);
    if (method === 'GET') return json(res, 200, sql.list.all());
  }

  if (pathname === '/api/brand/watermark') {
    if (method === 'POST') return saveWatermark(req, res);
    if (method === 'GET') return serveWatermark(res);
    if (method === 'DELETE') {
      await rm(WATERMARK, { force: true });
      return json(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/brand/music') {
    if (method === 'POST') return saveMusic(req, res);
    if (method === 'GET') return json(res, 200, sql.musicList.all());
  }

  // Route patterns only admit [a-z0-9-], so ids are safe by the time they reach the filesystem.
  const music = /^\/api\/brand\/music\/([a-z0-9-]+)$/.exec(pathname);
  if (music) {
    const id = music[1];
    if (method === 'GET') return serveMusic(res, id);
    if (method === 'DELETE') {
      const { ext } = getMusic(id);
      sql.musicRemove.run(id);
      await rm(join(MUSIC, `${id}.${ext}`), { force: true });
      return json(res, 200, { ok: true });
    }
  }

  const comments = /^\/api\/recordings\/([a-z0-9-]+)\/comments$/.exec(pathname);
  if (comments && method === 'POST') {
    const id = comments[1];
    const recording = getRecording(id);
    const { author, body, t } = await readJson(req);
    if (typeof body !== 'string' || !body.trim()) fail(400, 'Comment body is required');
    const name = (typeof author === 'string' && author.trim()) || 'Guest';
    // Seconds into the recording; null means a general comment.
    const at = Number.isFinite(t) ? Math.max(0, Math.min(t, recording.duration_ms / 1000)) : null;
    return json(res, 201, sql.comment.get(id, name, body.trim(), Date.now(), at));
  }

  const render = /^\/api\/recordings\/([a-z0-9-]+)\/render$/.exec(pathname);
  if (render && method === 'POST') return startRender(req, res, render[1]);
  const renderJob = /^\/api\/renders\/([a-z0-9-]+)$/.exec(pathname);
  if (renderJob && method === 'GET') {
    return json(res, 200, renders.get(renderJob[1]) ?? fail(404, 'Render job not found (jobs are forgotten when the server restarts)'));
  }
  if (renderJob && method === 'DELETE') {
    const job = renders.get(renderJob[1]) ?? fail(404, 'Render job not found (jobs are forgotten when the server restarts)');
    if (job.state === 'queued' || job.state === 'running') {
      job.cancel?.(); // kills ffmpeg; runRender() settles the job and removes its partial file
      Object.assign(job, { state: 'canceled', step: 'canceled', progress: 0, error: 'Render canceled' });
    }
    return json(res, 200, { ok: true });
  }

  const transcribe = /^\/api\/recordings\/([a-z0-9-]+)\/transcribe$/.exec(pathname);
  if (transcribe && method === 'POST') return startTranscribe(req, res, transcribe[1]);
  const transcribeJob = /^\/api\/transcribe\/([a-z0-9-]+)$/.exec(pathname);
  if (transcribeJob && method === 'GET') return json(res, 200, transcribeJobs.get(transcribeJob[1]) ?? fail(404, 'Transcription job not found (jobs are forgotten when the server restarts)'));
  const transcript = /^\/api\/recordings\/([a-z0-9-]+)\/transcript$/.exec(pathname);
  if (transcript && method === 'GET') {
    const { transcript: stored } = getRecording(transcript[1]);
    if (!stored) fail(404, 'No transcript');
    return json(res, 200, { segments: JSON.parse(stored) });
  }

  const silence = /^\/api\/recordings\/([a-z0-9-]+)\/silence$/.exec(pathname);
  if (silence && method === 'GET') return detectSilence(res, silence[1], new URLSearchParams(req.url.slice(pathname.length + 1)));

  const srt = /^\/api\/recordings\/([a-z0-9-]+)\/captions\.srt$/.exec(pathname);
  if (srt && method === 'GET') {
    const { id, captions } = getRecording(srt[1]);
    if (!captions) fail(404, 'No captions');
    res.writeHead(200, {
      'Content-Type': 'application/x-subrip; charset=utf-8',
      'Content-Disposition': `attachment; filename="clip-${id}.srt"`,
    });
    return res.end(toSrt(JSON.parse(captions)));
  }

  const stitch = pathname === '/api/stitch';
  if (stitch && method === 'POST') {
    const { ids, title } = await readJson(req);
    return json(res, 201, await stitchRecordings(ids, title));
  }
  const thumb = /^\/api\/recordings\/([a-z0-9-]+)\/thumbnail\.jpg$/.exec(pathname);
  if (thumb && method === 'GET') return serveYouTubeThumbnail(res, thumb[1], new URLSearchParams(req.url.slice(pathname.length + 1)));

  const metadata = /^\/api\/recordings\/([a-z0-9-]+)\/metadata\.(json|txt)$/.exec(pathname);
  if (metadata && method === 'GET') return serveMetadata(res, metadata[1], metadata[2]);

  const pkg = /^\/api\/recordings\/([a-z0-9-]+)\/package\.zip$/.exec(pathname);
  if (pkg && method === 'GET') return servePackage(res, pkg[1]);

  const recording = /^\/api\/recordings\/([a-z0-9-]+)$/.exec(pathname);
  if (recording) {
    const id = recording[1];
    if (method === 'GET') {
      const row = getRecording(id);
      const source = row.source_id && sql.get.get(row.source_id); // the source may have been deleted since
      return json(res, 200, { ...row, source_title: source?.title ?? null, comments: sql.comments.all(id), waveform: await waveform(id) });
    }
    if (method === 'PATCH') {
      getRecording(id);
      const { title } = await readJson(req);
      if (typeof title !== 'string') fail(400, 'Title must be a string');
      if (title.length > 200) fail(400, 'Title cannot exceed 200 characters');
      sql.rename.run(cleanTitle(title), id);
      return json(res, 200, getRecording(id));
    }
    if (method === 'DELETE') {
      getRecording(id);
      sql.remove.run(id);
      waveforms.delete(id);
      await rm(join(MEDIA, `${id}.webm`), { force: true });
      // Webm first so no new build can start; a running one must land before its output can be removed.
      const outputs = [`${id}.mp4`, `${id}.jpg`].map((name) => join(MEDIA, name));
      await Promise.allSettled(outputs.map((out) => building.get(out)));
      await Promise.all(outputs.map((out) => rm(out, { force: true })));
      return json(res, 200, { ok: true });
    }
  }

  if (method === 'GET') {
    const media = /^\/media\/([a-z0-9-]+)\.webm$/.exec(pathname);
    if (media) return serveMedia(req, res, media[1]);
    const mp4 = /^\/media\/([a-z0-9-]+)\.mp4$/.exec(pathname);
    if (mp4) return serveMp4(res, mp4[1]);
    const jpg = /^\/media\/([a-z0-9-]+)\.jpg$/.exec(pathname);
    if (jpg) return serveThumbnail(res, jpg[1]);
    if (pathname === '/') return serveStatic(res, '/index.html');
    if (pathname === '/library') return serveStatic(res, '/library.html');
  if (pathname === '/stitch') return serveStatic(res, '/stitch.html');
    if (/^\/watch\/[a-z0-9-]+$/.test(pathname)) return serveStatic(res, '/watch.html');
    if (/^\/edit\/[a-z0-9-]+$/.test(pathname)) return serveStatic(res, '/edit.html');
    return serveStatic(res, pathname);
  }
  fail(404, 'Not found');
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    if (!err.status) console.error(err);
    if (res.headersSent) return res.destroy();
    // Close the socket so a rejected upload stops sending instead of draining unread.
    res.setHeader('Connection', 'close');
    json(res, err.status ?? 500, { error: err.status ? err.message : 'Internal error' });
  });
});

server.requestTimeout = 0; // the 5-minute default would abort large uploads on slow links
server.listen(Number(process.env.PORT) || 3000, HOST, () => {
  console.log(`Clip listening on http://${HOST}:${server.address().port}`);
});
