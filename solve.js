// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers as the reference, byte for byte, produced faster:
//  - Markdown rendered in one pass over the source lines (no token array),
//    inline markup scanned with native indexOf for the next special char and
//    whole plain runs escaped in one native replace (the reference escapes
//    every character one by one, which profiled as ~1/3 of its time).
//  - Templates compiled once per case to plain JS functions (new Function)
//    with includes inlined up to the depth cap, so rendering is straight-line
//    code: no tree walk, no scope-chain lookup per variable.
//  - Slugs cached per case (titles/tags/headings repeat heavily) with a
//    fused ASCII fast path that skips NFKD normalisation.
//  - One line split per source, shared by front matter, word count and
//    Markdown; cards/pages built once and reused, never recomputed.
//
// Nothing is cached from one case to the next: every per-case structure
// (slug cache, parsed templates, compiled renderers) is created inside run().

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const INCLUDE_DEPTH = 8;
const HOP = Object.prototype.hasOwnProperty;

/* ---------------------------------------------------------------- text */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/; // no /g: test() never touches lastIndex.
/** `text` with & < > " and ' escaped. Most inputs hold none of them. */
function esc(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESC_MAP[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const MARK_RE = /\p{M}/gu;
let slugCache = null; // fresh Map per run()
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifySlow(text);
  slugCache.set(text, out);
  return out;
}
function slugifySlow(text) {
  let out = '';
  let gap = false;
  // Pure ASCII: NFKD is the identity and there are no combining marks, so the
  // normalise + mark-strip pass can be skipped entirely. One pass: a non-ASCII
  // character restarts on the slow path.
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (text.charCodeAt(k) > 127) return slugifyUnicode(text);
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}
function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}
/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  if (rel.indexOf('.') === -1 && rel.indexOf('//') === -1 && rel.charCodeAt(rel.length - 1) !== 47) {
    // No '.' or '..' steps, no empty segments and no trailing slash: plain concatenation.
    return dir === '' ? rel : dir + '/' + rel;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/* ------------------------------------------------------------ front matter */

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const BLANK_RE = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Front matter of `lines` ({ data, close }) or { error }; body starts at close+1. */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (BLANK_RE.test(line) || line.startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

/* --------------------------------------------------------------- markdown */

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether char code `c` is JS whitespace (\s). */
function isWSCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
const WS8 = new Uint8Array(256);
for (const c of [9, 10, 11, 12, 13, 32, 160]) WS8[c] = 1;
/** Words of lines[start..]: runs of non-whitespace, counted without joining. */
function countWords(lines, start) {
  let n = 0;
  for (let li = start; li < lines.length; li++) {
    const line = lines[li];
    let inW = false;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      const ws = c < 256 ? WS8[c] : isWSCode(c);
      if (ws) inW = false;
      else if (!inW) { inW = true; n++; }
    }
  }
  return n;
}

function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}
/** Fence open: language or '' (no language), null when not a fence line. */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let k = 3;
  let lang = '';
  while (k < line.length) {
    const c = line[k];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') { lang += c; k++; }
    else break;
  }
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  return k === line.length ? lang : null;
}
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let k = 3; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}
/** { depth, text } or null. */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line[k] === '#') k++;
  if (k === 0 || k > 6) return null;
  if (k >= line.length || (line[k] !== ' ' && line[k] !== '\t')) return null;
  let end = line.length;
  while (end > k && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  let st = k;
  while (st < end && (line[st] === ' ' || line[st] === '\t')) st++;
  if (st >= end) return null;
  return { depth: k, text: line.slice(st, end) };
}
function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line[0];
  if (c0 !== '-' && c0 !== '*') return false;
  if (line[1] !== c0 || line[2] !== c0) return false;
  for (let k = 3; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line[0];
  if (c0 === ' ' || c0 === '\t') return isBlank(line);
  if (c0 === '`') return fenceOpen(line) !== null;
  if (c0 === '#') return headingOf(line) !== null;
  if (c0 === '-' || c0 === '*') return isHr(line);
  return false;
}
/** { text } or null for a bullet item line. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return { text: line.slice(2) };
  return null;
}
/** { num, text } or null for an ordered item line. */
function orderedOf(line) {
  let k = 0;
  while (k < line.length && line[k] >= '0' && line[k] <= '9') k++;
  if (k === 0 || k > 9) return null;
  if (line[k] !== '.' || line[k + 1] !== ' ') return null;
  return { num: Number(line.slice(0, k)), text: line.slice(k + 2) };
}
function isContinued(line) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  return k >= 2 && k < line.length && !isWSCode(line.charCodeAt(k));
}

