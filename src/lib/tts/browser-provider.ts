/**
 * Free provider: the Web Speech API built into every modern browser.
 *
 * Voices come from the operating system and the browser. Microsoft Edge on
 * Windows adds free "Natural" neural voices, Chrome adds "Google" voices, and
 * macOS / iOS offer "Enhanced" and "Premium" voices you can download in
 * system settings. Nothing is sent anywhere by this app.
 */

import { TTSProvider, TTSVoice, SpeakOptions, TTSError, abortError } from './types';

const PREMIUM_PATTERN = /natural|neural|online|premium|enhanced|google|siri/i;

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
}

function loadVoices(timeoutMs = 2500): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);
  const now = s.getVoices();
  if (now.length > 0) return Promise.resolve(now);

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      s.removeEventListener('voiceschanged', finish);
      resolve(s.getVoices());
    };
    s.addEventListener('voiceschanged', finish);
    setTimeout(finish, timeoutMs);
  });
}

class BrowserSpeechProvider implements TTSProvider {
  id = 'browser';
  name = 'Free (built-in voices)';
  free = true;
  settings = [];

  /** Chrome drops onend if the utterance gets garbage collected, so keep a reference */
  private current: SpeechSynthesisUtterance | null = null;
  private voiceCache: SpeechSynthesisVoice[] = [];

  isSupported(): boolean {
    return synth() !== null && typeof window.SpeechSynthesisUtterance !== 'undefined';
  }

  isConfigured(): boolean {
    return true;
  }

  async listVoices(): Promise<TTSVoice[]> {
    this.voiceCache = await loadVoices();
    return this.voiceCache.map((v) => ({
      id: v.voiceURI || v.name,
      name: v.name,
      lang: v.lang,
      premium: PREMIUM_PATTERN.test(v.name) || !v.localService,
    }));
  }

  speak(text: string, options: SpeakOptions, _config: unknown, signal: AbortSignal): Promise<void> {
    const s = synth();
    if (!s) return Promise.reject(new TTSError('Speech is not supported in this browser.', 'unsupported'));
    if (signal.aborted) return Promise.reject(abortError());

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = this.voiceCache.find((v) => (v.voiceURI || v.name) === options.voiceId);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = Math.min(Math.max(options.rate, 0.1), 4);

      let settled = false;
      let started = false;
      let watchdog: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        settled = true;
        if (watchdog) clearInterval(watchdog);
        signal.removeEventListener('abort', onAbort);
        if (this.current === utterance) this.current = null;
      };
      const onAbort = () => {
        if (settled) return;
        cleanup();
        s.cancel();
        reject(abortError());
      };

      utterance.onstart = () => {
        started = true;
      };
      utterance.onend = () => {
        if (settled) return;
        cleanup();
        resolve();
      };
      utterance.onerror = (e) => {
        if (settled) return;
        cleanup();
        // "interrupted" / "canceled" happen when we cancel on purpose
        if (e.error === 'interrupted' || e.error === 'canceled') {
          reject(abortError());
        } else {
          reject(new TTSError(`Speech failed: ${e.error}`));
        }
      };

      signal.addEventListener('abort', onAbort);
      this.current = utterance;

      // Clear anything still queued. Chrome can silently drop an utterance that is
      // queued in the same tick as cancel(), so give it a moment when it was busy.
      const busy = s.speaking || s.pending || s.paused;
      s.cancel();
      if (busy) {
        setTimeout(() => {
          if (!settled) s.speak(utterance);
        }, 80);
      } else {
        s.speak(utterance);
      }

      // Some browsers (Safari, a few Linux builds) occasionally never fire onend.
      // Poll the engine state and finish the chunk ourselves if it went quiet.
      watchdog = setInterval(() => {
        if (settled) return;
        if (started && !s.speaking && !s.pending && !s.paused) {
          cleanup();
          resolve();
        }
      }, 400);
    });
  }

  /**
   * Native pause is unreliable across browsers (Chrome Android ignores it,
   * some online voices never resume). Read Aloud restarts the sentence instead.
   */
  pause(): boolean {
    synth()?.cancel();
    return false;
  }

  resume(): void {
    // Not used: the engine restarts the current sentence.
  }

  stop(): void {
    synth()?.cancel();
    this.current = null;
  }
}

export const browserProvider = new BrowserSpeechProvider();
