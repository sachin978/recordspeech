# RecordSpeech — personal AI English speaking coach

**Speak → Pause → Compare → Understand mistakes → Speak better next time.**

Press **Start Recording** and talk about anything for as long as you like: your day, a system design, an interview answer. You don't have to press anything between sentences. When you press **Pause & Analyse**, RecordSpeech:

1. turns your speech into text, word for word (fillers, repetitions and mistakes included),
2. shows **What I said** next to **Improved English**, sentence by sentence, with the changed words highlighted,
3. explains every correction in simple English (**Understand Your Mistakes**),
4. gives a grammar-corrected, a more natural, and (where it fits) a professional version,
5. if you gave a topic, suggests **better ways to explain it**, kept separate from English mistakes,
6. reviews the whole session (top 3 areas, repeated mistakes, fillers, vocabulary, 3 tips for next time),
7. saves everything locally so the **Progress** page can show which mistakes you keep making and whether they are fading.

It runs locally on your computer. There are no accounts and no cloud database.

---

## Quick start

Requirements: **Node.js 20.9+** (tested on 20.20), npm, a recent **Chrome/Edge/Firefox**, and an **OpenAI API key**.

```bash
cd ~/Desktop/Recordspeech
npm install
cp .env.example .env.local        # then edit .env.local and set OPENAI_API_KEY=sk-...
npm run build
npm start                         # → http://127.0.0.1:3210
```

For development with hot reload, run `npm run dev` (same address).

Open **http://127.0.0.1:3210** (or `http://localhost:3210`). The microphone only works on `localhost` or HTTPS. Allow microphone access when the browser asks.

> The server binds to `127.0.0.1` only, and its API rejects requests from other sites or hosts, so nobody else can use your API key through it.

## Environment variables

| Variable | Required | Default | What it does |
|---|---|---|---|
| `OPENAI_API_KEY` | **yes** | – | Used server-side only, for transcription and analysis |
| `OPENAI_TRANSCRIBE_MODEL` | no | `gpt-transcribe` | Speech-to-text model. `gpt-4o-transcribe` and `whisper-1` also work (OpenAI has deprecated both; they shut down Feb 2027) |
| `OPENAI_ANALYSIS_MODEL` | no | `gpt-6.2-sol` | Grammar/feedback model. `gpt-6-luna` is faster and much cheaper, with somewhat less nuanced feedback |
| `OPENAI_REASONING_EFFORT` | no | `low` | Reasoning effort for the analysis model. Set it empty to use the model's default. Dropped automatically if the model rejects it |
| `ANALYSIS_BATCH_SIZE` | no | `8` | Sentences per parallel analysis request |
| `OPENAI_MAX_CONCURRENCY` | no | `6` | Maximum simultaneous OpenAI requests (lower it if you hit rate limits) |
| `TRANSCRIBE_TIMEOUT_MS` / `ANALYSIS_TIMEOUT_MS` | no | `120000` | Per-request timeouts |
| `DATA_DIR` | no | `./data` | Where the SQLite history (and any audio you chose to keep) is stored |

Without a key, the app still opens and records. It shows a banner explaining what is missing and never fakes results.

## Using it

1. *(Optional)* Type **What are you going to talk about today?**, e.g. "Explaining URL shortener system design". The setting (technical, interview, work, casual) is detected automatically, or you can choose it.
2. **Start Recording**: there's a live timer, a level meter, and a warning if no sound is reaching the mic.
3. **Pause & Analyse**: the recording stops and is analysed. The left column ("What I said") appears as soon as transcription finishes, and the right column fills in as analysis completes.
4. **Resume Recording** keeps talking in the same session; the new speech is added as *Part 2*.
5. **Stop Recording** stops without analysing. Nothing is sent until you press **Analyse**.
6. **Discard Recording** deletes un-analysed audio.

Mistakes are classified into three levels: **Grammar mistake**, **Could sound more natural** (correct but awkward), and **Correct**. Correct sentences are never "corrected".

## Architecture

```
Browser (React, Next.js page)                          Next.js server (Node)                 OpenAI
─────────────────────────────                          ─────────────────────                 ──────
MediaRecorder (Opus, 32 kbps)
 └─ new self-contained segment at a pause after ~60 s
    (next recorder starts before the old one stops → no gap)
 └─ every 1 s: chunk backed up to IndexedDB  ── crash/reload recovery
Pause & Analyse ── multipart upload ──────────────────► POST /api/analyse (NDJSON progress stream)
                                                         1. transcribe segments in parallel ─────► gpt-transcribe
                                                         2. join in order, split sentences (code, not AI)
                                                         3. save transcript to SQLite
◄─ "transcribed" event: left column shown, local audio deleted
                                                         4. parallel structured-output calls ────► gpt-6.2-sol
                                                            · N sentence batches (strict JSON schema)
                                                            · 1 session-feedback call
                                                         5. validate + normalise, compute stats, save
◄─ "sentences" events (rows fill in) → "result"
```

* **One app, one process**: Next.js serves both the UI and the API routes. There are no microservices, queues or external database.
* **SQLite** (`data/recordspeech.db`) holds sessions, sentences, analyses and a flat `mistakes` table used for progress queries. It survives restarts (tested).
* **Code layout**
  * `src/client/` holds the browser code: the segmented recorder, the IndexedDB audio backup, and the stream reader.
  * `src/lib/` holds the server code: config, the OpenAI client, transcription, sentence splitting, stats, the analysis prompts/schemas/validation, the pipeline, the database, and progress.
  * `src/components/` holds the UI: `RecordStudio` (recording state machine) and `SessionView` (results).
  * `src/app/` holds the pages (`/`, `/history`, `/sessions/[id]`, `/progress`) and the API routes.

## Technology choices and why