/** Whether s[j] is escaped: the maximal run of backslashes just before it has
 * odd length (the reference scan enters such a run at its start and skips it
 * in pairs, so parity decides exactly). */
function isEscaped(s, j) {
  let k = j - 1;
  let c = 0;
  while (k >= 0 && s[k] === '\\') { c++; k--; }
  return (c & 1) === 1;
}
/** First index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  let j = from;
  for (;;) {
    j = s.indexOf(what, j);
    if (j === -1 || j + what.length > end) return -1;
    if (!isEscaped(s, j)) return j;
    j++;
  }
}
/** First single * in [from, end), one whose run is not **, outside an escape, or -1. */
function findSingleStar(s, from, end) {
  let j = from;
  for (;;) {
    j = s.indexOf('*', j);
    if (j === -1 || j >= end) return -1;
    if (isEscaped(s, j)) { j++; continue; }
    if (j + 1 < end && s[j + 1] === '*') { j += 2; continue; }
    return j;
  }
}

/** A link target's href, resolving relative paths against ctx.dir. */
function resolveLink(ctx, target) {
  if (SCHEME_RE.test(target) || target[0] === '/' || target[0] === '#') return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(ctx.dir, rel);
  if (path !== null && ctx.bySource.has(path)) return ctx.bySource.get(path).url + frag;
  if (path !== null && ctx.staticPaths.has(path)) return ctx.base + '/' + path + frag;
  ctx.broken.add(`broken-link ${ctx.src} -> ${target}`);
  return target;
}

/** `s[a..b)` rendered inline, appended to `out` (an array of string chunks).
 * Bounds-based: inner spans recurse on the same string instead of slicing it,
 * but no scan ever looks past `b`, exactly as the reference's sliced strings. */
function inlineTo(s, a, b, ctx, out) {
  let ps = a;
  let i = a;
  while (i < b) {
    // Next construct: the nearest of \ ` * [ in [i, b) (native scans, no per-char loop).
    let j1 = s.indexOf('\\', i);
    let j2 = s.indexOf('`', i);
    let j3 = s.indexOf('*', i);
    let j4 = s.indexOf('[', i);
    if (j1 === -1 || j1 >= b) j1 = -1;
    if (j2 === -1 || j2 >= b) j2 = -1;
    if (j3 === -1 || j3 >= b) j3 = -1;
    if (j4 === -1 || j4 >= b) j4 = -1;
    let j = -1;
    if (j1 !== -1 && (j === -1 || j1 < j)) j = j1;
    if (j2 !== -1 && (j === -1 || j2 < j)) j = j2;
    if (j3 !== -1 && (j === -1 || j3 < j)) j = j3;
    if (j4 !== -1 && (j === -1 || j4 < j)) j = j4;
    if (j === -1) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < b && ESCAPABLE.has(s[j + 1])) {
        if (j > ps) out.push(esc(s.slice(ps, j)));
        out.push(esc(s[j + 1]));
        i = j + 2;
        ps = i;
      } else i = j + 1;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        if (j > ps) out.push(esc(s.slice(ps, j)));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        ps = i;
      } else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (j + 1 < b && s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k > j + 2) {
          if (j > ps) out.push(esc(s.slice(ps, j)));
          out.push('<strong>');
          inlineTo(s, j + 2, k, ctx, out);
          out.push('</strong>');
          i = k + 2;
          ps = i;
        } else i = j + 2;
      } else {
        const k = findSingleStar(s, j + 1, b);
        if (k > j + 1) {
          if (j > ps) out.push(esc(s.slice(ps, j)));
          out.push('<em>');
          inlineTo(s, j + 1, k, ctx, out);
          out.push('</em>');
          i = k + 1;
          ps = i;
        } else i = j + 1;
      }
      continue;
    }
    // '[': a link, or a literal '['.
    const k = findUnescaped(s, ']', j + 1, b);
    let m = -1;
    if (k !== -1 && k + 1 < b && s[k + 1] === '(') m = s.indexOf(')', k + 2);
    if (m !== -1 && m >= b) m = -1;
    if (m !== -1) {
      const target = s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        if (j > ps) out.push(esc(s.slice(ps, j)));
        out.push('<a href="', esc(resolveLink(ctx, target)), '">');
        inlineTo(s, j + 1, k, ctx, out);
        out.push('</a>');
        i = m + 1;
        ps = i;
        continue;
      }
    }
    i = j + 1;
  }
  if (b > ps) out.push(esc(s.slice(ps, b)));
}

