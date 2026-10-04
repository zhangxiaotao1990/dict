import { MDict, normKey } from './mdict.js';

const VERSION = '1.0.0';
const $ = (s, root = document) => root.querySelector(s);

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    const aria = k.startsWith('aria-');
    if (v == null || (v === false && !aria)) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true && !aria ? '' : String(v));
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('mdx.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mdx.' + k, JSON.stringify(v)); } catch {} },
};
const prefs = {
  zoom: store.get('zoom', 1),
  autoplay: store.get('autoplay', 'off'),       // off | uk | us
  darkContent: store.get('darkContent', 'auto'), // auto | off
  tab: store.get('tab', 0),                      // last chosen dictionary tab in combined entries
};
const setPref = (k, v) => { prefs[k] = v; store.set(k, v); };

const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

async function inflate(data) {
  const s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/* ================= storage: Origin Private File System ================= */

const KEEP_EXT = /\.(mdx|mdd|css|js|png|jpe?g|gif|svg|webp|mp3|ttf|otf|woff2?)$/i;

async function dictDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('dicts', { create: true });
}

async function listFiles(dir) {
  const out = [];
  if (typeof dir.values === 'function') {
    for await (const handle of dir.values()) if (handle.kind === 'file') out.push(handle);
  } else {
    for await (const [, handle] of dir.entries()) if (handle.kind === 'file') out.push(handle);
  }
  return out;
}

function writeViaWorker(file, onProgress) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker('import-worker.js'); } catch (e) { e.fallback = true; reject(e); return; }
    w.onmessage = (e) => {
      const m = e.data;
      if (m.progress != null) onProgress(m.progress);
      else if (m.done) { w.terminate(); resolve(); }
      else if (m.error) { w.terminate(); reject(Object.assign(new Error(m.error), { fallback: !!m.fallback })); }
    };
    w.onerror = (e) => { w.terminate(); reject(Object.assign(new Error(e.message || 'worker error'), { fallback: true })); };
    w.postMessage({ file });
  });
}

async function writeViaWritable(dir, file, onProgress) {
  const fh = await dir.getFileHandle(file.name, { create: true });
  if (!fh.createWritable) throw new Error('此浏览器不支持离线存储，请升级系统');
  const w = await fh.createWritable();
  const r = file.stream().getReader();
  let n = 0;
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      await w.write(value);
      n += value.byteLength;
      onProgress(n);
    }
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch {}
    throw e;
  }
}

async function saveFile(dir, file, onProgress) {
  try {
    await writeViaWorker(file, onProgress);
  } catch (e) {
    if (!e.fallback) throw e;
    await writeViaWritable(dir, file, onProgress);
  }
  const saved = await (await dir.getFileHandle(file.name)).getFile();
  if (saved.size !== file.size) throw new Error(`${file.name} 写入不完整（${saved.size}/${file.size}）`);
}

/* ================= dictionaries ================= */

let dicts = [];          // { id, base, title, mdx, mdds, files, bytes }
let loose = new Map();   // '\\name.css' -> File (stand-alone resources, e.g. external CSS)
let otherFiles = [];     // stored files not attached to any dictionary
let loadErrors = [];
let index = [];          // sorted [{ n, k, d, i }]
let exact = new Map();   // normalised key without spaces -> entries
let storageError = null;

async function openMdict(file, isMdd) {
  const m = new MDict(async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer()), inflate, { isMdd });
  try {
    await m.init();
  } catch (e) {
    throw new Error(/bounds|range|offset/i.test(e.message) ? '文件不完整或已损坏，请重新导入' : e.message);
  }
  if (file.size < m.recComp[m.numRecBlocks]) throw new Error('文件不完整，请重新导入');
  return m;
}

async function loadDicts() {
  dicts = []; loose = new Map(); otherFiles = []; loadErrors = []; index = []; exact = new Map();
  resetResourceCaches();
  let dir;
  try { dir = await dictDir(); } catch (e) { storageError = e; return; }
  const files = new Map();
  for (const fh of await listFiles(dir)) {
    try { files.set(fh.name, await fh.getFile()); } catch {}
  }
  const names = [...files.keys()].sort();
  const used = new Set();
  const bad = new Set();
  for (const name of names.filter((n) => /\.mdx$/i.test(n))) {
    const base = name.slice(0, -4);
    const mddNames = names.filter((n) => n.length > base.length && n.slice(0, base.length).toLowerCase() === base.toLowerCase()
      && /^(\.\d+)?\.mdd$/i.test(n.slice(base.length)));
    used.add(name);
    mddNames.forEach((n) => used.add(n));
    try {
      const mdx = await openMdict(files.get(name), false);
      const mdds = [];
      for (const mn of mddNames) {
        try {
          const m = await openMdict(files.get(mn), true);
          m.resMap = new Map(m.keys.map((k, i) => [k.toLowerCase(), i]));
          mdds.push(m);
        } catch (e) { loadErrors.push(`${mn}：${e.message}`); bad.add(mn); }
      }
      const fileList = [name, ...mddNames];
      dicts.push({
        id: dicts.length, base, title: mdx.attrs.Title || base, mdx, mdds, files: fileList,
        bytes: fileList.reduce((a, n) => a + files.get(n).size, 0),
      });
    } catch (e) {
      loadErrors.push(`${name}：${e.message}`);
      bad.add(name);
      mddNames.forEach((n) => used.delete(n)); // list them under "other files" so they can be removed
    }
  }
  for (const [n, f] of files) {
    if (used.has(n)) continue;
    otherFiles.push({ name: n, size: f.size });
    if (!/\.md[dx]$/i.test(n)) loose.set('\\' + n.toLowerCase(), f);
  }
  for (const n of bad) otherFiles.push({ name: n, size: files.get(n).size, bad: true });
  buildIndex();
}

