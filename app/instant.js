// Instant engine — the browser analogue of ocr-Wrapper's pdf-inspector:
// read the PDF's own text layer and reassemble it into clean markdown.
// No rendering, no models: headings from font-size clustering, paragraphs
// from baseline gaps and indents, two-column layouts read column by column,
// running headers/footers dropped, paragraphs stitched across page breaks
// by markdown.js.
import { rtlRatio } from './markdown.js';

const PAGE_NO_RE = /^[^\p{L}\d]*[\dIVXLCivxlc]+[^\p{L}\d]*$/u;

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Group a page's text items into visual lines (y desc, x asc within line). */
async function pageLines(page) {
  const tc = await page.getTextContent();
  const styles = tc.styles || {};
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const tr = it.transform;
    const size = Math.hypot(tr[1], tr[3]) || it.height || 10;
    const family = `${styles[it.fontName]?.fontFamily || ''} ${it.fontName || ''}`;
    items.push({
      str: it.str, x: tr[4], y: tr[5], width: it.width || 0, size,
      bold: /bold|black|heavy|semib|[-_]bd\b/i.test(family),
    });
  }
  items.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  let cur = null;
  for (const it of items) {
    const tol = Math.max(1.6, it.size * 0.45);
    const ratio = cur ? it.size / cur.sizeRef : 1;
    if (cur && Math.abs(cur.y - it.y) <= tol && ratio > 0.6 && ratio < 1.7) {
      cur.items.push(it);
    } else {
      cur = { y: it.y, sizeRef: it.size, items: [it] };
      lines.push(cur);
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    for (const it of line.items) {
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        if (gap > it.size * 0.22 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      }
      text += it.str;
      prevEnd = it.x + it.width;
    }
    line.text = text.replace(/\s+/g, ' ').trim();
    line.x = Math.min(...line.items.map((i) => i.x));
    line.xEnd = Math.max(...line.items.map((i) => i.x + i.width));
    line.size = median(line.items.map((i) => i.size));
    line.bold = line.items.filter((i) => i.bold).length > line.items.length / 2;
  }
  return lines.filter((l) => l.text);
}

