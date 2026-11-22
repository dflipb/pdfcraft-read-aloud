# Read Aloud for the PDFCraft PDF Reader

Read Aloud adds text to speech to the existing **PDF Reader** tool (`/tools/pdf-reader`).
It reads the document sentence by sentence, highlights the sentence being spoken,
and turns pages as it goes.

## Features

- **Free voices by default.** Uses the browser's built-in speech engine, so it costs nothing,
  works offline, and sends nothing anywhere.
  - Microsoft Edge on Windows includes free natural sounding neural voices.
  - Chrome adds Google voices.
  - macOS and iOS can download Enhanced and Premium voices in System Settings, Accessibility, Spoken Content.
  - Voices marked with a star in the list are the natural sounding ones.
- **Optional paid voices (ElevenLabs).** Add your own API key in Read Aloud settings.
  The key is stored only in your browser (localStorage) and is sent only to api.elevenlabs.io.
  The next sentence is fetched in the background so there are no gaps, and the surrounding text
  is sent along so the intonation flows naturally.
- Play, pause, stop, previous and next sentence
- Speed from 0.5x to 2.5x
- Language filter and voice picker; your choices are remembered
- **Follow along:** sentence highlight (character accurate) and automatic page turning
- **Start anywhere:** select text before pressing play to start there, or click any sentence while reading to jump to it
- Pages with no text (scans) are skipped, with a hint to run OCR PDF first
- English and Spanish UI strings (other languages fall back to English)

## Run it

```bash
npm install
npm run dev
# open http://localhost:3000/en/tools/pdf-reader/
```

Desktop app (Tauri), same feature: `npm run dev:tauri` or `npm run build:tauri`.

## Files

| File | What it does |
|------|--------------|
| `src/lib/tts/types.ts` | The `TTSProvider` interface every voice engine implements |
| `src/lib/tts/browser-provider.ts` | Free engine (Web Speech API) |
| `src/lib/tts/elevenlabs-provider.ts` | Paid engine (ElevenLabs REST API) |
| `src/lib/tts/registry.ts` | List of engines and saved settings |
| `src/lib/tts/segmenter.ts` | Joins PDF text items into sentences, maps each sentence back to its spans |
| `src/components/tools/pdf-reader/useReadAloud.ts` | Playback engine: reading order, highlight, page turns, click to jump |
| `src/components/tools/pdf-reader/ReadAloudPanel.tsx` | Controls bar and settings dialog |
| `src/components/tools/pdf-reader/PDFReaderTool.tsx` | Existing reader, now shows the Read Aloud panel |

## Adding another paid engine

1. Create `src/lib/tts/<name>-provider.ts` that implements `TTSProvider` from `types.ts`.
   List any settings it needs (API key, model) in its `settings` array; the settings dialog
   builds the fields automatically.
2. Add it to `PROVIDERS` in `src/lib/tts/registry.ts`.

That is all. OpenAI TTS, Azure, Google Cloud, or a local Piper server all fit this shape.

## Tests

- `src/__tests__/lib/tts-segmenter.test.ts`: sentence splitting, hyphen joining, long sentence splitting, Spanish punctuation
- Existing `PDFReaderTool` tests updated to look for the printer dropdown inside the print dialog

## License

PDFCraft is AGPL-3.0. Personal use and free public use are fine. If you host a modified
version publicly, publish your modified source too.
