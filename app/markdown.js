// Output shaping, ported from ocr-Wrapper: stitch paragraphs across page
// boundaries so a sentence cut by a page break reads continuously, detect
// RTL output, and lightly tidy Persian OCR text (glyphs, digits, half-spaces).

const TERMINAL_PUNCT = ['.', '!', '؟', '…', ':'];
const TRAILING_WRAPPERS = ['"', "'", '»', ')', '”', '’'];

export function looksLikeParagraphEnd(text) {
  text = text.trimEnd();
  while (text && TRAILING_WRAPPERS.includes(text.at(-1))) text = text.slice(0, -1);
  return !!text && TERMINAL_PUNCT.includes(text.at(-1));
}

/**
 * Turn per-page text into a flat paragraph list, merging any paragraph that a
 * page boundary cut mid-sentence. Returns the paragraph array.
 */
export function mergePages(texts) {
  const paragraphs = [];
  for (const text of texts) {
    if (!text) continue;
    if (text.startsWith('[ERROR')) {
      paragraphs.push(text);
      continue;
    }
    const pageParas = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (!pageParas.length) continue;
    const last = paragraphs.at(-1);
    if (last && !last.startsWith('[ERROR') && !looksLikeParagraphEnd(last)) {
      paragraphs[paragraphs.length - 1] = last.trimEnd() + ' ' + pageParas[0];
      pageParas.shift();
    }
    paragraphs.push(...pageParas);
  }
  return paragraphs;
}

const RTL_RANGES = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;

/** Fraction of Arabic/Hebrew script letters in a text sample (0–1). */
export function rtlRatio(text) {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (!letters.length) return 0;
  const rtl = letters.match(RTL_RANGES)?.length || 0;
  return rtl / letters.length;
}

/**
 * Attach common Persian prefixes/suffixes with ZWNJ and unify Arabic glyphs
 * and digits — the browser-side stand-in for ocr-Wrapper's hazm pass.
 */
export function normalizePersian(text) {
  let t = text;
  t = t.replaceAll('ي', 'ی').replaceAll('ك', 'ک').replaceAll('ﻻ', 'لا');
  t = t.replace(/[٠-٩]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d.charCodeAt(0) - 0x0660]);
  const letter = '\u0621-\u064A\u0660-\u066F\u0670-\u06D3\u06FA-\u06FF';
  // "می رود" / "نمی رود" -> ZWNJ-joined prefix
  t = t.replace(new RegExp(`(^|[\\s()«"'\\[>])((?:ن)?می) (?=[${letter}])`, 'gu'),
    (_, pre, word) => pre + word + '\u200C');
  // "کتاب ها" / "کتاب های" / "کتاب هایی" -> ZWNJ-joined suffix
  t = t.replace(new RegExp(`([${letter}]) (ها|های|هایی|هایی)(?=$|[\\s\\n.,؛،:!?»"')\\]])`, 'gu'),
    (_, word, suf) => word + '\u200C' + suf);
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t;
}

/** Assemble the final markdown document from per-page texts. */
export function pagesToMarkdown(pageTexts, { rtl = false, normalize = false } = {}) {
  let paragraphs = mergePages(pageTexts);
  if (normalize) paragraphs = paragraphs.map(normalizePersian);
  const body = paragraphs.join('\n\n').trim() + '\n';
  return rtl ? `<div dir="rtl">\n\n${body}</div>\n` : body;
}
