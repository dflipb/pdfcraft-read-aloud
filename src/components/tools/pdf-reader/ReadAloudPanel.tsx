'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Headphones,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Square,
  Settings2,
  Loader2,
  Highlighter,
  AlertCircle,
  Info,
  X,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui';
import { getProvider, resolvedConfig, isAbortError, type ProviderConfig, type TTSVoice } from '@/lib/tts';
import type { useReadAloud } from './useReadAloud';

type ReadAloud = ReturnType<typeof useReadAloud>;

const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];

const selectClass =
  'h-8 px-2 text-xs rounded-md border border-[hsl(var(--color-input))] bg-[hsl(var(--color-background))] text-[hsl(var(--color-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--color-ring))] max-w-full';

function useT() {
  const t = useTranslations('tools');
  return (key: string, fallback: string, values?: Record<string, string | number>) => {
    const full = `pdfReader.readAloud.${key}`;
    try {
      if (t.has(full)) return t(full, values);
    } catch {
      // fall through
    }
    return values ? fallback.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? '')) : fallback;
  };
}

function languageName(tag: string, uiLocale: string): string {
  if (!tag) return tag;
  try {
    const dn = new Intl.DisplayNames([uiLocale], { type: 'language' });
    return dn.of(tag) || tag;
  } catch {
    return tag;
  }
}

export interface ReadAloudPanelProps {
  ra: ReadAloud;
  onClose?: () => void;
}

