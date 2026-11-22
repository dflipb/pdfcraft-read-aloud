'use client';

/**
 * Read Aloud engine for the PDF.js viewer iframe.
 *
 * - Pulls text page by page from the viewer's loaded document
 * - Speaks it sentence by sentence through the selected TTS provider
 * - Highlights the sentence in the viewer's text layer and turns pages
 * - Lets the user click any sentence to jump there while reading
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  PROVIDERS,
  getProvider,
  loadSettings,
  saveSettings,
  resolvedConfig,
  buildPageText,
  segmentForItem,
  alignItemsToSpans,
  isAbortError,
  TTSError,
  type ReadAloudSettings,
  type TTSVoice,
  type PageText,
  type ProviderConfig,
} from '@/lib/tts';

export type ReadAloudStatus = 'idle' | 'loading' | 'playing' | 'paused';

export interface ReadPosition {
  page: number;
  /** Segment index on the page; -1 means "last segment of the page" */
  segment: number;
}

/* Minimal typings for the parts of the PDF.js viewer we touch */
interface PdfTextContent {
  items: Array<{ str?: string; hasEOL?: boolean; transform?: number[]; width?: number }>;
}
interface PdfPageProxy {
  getTextContent(options?: { includeMarkedContent?: boolean; disableNormalization?: boolean }): Promise<PdfTextContent>;
}
interface PdfDocumentProxy {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxy>;
}
interface PdfEventBus {
  on(name: string, fn: (e: { pageNumber?: number }) => void): void;
  off(name: string, fn: (e: { pageNumber?: number }) => void): void;
}
interface PdfViewerApp {
  pdfDocument: PdfDocumentProxy | null;
  page: number;
  eventBus?: PdfEventBus;
}

const HIGHLIGHT_CLASS = 'pdfcraft-tts-hl';
const HIGHLIGHT_NAME = 'pdfcraft-tts';
const STYLE_ID = 'pdfcraft-tts-style';
const HIGHLIGHT_CSS = `
::highlight(${HIGHLIGHT_NAME}) {
  background-color: rgba(255, 196, 0, 0.45);
  color: transparent;
}
.textLayer span.${HIGHLIGHT_CLASS} {
  background-color: rgba(255, 196, 0, 0.42) !important;
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(255, 170, 0, 0.35);
}
@media (prefers-color-scheme: dark) {
  .textLayer span.${HIGHLIGHT_CLASS} { background-color: rgba(255, 196, 0, 0.5) !important; }
}
.pdfcraft-tts-active .textLayer span:not(.markedContent) { cursor: pointer; }
`;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Leaf text spans of a text layer, in the same order as getTextContent() items */
function leafSpans(layer: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  layer.querySelectorAll('span').forEach((s) => {
    const el = s as HTMLElement;
    if (el.classList.contains('markedContent')) return;
    const parent = el.parentElement;
    if (parent === layer || parent?.classList.contains('markedContent')) out.push(el);
  });
  return out;
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

/** CSS Custom Highlight API in the viewer window (Chrome/Edge 105+, Safari 17.2+, Firefox 140+) */
function highlightApi(win: Window | null | undefined): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const w = win as (Window & { CSS?: { highlights?: HighlightRegistry }; Highlight?: HighlightCtor }) | null | undefined;
  if (w?.CSS?.highlights && typeof w.Highlight === 'function') {
    return { registry: w.CSS.highlights, Highlight: w.Highlight };
  }
  return null;
}

