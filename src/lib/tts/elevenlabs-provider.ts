/**
 * Optional paid provider: ElevenLabs.
 *
 * The API key is entered by the user in the Read Aloud settings and kept in
 * this browser's localStorage only. Requests go straight from the browser to
 * api.elevenlabs.io; this app has no server in between. Only the text being
 * read is sent, one sentence at a time, and the next sentence is fetched in
 * the background so playback has no gaps.
 */

import { TTSProvider, TTSVoice, SpeakOptions, ProviderConfig, TTSError, abortError } from './types';

const API_BASE = 'https://api.elevenlabs.io/v1';
const MAX_CACHE = 8;

function cacheKey(text: string, options: SpeakOptions, config: ProviderConfig): string {
  return `${config.model || ''}|${options.voiceId || ''}|${text}`;
}

async function readError(res: Response): Promise<TTSError> {
  let detail = '';
  try {
    const body = await res.json();
    detail = typeof body?.detail === 'string' ? body.detail : body?.detail?.message || '';
  } catch {
    // body was not JSON
  }
  if (res.status === 401) {
    return new TTSError('ElevenLabs rejected the API key. Check it in Read Aloud settings.', 'auth');
  }
  if (res.status === 402 || res.status === 429) {
    return new TTSError(detail || 'ElevenLabs quota or rate limit reached.', 'quota');
  }
  return new TTSError(detail || `ElevenLabs request failed (HTTP ${res.status}).`);
}

class ElevenLabsProvider implements TTSProvider {
  id = 'elevenlabs';
  name = 'ElevenLabs (paid, your API key)';
  free = false;
  settings = [
    {
      key: 'apiKey',
      label: 'API key',
      type: 'password' as const,
      placeholder: 'sk_...',
      help: 'Create one at elevenlabs.io under Developers > API Keys. It is stored only in this browser.',
    },
    {
      key: 'model',
      label: 'Model',
      type: 'select' as const,
      defaultValue: 'eleven_flash_v2_5',
      options: [
        { value: 'eleven_flash_v2_5', label: 'Flash v2.5 (fast, lower cost, 32 languages)' },
        { value: 'eleven_multilingual_v2', label: 'Multilingual v2 (best narration quality)' },
      ],
    },
  ];

  private audio: HTMLAudioElement | null = null;
  private cache = new Map<string, Promise<string>>();
  private playingUrl: string | null = null;

  isSupported(): boolean {
    return typeof window !== 'undefined' && typeof Audio !== 'undefined' && typeof fetch !== 'undefined';
  }

  isConfigured(config: ProviderConfig): boolean {
    return !!config.apiKey && config.apiKey.trim().length > 10;
  }

  async listVoices(config: ProviderConfig): Promise<TTSVoice[]> {
    if (!this.isConfigured(config)) return [];
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/voices`, { headers: { 'xi-api-key': config.apiKey.trim() } });
    } catch {
      throw new TTSError('Could not reach ElevenLabs. Check your internet connection.', 'network');
    }
    if (!res.ok) throw await readError(res);
    const data = await res.json();
    const voices: Array<{ voice_id: string; name: string; labels?: Record<string, string> }> = data?.voices || [];
    // No language filter here: ElevenLabs voices speak every language the model supports,
    // so the accent is shown in the name instead.
    return voices
      .map((v) => {
        const extra = [v.labels?.accent, v.labels?.gender].filter(Boolean).join(', ');
        return {
          id: v.voice_id,
          name: extra ? `${v.name} (${extra})` : v.name,
          premium: true,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private fetchAudio(text: string, options: SpeakOptions, config: ProviderConfig): Promise<string> {
    const key = cacheKey(text, options, config);
    const cached = this.cache.get(key);
    if (cached) return cached;

    if (!options.voiceId) return Promise.reject(new TTSError('Pick an ElevenLabs voice first.'));

    const request = (async () => {
      const body: Record<string, unknown> = {
        text,
        model_id: config.model || 'eleven_flash_v2_5',
      };
      if (options.previousText) body.previous_text = options.previousText.slice(-500);
      if (options.nextText) body.next_text = options.nextText.slice(0, 500);

      let res: Response;
      try {
        res = await fetch(
          `${API_BASE}/text-to-speech/${encodeURIComponent(options.voiceId!)}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: {
              'xi-api-key': config.apiKey.trim(),
              'Content-Type': 'application/json',
              Accept: 'audio/mpeg',
            },
            body: JSON.stringify(body),
          }
        );
      } catch {
        throw new TTSError('Could not reach ElevenLabs. Check your internet connection.', 'network');
      }
      if (!res.ok) throw await readError(res);
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    })();

    // Failed requests must not stay cached
    request.catch(() => this.cache.delete(key));

    this.cache.set(key, request);
    this.trimCache();
    return request;
  }

  private trimCache() {
    while (this.cache.size > MAX_CACHE) {
      const oldestKey = this.cache.keys().next().value as string;
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      oldest?.then((url) => {
        if (url !== this.playingUrl) URL.revokeObjectURL(url);
      }).catch(() => {});
    }
  }

  prepare(text: string, options: SpeakOptions, config: ProviderConfig): void {
    if (!this.isConfigured(config) || !options.voiceId) return;
    this.fetchAudio(text, options, config).catch(() => {
      // Errors surface when the chunk is actually spoken
    });
  }

  async speak(text: string, options: SpeakOptions, config: ProviderConfig, signal: AbortSignal): Promise<void> {
    if (!this.isConfigured(config)) {
      throw new TTSError('Add your ElevenLabs API key in Read Aloud settings.', 'auth');
    }
    if (signal.aborted) throw abortError();

    const url = await Promise.race([
      this.fetchAudio(text, options, config),
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true })),
    ]);
    if (signal.aborted) throw abortError();

    if (!this.audio) this.audio = new Audio();
    const audio = this.audio;
    audio.src = url;
    audio.playbackRate = options.rate;
    this.playingUrl = url;

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        audio.onended = null;
        audio.onerror = null;
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        audio.pause();
        reject(abortError());
      };
      audio.onended = () => {
        cleanup();
        resolve();
      };
      audio.onerror = () => {
        cleanup();
        reject(new TTSError('The audio from ElevenLabs could not be played.'));
      };
      signal.addEventListener('abort', onAbort);
      audio.play().catch((err) => {
        cleanup();
        reject(err?.name === 'AbortError' ? abortError() : new TTSError('Playback was blocked by the browser. Press play again.'));
      });
    });
  }

  /** Only a chunk that is actually playing can pause in place; otherwise the engine restarts it (from cache) */
  pause(): boolean {
    if (this.audio && !this.audio.paused && this.audio.currentSrc) {
      this.audio.pause();
      return true;
    }
    return false;
  }

  resume(): void {
    this.audio?.play().catch(() => {});
  }

  stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.playingUrl = null;
  }

  setRate(rate: number): void {
    if (this.audio) this.audio.playbackRate = rate;
  }

  clearCache(): void {
    for (const p of this.cache.values()) {
      p.then((url) => {
        if (url !== this.playingUrl) URL.revokeObjectURL(url);
      }).catch(() => {});
    }
    this.cache.clear();
  }
}

export const elevenLabsProvider = new ElevenLabsProvider();