function buildIndex() {
  const arr = [];
  for (const d of dicts) {
    const keys = d.mdx.keys;
    for (let i = 0; i < keys.length; i++) {
      const n = normKey(keys[i]);
      if (n) arr.push({ n, k: keys[i], d: d.id, i });
    }
  }
  // lower-case variants first among equal keys ("may" before "May")
  arr.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : a.k < b.k ? 1 : a.k > b.k ? -1 : a.d - b.d));
  index = arr;
  exact = new Map();
  for (const e of arr) {
    const s = e.n.replace(/ /g, '');
    const l = exact.get(s);
    if (l) l.push(e); else exact.set(s, [e]);
  }
}

function lowerBound(q) {
  let lo = 0, hi = index.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (index[m].n < q) lo = m + 1; else hi = m;
  }
  return lo;
}

function suggest(q, limit = 80) {
  const n = normKey(q);
  if (!n) return [];
  const out = [], seen = new Set();
  const lq = q.trim().toLowerCase();
  // an exact hit that differs only in spacing/punctuation goes first ("lookup" -> "look-up")
  for (const e of exact.get(n.replace(/ /g, '')) || []) {
    const lk = e.k.toLowerCase();
    if (!seen.has(lk)) { seen.add(lk); out.push(e); }
  }
  out.sort((a, b) => (b.k.toLowerCase() === lq) - (a.k.toLowerCase() === lq));
  for (let p = lowerBound(n); p < index.length && out.length < limit; p++) {
    const e = index[p];
    if (!e.n.startsWith(n)) break;
    const lk = e.k.toLowerCase();
    if (seen.has(lk)) continue;
    seen.add(lk);
    out.push(e);
  }
  return out;
}

function findEntries(word) {
  const n = normKey(word);
  if (!n) return [];
  let c = exact.get(n.replace(/ /g, '')) || [];
  const sameSpacing = c.filter((e) => e.n === n);
  if (sameSpacing.length) c = sameSpacing;
  const lw = word.trim().toLowerCase();
  const sameText = c.filter((e) => e.k.trim().toLowerCase() === lw);
  if (sameText.length) c = sameText;
  return c;
}

/* ---------- inflections & typos ---------- */

const IRREGULAR = (
  'arise:arose,arisen|awake:awoke,awoken|be:was,were,been,is,am,are|bear:bore,borne|beat:beaten|become:became|begin:began,begun|' +
  'bend:bent|bind:bound|bite:bit,bitten|bleed:bled|blow:blew,blown|break:broke,broken|breed:bred|bring:brought|build:built|' +
  'burn:burnt|buy:bought|catch:caught|choose:chose,chosen|cling:clung|come:came|creep:crept|deal:dealt|dig:dug|do:did,done,does|' +
  'draw:drew,drawn|dream:dreamt|drink:drank,drunk|drive:drove,driven|eat:ate,eaten|fall:fell,fallen|feed:fed|feel:felt|fight:fought|' +
  'find:found|flee:fled|fling:flung|fly:flew,flown,flies|forbid:forbade,forbidden|forget:forgot,forgotten|forgive:forgave,forgiven|' +
  'freeze:froze,frozen|get:got,gotten|give:gave,given|go:went,gone,goes|grind:ground|grow:grew,grown|hang:hung|have:had,has|' +
  'hear:heard|hide:hid,hidden|hold:held|keep:kept|kneel:knelt|know:knew,known|lay:laid|lead:led|lean:leant|leap:leapt|learn:learnt|' +
  'leave:left|lend:lent|lie:lain,lying|light:lit|lose:lost|make:made|mean:meant|meet:met|pay:paid|ride:rode,ridden|ring:rang,rung|' +
  'rise:rose,risen|run:ran|say:said|see:saw,seen|seek:sought|sell:sold|send:sent|sew:sewn|shake:shook,shaken|shine:shone|shoot:shot|' +
  'show:shown|shrink:shrank,shrunk|sing:sang,sung|sink:sank,sunk|sit:sat|sleep:slept|slide:slid|smell:smelt|speak:spoke,spoken|' +
  'speed:sped|spell:spelt|spend:spent|spill:spilt|spin:spun|spit:spat|spoil:spoilt|spring:sprang,sprung|stand:stood|steal:stole,stolen|' +
  'stick:stuck|sting:stung|stink:stank,stunk|stride:strode|strike:struck,stricken|string:strung|strive:strove,striven|swear:swore,sworn|' +
  'sweep:swept|swell:swollen|swim:swam,swum|swing:swung|take:took,taken|teach:taught|tear:tore,torn|tell:told|think:thought|' +
  'throw:threw,thrown|tread:trod,trodden|understand:understood|undertake:undertook,undertaken|wake:woke,woken|wear:wore,worn|' +
  'weave:wove,woven|weep:wept|win:won|wind:wound|withdraw:withdrew,withdrawn|wring:wrung|write:wrote,written|overcome:overcame|' +
  'man:men|woman:women|child:children|foot:feet|tooth:teeth|mouse:mice|goose:geese|person:people|ox:oxen|louse:lice|' +
  'criterion:criteria|phenomenon:phenomena|medium:media|analysis:analyses|crisis:crises|thesis:theses|cactus:cacti|fungus:fungi|' +
  'nucleus:nuclei|radius:radii|stimulus:stimuli|index:indices|appendix:appendices|matrix:matrices|knife:knives|wife:wives|life:lives|' +
  'leaf:leaves|half:halves|wolf:wolves|shelf:shelves|thief:thieves|calf:calves|loaf:loaves|good:better,best|bad:worse,worst|' +
  'far:farther,further,farthest,furthest|little:less,least|many:more,most'
).split('|').reduce((m, s) => { const [b, f] = s.split(':'); f.split(',').forEach((x) => m.set(x, b)); return m; }, new Map());