| Choice | Why |
|---|---|
| **Record first, analyse on pause** (no real-time streaming) | Matches the product: talk freely, then review. Avoids websockets/realtime cost and complexity |
| **Silence-aligned segments (~1 min)** | Each segment is a valid audio file, far below OpenAI's 25 MB limit. Segments are transcribed **in parallel**, so a 20-minute talk takes about as long as one minute's transcription. Cutting at pauses avoids splitting words |
| **Opus/WebM at 32 kbps** (browser-native) | About 4 MB for 20 minutes, so uploads are fast and no server-side conversion (ffmpeg) is needed |
| **`gpt-transcribe`** | OpenAI's current recommended model for recorded audio (whisper-1 and gpt-4o-transcribe are deprecated), cheap at ~$0.0045/min. A verbatim prompt keeps fillers and mistakes, and the topic is included in the prompt to help with technical terms. Unclear words come from token confidence (logprobs) when the model provides them |
| **Browser speech recognition: not used** | Chrome sends audio to Google anyway, it stops after pauses, and it is weaker with Indian-English accents and technical vocabulary |
| **Sentence splitting in code, not by the AI** | "What I said" always comes from the transcript itself, so the model cannot rewrite or invent your words, and the left and right columns stay aligned by index |
| **Strict JSON-schema structured outputs + zod validation** | One schema definition drives both the request and the response validation. Malformed or incomplete responses are retried, then shown as "not analysed" with a **Retry analysis** button |
| **Normalisation rules on AI output** | Code enforces the coaching rules even if the model slips: a sentence marked correct is never changed, "incorrect" requires a real change plus a grammar mistake, and duplicate alternative versions are hidden |
| **Parallel sentence batches + one feedback call** | For long sessions, output length dominates latency, so batches of 8 sentences run concurrently. Short sessions still need only 2 calls |
| **Deterministic numbers** | Accuracy, filler counts, words per minute and trends are counted in code from the transcript and the analysis, and each shows its basis. There are no opaque AI scores. Pronunciation and accent are **not** assessed (text only) |
| **better-sqlite3 v12** | Simple, fast, synchronous, a single file. v12 because v13 needs Node 22+ |
| **No UI framework/CSS library** | One plain stylesheet with automatic dark mode |

## Privacy: where your data goes

* **Audio** is sent to **OpenAI's transcription API** only when you press *Pause & Analyse* / *Analyse*. It is never sent while you're just recording, and segments that are pure silence are not sent at all.
* **Transcript text and your optional topic** are sent to **OpenAI's chat completions API** for analysis.
* Nothing is sent anywhere else. OpenAI's API data-retention policy applies to what is sent; by default API data is not used for training.
* **Audio is not stored permanently.** While you record, it is backed up in your browser's IndexedDB so a crash or reload doesn't lose it. That copy is deleted as soon as the server confirms the transcript is saved, or when you discard. The server never writes audio to disk unless you tick **"Keep a copy of the audio on this computer"**; it is then stored in `data/audio/<session>/` and deleted along with the session.
* The API key lives only in `.env.local`, is read only by server code, and is never sent to the browser. The tests scan the built client bundle for it. Error messages are sanitised.
* `.gitignore` excludes `.env*` (except `.env.example`), `data/`, databases and audio files.

## Testing

```bash
npm test            # unit tests (vitest): splitting, diff, fillers, uncertainty, schema, normalisation, progress
npm run test:e2e    # end-to-end (Playwright, real Chrome): builds the app and runs it against a mock OpenAI API
LONG=1 LONG_SEC=600 npx playwright test long   # optional 10-minute continuous recording test
```

The end-to-end tests drive the **real app**: a production build, a real Chrome `MediaRecorder` fed by a fake microphone playing generated speech-like audio, real uploads, real SQLite. Only OpenAI is replaced, by `tests/mock/openai-mock.mjs`, which speaks the same HTTP API and can inject failures. They cover:

* the full flow, segmenting, alignment, diff highlights, unclear words, the natural toggle, resume as Part 2, history and progress
* discard, stop and reload recovery, and recovery after the tab dies mid-recording
* transcription failure (audio kept, retry works), analysis failure (transcript kept, **Retry analysis** works), malformed AI JSON
* microphone permission denied, a silent microphone (nothing sent), automatic fallback when a model rejects an optional parameter
* the API key never appearing in the client bundle, HTML or errors, and cross-site/foreign-host requests being blocked
* history surviving a real server restart

**Not covered by automated tests: real OpenAI output quality.** The mock returns canned analyses. Run one real session with your key to see actual results.

## Limitations

* **Real-API verification is pending until you add a key.** The integration follows OpenAI's current docs (`gpt-transcribe`, `gpt-6.2-sol`, Chat Completions structured outputs). Where the docs leave things unclear (whether `gpt-transcribe` supports `include[]=logprobs` and the `languages[]` field), the client tries the parameter and automatically drops it if the model rejects it. If logprobs aren't supported, the "unclear word" markers simply won't appear.
* Transcription models often drop "um/uh", so those filler counts are lower bounds. Other fillers ("actually", "basically", "you know"…) are counted reliably.
* Analysis quality depends on the model. `gpt-6.2-sol` is the default for quality; `gpt-6-luna` is faster and cheaper.
* Very long sessions (30+ minutes) work, but analysis takes longer and costs more. For 20 minutes, expect very roughly $0.10 for transcription and $0.30–0.80 for analysis with `gpt-6.2-sol` (a few cents with `gpt-6-luna`).
* Pronunciation, accent and fluency are not assessed; only the transcript is analysed.
* Desktop-first UI. It works on mobile browsers that support `MediaRecorder` but has not been tuned for them.
* Pages are full reloads by design, so the "you have unsaved audio" warning always fires.
