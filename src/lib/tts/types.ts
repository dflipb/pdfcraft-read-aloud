/**
 * Text-to-speech provider contract.
 *
 * Read Aloud talks to every voice engine through this interface, so a new
 * engine (OpenAI, Azure, a local Piper server, ...) only needs one new file
 * that implements TTSProvider plus one line in registry.ts.
 */

export interface TTSVoice {
  /** Provider-specific voice id */
  id: string;
  /** Human readable name */
  name: string;
  /** BCP-47 language tag when known, e.g. "en-US" */
  lang?: string;
  /** True for neural / natural sounding voices, used for sorting */
  premium?: boolean;
}

export interface SpeakOptions {
  voiceId?: string;
  /** Playback speed, 1 = normal */
  rate: number;
  /** Text spoken just before this chunk (helps cloud engines keep natural intonation) */
  previousText?: string;
  /** Text that will be spoken right after this chunk */
  nextText?: string;
}

export interface ProviderSetting {
  key: string;
  label: string;
  type: 'password' | 'text' | 'select';
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
}

export type ProviderConfig = Record<string, string>;

export class TTSError extends Error {
  constructor(message: string, public readonly code: 'auth' | 'quota' | 'network' | 'unsupported' | 'other' = 'other') {
    super(message);
    this.name = 'TTSError';
  }
}

export interface TTSProvider {
  id: string;
  name: string;
  /** Free providers need no key and work offline */
  free: boolean;
  /** Extra settings shown in the settings dialog (API key, model, ...) */
  settings: ProviderSetting[];

  /** True when this provider can run in the current environment */
  isSupported(): boolean;
  /** True when all required settings are filled in */
  isConfigured(config: ProviderConfig): boolean;

  listVoices(config: ProviderConfig): Promise<TTSVoice[]>;

  /**
   * Speak one chunk of text. Resolves when playback finishes,
   * rejects with an AbortError when the signal fires.
   */
  speak(text: string, options: SpeakOptions, config: ProviderConfig, signal: AbortSignal): Promise<void>;

  /** Optional: fetch audio for an upcoming chunk ahead of time so there is no gap */
  prepare?(text: string, options: SpeakOptions, config: ProviderConfig): void;

  /** Pause in place. Return false if the engine cannot pause (the chunk is then restarted on resume). */
  pause(): boolean;
  resume(): void;
  stop(): void;

  /** Apply a new speed to audio that is already playing, if the engine allows it */
  setRate?(rate: number): void;

  /** Drop cached audio, e.g. when the voice changes */
  clearCache?(): void;
}

export function abortError(): DOMException {
  return new DOMException('Speech aborted', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
