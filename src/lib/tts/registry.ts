/**
 * Registered voice engines and saved Read Aloud settings.
 *
 * To add another paid engine (OpenAI, Azure, Google, a local Piper server):
 *   1. Create `<name>-provider.ts` implementing TTSProvider from ./types
 *   2. Add it to PROVIDERS below
 * The settings dialog builds its fields from the provider's `settings` list,
 * so no UI work is needed.
 */

import type { TTSProvider, ProviderConfig } from './types';
import { browserProvider } from './browser-provider';
import { elevenLabsProvider } from './elevenlabs-provider';

export const PROVIDERS: TTSProvider[] = [browserProvider, elevenLabsProvider];

export function getProvider(id: string): TTSProvider {
  return PROVIDERS.find((p) => p.id === id) ?? browserProvider;
}

const STORAGE_KEY = 'pdfcraft-read-aloud';

export interface ReadAloudSettings {
  providerId: string;
  /** Selected voice per provider */
  voices: Record<string, string>;
  /** Selected language filter for the voice list, per provider */
  languages: Record<string, string>;
  rate: number;
  /** Turn pages and highlight the sentence being read */
  followAlong: boolean;
  /** Per-provider configuration (API keys, model) */
  config: Record<string, ProviderConfig>;
}

export const DEFAULT_SETTINGS: ReadAloudSettings = {
  providerId: 'browser',
  voices: {},
  languages: {},
  rate: 1,
  followAlong: true,
  config: {},
};

export function loadSettings(): ReadAloudSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      voices: { ...(parsed.voices || {}) },
      languages: { ...(parsed.languages || {}) },
      config: { ...(parsed.config || {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: ReadAloudSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode); settings then last for the session only
  }
}

/** Provider config with defaults filled in from the provider's settings list */
export function resolvedConfig(provider: TTSProvider, settings: ReadAloudSettings): ProviderConfig {
  const saved = settings.config[provider.id] || {};
  const out: ProviderConfig = {};
  for (const s of provider.settings) {
    out[s.key] = saved[s.key] ?? s.defaultValue ?? '';
  }
  return out;
}