/** A list block starting at lines[i] (first item already classified), rendered into `blocks`. Returns the next line index. */
function renderList(lines, i, n, isOrdered, first, ctx, blocks) {
  const items = [];
  while (i < n) {
    if (isOrdered) {
      const m = orderedOf(lines[i]);
      if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
    } else {
      const m = bulletOf(lines[i]);
      if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
    }
    if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; continue; }
    break;
  }
  const tag = isOrdered ? 'ol' : 'ul';
  blocks.push(isOrdered && first.num !== 1 ? `<ol start="${first.num}">\n` : `<${tag}>\n`);
  for (let it = 0; it < items.length; it++) {
    blocks.push('<li>');
    const text = items[it].join('\n');
    inlineTo(text, 0, text.length, ctx, blocks);
    blocks.push('</li>\n');
  }
  blocks.push(`</${tag}>\n`);
  return i;
}

/** lines[start..] rendered: { html, toc, excerpt }. Single pass, no token array. */
function renderMarkdown(lines, start, ctx) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) { i++; continue; }
    const c0 = line[0];
    if (c0 === ' ' || c0 === '\t') {
      if (isBlank(line)) { i++; continue; }
      // An indented line at block start can only be a paragraph line.
    } else if (c0 === '`') {
      const fence = fenceOpen(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        // Escaping is per character, so one escape of the joined body (plus
        // its trailing newline) equals escaping each line on its own.
        const code = body.length === 0 ? '' : esc(body.join('\n')) + '\n';
        blocks.push(`<pre><code${fence === '' ? '' : ` class="language-${fence}"`}>${code}</code></pre>\n`);
        continue;
      }
    } else if (c0 === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const st = blocks.length;
        blocks.push(`<h${heading.depth} id="${id}">`);
        inlineTo(heading.text, 0, heading.text.length, ctx, blocks);
        const html = blocks.slice(st + 1).join('');
        blocks.push(`</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHr(line)) { blocks.push('<hr>\n'); i++; continue; }
      const bullet = bulletOf(line);
      if (bullet !== null) { i = renderList(lines, i, n, false, bullet, ctx, blocks); continue; }
    } else if (c0 === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const ls = [];
      for (let b = 0; b < body.length; b++) {
        const t = trimLine(body[b]);
        if (t !== '') ls.push(t);
      }
      if (ls.length === 0) blocks.push('<blockquote>\n</blockquote>\n');
      else {
        blocks.push('<blockquote>\n<p>');
        const text = ls.join('\n');
        inlineTo(text, 0, text.length, ctx, blocks);
        blocks.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= '0' && c0 <= '9') {
      const ordered = orderedOf(line);
      if (ordered !== null) { i = renderList(lines, i, n, true, ordered, ctx, blocks); continue; }
    }
    // Paragraph: this line and the lines after it up to a blank line, a fence,
    // a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const st = blocks.length;
    blocks.push('<p>');
    const text = body.join('\n');
    inlineTo(text, 0, text.length, ctx, blocks);
    if (excerpt === null) excerpt = blocks.slice(st + 1).join('');
    blocks.push('</p>\n');
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

/* --------------------------------------------------------------- templates */

class TemplateError extends Error {}
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = BLANK_RE.test(src.slice(lineStart, open)) && BLANK_RE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** Own-property read, or undefined (a path step past a non-object is undefined). */
const hasOwn = Object.hasOwn;
function G(v, k) {
  return v !== null && typeof v === 'object' && hasOwn(v, k) ? v[k] : undefined;
}
/** A value as text. */
function T(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k) s += ', ';
      s += T(v[k]);
    }
    return s;
  }
  return '';
}
let escCache = null; // fresh Map per run(): repeated template values escape once.
/** A value as escaped text (numbers and booleans never hold an escapable). */
function W(v) {
  if (typeof v === 'string') {
    const hit = escCache.get(v);
    if (hit !== undefined) return hit;
    const e = esc(v);
    escCache.set(v, e);
    return e;
  }
  if (typeof v === 'number') return String(v);
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) return esc(T(v));
  return '';
}
/** Whether a value counts as true in an if. */
function Y(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/* Interpreter fallback (used only when a template's compiled form would be
   absurdly large, e.g. cyclic includes expanded to the depth cap). */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !HOP.call(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !HOP.call(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text': out += n.text; break;
      case 'var': out += esc(T(lookup(scope, n.path))); break;
      case 'raw': out += T(lookup(scope, n.path)); break;
      case 'if': {
        const v = Y(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        });
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

/** First path segment resolved against the compile-time scope stack. */
function resolveExpr(path, frames) {
  let base = null;
  for (let k = frames.length - 1; k >= 0; k--) {
    const e = frames[k].get(path[0]);
    if (e !== undefined) { base = e.e; break; }
  }
  if (base === null) base = 'R.' + path[0];
  let expr = base;
  for (let k = 1; k < path.length; k++) expr = 'G(' + expr + ',' + JSON.stringify(path[k]) + ')';
  return expr;
}

/** Root names a path's value derives from, given the bound names (`frames` is an
 * array of Maps name -> { e: JS expression, k: 'elem'|'loop', d: Set of roots },
 * innermost last). */
function resolveDeps(path, frames) {
  for (let k = frames.length - 1; k >= 0; k--) {
    const d = frames[k].get(path[0]);
    if (d !== undefined) return d.d;
  }
  return new Set([path[0]]);
}

/** Free variables of `nodes`, transitively through includes, given `frames`
 * (the includer's bound names; entries marked internal are bound inside the
 * template itself). Returns { roots, ext, extLoop }: root names read, external
 * loop-element variables read (name -> JS expression), and whether an external
 * `loop` object is read. `visiting` holds the templates on the include chain. */
function analyzeFree(nodes, frames, templates, visiting) {
  const roots = new Set();
  const ext = new Map();
  let extLoop = false;
  const ref = (path, fr) => {
    for (let k = fr.length - 1; k >= 0; k--) {
      const f = fr[k].get(path[0]);
      if (f !== undefined) {
        if (!f.internal) {
          if (f.k === 'elem') ext.set(path[0], f.e);
          else extLoop = true;
        }
        return;
      }
    }
    roots.add(path[0]);
  };
  const walk = (ns, fr) => {
    for (const nd of ns) {
      if (nd.kind === 'text') continue;
      if (nd.kind === 'var' || nd.kind === 'raw') ref(nd.path, fr);
      else if (nd.kind === 'if') {
        ref(nd.path, fr);
        walk(nd.then, fr);
        if (nd.else !== null) walk(nd.else, fr);
      } else if (nd.kind === 'for') {
        ref(nd.path, fr);
        const ad = resolveDeps(nd.path, fr);
        const nf = fr.concat([new Map([
          [nd.name, { e: '', k: 'elem', d: ad, internal: true }],
          ['loop', { e: '', k: 'loop', d: ad, internal: true }],
        ])]);
        walk(nd.body, nf);
      } else if (nd.kind === 'include') {
        const child = templates.get(nd.name);
        if (child !== undefined && !visiting.has(nd.name)) {
          const nv = new Set(visiting);
          nv.add(nd.name);
          const sub = analyzeFree(child, fr, templates, nv);
          for (const r of sub.roots) roots.add(r);
          for (const [nm, ex] of sub.ext) ext.set(nm, ex);
          if (sub.extLoop) extLoop = true;
        }
      }
    }
  };
  walk(nodes, frames);
  return { roots, ext, extLoop };
}

const CONST_ROOTS = new Set(['site', 'tags', 'recent']);
function rootsAreConstant(roots) {
  for (const d of roots) if (!CONST_ROOTS.has(d)) return false;
  return true;
}

/** Emit compiled JS for `nodes` into `c`; includes inlined, depth-capped, and
 * includes of case-constant templates folded to a cached render (K) or of
 * single-element templates memoised by that element (J). `frames` is the
 * compile-time scope stack (Maps name -> { e, k, d, internal }). */
function genNodes(nodes, frames, depth, c, templates, uid) {
  for (const nd of nodes) {
    if (nd.kind === 'text') c.push('O.push(' + JSON.stringify(nd.text) + ');');
    else if (nd.kind === 'var') c.push('O.push(W(' + resolveExpr(nd.path, frames) + '));');
    else if (nd.kind === 'raw') c.push('O.push(T(' + resolveExpr(nd.path, frames) + '));');
    else if (nd.kind === 'if') {
      c.push('if(' + (nd.not ? '!' : '') + 'Y(' + resolveExpr(nd.path, frames) + ')){');
      genNodes(nd.then, frames, depth, c, templates, uid);
      c.push('}');
      if (nd.else !== null) {
        c.push('else{');
        genNodes(nd.else, frames, depth, c, templates, uid);
        c.push('}');
      }
    } else if (nd.kind === 'for') {
      const u = ++uid.n;
      const ad = resolveDeps(nd.path, frames);
      c.push('{const _a' + u + '=' + resolveExpr(nd.path, frames) + ';if(Array.isArray(_a' + u + ')){const _n' + u + '=_a' + u + '.length;const _l' + u + '={index:0,first:false,last:false,length:_n' + u + '};for(let _k' + u + '=0;_k' + u + '<_n' + u + ';_k' + u + '++){const _x' + u + '=_a' + u + '[_k' + u + '];_l' + u + '.index=_k' + u + '+1;_l' + u + '.first=_k' + u + '===0;_l' + u + '.last=_k' + u + '===_n' + u + '-1;');
      frames.push(new Map([
        [nd.name, { e: '_x' + u, k: 'elem', d: ad, internal: false }],
        ['loop', { e: '_l' + u, k: 'loop', d: ad, internal: false }],
      ]));
      genNodes(nd.body, frames, depth, c, templates, uid);
      frames.pop();
      c.push('}}}');
    } else if (nd.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const child = templates.get(nd.name);
        if (child !== undefined) {
          const free = analyzeFree(child, frames, templates, new Set([nd.name]));
          if (free.ext.size === 0 && !free.extLoop && rootsAreConstant(free.roots)) {
            c.push('O.push(K(' + JSON.stringify(nd.name) + ',' + (depth + 1) + ',R));');
          } else if (free.ext.size === 1 && !free.extLoop && rootsAreConstant(free.roots)) {
            const [nm, ex] = free.ext.entries().next().value;
            c.push('O.push(J(' + JSON.stringify(nd.name) + ',' + (depth + 1) + ',' + JSON.stringify(nm) + ',' + ex + ',R));');
          } else {
            genNodes(child, frames, depth + 1, c, templates, uid);
          }
        }
      }
    }
  }
}

const COMPILE_CAP = 131072;
/** { fn } | { nodes } (interpret) | null (no such template). `startDepth` is
 * the depth the template itself renders at (0 for a top-level render). */
function compileTop(name, templates, startDepth) {
  const nodes = templates.get(name);
  if (nodes === undefined) return null;
  const c = ['"use strict";const O=[];'];
  genNodes(nodes, [], startDepth, c, templates, { n: 0 });
  c.push('return O.join("");');
  const src = c.join('');
  if (src.length > COMPILE_CAP) return { nodes };
  try {
    return { fn: new Function('R', 'G', 'T', 'W', 'Y', 'K', 'J', src) };
  } catch (e) {
    return { nodes };
  }
}

/* ------------------------------------------------------------------- build */

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

export function run(input) {
  slugCache = new Map();
  escCache = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const renderers = new Map();
  const interpCtx = { templates, escape: esc };
  const renderCompiled = (r, R, depth) => (r === null ? '' : r.fn !== undefined ? r.fn(R, G, T, W, Y, K, J) : renderNodes(r.nodes, { vars: R, parent: null }, interpCtx, depth));
  // Case-constant templates, rendered once per case and reused: K(name, depth, R).
  const constCache = new Map();
  const constRenderers = new Map();
  const K = (name, depth, R) => {
    const key = name + '\n' + depth;
    let s = constCache.get(key);
    if (s !== undefined) return s;
    let r = constRenderers.get(key);
    if (r === undefined) {
      r = compileTop(name, templates, depth);
      constRenderers.set(key, r);
    }
    s = renderCompiled(r, R, depth);
    constCache.set(key, s);
    return s;
  };
  // Single-element templates, memoised by that element: J(name, depth, varName, obj, R).
  const memoCache = new Map();
  const memoRenderers = new Map();
  const J = (name, depth, varName, obj, R) => {
    const key = name + '\n' + depth;
    let m = memoCache.get(key);
    if (m === undefined) {
      m = new Map();
      memoCache.set(key, m);
    }
    let s = m.get(obj);
    if (s !== undefined) return s;
    let r = memoRenderers.get(key);
    if (r === undefined) {
      r = compileTop(name, templates, depth);
      memoRenderers.set(key, r);
    }
    const R2 = Object.create(null);
    R2.site = R.site;
    R2.tags = R.tags;
    R2.recent = R.recent;
    R2[varName] = obj;
    s = renderCompiled(r, R2, depth);
    m.set(obj, s);
    return s;
  };
  const renderTemplate = (name, R) => {
    let r = renderers.get(name);
    if (r === undefined) {
      r = compileTop(name, templates, 0);
      renderers.set(name, r);
    }
    if (r === null) return null;
    if (r.fn !== undefined) return r.fn(R, G, T, W, Y, K, J);
    return renderNodes(r.nodes, { vars: R, parent: null }, interpCtx, 0);
  };
  const mkR = (extra) => {
    const R = Object.create(null);
    R.site = site;
    R.tags = allTags;
    R.recent = recent;
    if (extra !== undefined) Object.assign(R, extra);
    return R;
  };

  // 1. Sources, in code-unit order of path; .md sources, the rest static.
  let files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }
  files = null;

  // 2. Front matter, in order: refused, generator's own dir, post w/o date,
  //    unknown layout, draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.close + 1;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const ctx = { bySource, staticPaths, base, broken, dir: '', src: '' };
  for (const s of sources) {
    ctx.dir = dirOf(s.path);
    ctx.src = s.path;
    const md = renderMarkdown(s.lines, s.bodyStart, ctx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = countWords(s.lines, s.bodyStart);
    s.lines = null;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTagList = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push({ name, slug }); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTagList(p)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTagList(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  // A page is its card plus the page-only fields; the card object itself is
  // reused (lists never read the page-only fields, and the output holds only
  // rendered HTML, so the extra fields are unobservable).
  for (const s of sources) {
    s.card = cardOf(s);
    s.card.slug = s.slug;
    s.card.content = s.html;
    s.card.toc = s.toc;
    s.card.newer = linkOf(s.newer ?? null);
    s.card.older = linkOf(s.older ?? null);
    s.card.is_post = s.post;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) });

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const output = {};
  for (const s of sources) output[`${s.outDir}/index.html`] = renderTemplate(s.layout, mkR({ page: s.card }));
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = renderTemplate('index', mkR({
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    }));
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = renderTemplate('tag', mkR({ tag: tagOf(t) }));
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderTemplate('tags', mkR());
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