/** Find the text node + offset for a character offset inside an element */
function textPoint(el: Element, offset: number): { node: Text; offset: number } | null {
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  let remaining = offset;
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    if (remaining <= len) return { node: n, offset: remaining };
    remaining -= len;
    last = n;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

/** Item index -> span, for one page's text layer (null if it cannot be matched safely) */
function spansForItems(layer: Element, pageText: PageText): { spans: HTMLElement[]; map: number[] } | null {
  const spans = leafSpans(layer);
  const map = alignItemsToSpans(pageText.itemStrs, spans.map((s) => s.textContent ?? ''));
  return map ? { spans, map } : null;
}

function pickDefaultVoice(voices: TTSVoice[], lang: string | undefined): string | undefined {
  if (voices.length === 0) return undefined;
  const base = (lang || '').split('-')[0].toLowerCase();
  const sameLang = voices.filter((v) => (v.lang || '').toLowerCase().startsWith(base));
  const pool = sameLang.length ? sameLang : voices;
  return (pool.find((v) => v.premium) || pool[0]).id;
}

export function languageOf(tag?: string): string {
  return (tag || '').replace('_', '-');
}

export interface UseReadAloudOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** Changes whenever a different PDF is opened */
  docKey: string | null;
}

export function useReadAloud({ iframeRef, docKey }: UseReadAloudOptions) {
  const [settings, setSettings] = useState<ReadAloudSettings>(() => loadSettings());
  const [status, setStatus] = useState<ReadAloudStatus>('idle');
  const [position, setPosition] = useState<ReadPosition | null>(null);
  const [currentText, setCurrentText] = useState('');
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [voices, setVoices] = useState<TTSVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const statusRef = useRef<ReadAloudStatus>('idle');
  statusRef.current = status;
  const positionRef = useRef<ReadPosition | null>(null);
  const runRef = useRef<AbortController | null>(null);
  const nativePausedRef = useRef(false);
  const pageCacheRef = useRef(new Map<number, Promise<PageText>>());
  const highlightTargetRef = useRef<{ page: number; segment: number } | null>(null);
  const attachedAppRef = useRef<PdfViewerApp | null>(null);
  const attachedDocRef = useRef<Document | null>(null);
  const voicesRef = useRef<TTSVoice[]>([]);
  voicesRef.current = voices;

  const provider = useMemo(() => getProvider(settings.providerId), [settings.providerId]);
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const config = useMemo(() => resolvedConfig(provider, settings), [provider, settings]);
  const configured = provider.isConfigured(config);

  /* ---------------- settings ---------------- */

  const updateSettings = useCallback((patch: Partial<ReadAloudSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const setProviderConfig = useCallback((providerId: string, cfg: ProviderConfig) => {
    setSettings((prev) => {
      const next = { ...prev, config: { ...prev.config, [providerId]: cfg } };
      saveSettings(next);
      return next;
    });
  }, []);

  const selectedVoiceId = settings.voices[provider.id];
  const selectedVoice = voices.find((v) => v.id === selectedVoiceId);
  const speechLang = selectedVoice?.lang || settings.languages[provider.id] || (typeof navigator !== 'undefined' ? navigator.language : 'en');

  /* ---------------- voices ---------------- */

  useEffect(() => {
    let cancelled = false;
    if (!provider.isSupported()) {
      setVoices([]);
      return;
    }
    if (!provider.isConfigured(config)) {
      setVoices([]);
      setVoicesError(null);
      return;
    }
    setVoicesLoading(true);
    setVoicesError(null);
    provider
      .listVoices(config)
      .then((list) => {
        if (cancelled) return;
        const sorted = [...list].sort(
          (a, b) =>
            (a.lang || '').localeCompare(b.lang || '') ||
            Number(!!b.premium) - Number(!!a.premium) ||
            a.name.localeCompare(b.name)
        );
        setVoices(sorted);
        const s = settingsRef.current;
        const saved = s.voices[provider.id];
        if (!saved || !sorted.some((v) => v.id === saved)) {
          const lang = s.languages[provider.id] || navigator.language;
          const id = pickDefaultVoice(sorted, lang);
          if (id) updateSettings({ voices: { ...s.voices, [provider.id]: id } });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setVoices([]);
        setVoicesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => !cancelled && setVoicesLoading(false));
    return () => {
      cancelled = true;
    };
    // config is derived from settings; stringify keeps this from refiring on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, JSON.stringify(config), updateSettings]);

  /* ---------------- viewer access ---------------- */

  const getApp = useCallback((): PdfViewerApp | null => {
    try {
      const win = iframeRef.current?.contentWindow as (Window & { PDFViewerApplication?: PdfViewerApp }) | null;
      return win?.PDFViewerApplication ?? null;
    } catch {
      return null;
    }
  }, [iframeRef]);

  const getViewerDoc = useCallback((): Document | null => {
    try {
      return iframeRef.current?.contentDocument ?? null;
    } catch {
      return null;
    }
  }, [iframeRef]);

  const waitForDocument = useCallback(async (): Promise<{ app: PdfViewerApp; doc: PdfDocumentProxy }> => {
    for (let i = 0; i < 150; i++) {
      const app = getApp();
      if (app?.pdfDocument) return { app, doc: app.pdfDocument };
      await sleep(200);
    }
    throw new TTSError('The PDF is still loading. Try again in a moment.');
  }, [getApp]);

  const getPageText = useCallback(
    (doc: PdfDocumentProxy, pageNumber: number): Promise<PageText> => {
      const cache = pageCacheRef.current;
      const hit = cache.get(pageNumber);
      if (hit) return hit;
      const p = doc
        .getPage(pageNumber)
        .then((page) => page.getTextContent({ disableNormalization: true }))
        .then((content) => {
          const items = content.items.filter((it) => typeof it.str === 'string') as Array<{ str: string; hasEOL?: boolean; transform?: number[]; width?: number }>;
          return buildPageText(pageNumber, items, speechLang);
        });
      p.catch(() => cache.delete(pageNumber));
      cache.set(pageNumber, p);
      return p;
    },
    [speechLang]
  );

  // Segmentation depends on language; rebuild when it changes
  useEffect(() => {
    pageCacheRef.current.clear();
  }, [speechLang]);

  /* ---------------- highlighting ---------------- */

  const clearHighlight = useCallback(() => {
    const vdoc = getViewerDoc();
    vdoc?.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
    try {
      highlightApi(vdoc?.defaultView)?.registry.delete(HIGHLIGHT_NAME);
    } catch {
      // ignore
    }
  }, [getViewerDoc]);

  const applyHighlight = useCallback(
    async (scroll: boolean) => {
      const target = highlightTargetRef.current;
      const vdoc = getViewerDoc();
      if (!target || !vdoc) return;
      clearHighlight();
      const app = getApp();
      if (!app?.pdfDocument) return;
      const pageText = await getPageText(app.pdfDocument, target.page);
      // A newer target may have arrived while text was loading
      if (highlightTargetRef.current !== target) return;
      const seg = pageText.segments[target.segment];
      if (!seg || seg.firstItem < 0) return;
      const layer = vdoc.querySelector(`.page[data-page-number="${target.page}"] .textLayer`);
      if (!layer) return; // not rendered yet; the textlayerrendered event will call us again
      const aligned = spansForItems(layer, pageText);
      if (!aligned) return; // text layer does not match the extracted text; skip highlighting
      let first: HTMLElement | null = null;
      const api = highlightApi(vdoc.defaultView);
      const ranges: Range[] = [];
      for (let i = seg.firstItem; i <= seg.lastItem; i++) {
        const span = aligned.map[i] >= 0 ? aligned.spans[aligned.map[i]] : null;
        if (!span || !span.textContent) continue;
        if (!first) first = span;
        if (api) {
          // Character-accurate: highlight only the part of this span inside the sentence
          const [itemStart, itemEnd] = pageText.itemRanges[i];
          const from = Math.max(seg.start, itemStart) - itemStart;
          const to = Math.min(seg.end, itemEnd) - itemStart;
          const a = textPoint(span, from);
          const b = textPoint(span, Math.min(to, span.textContent.length));
          if (a && b) {
            const r = vdoc.createRange();
            r.setStart(a.node, a.offset);
            r.setEnd(b.node, b.offset);
            ranges.push(r);
            continue;
          }
        }
        span.classList.add(HIGHLIGHT_CLASS);
      }
      if (api && ranges.length) {
        try {
          api.registry.set(HIGHLIGHT_NAME, new api.Highlight(...ranges));
        } catch {
          ranges.length = 0;
        }
      }
      if (scroll && first) {
        // Visible area = viewer container, clipped by the part of the iframe that is on screen
        const container = vdoc.getElementById('viewerContainer');
        const r = first.getBoundingClientRect();
        const c = container?.getBoundingClientRect() ?? { top: 0, bottom: vdoc.defaultView?.innerHeight ?? 0 };
        const frameRect = iframeRef.current?.getBoundingClientRect();
        const visTop = Math.max(c.top, frameRect ? -frameRect.top : 0);
        const visBottom = Math.min(c.bottom, frameRect ? window.innerHeight - frameRect.top : c.bottom);
        if (r.top < visTop + 40 || r.bottom > visBottom - 40) {
          if (container) {
            const target = container.scrollTop + (r.top - c.top) - (visTop - c.top) - (visBottom - visTop) / 3;
            container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
          } else {
            first.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }
      }
    },
    [clearHighlight, getApp, getPageText, getViewerDoc, iframeRef]
  );

  /** Make sure the viewer is fully on screen so followed text is visible */
  const revealViewer = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    const r = frame.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) {
      // Line the viewer's bottom up with the window so the Read Aloud bar above it stays visible
      const delta = r.height + 8 <= window.innerHeight ? r.bottom - window.innerHeight + 8 : r.top;
      window.scrollBy({ top: delta, behavior: 'smooth' });
    }
  }, [iframeRef]);

  const highlight = useCallback(
    (page: number, segment: number) => {
      highlightTargetRef.current = { page, segment };
      if (!settingsRef.current.followAlong) {
        clearHighlight();
        return;
      }
      const app = getApp();
      if (app && app.page !== page) {
        // Bring the page into view; the text layer renders and re-triggers highlighting
        app.page = page;
      }
      void applyHighlight(true);
    },
    [applyHighlight, clearHighlight, getApp]
  );

  /* ---------------- playback ---------------- */

  const cancelRun = useCallback(() => {
    runRef.current?.abort();
    runRef.current = null;
    nativePausedRef.current = false;
  }, []);

  const runFrom = useCallback(
    async (start: ReadPosition) => {
      cancelRun();
      const ctrl = new AbortController();
      runRef.current = ctrl;
      setError(null);
      setNotice(null);
      setStatus('loading');

      const prov = providerRef.current;
      try {
        if (!prov.isSupported()) throw new TTSError('This voice engine does not work in this browser.', 'unsupported');
        const cfg = resolvedConfig(prov, settingsRef.current);
        if (!prov.isConfigured(cfg)) throw new TTSError('Finish setting up this voice engine in Read Aloud settings.', 'auth');

        const { doc } = await waitForDocument();
        setNumPages(doc.numPages);
        let page = Math.min(Math.max(1, start.page), doc.numPages);
        let segment = start.segment;
        let emptyRun = 0;

        while (!ctrl.signal.aborted) {
          if (page > doc.numPages) {
            setStatus('idle');
            setNotice('Finished reading the document.');
            clearHighlight();
            positionRef.current = null;
            setPosition(null);
            setCurrentText('');
            runRef.current = null;
            return;
          }
          const pageText = await getPageText(doc, page);
          if (ctrl.signal.aborted) return;
          if (segment < 0) segment = Math.max(0, pageText.segments.length - 1);

          if (pageText.segments.length === 0) {
            emptyRun++;
            if (emptyRun === 3) {
              setNotice('Several pages have no selectable text. If this is a scan, run OCR PDF on it first.');
            }
            page++;
            segment = 0;
            continue;
          }
          if (segment >= pageText.segments.length) {
            page++;
            segment = 0;
            continue;
          }
          emptyRun = 0;

          const seg = pageText.segments[segment];
          const prevText = pageText.segments[segment - 1]?.text;
          let nextText = pageText.segments[segment + 1]?.text;
          if (!nextText && page < doc.numPages) {
            // Warm up the next page and pre-fetch its first chunk
            const nextPage = page + 1;
            getPageText(doc, nextPage)
              .then((np) => {
                const first = np.segments[0];
                const s = settingsRef.current;
                if (first && !ctrl.signal.aborted) {
                  prov.prepare?.(first.text, { voiceId: s.voices[prov.id], rate: s.rate, previousText: seg.text }, resolvedConfig(prov, s));
                }
              })
              .catch(() => {});
          }

          const pos = { page, segment };
          positionRef.current = pos;
          setPosition(pos);
          setCurrentText(seg.text);
          highlight(page, segment);

          const s = settingsRef.current;
          const speakOpts = { voiceId: s.voices[prov.id], rate: s.rate, previousText: prevText, nextText };
          if (nextText) {
            prov.prepare?.(nextText, { voiceId: s.voices[prov.id], rate: s.rate, previousText: seg.text }, resolvedConfig(prov, s));
          }

          if (!nativePausedRef.current) setStatus('playing');
          await prov.speak(seg.text, speakOpts, resolvedConfig(prov, s), ctrl.signal);
          segment++;
        }
      } catch (err) {
        if (isAbortError(err) || ctrl.signal.aborted) return;
        runRef.current = null;
        setStatus(positionRef.current ? 'paused' : 'idle');
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [cancelRun, clearHighlight, getPageText, highlight, waitForDocument]
  );

  /**
   * Map an element inside the text layer (and optionally a point inside it,
   * as a text node + offset) to the sentence that contains it.
   */
  const positionFromElement = useCallback(
    async (el: Element, point?: { node: Node; offset: number } | null): Promise<ReadPosition | null> => {
      const app = getApp();
      if (!app?.pdfDocument) return null;
      const pageEl = el.closest('.page[data-page-number]') as HTMLElement | null;
      const layer = el.closest('.textLayer');
      if (!pageEl || !layer) return null;
      const page = Number(pageEl.dataset.pageNumber);
      let leaf: Element | null = el;
      while (leaf && leaf.parentElement && leaf.parentElement !== layer && !leaf.parentElement.classList.contains('markedContent')) {
        leaf = leaf.parentElement;
      }
      const pageText = await getPageText(app.pdfDocument, page);
      const aligned = spansForItems(layer, pageText);
      if (!aligned) return { page, segment: 0 };
      const spanIdx = leaf ? aligned.spans.indexOf(leaf as HTMLElement) : -1;
      const idx = spanIdx >= 0 ? aligned.map.indexOf(spanIdx) : -1;
      if (idx < 0) return { page, segment: 0 };
      // Exact character under the pointer / selection start, when available
      if (point && leaf && leaf.contains(point.node)) {
        let offset = 0;
        const walker = leaf.ownerDocument.createTreeWalker(leaf, 4);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n === point.node) {
            offset += point.offset;
            break;
          }
          offset += (n as Text).data.length;
        }
        const [itemStart, itemEnd] = pageText.itemRanges[idx];
        const pos = Math.min(itemStart + offset, Math.max(itemStart, itemEnd - 1));
        const segIdx = pageText.segments.findIndex((sg) => sg.end > pos);
        if (segIdx >= 0) return { page, segment: segIdx };
      }
      return { page, segment: segmentForItem(pageText, idx) };
    },
    [getApp, getPageText]
  );

  /** Where to start when Play is pressed from idle: the selected text, else the current page */
  const startPosition = useCallback(async (): Promise<ReadPosition> => {
    const app = getApp();
    const vdoc = getViewerDoc();
    const fallback = { page: app?.page || 1, segment: 0 };
    try {
      const sel = vdoc?.defaultView?.getSelection();
      const range = sel && sel.rangeCount > 0 && sel.toString().trim() ? sel.getRangeAt(0) : null;
      const node = range ? range.startContainer : null;
      const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
      const point = range && node && node.nodeType === 3 ? { node, offset: range.startOffset } : null;
      const pos = el && app?.pdfDocument ? await positionFromElement(el, point) : null;
      return pos || fallback;
    } catch {
      return fallback;
    }
  }, [getApp, getViewerDoc, positionFromElement]);

  const play = useCallback(async () => {
    if (statusRef.current === 'paused' && positionRef.current) {
      if (nativePausedRef.current && runRef.current) {
        nativePausedRef.current = false;
        providerRef.current.resume();
        setStatus('playing');
        return;
      }
      void runFrom(positionRef.current);
      return;
    }
    if (statusRef.current === 'playing' || statusRef.current === 'loading') return;
    const pos = await startPosition();
    if (settingsRef.current.followAlong) revealViewer();
    void runFrom(pos);
  }, [runFrom, startPosition, revealViewer]);

  const pause = useCallback(() => {
    if (statusRef.current !== 'playing' && statusRef.current !== 'loading') return;
    const handled = statusRef.current === 'playing' && providerRef.current.pause();
    if (handled && runRef.current) {
      nativePausedRef.current = true;
    } else {
      cancelRun();
    }
    setStatus('paused');
  }, [cancelRun]);

  const toggle = useCallback(() => {
    if (statusRef.current === 'playing' || statusRef.current === 'loading') pause();
    else void play();
  }, [pause, play]);

  const stop = useCallback(() => {
    cancelRun();
    providerRef.current.stop();
    clearHighlight();
    highlightTargetRef.current = null;
    positionRef.current = null;
    setPosition(null);
    setCurrentText('');
    setStatus('idle');
  }, [cancelRun, clearHighlight]);

  const jumpTo = useCallback(
    (pos: ReadPosition) => {
      providerRef.current.stop();
      void runFrom(pos);
    },
    [runFrom]
  );

  const next = useCallback(() => {
    const p = positionRef.current;
    if (!p) return;
    jumpTo({ page: p.page, segment: p.segment + 1 });
  }, [jumpTo]);

  const prev = useCallback(() => {
    const p = positionRef.current;
    if (!p) return;
    if (p.segment > 0) jumpTo({ page: p.page, segment: p.segment - 1 });
    else if (p.page > 1) jumpTo({ page: p.page - 1, segment: -1 });
    else jumpTo({ page: 1, segment: 0 });
  }, [jumpTo]);

  const readPage = useCallback(
    (page: number) => {
      jumpTo({ page, segment: 0 });
    },
    [jumpTo]
  );

  /* ---------------- reactions to setting changes ---------------- */

  // Speed: apply immediately where the engine supports it, otherwise from the next sentence
  useEffect(() => {
    providerRef.current.setRate?.(settings.rate);
  }, [settings.rate]);

  // Voice or engine changed while reading: restart the current sentence with the new voice
  const voiceKey = `${settings.providerId}|${selectedVoiceId}|${JSON.stringify(settings.config[settings.providerId] || {})}`;
  const lastVoiceKey = useRef(voiceKey);
  useEffect(() => {
    if (lastVoiceKey.current === voiceKey) return;
    const previousProvider = getProvider(lastVoiceKey.current.split('|')[0]);
    lastVoiceKey.current = voiceKey;
    previousProvider.stop();
    previousProvider.clearCache?.();
    if ((statusRef.current === 'playing' || statusRef.current === 'loading') && positionRef.current) {
      void runFrom(positionRef.current);
    } else if (statusRef.current === 'paused') {
      cancelRun();
    }
  }, [voiceKey, runFrom, cancelRun]);

  // Follow-along toggled
  useEffect(() => {
    if (!settings.followAlong) clearHighlight();
    else if (highlightTargetRef.current) void applyHighlight(false);
  }, [settings.followAlong, applyHighlight, clearHighlight]);

  /* ---------------- viewer wiring ---------------- */

  const active = status !== 'idle';
  const activeRef = useRef(active);
  activeRef.current = active;

  // Re-apply highlight when PDF.js (re)renders a text layer (scrolling, zooming)
  // and let clicks on text jump the reader while a session is active.
  useEffect(() => {
    if (!docKey) return;
    let stopped = false;
    let app: PdfViewerApp | null = null;
    let vdoc: Document | null = null;

    const onTextLayer = (e: { pageNumber?: number }) => {
      if (highlightTargetRef.current && e.pageNumber === highlightTargetRef.current.page && settingsRef.current.followAlong) {
        void applyHighlight(false);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!activeRef.current) return;
      const target = e.target as Element | null;
      if (!target?.closest?.('.textLayer')) return;
      const sel = vdoc?.defaultView?.getSelection();
      if (sel && sel.toString().trim().length > 0) return; // user is selecting text, not jumping
      let point: { node: Node; offset: number } | null = null;
      try {
        const d = vdoc as Document & {
          caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
          caretRangeFromPoint?: (x: number, y: number) => Range | null;
        };
        const cp = d.caretPositionFromPoint?.(e.clientX, e.clientY);
        if (cp) point = { node: cp.offsetNode, offset: cp.offset };
        else {
          const cr = d.caretRangeFromPoint?.(e.clientX, e.clientY);
          if (cr) point = { node: cr.startContainer, offset: cr.startOffset };
        }
      } catch {
        point = null;
      }
      void positionFromElement(target, point).then((pos) => {
        if (pos) jumpTo(pos);
      });
    };

    (async () => {
      for (let i = 0; i < 150 && !stopped; i++) {
        app = getApp();
        vdoc = getViewerDoc();
        if (app?.eventBus && app.pdfDocument && vdoc) break;
        await sleep(200);
      }
      if (stopped || !app?.eventBus || !vdoc) return;
      attachedAppRef.current = app;
      attachedDocRef.current = vdoc;
      setNumPages(app.pdfDocument?.numPages || 0);
      if (!vdoc.getElementById(STYLE_ID)) {
        const style = vdoc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = HIGHLIGHT_CSS;
        vdoc.head.appendChild(style);
      }
      app.eventBus.on('textlayerrendered', onTextLayer);
      vdoc.addEventListener('click', onClick);
    })();

    return () => {
      stopped = true;
      try {
        app?.eventBus?.off('textlayerrendered', onTextLayer);
        vdoc?.removeEventListener('click', onClick);
      } catch {
        // iframe already gone
      }
      attachedAppRef.current = null;
      attachedDocRef.current = null;
    };
  }, [docKey, applyHighlight, getApp, getViewerDoc, jumpTo, positionFromElement]);

  // Pointer cursor on text while a session is active
  useEffect(() => {
    const vdoc = attachedDocRef.current ?? getViewerDoc();
    vdoc?.body?.classList.toggle('pdfcraft-tts-active', active);
  }, [active, getViewerDoc]);

  // New document: reset everything
  useEffect(() => {
    pageCacheRef.current.clear();
    cancelRun();
    providerRef.current.stop();
    highlightTargetRef.current = null;
    positionRef.current = null;
    setPosition(null);
    setCurrentText('');
    setStatus('idle');
    setError(null);
    setNotice(null);
  }, [docKey, cancelRun]);

  // Unmount
  useEffect(() => {
    return () => {
      runRef.current?.abort();
      PROVIDERS.forEach((p) => p.stop());
    };
  }, []);

  return {
    // state
    status,
    position,
    currentText,
    numPages,
    error,
    notice,
    dismissNotice: () => setNotice(null),
    dismissError: () => setError(null),
    // voices / settings
    settings,
    updateSettings,
    setProviderConfig,
    providers: PROVIDERS,
    provider,
    config,
    configured,
    voices,
    voicesLoading,
    voicesError,
    selectedVoiceId,
    // controls
    play,
    pause,
    toggle,
    stop,
    next,
    prev,
    readPage,
  };
}