function lemmaCandidates(word) {
  const w = word.trim().toLowerCase();
  const c = [];
  const add = (s) => { if (s && s.length > 1 && s !== w) c.push(s); };
  if (IRREGULAR.has(w)) add(IRREGULAR.get(w));
  if (/'s$|’s$/.test(w)) add(w.slice(0, -2));
  for (const [suf, rep] of [['ies', 'y'], ['ied', 'y'], ['ier', 'y'], ['iest', 'y'], ['ves', 'f'], ['ves', 'fe']]) {
    if (w.endsWith(suf)) add(w.slice(0, -suf.length) + rep);
  }
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
  for (const suf of ['ing', 'ed', 'er', 'est']) {
    if (!w.endsWith(suf)) continue;
    const st = w.slice(0, -suf.length);
    add(st); add(st + 'e');
    if (st.length > 2 && st.at(-1) === st.at(-2)) add(st.slice(0, -1));
    if (suf === 'ing' && st.endsWith('y')) add(st.slice(0, -1) + 'ie');
  }
  if (w.endsWith('ily')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ly')) add(w.slice(0, -2));
  return [...new Set(c)];
}

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}

function fuzzy(word, limit = 12) {
  const s = normKey(word).replace(/ /g, '');
  if (s.length < 3) return [];
  const max = s.length <= 5 ? 1 : 2;
  const hits = [];
  for (const [key, list] of exact) {
    if (Math.abs(key.length - s.length) > max) continue;
    const d = editDistance(s, key, max);
    if (d <= max) hits.push({ d, e: list[0] });
  }
  // among equally close words, longer entries first: big entries are the common words ("helo" -> "hello", not "helm")
  for (const x of hits) x.size = entrySize(x.e);
  hits.sort((a, b) => a.d - b.d || b.size - a.size);
  return hits.slice(0, limit).map((x) => x.e);
}

function entrySize(e) {
  const m = dicts[e.d].mdx;
  let j = e.i + 1;
  while (j < m.numEntries && m.offsets[j] <= m.offsets[e.i]) j++;
  return m.offsets[j] - m.offsets[e.i];
}

/* ================= resources (CSS / images / audio from .mdd) ================= */

const MIME = { css: 'text/css', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  spx: 'audio/ogg', js: 'text/javascript', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
const mimeOf = (p) => MIME[(p.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase()] || 'application/octet-stream';

let urlCache = new Map();   // dict id + key -> Promise<blob url | null>
let cssCache = new Map();
const audioKeys = [];       // LRU of audio blob URLs

function resetResourceCaches() {
  for (const p of urlCache.values()) p.then((u) => u && URL.revokeObjectURL(u));
  urlCache = new Map(); cssCache = new Map(); audioKeys.length = 0;
}

function resKey(path) {
  let p = path.trim();
  try { p = decodeURIComponent(p); } catch {}
  p = p.replace(/[?#].*$/, '').replace(/\//g, '\\').replace(/^\.?\\+/, '');
  return '\\' + p.toLowerCase();
}

function joinRes(baseKey, rel) {
  if (/^[\\/]/.test(rel)) return resKey(rel);
  const parts = baseKey.split('\\').slice(0, -1);
  for (const seg of rel.replace(/\//g, '\\').split('\\')) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return resKey(parts.join('\\'));
}

async function resBytes(d, key) {
  const lf = loose.get(key) || loose.get('\\' + key.split('\\').pop());
  if (lf) return new Uint8Array(await lf.arrayBuffer());
  for (const m of d.mdds) {
    const i = m.resMap.get(key);
    if (i != null) return m.record(i);
  }
  return null;
}

function resUrl(d, key) {
  const ck = d.id + key;
  let p = urlCache.get(ck);
  if (!p) {
    p = resBytes(d, key)
      .then((b) => (b ? URL.createObjectURL(new Blob([b], { type: mimeOf(key) })) : null))
      .catch(() => null);
    urlCache.set(ck, p);
    if (/\.(mp3|wav|ogg|spx)$/.test(key)) {
      audioKeys.push(ck);
      if (audioKeys.length > 300) {
        const old = audioKeys.shift();
        urlCache.get(old)?.then((u) => u && URL.revokeObjectURL(u));
        urlCache.delete(old);
      }
    }
  }
  return p;
}

const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
function fixCss(css) {
  // page-level selectors would not match inside the shadow root; aim them at our wrapper instead
  css = css.replace(/(^|[},\s])(html|body)(?=[\s,{.:#[>~+])/g, '$1.mdx-body');
  // Windows-only font lists fall back to Times on iPhone; give them a sans-serif tail
  css = css.replace(/font-family\s*:\s*([^;}]+)/gi, (m, v) =>
    /\b(sans-serif|serif|monospace|inherit|initial|cursive|system-ui|fantasy)\b/i.test(v) ? m
      : `font-family:${v.trim()}, -apple-system, "PingFang SC", sans-serif`);
  return css;
}

function getCss(d, key) {
  const ck = d.id + key;
  if (!cssCache.has(ck)) {
    cssCache.set(ck, (async () => {
      const b = await resBytes(d, key);
      if (!b) return '';
      let css = fixCss(new TextDecoder().decode(b));
      const urls = [...new Set([...css.matchAll(URL_RE)].map((m) => m[2]).filter((u) => !/^(data|blob|https?):/i.test(u)))];
      const map = new Map(await Promise.all(urls.map(async (u) => [u, await resUrl(d, joinRes(key, u))])));
      return css.replace(URL_RE, (m, q, u) => (map.get(u) ? `url("${map.get(u)}")` : m));
    })().catch(() => ''));
  }
  return cssCache.get(ck);
}

/* ================= audio ================= */

const audio = new Audio();
audio.preload = 'auto';
let audioUnlocked = false;
let playingEl = null;

function silentWav() {
  const n = 400, b = new ArrayBuffer(44 + n), v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(b, 44).fill(128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}

// iOS only lets a media element play without a tap after it has played once inside a tap.
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  if (audio.src) return;
  audio.src = silentWav();
  audio.play().catch(() => {});
}
document.addEventListener('touchend', unlockAudio, { capture: true, once: true });
document.addEventListener('click', unlockAudio, { capture: true, once: true });

function markPlaying(el) {
  playingEl?.classList.remove('playing');
  playingEl = el || null;
  playingEl?.classList.add('playing');
}
audio.addEventListener('ended', () => markPlaying(null));
audio.addEventListener('pause', () => markPlaying(null));

async function playSound(d, href, el, { quiet = false } = {}) {
  const key = resKey(href.replace(/^sound:\/\//i, ''));
  const url = await resUrl(d, key);
  if (!url) { if (!quiet) toast('没有找到这个发音'); return; }
  audio.pause();
  audio.src = url;
  markPlaying(el);
  try { await audio.play(); } catch (e) {
    markPlaying(null);
    if (e.name === 'NotAllowedError' && !quiet) toast('再点一次即可发音');
  }
}

function speak(text, lang = 'en-GB') {
  if (!('speechSynthesis' in window)) { toast('此设备不支持朗读'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

/* ================= entry rendering ================= */

const BASE_CSS = `
:host { display: block; }
.mdx-body {
  background: #fff !important; color: #222; margin: 0 !important; padding: 10px 16px 40px !important;
  overflow-wrap: break-word; zoom: var(--zoom, 1); -webkit-user-select: text; user-select: text;
}
.mdx-body img { max-width: 100% !important; height: auto; }
.mdx-body a[href^="sound://" i] {
  display: inline-block; padding: 3px 4px; margin: -3px 0; border-radius: 7px; vertical-align: middle; line-height: 0;
  -webkit-tap-highlight-color: rgba(0, 114, 198, .25);
}
.mdx-body a[href^="sound://" i] img { width: 22px !important; height: 22px !important; max-width: none !important; }
.mdx-body a[href^="sound://" i].playing { background: rgba(0, 114, 198, .16); }
.mdx-body .js_dict_tittle { display: inline-block !important; padding: 7px 12px !important; margin: 2px 2px 2px 0 !important; font-size: 13px !important; border-radius: 8px; cursor: pointer; }
.mdx-body .javascript_tittle_box { margin: 4px 0 12px !important; }
.entry-sep { padding: 14px 16px 6px; font: 600 13px -apple-system, sans-serif; color: #888; background: #fff; border-top: 8px solid #f2f2f4; zoom: 1; }
:host(.dark) .mdx-body, :host(.dark) .entry-sep { filter: invert(.92) hue-rotate(180deg); }
:host(.dark) .mdx-body img { filter: invert(1) hue-rotate(180deg); }
`;

const contentHost = $('#content');
const shadow = contentHost.attachShadow({ mode: 'open' });
const ranScripts = new Set();

function applyContentPrefs() {
  contentHost.style.setProperty('--zoom', prefs.zoom);
  const dark = prefs.darkContent === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches;
  contentHost.classList.toggle('dark', dark);
  contentHost.style.background = dark ? '#141414' : '#fff';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyContentPrefs);

async function buildEntryNode(r, multi) {
  const d = dicts[r.e.d];
  const t = document.createElement('template');
  t.innerHTML = r.html;
  const c = t.content;
  for (const s of c.querySelectorAll('script')) {
    const code = s.textContent;
    if (code.trim() && !s.src && !ranScripts.has(code)) {
      ranScripts.add(code);
      try { (0, eval)(code); } catch (e) { console.warn('dictionary script failed', e); }
    }
    s.remove();
  }
  const cssJobs = [];
  for (const l of c.querySelectorAll('link[href]')) {
    const href = l.getAttribute('href');
    if (!/stylesheet/i.test(l.getAttribute('rel') || '') && !/\.css$/i.test(href)) continue;
    const st = document.createElement('style');
    l.replaceWith(st);
    cssJobs.push(getCss(d, resKey(href)).then((css) => { st.textContent = css; }));
  }
  const imgs = [];
  for (const img of c.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (/^(data|blob|https?):/i.test(src)) continue;
    img.removeAttribute('src');
    imgs.push([img, resKey(src)]);
  }
  const wrap = h('div', { class: 'mdx-body', 'data-d': d.id });
  wrap.append(c);
  await Promise.all(cssJobs);
  const nodes = [];
  if (multi) nodes.push(h('div', { class: 'entry-sep' }, `${r.e.k}${dicts.length > 1 ? ' · ' + d.title : ''}`));
  nodes.push(wrap);
  return { nodes, imgs, d };
}

let renderSeq = 0;
let currentWord = '';
let currentEntries = [];

async function entryHtml(e, depth = 0) {
  const d = dicts[e.d];
  const html = await d.mdx.text(e.i);
  if (html.startsWith('@@@LINK=') && depth < 6) {
    const target = html.slice(8).trim();
    const t = findEntries(target).filter((x) => x.d === e.d);
    if (t.length) return entryHtml(t[0], depth + 1);
  }
  return html;
}

function findPronLink(root, kind) {
  const re = kind === 'uk'
    ? /(^|[\/\\_.-])(uk|gb|br|bre|eng)([\/\\_.-]|$)/i
    : /(^|[\/\\_.-])(us|am|ame|nam|usa)([\/\\_.-]|$)/i;
  for (const a of root.querySelectorAll('a[href^="sound://" i]')) {
    if (re.test(a.getAttribute('href').slice(8))) return a;
  }
  return null;
}

function phoneticFor(a) {
  let p = a?.previousElementSibling;
  if (p && /phon|pron|ipa/i.test(p.className)) return p.textContent.replace(/\s+/g, ' ').trim();
  return '';
}

const SPEAKER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke-width="1.6"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.3 6.5a8 8 0 0 1 0 11"/></svg>';

function renderProns(word) {
  const box = $('#prons');
  box.replaceChildren();
  const btns = [];
  for (const [kind, label] of [['uk', '英'], ['us', '美']]) {
    const a = findPronLink(shadow, kind);
    if (!a) continue;
    const d = dicts[+a.closest('.mdx-body').dataset.d];
    const ipa = phoneticFor(a);
    const b = h('button', { class: 'pron', 'data-kind': kind }, h('b', {}, label), ipa ? h('span', { class: 'ipa' }, `/${ipa}/`) : null);
    b.insertAdjacentHTML('beforeend', SPEAKER);
    b.addEventListener('pointerdown', () => resUrl(d, resKey(a.getAttribute('href').slice(8))));
    b.addEventListener('click', () => playSound(d, a.getAttribute('href'), b));
    box.append(b);
    btns.push(b);
  }
  if (!btns.length) {
    const b = h('button', { class: 'pron' }, h('b', {}, '朗读'));
    b.insertAdjacentHTML('beforeend', SPEAKER);
    b.addEventListener('click', () => speak(word));
    box.append(b);
  }
  return btns;
}

async function showEntry(entries, note) {
  const seq = ++renderSeq;
  const list = entries.slice(0, 10);
  const results = [];
  for (const e of list) results.push({ e, html: await entryHtml(e) });
  const built = [];
  for (const r of results) built.push(await buildEntryNode(r, results.length > 1));
  if (seq !== renderSeq) return;

  const word = entries[0].k;
  currentWord = word;
  currentEntries = entries;
  $('#hw').textContent = word;
  const note$ = $('#entry-note');
  note$.hidden = !note;
  note$.textContent = note || '';
  updateStar();
  shadow.replaceChildren(h('style', {}, BASE_CSS), ...built.flatMap((b) => b.nodes));
  $('#notfound').hidden = true;
  $('#content').hidden = false;
  setView('entry');
  window.scrollTo(0, 0);

  // restore the preferred tab of combined dictionaries (e.g. always open on Collins)
  if (prefs.tab > 0) {
    for (const bar of shadow.querySelectorAll('.javascript_tittle_box')) bar.children[prefs.tab]?.click();
  }
  const prons = renderProns(word);
  for (const b of built) {
    for (const [img, key] of b.imgs) resUrl(b.d, key).then((u) => { if (u) img.src = u; });
  }
  if (prefs.autoplay !== 'off') {
    const a = findPronLink(shadow, prefs.autoplay);
    const btn = prons.find((b) => b.dataset.kind === prefs.autoplay);
    if (a) playSound(dicts[+a.closest('.mdx-body').dataset.d], a.getAttribute('href'), btn, { quiet: true });
  }
}

function showNotFound(word) {
  ++renderSeq;
  currentWord = word;
  currentEntries = [];
  $('#hw').textContent = word;
  $('#entry-note').hidden = true;
  updateStar();
  $('#prons').replaceChildren();
  const sugg = fuzzy(word);
  const hasChinese = /[\u3400-\u9fff]/.test(word);
  shadow.replaceChildren();
  $('#content').hidden = true;
  const nf = $('#notfound');
  nf.replaceChildren(
    h('div', { class: 'msg' },
      h('h2', {}, '没有找到这个词'),
      h('p', {}, hasChinese ? '词典按英文词条索引，暂不支持中文反查。' : (sugg.length ? '你是不是要找：' : '请检查拼写，或换个说法试试。'))),
    sugg.length ? h('ul', { class: 'list' }, sugg.map(rowFor)) : null);
  nf.hidden = false;
  setView('entry');
  window.scrollTo(0, 0);
}

async function openWord(word, { push = true } = {}) {
  word = (word || '').trim();
  if (!word) return;
  if (!dicts.length) { toast('请先在设置里导入词典'); return; }
  let entries = findEntries(word);
  let note = '';
  if (!entries.length) {
    for (const c of lemmaCandidates(word)) {
      const r = findEntries(c);
      if (r.length) { entries = r; note = `未收录 “${word}”，已显示原形 “${r[0].k}”`; break; }
    }
  }
  closeSearch(entries.length ? entries[0].k : word);
  if (push) {
    navDepth++;
    history.pushState({ w: word, depth: navDepth }, '', '#' + encodeURIComponent(word));
  }
  if (!entries.length) { showNotFound(word); return; }
  try {
    await showEntry(entries, note);
    addHistory(entries[0].k);
  } catch (e) {
    console.error(e);
    toast('读取词条失败：' + e.message, 4000);
  }
}

/* link handling inside entries */
shadow.addEventListener('click', (ev) => {
  const tab = ev.target.closest('.js_dict_tittle');
  if (tab) setPref('tab', [...tab.parentNode.children].indexOf(tab));
  const a = ev.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  const d = dicts[+(a.closest('.mdx-body')?.dataset.d || 0)];
  if (/^sound:\/\//i.test(href)) { ev.preventDefault(); playSound(d, href, a); return; }
  const m = href.match(/^(?:entry|bword):\/\/(.*)$/i);
  if (m) {
    ev.preventDefault();
    let target = m[1];
    try { target = decodeURIComponent(target); } catch {}
    if (target.startsWith('#')) scrollToAnchor(target.slice(1));
    else openWord(target);
    return;
  }
  if (/^https?:/i.test(href)) { ev.preventDefault(); window.open(href, '_blank', 'noopener'); return; }
  if (href.startsWith('#')) { ev.preventDefault(); scrollToAnchor(href.slice(1)); return; }
  ev.preventDefault();
});
shadow.addEventListener('pointerdown', (ev) => {
  const a = ev.target.closest?.('a[href^="sound://" i]');
  if (a) resUrl(dicts[+(a.closest('.mdx-body')?.dataset.d || 0)], resKey(a.getAttribute('href').slice(8)));
});

function scrollToAnchor(id) {
  if (!id || id === 'page_top' || id === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const t = shadow.getElementById(id) || shadow.querySelector(`[name="${CSS.escape(id)}"]`);
  if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* select a word in the definition -> look it up */
const selBtn = $('#sel-btn');
let selWord = '';

// Text selected inside the shadow root: Chrome exposes it via toString(), Safari via getComposedRanges().
function selectedText() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return '';
  let s = sel.toString();
  if (!s && sel.getComposedRanges) {
    let sr;
    try { [sr] = sel.getComposedRanges({ shadowRoots: [shadow] }); } catch { try { [sr] = sel.getComposedRanges(shadow); } catch {} }
    if (sr && !sr.collapsed) {
      try {
        const r = document.createRange();
        r.setStart(sr.startContainer, sr.startOffset);
        r.setEnd(sr.endContainer, sr.endOffset);
        s = r.toString();
      } catch {}
    }
  }
  return s;
}

document.addEventListener('selectionchange', () => {
  const s = selectedText().replace(/\s+/g, ' ').trim();
  const ok = view === 'entry' && !searching && s && s.length <= 40 && /^[\p{L}][\p{L}'’\- ]*$/u.test(s) && s.split(' ').length <= 4
    && s.toLowerCase() !== currentWord.toLowerCase();
  selWord = ok ? s : '';
  selBtn.hidden = !ok;
  if (ok) selBtn.textContent = `查词：${s}`;
});
selBtn.addEventListener('click', () => {
  const w = selWord;
  window.getSelection()?.removeAllRanges();
  selBtn.hidden = true;
  if (w) openWord(w);
});

/* ================= history & favourites ================= */

function addHistory(w) {
  const list = store.get('history', []).filter((x) => x !== w);
  list.unshift(w);
  store.set('history', list.slice(0, 300));
}
const favs = () => store.get('fav', []);
function isFav(w) { return favs().includes(w); }
function toggleFav(w) {
  let f = favs();
  if (f.includes(w)) f = f.filter((x) => x !== w); else f.unshift(w);
  store.set('fav', f);
  return f.includes(w);
}
function updateStar() {
  const on = !!currentEntries.length && isFav(currentWord);
  const s = $('#star');
  s.hidden = !currentEntries.length;
  s.setAttribute('aria-pressed', on);
  s.setAttribute('aria-label', on ? '移出生词本' : '加入生词本');
  s.querySelector('path').setAttribute('fill', on ? 'currentColor' : 'none');
}
$('#star').addEventListener('click', () => {
  const on = toggleFav(currentWord);
  updateStar();
  toast(on ? '已加入生词本' : '已移出生词本', 1400);
});

/* ================= views ================= */

let view = 'home';
let navDepth = 0;
let homeTab = 'history';

function setView(v) {
  view = v;
  $('#home').hidden = v !== 'home';
  $('#entry').hidden = v !== 'entry';
  $('#back').hidden = v !== 'entry';
  if (v !== 'entry') selBtn.hidden = true;
}

function rowFor(e) {
  const word = typeof e === 'string' ? e : e.k;
  return h('li', {}, h('button', { class: 'row', onclick: () => openWord(word) }, h('span', { class: 'w' }, word)));
}

function onboarding() {
  const needInstall = isIOS && !isStandalone();
  const box = h('div', { class: 'onboard' },
    h('h2', {}, '欢迎使用'),
    h('p', {}, '把你的 MDict 词典（.mdx + .mdd）导入到手机里，之后完全离线可用：搜索、释义、真人发音。'));
  const steps = h('ol', { class: 'steps' });
  if (needInstall) {
    steps.append(
      h('li', {}, '先把本页添加到主屏幕', h('small', {}, 'Safari 底部「分享」按钮 → 「添加到主屏幕」')),
      h('li', {}, '从主屏幕打开「词典」', h('small', {}, '主屏幕 App 和 Safari 的存储是分开的，在 Safari 里导入的词典主屏幕看不到')));
  }
  steps.append(
    h('li', {}, '导入词典文件', h('small', {}, '在「文件」里找到 iCloud 云盘 › Dic › … › CSSinMDD_Sound，同时选中 .mdx 和 .mdd 两个文件')),
    h('li', {}, '等待复制完成即可查词', h('small', {}, '带发音的 .mdd 约 370 MB，复制需要一两分钟')));
  box.append(steps, h('button', { class: 'btn', onclick: pickFiles }, '导入词典文件'));
  if (needInstall) box.append(h('div', { class: 'note' }, '提示：你现在是在 Safari 浏览器中。建议先添加到主屏幕，再从主屏幕打开后导入。'));
  if (storageError) box.append(h('div', { class: 'note' }, '当前环境无法使用离线存储：' + storageError.message));
  if (loadErrors.length) box.append(h('div', { class: 'note' }, loadErrors.join('；')));
  return box;
}

function renderHome() {
  const home = $('#home');
  if (!dicts.length) { home.replaceChildren(onboarding()); return; }
  const hist = store.get('history', []);
  const fav = favs();
  const seg = h('div', { class: 'seg', role: 'tablist' },
    h('button', { role: 'tab', 'aria-selected': homeTab === 'history', onclick: () => { homeTab = 'history'; renderHome(); } }, '最近查询'),
    h('button', { role: 'tab', 'aria-selected': homeTab === 'fav', onclick: () => { homeTab = 'fav'; renderHome(); } }, `生词本${fav.length ? ' ' + fav.length : ''}`));
  const items = homeTab === 'history' ? hist : fav;
  let body;
  if (!items.length) {
    body = h('div', { class: 'empty' },
      h('div', { class: 'big' }, homeTab === 'history' ? '🔎' : '⭐️'),
      homeTab === 'history' ? '在上方输入单词开始查询' : '查词时点右上角的星标，单词会收藏到这里');
  } else {
    const head = h('div', { class: 'section-h' },
      h('span', {}, homeTab === 'history' ? `共 ${items.length} 条` : `共 ${items.length} 个单词`),
      homeTab === 'history' ? h('button', { onclick: clearHistory }, '清空') : null);
    body = [head, h('ul', { class: 'list' }, items.slice(0, 300).map(rowFor))];
  }
  const total = dicts.reduce((a, d) => a + d.mdx.keys.length, 0);
  home.replaceChildren(seg, ...[body].flat(),
    h('div', { class: 'home-foot' }, `${dicts.map((d) => d.title).join('、')} · ${total.toLocaleString()} 词条`));
}

let clearArmed = 0;
function clearHistory(ev) {
  if (Date.now() - clearArmed > 3000) {
    clearArmed = Date.now();
    ev.target.textContent = '再点一次确认';
    return;
  }
  store.set('history', []);
  renderHome();
}

function showHome() {
  ++renderSeq;
  closeSearch('');
  setView('home');
  renderHome();
}

/* ================= search box ================= */

const q = $('#q');
const suggestBox = $('#suggest');
let searching = false;

function measureBar() {
  document.documentElement.style.setProperty('--barh', $('#bar').getBoundingClientRect().bottom + 'px');
}
addEventListener('resize', measureBar);

function openSearch() {
  if (!searching) {
    searching = true;
    $('#cancel').hidden = false;
    $('#settings-btn').hidden = true;
    $('#back').hidden = true;
    measureBar();
  }
  renderSuggest();
}

function closeSearch(value) {
  searching = false;
  q.value = value;
  $('#clear').hidden = !value;
  $('#cancel').hidden = true;
  $('#settings-btn').hidden = false;
  $('#back').hidden = view !== 'entry';
  suggestBox.hidden = true;
  q.blur();
}

let fuzzyTimer;
function renderSuggest() {
  const v = q.value;
  $('#clear').hidden = !v;
  clearTimeout(fuzzyTimer);
  if (!v.trim()) {
    const hist = store.get('history', []).slice(0, 40);
    suggestBox.replaceChildren(...(hist.length
      ? [h('div', { class: 'section-h' }, h('span', {}, '最近查询')), h('ul', { class: 'list' }, hist.map(rowFor))]
      : [h('div', { class: 'empty' }, dicts.length ? '输入英文单词或短语' : '请先导入词典')]));
    suggestBox.hidden = false;
    return;
  }
  const items = suggest(v);
  const lv = v.trim().toLowerCase();
  const rows = items.map((e) => {
    const k = e.k;
    const w = h('span', { class: 'w' });
    if (k.toLowerCase().startsWith(lv)) w.append(h('b', {}, k.slice(0, lv.length)), k.slice(lv.length));
    else w.append(k);
    return h('li', {}, h('button', { class: 'row', onclick: () => openWord(k) }, w));
  });
  const parts = [];
  if (!items.length) {
    const lem = lemmaCandidates(v).map((c) => findEntries(c)[0]).find(Boolean);
    if (lem) parts.push(h('div', { class: 'hint' }, `“${v.trim()}” 的原形：`), h('ul', { class: 'list' }, rowFor(lem)));
    const slot = h('div');
    parts.push(slot);
    fuzzyTimer = setTimeout(() => {
      const f = fuzzy(v).filter((e) => !lem || e.k !== lem.k);
      slot.replaceChildren(...(f.length
        ? [h('div', { class: 'hint' }, '你是不是要找：'), h('ul', { class: 'list' }, f.map(rowFor))]
        : lem ? [] : [h('div', { class: 'empty' }, /[\u3400-\u9fff]/.test(v) ? '暂不支持中文反查' : '没有匹配的词条')]));
    }, 180);
  } else {
    parts.push(h('ul', { class: 'list' }, rows));
  }
  suggestBox.replaceChildren(...parts);
  suggestBox.hidden = false;
  suggestBox.scrollTop = 0;
}

q.addEventListener('focus', () => {
  openSearch();
  // re-tapping the box on an entry selects the word so typing replaces it
  if (view === 'entry' && q.value && q.value === currentWord) setTimeout(() => q.setSelectionRange(0, q.value.length), 0);
});
q.addEventListener('input', () => { if (!searching) openSearch(); else renderSuggest(); });
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = q.value.trim();
  if (!v) return;
  const top = suggest(v, 1)[0];
  openWord(top && top.n === normKey(v) ? top.k : v);
});
$('#clear').addEventListener('click', () => { q.value = ''; q.focus(); openSearch(); });
$('#cancel').addEventListener('click', () => closeSearch(view === 'entry' ? currentWord : ''));
$('#back').addEventListener('click', () => {
  if (navDepth > 0) history.back();
  else { history.replaceState({ depth: 0 }, '', location.pathname + location.search); showHome(); }
});
addEventListener('popstate', (e) => {
  const st = e.state || {};
  navDepth = st.depth || 0;
  if (st.w) openWord(st.w, { push: false });
  else showHome();
});

/* ================= import ================= */

const fileInput = $('#file');
function pickFiles() { fileInput.click(); }
fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (files.length) importFiles(files);
});

function setProgress(name, done, total) {
  $('#p-file').textContent = name;
  $('#p-bar').style.width = (total ? (done / total) * 100 : 0).toFixed(1) + '%';
  $('#p-num').textContent = `${mb(done)} / ${mb(total)}`;
}

async function importFiles(list) {
  const files = list.filter((f) => KEEP_EXT.test(f.name));
  if (!files.length) { toast('请选择 .mdx / .mdd 词典文件', 3000); return; }
  if (files.length < list.length) toast(`已忽略 ${list.length - files.length} 个不支持的文件`);
  const total = files.reduce((a, f) => a + f.size, 0);
  try {
    const est = await navigator.storage.estimate();
    if (est.quota && est.quota - (est.usage || 0) < total) toast(`存储空间可能不足：需要 ${mb(total)}`, 4000);
  } catch {}
  try { await navigator.storage.persist?.(); } catch {}
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  $('#p-title').textContent = '正在导入词典';
  $('#progress').hidden = false;
  let done = 0;
  try {
    const dir = await dictDir();
    for (const f of files) {
      setProgress(f.name, done, total);
      await saveFile(dir, f, (n) => setProgress(f.name, done + n, total));
      done += f.size;
    }
    $('#p-title').textContent = '正在建立索引…';
    await loadDicts();
    const hasMdx = dicts.length > 0;
    toast(hasMdx ? `导入完成：${dicts.map((d) => d.title).join('、')}` : '已导入，还需要 .mdx 文件', 3000);
  } catch (e) {
    console.error(e);
    toast('导入失败：' + e.message, 5000);
    await loadDicts();
  } finally {
    $('#progress').hidden = true;
    try { await lock?.release(); } catch {}
  }
  if (!$('#sheet').hidden) renderSettings();
  if (view === 'home') renderHome();
}

async function deleteFiles(names) {
  const dir = await dictDir();
  for (const n of names) { try { await dir.removeEntry(n); } catch (e) { console.warn(e); } }
  await loadDicts();
  renderSettings();
  if (!dicts.length) showHome(); else if (view === 'home') renderHome();
}

/* ================= settings ================= */

function armedButton(label, confirmLabel, action) {
  let armed = 0;
  const b = h('button', { class: 'danger' }, label);
  b.addEventListener('click', () => {
    if (Date.now() - armed < 3000) { action(); return; }
    armed = Date.now();
    b.textContent = confirmLabel;
    setTimeout(() => { if (b.isConnected) b.textContent = label; }, 3000);
  });
  return b;
}

async function renderSettings() {
  const sheet = $('#sheet');
  const close = () => { sheet.hidden = true; if (view === 'home') renderHome(); };
  const dictItems = dicts.map((d) => h('div', { class: 'item' },
    h('div', { class: 'grow' },
      h('div', { class: 't' }, d.title),
      h('div', { class: 's' }, `${d.mdx.keys.length.toLocaleString()} 词条 · ${mb(d.bytes)} · ${d.mdds.length ? (d.mdds.some((m) => m.keys.some((k) => /\.mp3$/i.test(k))) ? '含发音' : '含资源') : '无 .mdd（无发音和样式）'}`),
      h('div', { class: 's' }, d.files.join('、'))),
    armedButton('删除', '确认删除', () => deleteFiles(d.files))));
  const otherItems = otherFiles.map((f) => h('div', { class: 'item' },
    h('div', { class: 'grow' }, h('div', { class: 't' }, f.name), h('div', { class: 's' }, `${mb(f.size)} · ${f.bad ? '文件不完整或已损坏，请删除后重新导入' : /\.mdd$/i.test(f.name) ? '没有同名 .mdx，未使用' : '附加资源'}`)),
    armedButton('删除', '确认删除', () => deleteFiles([f.name]))));

  const zoom = h('input', { type: 'range', min: '0.8', max: '1.6', step: '0.05', value: prefs.zoom, 'aria-label': '正文字号' });
  const zoomLabel = h('span', { class: 's' }, Math.round(prefs.zoom * 100) + '%');
  zoom.addEventListener('input', () => { setPref('zoom', +zoom.value); zoomLabel.textContent = Math.round(prefs.zoom * 100) + '%'; applyContentPrefs(); });
  const select = (key, options) => {
    const s = h('select', {}, options.map(([v, t]) => h('option', { value: v, selected: prefs[key] === v }, t)));
    s.addEventListener('change', () => { setPref(key, s.value); applyContentPrefs(); });
    return s;
  };

  let usage = '';
  try {
    const est = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    usage = `已用 ${mb(est.usage || 0)}${persisted ? ' · 已设为持久存储' : ''}`;
  } catch {}

  sheet.replaceChildren(
    h('div', { class: 'sheet-bar' }, h('span', { style: 'width:44px' }), h('h2', {}, '设置'), h('button', { class: 'text-btn', style: 'font-weight:600', onclick: close }, '完成')),
    h('div', { class: 'section-h' }, h('span', {}, '词典')),
    h('div', { class: 'group' },
      ...(dictItems.length ? dictItems : [h('div', { class: 'item' }, h('div', { class: 'grow s' }, '还没有导入词典'))]),
      h('div', { class: 'item' }, h('button', { class: 'link', onclick: pickFiles }, '＋ 导入词典文件…'))),
    h('p', { class: 'foot' }, '同时选择同名的 .mdx 和 .mdd（发音、图片、样式都在 .mdd 里）。推荐 ', h('code', {}, 'CSSinMDD_Sound'), ' 文件夹里的两个文件；不需要发音可以选 ', h('code', {}, 'CSSinMDD_NoSound'), '（只有 120 MB）。'),
    ...(loadErrors.length ? [h('p', { class: 'foot', style: 'color:var(--danger)' }, loadErrors.join('；'))] : []),
    ...(otherItems.length ? [h('div', { class: 'section-h' }, h('span', {}, '其他文件')), h('div', { class: 'group' }, otherItems)] : []),
    h('div', { class: 'section-h' }, h('span', {}, '阅读')),
    h('div', { class: 'group' },
      h('div', { class: 'item' }, h('div', { class: 'grow t' }, '正文字号'), zoomLabel, zoom),
      h('div', { class: 'item' }, h('div', { class: 'grow t' }, '打开词条时自动发音'), select('autoplay', [['off', '关闭'], ['uk', '英音'], ['us', '美音']])),
      h('div', { class: 'item' }, h('div', { class: 'grow t' }, '深色模式下正文'), select('darkContent', [['auto', '跟随系统变暗'], ['off', '保持白底']]))),
    h('p', { class: 'foot' }, '牛津/朗文/柯林斯的页签会记住你上次选择的那一个。在释义里选中一个单词，可以点底部按钮直接查它。'),
    h('div', { class: 'section-h' }, h('span', {}, '存储')),
    h('div', { class: 'group' }, h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', { class: 't' }, '本机存储'), h('div', { class: 's' }, usage || '—')))),
    h('p', { class: 'foot' }, `词典只保存在这台设备上，不会上传到任何地方。版本 ${VERSION}`),
  );
  sheet.hidden = false;
}
$('#settings-btn').addEventListener('click', renderSettings);

/* ================= start ================= */

(async function init() {
  applyContentPrefs();
  measureBar();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!navigator.storage?.getDirectory || typeof DecompressionStream === 'undefined') {
    storageError = new Error('需要 iOS 16.4 或更新版本的 Safari');
    $('#home').replaceChildren(onboarding());
    return;
  }
  const t0 = performance.now();
  await loadDicts();
  console.log(`loaded ${dicts.length} dictionaries, ${index.length} keys in ${Math.round(performance.now() - t0)} ms`);
  const start = (() => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } })();
  history.replaceState({ depth: 0 }, '', location.pathname + location.search);
  setView('home');
  renderHome();
  if (start && dicts.length) openWord(start);
})();