export function ReadAloudPanel({ ra, onClose }: ReadAloudPanelProps) {
  const tr = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const uiLocale = typeof navigator !== 'undefined' ? navigator.language : 'en';

  const { settings, provider, voices, status, position, numPages } = ra;
  const isPlaying = status === 'playing' || status === 'loading';
  const hasSession = status !== 'idle';

  /* Language filter for the voice list */
  const languages = useMemo(() => {
    const set = new Set<string>();
    voices.forEach((v) => v.lang && set.add(v.lang));
    return Array.from(set).sort((a, b) => languageName(a, uiLocale).localeCompare(languageName(b, uiLocale)));
  }, [voices, uiLocale]);

  const savedLang = settings.languages[provider.id];
  const selectedVoice = voices.find((v) => v.id === ra.selectedVoiceId);
  const langFilter = savedLang ?? selectedVoice?.lang ?? '';
  const filteredVoices = useMemo(
    () => (langFilter ? voices.filter((v) => v.lang === langFilter) : voices),
    [voices, langFilter]
  );

  const setLanguage = (lang: string) => {
    const nextLanguages = { ...settings.languages, [provider.id]: lang };
    const pool = lang ? voices.filter((v) => v.lang === lang) : voices;
    const keep = pool.some((v) => v.id === ra.selectedVoiceId);
    const best = keep ? ra.selectedVoiceId : (pool.find((v) => v.premium) || pool[0])?.id;
    ra.updateSettings({
      languages: nextLanguages,
      voices: best ? { ...settings.voices, [provider.id]: best } : settings.voices,
    });
  };

  const setVoice = (id: string) => ra.updateSettings({ voices: { ...settings.voices, [provider.id]: id } });

  const setEngine = (id: string) => {
    const p = getProvider(id);
    ra.updateSettings({ providerId: id });
    if (!p.isConfigured(resolvedConfig(p, { ...settings, providerId: id }))) setSettingsOpen(true);
  };

  let statusLine: string;
  if (status === 'loading') statusLine = tr('loading', 'Preparing...');
  else if (status === 'playing' && position) statusLine = tr('reading', 'Reading page {page} of {total}', { page: position.page, total: numPages || '?' });
  else if (status === 'paused' && position) statusLine = tr('paused', 'Paused on page {page} of {total}', { page: position.page, total: numPages || '?' });
  else statusLine = tr('idleHint', 'Press play to read from the current page, or select some text first to start there. While reading, click any sentence to jump to it.');

  return (
    <Card variant="outlined" className="!p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 mr-1 text-sm font-medium text-[hsl(var(--color-foreground))]">
          <Headphones className="w-4 h-4 text-[hsl(var(--color-primary))]" aria-hidden />
          {tr('title', 'Read aloud')}
        </div>

        {/* Transport */}
        <div className="flex items-center gap-1" role="group" aria-label={tr('title', 'Read aloud')}>
          <Button variant="ghost" size="sm" onClick={ra.prev} disabled={!hasSession} title={tr('prev', 'Previous sentence')} aria-label={tr('prev', 'Previous sentence')}>
            <SkipBack className="w-4 h-4" />
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={ra.toggle}
            disabled={!ra.configured || (provider.free && voices.length === 0 && !ra.voicesLoading)}
            title={isPlaying ? tr('pause', 'Pause') : status === 'paused' ? tr('resume', 'Resume') : tr('play', 'Play')}
            aria-label={isPlaying ? tr('pause', 'Pause') : tr('play', 'Play')}
            className="min-w-[2.5rem]"
          >
            {status === 'loading' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : isPlaying ? (
              <Pause className="w-4 h-4" />
            ) : (
              <Play className="w-4 h-4" />
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={ra.next} disabled={!hasSession} title={tr('next', 'Next sentence')} aria-label={tr('next', 'Next sentence')}>
            <SkipForward className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={ra.stop} disabled={!hasSession} title={tr('stop', 'Stop')} aria-label={tr('stop', 'Stop')}>
            <Square className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* Speed */}
        <label className="flex items-center gap-1 text-xs text-[hsl(var(--color-muted-foreground))]">
          {tr('speed', 'Speed')}
          <select className={selectClass} value={settings.rate} onChange={(e) => ra.updateSettings({ rate: Number(e.target.value) })}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        </label>

        {/* Engine */}
        <label className="flex items-center gap-1 text-xs text-[hsl(var(--color-muted-foreground))]">
          {tr('engine', 'Engine')}
          <select className={selectClass} value={settings.providerId} onChange={(e) => setEngine(e.target.value)}>
            {ra.providers
              .filter((p) => p.isSupported())
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.free ? tr('engineFree', 'Free (built-in voices)') : p.name}
                </option>
              ))}
          </select>
        </label>

        {/* Language + voice */}
        {ra.configured && languages.length > 1 && (
          <select className={selectClass} value={langFilter} onChange={(e) => setLanguage(e.target.value)} aria-label={tr('language', 'Language')} title={tr('language', 'Language')}>
            <option value="">{tr('allLanguages', 'All languages')}</option>
            {languages.map((l) => (
              <option key={l} value={l}>
                {languageName(l, uiLocale)} ({l})
              </option>
            ))}
          </select>
        )}
        {ra.configured && (
          <select
            className={`${selectClass} min-w-[10rem] flex-1 sm:flex-none sm:max-w-[16rem]`}
            value={ra.selectedVoiceId || ''}
            onChange={(e) => setVoice(e.target.value)}
            disabled={ra.voicesLoading || voices.length === 0}
            aria-label={tr('voice', 'Voice')}
            title={tr('voice', 'Voice')}
          >
            {ra.voicesLoading && <option value="">{tr('loadingVoices', 'Loading voices...')}</option>}
            {!ra.voicesLoading && voices.length === 0 && <option value="">{tr('noVoices', 'No voices found')}</option>}
            {filteredVoices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.premium && provider.free ? '★ ' : ''}
                {v.name}
                {!langFilter && v.lang ? ` (${v.lang})` : ''}
              </option>
            ))}
          </select>
        )}
        {!ra.configured && (
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)} className="text-xs h-8">
            {tr('setupRequired', 'Add your API key')}
          </Button>
        )}

        <div className="flex items-center gap-1 ml-auto">
          <Button
            variant={settings.followAlong ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => ra.updateSettings({ followAlong: !settings.followAlong })}
            title={tr('followAlongHint', 'Highlight the sentence being read and turn pages automatically')}
            aria-pressed={settings.followAlong}
            className="text-xs h-8 gap-1"
          >
            <Highlighter className="w-3.5 h-3.5" />
            <span className="hidden md:inline">{tr('followAlong', 'Follow along')}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)} title={tr('settings', 'Read aloud settings')} aria-label={tr('settings', 'Read aloud settings')}>
            <Settings2 className="w-4 h-4" />
          </Button>
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose} title={tr('hide', 'Hide read aloud')} aria-label={tr('hide', 'Hide read aloud')}>
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Status / current sentence */}
      <div className="flex items-start gap-2 text-xs text-[hsl(var(--color-muted-foreground))]" aria-live="polite">
        <span className="shrink-0 font-medium">{statusLine}</span>
        {hasSession && ra.currentText && (
          <span className="truncate italic text-[hsl(var(--color-foreground))]/80" title={ra.currentText}>
            &ldquo;{ra.currentText}&rdquo;
          </span>
        )}
      </div>

      {ra.voicesError && (
        <div className="flex items-center gap-2 text-xs p-2 rounded-md bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900/40">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">{ra.voicesError}</span>
          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setSettingsOpen(true)}>
            {tr('openSettings', 'Settings')}
          </Button>
        </div>
      )}
      {ra.error && (
        <div className="flex items-center gap-2 text-xs p-2 rounded-md bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900/40" role="alert">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">{ra.error}</span>
          {!provider.free && (
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setEngine('browser')}>
              {tr('useFree', 'Use free voices')}
            </Button>
          )}
          <button onClick={ra.dismissError} aria-label={tr('close', 'Close')} className="opacity-70 hover:opacity-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {ra.notice && (
        <div className="flex items-center gap-2 text-xs p-2 rounded-md bg-sky-50 dark:bg-sky-950/30 text-sky-800 dark:text-sky-200 border border-sky-200 dark:border-sky-900/40">
          <Info className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">{ra.notice}</span>
          <button onClick={ra.dismissNotice} aria-label={tr('close', 'Close')} className="opacity-70 hover:opacity-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <ReadAloudSettingsModal ra={ra} isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function ReadAloudSettingsModal({ ra, isOpen, onClose }: { ra: ReadAloud; isOpen: boolean; onClose: () => void }) {
  const tr = useT();
  const [engineId, setEngineId] = useState(ra.settings.providerId);
  const [drafts, setDrafts] = useState<Record<string, ProviderConfig>>({});
  const [testState, setTestState] = useState<{ busy: boolean; message?: string; ok?: boolean }>({ busy: false });
  const testAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setEngineId(ra.settings.providerId);
    setDrafts({});
    setTestState({ busy: false });
    // reset only when the dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const engine = getProvider(engineId);
  const draft: ProviderConfig = drafts[engineId] ?? resolvedConfig(engine, ra.settings);
  const setField = (key: string, value: string) => setDrafts((d) => ({ ...d, [engineId]: { ...draft, [key]: value } }));

  const runTest = async () => {
    testAbort.current?.abort();
    const ctrl = new AbortController();
    testAbort.current = ctrl;
    setTestState({ busy: true });
    try {
      if (!engine.isConfigured(draft)) throw new Error(tr('setupRequired', 'Add your API key'));
      const list: TTSVoice[] = await engine.listVoices(draft);
      if (list.length === 0) throw new Error(tr('noVoices', 'No voices found'));
      const saved = ra.settings.voices[engine.id];
      const voiceId = list.some((v) => v.id === saved) ? saved : (list.find((v) => v.premium) || list[0]).id;
      ra.stop();
      await engine.speak(tr('testSentence', 'This is how this voice sounds reading your PDF.'), { voiceId, rate: ra.settings.rate }, draft, ctrl.signal);
      setTestState({ busy: false, ok: true, message: tr('testOk', 'Working. {count} voices available.', { count: list.length }) });
    } catch (err) {
      if (isAbortError(err)) {
        setTestState({ busy: false });
        return;
      }
      setTestState({ busy: false, ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const save = () => {
    testAbort.current?.abort();
    for (const [id, cfg] of Object.entries(drafts)) ra.setProviderConfig(id, cfg);
    ra.updateSettings({ providerId: engineId });
    onClose();
  };

  const close = () => {
    testAbort.current?.abort();
    engine.stop();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title={tr('settings', 'Read aloud settings')} size="lg">
      <div className="space-y-4 py-1 text-sm">
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wider text-[hsl(var(--color-muted-foreground))] mb-1">
            {tr('engine', 'Engine')}
          </legend>
          {ra.providers
            .filter((p) => p.isSupported())
            .map((p) => (
              <label
                key={p.id}
                className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer ${
                  engineId === p.id ? 'border-[hsl(var(--color-primary))] bg-[hsl(var(--color-primary))]/5' : 'border-[hsl(var(--color-border))]'
                }`}
              >
                <input type="radio" name="tts-engine" className="mt-1" checked={engineId === p.id} onChange={() => setEngineId(p.id)} />
                <div className="space-y-0.5">
                  <div className="font-medium flex items-center gap-2">
                    {p.free ? tr('engineFree', 'Free (built-in voices)') : p.name}
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        p.free ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                      }`}
                    >
                      {p.free ? tr('freeBadge', 'Free') : tr('paidBadge', 'Paid')}
                    </span>
                  </div>
                  <p className="text-xs text-[hsl(var(--color-muted-foreground))]">
                    {p.free
                      ? tr(
                          'freeNote',
                          'Works offline and sends nothing anywhere. Voices come from your browser and operating system: Edge on Windows includes natural sounding voices, and on macOS or iOS you can download Enhanced voices in system settings. Voices marked with a star usually sound the most natural.'
                        )
                      : tr('paidNote', 'Studio quality voices. Uses your own account and is billed by {provider} per character read.', { provider: 'ElevenLabs' })}
                  </p>
                </div>
              </label>
            ))}
        </fieldset>

        {engine.settings.length > 0 && (
          <div className="space-y-3">
            {engine.settings.map((s) => (
              <div key={s.key}>
                <label className="block text-xs font-semibold text-[hsl(var(--color-muted-foreground))] mb-1" htmlFor={`tts-${engine.id}-${s.key}`}>
                  {s.key === 'apiKey' ? tr('apiKey', 'API key') : s.key === 'model' ? tr('model', 'Model') : s.label}
                </label>
                {s.type === 'select' ? (
                  <select id={`tts-${engine.id}-${s.key}`} className={`${selectClass} w-full h-9`} value={draft[s.key] ?? ''} onChange={(e) => setField(s.key, e.target.value)}>
                    {s.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`tts-${engine.id}-${s.key}`}
                    type={s.type === 'password' ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={s.placeholder}
                    value={draft[s.key] ?? ''}
                    onChange={(e) => setField(s.key, e.target.value)}
                    className={`${selectClass} w-full h-9 font-mono`}
                  />
                )}
                {s.help && <p className="text-xs text-[hsl(var(--color-muted-foreground))] mt-1">{s.key === 'apiKey' ? tr('apiKeyHelp', s.help) : s.help}</p>}
              </div>
            ))}
            <p className="text-xs text-[hsl(var(--color-muted-foreground))]">
              {tr('keyNote', 'Your key is saved only in this browser and is sent only to {provider}. The text being read is sent to {provider} to make the audio.', { provider: 'ElevenLabs' })}
            </p>
          </div>
        )}

        {testState.message && (
          <div
            className={`text-xs p-2 rounded-md border ${
              testState.ok
                ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800'
            }`}
          >
            {testState.message}
          </div>
        )}

        <div className="flex items-center justify-between pt-3 border-t border-[hsl(var(--color-border))]">
          <Button variant="outline" size="sm" onClick={runTest} disabled={testState.busy}>
            {testState.busy ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Volume2 className="w-4 h-4 mr-1" />}
            {tr('testVoice', 'Test voice')}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={close}>
              {tr('cancel', 'Cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={save}>
              {tr('save', 'Save')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default ReadAloudPanel;
