/**
 * Turns PDF.js text items into speakable chunks while remembering which
 * text items (and therefore which on-screen spans) each chunk covers.
 */

export interface PdfTextItemLike {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
}

export interface Segment {
  /** Text to speak */
  text: string;
  /** Character range inside PageText.text */
  start: number;
  end: number;
  /** Indices of the text items covered (inclusive), -1 when none */
  firstItem: number;
  lastItem: number;
}

export interface PageText {
  pageNumber: number;
  text: string;
  /** Character range of every text item inside `text` */
  itemRanges: Array<[number, number]>;
  /** Original string of every text item (used to match items to on-screen spans) */
  itemStrs: string[];
  segments: Segment[];
}

/** Longer chunks get split: some browser voices cut out on very long utterances */
export const MAX_CHUNK = 240;
const MIN_CHUNK = 14;

function fontHeight(item: PdfTextItemLike): number {
  const t = item.transform;
  if (!t || t.length < 4) return 10;
  return Math.hypot(t[2], t[3]) || 10;
}

function needsSpace(prev: PdfTextItemLike, cur: PdfTextItemLike): boolean {
  const pt = prev.transform;
  const ct = cur.transform;
  if (!pt || !ct || pt.length < 6 || ct.length < 6) return true;
  const h = Math.max(fontHeight(prev), fontHeight(cur));
  // Different line
  if (Math.abs(ct[5] - pt[5]) > h * 0.5) return true;
  // Same line: a visible horizontal gap means a word break
  const prevEnd = pt[4] + (prev.width ?? 0);
  return ct[4] - prevEnd > h * 0.15;
}

/** Join PDF text items into one string, keeping each item's character range. */
export function joinItems(items: PdfTextItemLike[]): { text: string; itemRanges: Array<[number, number]> } {
  let text = '';
  const itemRanges: Array<[number, number]> = [];
  let pendingBreak = false; // previous item ended a line
  let joinNext = false; // previous item ended with a dehyphenated word

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let s = item.str ?? '';

    if (i > 0 && text.length > 0 && !/\s$/.test(text) && !/^\s/.test(s) && s.length > 0) {
      if (joinNext) {
        // "exam-" + "ple" -> "example"
      } else if (pendingBreak || needsSpace(items[i - 1], item)) {
        text += ' ';
      }
    }

    joinNext = false;
    const next = items[i + 1];
    if (item.hasEOL && /\p{Ll}-$/u.test(s) && next && /^\p{Ll}/u.test(next.str ?? '')) {
      s = s.slice(0, -1);
      joinNext = true;
    }

    const start = text.length;
    text += s;
    itemRanges.push([start, text.length]);
    pendingBreak = !!item.hasEOL && !joinNext;
  }

  return { text, itemRanges };
}

interface RawPiece {
  start: number;
  end: number;
}

function sentencePieces(text: string, lang?: string): RawPiece[] {
  const pieces: RawPiece[] = [];
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<{ segment: string; index: number }> } }).Segmenter;
  if (Seg) {
    try {
      const segmenter = new Seg(lang || undefined, { granularity: 'sentence' });
      for (const s of segmenter.segment(text)) {
        pieces.push({ start: s.index, end: s.index + s.segment.length });
      }
      return pieces;
    } catch {
      pieces.length = 0;
    }
  }
  // Fallback: split after sentence punctuation followed by whitespace
  const re = /[.!?…。！？]+["'”’)\]]*\s+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    pieces.push({ start: last, end: m.index + m[0].length });
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ start: last, end: text.length });
  return pieces;
}

/** Trim a range so it starts and ends on non-whitespace */
function trimRange(text: string, r: RawPiece): RawPiece {
  let { start, end } = r;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

/** Split a long range at commas/semicolons, or at spaces, so no chunk passes `max` */
function splitLong(text: string, r: RawPiece, max: number): RawPiece[] {
  const out: RawPiece[] = [];
  let { start } = r;
  const { end } = r;
  while (end - start > max) {
    const window = text.slice(start, start + max);
    let cut = -1;
    const punct = /[,;:\u2013\u2014)]\s/g;
    let m: RegExpExecArray | null;
    while ((m = punct.exec(window))) {
      if (m.index > max * 0.4) cut = m.index + 1;
    }
    if (cut < 0) {
      const sp = window.lastIndexOf(' ');
      cut = sp > max * 0.4 ? sp : max;
    }
    out.push(trimRange(text, { start, end: start + cut }));
    start += cut;
  }
  out.push(trimRange(text, { start, end }));
  return out.filter((p) => p.end > p.start);
}

