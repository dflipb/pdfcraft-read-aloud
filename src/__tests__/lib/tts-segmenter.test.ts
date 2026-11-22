import { describe, it, expect } from 'vitest';
import { buildPageText, joinItems, segmentForItem } from '@/lib/tts/segmenter';

const line = (str: string, x: number, y: number, width: number, hasEOL = false) => ({
  str, hasEOL, width, transform: [10, 0, 0, 10, x, y],
});

describe('joinItems', () => {
  it('adds spaces between lines and gaps, joins hyphenated words', () => {
    const { text, itemRanges } = joinItems([
      line('This is an exam-', 0, 700, 80, true),
      line('ple of text.', 0, 688, 60, false),
      line('Next', 70, 688, 20, false),
    ]);
    expect(text).toBe('This is an example of text. Next');
    expect(text.slice(...itemRanges[1])).toBe('ple of text.');
  });

  it('does not add a space between glyph runs that touch', () => {
    const { text } = joinItems([line('Hel', 0, 700, 15), line('lo', 15, 700, 10)]);
    expect(text).toBe('Hello');
  });
});

describe('buildPageText', () => {
  it('splits sentences and maps them to items', () => {
    const page = buildPageText(1, [
      line('First sentence here. Second', 0, 700, 140, true),
      line('sentence continues here.', 0, 688, 120, true),
      line('Third one!', 0, 676, 50),
    ], 'en');
    expect(page.segments.map((s) => s.text)).toEqual([
      'First sentence here.',
      'Second sentence continues here.',
      'Third one!',
    ]);
    expect(page.segments[1].firstItem).toBe(0);
    expect(page.segments[1].lastItem).toBe(1);
    expect(page.segments[2].firstItem).toBe(2);
    expect(segmentForItem(page, 2)).toBe(2);
  });

  it('splits very long sentences under the limit', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + ', ' + Array.from({ length: 30 }, (_, i) => `more${i}`).join(' ') + '.';
    const page = buildPageText(1, [line(long, 0, 700, 1000)], 'en', 240);
    expect(page.segments.length).toBeGreaterThan(1);
    for (const s of page.segments) expect(s.text.length).toBeLessThanOrEqual(240);
    expect(page.segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ')).toBe(long);
  });

  it('skips pages with no readable text', () => {
    const page = buildPageText(1, [line('   ', 0, 700, 10), line('', 0, 690, 0)]);
    expect(page.segments).toHaveLength(0);
  });

  it('handles Spanish punctuation', () => {
    const page = buildPageText(1, [line('¿Dónde está la estación? Está aquí, cerca del río.', 0, 700, 300)], 'es');
    expect(page.segments.map((s) => s.text)).toEqual(['¿Dónde está la estación?', 'Está aquí, cerca del río.']);
  });
});

import { alignItemsToSpans } from '@/lib/tts/segmenter';

describe('alignItemsToSpans', () => {
  it('maps items to spans when the viewer skips empty items', () => {
    const items = ['Title', '', 'Author One', '', '', 'Abstract text'];
    const spans = ['Title', 'Author One', 'Abstract text'];
    expect(alignItemsToSpans(items, spans)).toEqual([0, -1, 1, -1, -1, 2]);
  });

  it('handles empty spans and ligature normalization', () => {
    const items = ['ﬁrst', '', 'line'];
    const spans = ['first', '', 'line'];
    expect(alignItemsToSpans(items, spans)).toEqual([0, -1, 2]);
  });

  it('gives up when the text clearly differs', () => {
    expect(alignItemsToSpans(['a', 'b', 'c', 'd', 'e'], ['x', 'y', 'z', 'w', 'v'])).toBeNull();
  });
});