/** Key for repeated-line detection: digits folded, case-folded, punct stripped. */
function repeatKey(text) {
  return text.replaceAll(/\d+/g, '#').toLowerCase().replace(/[^\p{L}\p{N}#]/gu, '').slice(0, 80);
}

/** Order lines for reading: single column straight down, or column by column. */
function orderLines(lines, pageWidth) {
  const mid = pageWidth / 2;
  const margin = pageWidth * 0.045;
  const isFull = (l) => l.x < mid - margin && l.xEnd > mid + margin;
  const fullCount = lines.filter(isFull).length;
  if (fullCount >= lines.length * 0.7 || lines.length < 4) {
    for (const l of lines) l.colBreak = false;
    return lines;
  }
  const out = [];
  let leftBuf = [];
  let rightBuf = [];
  const flush = (afterFull = false) => {
    if (leftBuf.length && rightBuf.length) {
      leftBuf.at(-1).colBreak = true; // column switch reads as a break
      out.push(...leftBuf, ...rightBuf);
    } else {
      out.push(...leftBuf, ...rightBuf);
    }
    if (afterFull && out.length) out.at(-1).colBreak = true;
    leftBuf = [];
    rightBuf = [];
  };
  for (const l of lines) {
    l.colBreak = false;
    if (isFull(l)) { flush(true); out.push(l); }
    else if (l.x < mid) leftBuf.push(l);
    else rightBuf.push(l);
  }
  flush();
  return out;
}

/** Turn one page's ordered lines into markdown blocks. */
function structurePage(lines, pageWidth, bodySize, dropKeys) {
  const ordered = orderLines(lines, pageWidth);
  const gapRef = median(ordered.map((l) => l.size)) || bodySize;
  const blocks = [];
  let para = null; // {lines: [], isBullet, isHeading}
  let prev = null;

  const flush = () => {
    if (!para) return;
    const text = para.lines.map((l) => l.text).reduce((acc, t, i) => {
      if (i === 0) return t;
      if (/[A-Za-z\u0600-\u06FF]-$/.test(acc) && /^[a-z\u0600-\u06FF]/.test(t)) {
        return acc.slice(0, -1) + t; // dehyphenate
      }
      return `${acc} ${t}`;
    }, '').trim();
    if (text) blocks.push(para.render(text));
    para = null;
  };

  for (const line of ordered) {
    if (dropKeys.has(repeatKey(line.text)) || PAGE_NO_RE.test(line.text)) continue;

    const ratio = line.size / (bodySize || line.size);
    const text = line.text;
    let level = 0;
    if (ratio >= 1.45 && text.length <= 90) level = 1;
    else if (ratio >= 1.22 && text.length <= 90) level = 2;
    else if (ratio >= 1.06 && line.bold && text.length <= 90) level = 3;

    const bullet = text.match(/^[•●▪‣◦·–—*]\s+(.{2,})/);
    const numbered = text.match(/^(\d{1,3})[.)]\s+(.{2,})/);

    const startsNew = !para
      || line.colBreak
      || level
      || bullet || numbered
      || para.isBullet || para.isHeading
      || (prev && (prev.y - line.y) > gapRef * 1.65)
      || (para.lines.length && (line.x - para.lines[0].x) > gapRef * 0.8);

    if (startsNew) flush();

    if (level) {
      blocks.push({ type: 'h', level, text });
    } else if (bullet) {
      const item = bullet[1];
      para = { lines: [{ text: item, x: line.x, y: line.y }], isBullet: true,
        render: (t) => ({ type: 'li', text: t }) };
    } else if (numbered) {
      para = { lines: [{ text: `${numbered[1]}. ${numbered[2]}`, x: line.x, y: line.y }],
        isBullet: true, render: (t) => ({ type: 'li', text: t, ordered: true }) };
    } else {
      para ??= { lines: [], render: (t) => ({ type: 'p', text: t }) };
      para.lines.push(line);
    }
    prev = line;
  }
  flush();

  // Render blocks to markdown, merging consecutive list items and same-level
  // headings (a title wrapped over two lines must not become two H1s).
  const out = [];
  let list = null;
  const flushList = () => { if (list) { out.push(list.items.join('\n')); list = null; } };
  for (const b of blocks) {
    if (b.type === 'h') {
      flushList();
      const prevHeading = out.at(-1);
      if (prevHeading?.startsWith('#'.repeat(b.level) + ' ')) {
        out[out.length - 1] = `${prevHeading} ${b.text}`;
      } else {
        out.push(`${'#'.repeat(b.level)} ${b.text}`);
      }
    } else if (b.type === 'li') {
      const ordered = b.ordered ?? false;
      if (!list || (list.items.length && list.ordered !== ordered)) {
        flushList();
        list = { items: [], ordered };
      }
      list.items.push(ordered ? b.text : `- ${b.text}`);
    } else { flushList(); out.push(b.text); }
  }
  flushList();
  return out.join('\n\n');
}

/**
 * Extract a text-based PDF to per-page markdown.
 * Returns { pageTexts, rtl } — final assembly happens in markdown.js.
 */
export async function runInstant(doc, pageNumbers, _opts, cb = {}) {
  const pages = [];
  const allSizes = [];
  const edgeLines = { first: [], last: [] };

  for (const n of pageNumbers) {
    if (cb.shouldStop?.()) break;
    const page = await doc.getPage(n);
    const lines = await pageLines(page);
    pages.push({ n, lines, width: page.view[2] });
    lines.forEach((l) => allSizes.push(l.size));
    if (lines.length) { edgeLines.first.push(repeatKey(lines[0].text)); edgeLines.last.push(repeatKey(lines.at(-1).text)); }
    cb.onPage?.(n);
    page.cleanup();
  }

  const bodySize = median(allSizes) || 10;
  const dropKeys = new Set();
  const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
  for (const key of [...edgeLines.first, ...edgeLines.last]) {
    if (!key) continue;
    const hits = edgeLines.first.filter((k) => k === key).length
      + edgeLines.last.filter((k) => k === key).length;
    if (hits >= threshold) dropKeys.add(key);
  }

  const pageTexts = pages.map(({ lines, width }) => structurePage(lines, width, bodySize, dropKeys));
  const rtl = rtlRatio(pageTexts.join(' ')) > 0.3;
  return { pageTexts, rtl };
}