function itemsInRange(itemRanges: Array<[number, number]>, start: number, end: number): [number, number] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < itemRanges.length; i++) {
    const [s, e] = itemRanges[i];
    if (e <= s) continue;
    if (e > start && s < end) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return [first, last];
}

/** Build speakable segments for one page of text items. */
export function buildPageText(
  pageNumber: number,
  items: PdfTextItemLike[],
  lang?: string,
  max = MAX_CHUNK
): PageText {
  const { text, itemRanges } = joinItems(items);

  // 1. sentences, trimmed, empty ones dropped
  let pieces = sentencePieces(text, lang)
    .map((p) => trimRange(text, p))
    .filter((p) => p.end > p.start && /[\p{L}\p{N}]/u.test(text.slice(p.start, p.end)));

  // 2. merge tiny fragments ("Fig.", "1.", "e.g.") into the next sentence
  const merged: RawPiece[] = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    if (prev && prev.end - prev.start < MIN_CHUNK && p.end - prev.start <= max) {
      prev.end = p.end;
    } else {
      merged.push({ ...p });
    }
  }
  pieces = merged;

  // 3. split anything too long
  const finalPieces = pieces.flatMap((p) => splitLong(text, p, max));

  const segments: Segment[] = finalPieces.map((p) => {
    const [firstItem, lastItem] = itemsInRange(itemRanges, p.start, p.end);
    return {
      text: text.slice(p.start, p.end).replace(/\s+/g, ' '),
      start: p.start,
      end: p.end,
      firstItem,
      lastItem,
    };
  });

  return { pageNumber, text, itemRanges, itemStrs: items.map((it) => it.str ?? ''), segments };
}

/** Segment index that contains the given text item, or the nearest one after it */
export function segmentForItem(page: PageText, itemIndex: number): number {
  const range = page.itemRanges[itemIndex];
  if (!range) return 0;
  const pos = range[0];
  for (let i = 0; i < page.segments.length; i++) {
    if (page.segments[i].end > pos) return i;
  }
  return Math.max(0, page.segments.length - 1);
}

/**
 * Match text items to the viewer's text layer spans.
 *
 * PDF.js does not always create a span for every item (empty strings are
 * skipped in recent versions), so items are matched by their text in order.
 * Returns, for every item index, its span index or -1. Returns null when the
 * two lists clearly describe different text.
 */
export function alignItemsToSpans(itemStrs: string[], spanTexts: string[]): number[] | null {
  const map = new Array<number>(itemStrs.length).fill(-1);
  let j = 0;
  let matched = 0;
  let wanted = 0;
  for (let i = 0; i < itemStrs.length; i++) {
    const str = itemStrs[i];
    if (str === '') {
      // An empty item may or may not have an (empty) span
      if (j < spanTexts.length && spanTexts[j] === '') j++;
      continue;
    }
    wanted++;
    // Skip stray empty spans
    while (j < spanTexts.length && spanTexts[j] === '' ) j++;
    if (j >= spanTexts.length) break;
    if (spanTexts[j] === str || spanTexts[j].normalize('NFKC') === str.normalize('NFKC')) {
      map[i] = j++;
      matched++;
      continue;
    }
    // Look a few spans ahead in case the viewer split or dropped something
    let found = -1;
    for (let k = j + 1; k < Math.min(spanTexts.length, j + 6); k++) {
      if (spanTexts[k] === str) {
        found = k;
        break;
      }
    }
    if (found >= 0) {
      map[i] = found;
      j = found + 1;
      matched++;
    }
  }
  if (wanted === 0) return map;
  return matched / wanted >= 0.8 ? map : null;
}
