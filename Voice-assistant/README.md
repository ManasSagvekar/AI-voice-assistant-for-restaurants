# Flavoria AI Table Assistant

Two apps that share one live database:

| App | Address | Who uses it | Access |
| --- | --- | --- | --- |
| Customer tablet | `/table/1` … `/table/8` | Guests, one tablet per table | Open, scoped to its own table |
| Restaurant dashboard | `/admin` | Staff | Staff PIN, HttpOnly session cookie (12 h) |

Both are served by one small Node.js server backed by SQLite. A change made in either app goes to the database and is pushed to every open screen over Server-Sent Events, usually in well under a second. That covers orders, order status, 86 toggles, prices, new dishes, server calls and bill requests.

## Run it

Requires Node.js 22.5 or newer. It uses the built-in `node:sqlite`, so there are no native modules to compile and no runtime dependencies.

```sh
npm install        # build tools only
npm run build      # writes public/assets (already included in this folder)
STAFF_PIN=1801 npm start
```

Then open `http://localhost:3000`. If you don't set `STAFF_PIN`, the server uses the default PIN `1801`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `STAFF_PIN` | generated | PIN for the dashboard |
| `TABLE_COUNT` | `8` | Number of table tablets |
| `DB_FILE` | `data/flavoria.db` | SQLite file. Put it on a persistent disk when hosting |
| `WHISPER_URL` | `http://127.0.0.1:8765` | Whisper service address |
| `WHISPER_MODEL` | `small.en` | Whisper model the service loads |
| `WHISPER_AUTOSTART` | on | Set to `0` to stop `npm start` launching the Whisper service |
| `PIPER_VOICE` | `en_US-amy-medium` | Assistant voice ([Piper voices](https://huggingface.co/rhasspy/piper-voices)); downloaded on first start |

Settings can also go in a `.env` file next to `package.json` (see `.env.example`); it is read on start and is git-ignored.

Staff can change the active table count from the dashboard's **Tables** tab (1–99). The value is stored in SQLite and takes precedence over `TABLE_COUNT` on later starts; `TABLE_COUNT` is used as the initial value for a fresh database. Reducing the count disables those table URLs but retains their saved data.

When a guest starts a tablet session, that table is marked **Occupied** in the staff dashboard. Use **Mark paid** on its bill request to settle the check and return the table to **Available**.

It deploys to any host that runs Node, such as a VPS, Render, Railway or Fly.io. Put it behind HTTPS; the session cookie is marked `Secure` automatically when the proxy sends `X-Forwarded-Proto: https`.

## Voice input with Whisper

Table tablets transcribe speech with [OpenAI Whisper](https://github.com/openai/whisper), running locally on the restaurant's machine, so guests' audio never leaves it. The tablet uses [Silero VAD](https://github.com/ricky0123/vad) (the neural voice-activity detector from the [Alice](https://github.com/pmbstyle/Alice) assistant, running in the browser via WebAssembly) to tell when the guest starts and stops talking, so each turn ends at the natural pause rather than on a timer, and background chatter doesn't open one. It then sends that utterance as 16 kHz audio to `POST /api/tables/:t/transcribe`, and the server forwards it to `whisper-service/server.py`. The live menu's dish names are passed to Whisper as a hint so they're spelled correctly. Transcription is limited to 12 turns per minute per table.

One-time setup (needs Python 3.10+; no ffmpeg required):

```sh
python -m venv whisper-service/.venv
# NVIDIA GPU:
whisper-service/.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
# or CPU only:  ... --index-url https://download.pytorch.org/whl/cpu   (use WHISPER_MODEL=base.en)
whisper-service/.venv/Scripts/python -m pip install -r whisper-service/requirements.txt
```

(On macOS/Linux the interpreter is `whisper-service/.venv/bin/python`.) After that, `npm start` launches the Whisper service automatically; the first start downloads the model (~460 MB for `small.en`). `npm run whisper` runs it on its own. The assistant's spoken replies use **Amy**, the local [Piper](https://github.com/OHF-Voice/piper1-gpl) voice from the Alice assistant, synthesized by the same service (`POST /api/tables/:t/speak`, cached, 30 replies per minute per table); the voice file (~60 MB) downloads on first start. If Whisper isn't installed or stops responding, tablets fall back to the browser's built-in speech recognition and voice; if the VAD can't load, a simple loudness detector ends turns instead. The VAD's runtime files (`public/assets/vendor/ort`, `vad`, about 17 MB) are copied by `npm run build` and cached by tablets for a day.

## How it fits together

```
customer tablet (/table/4) ──┐                ┌── restaurant dashboard (/admin)
   speech capture, UI        │  JSON + SSE    │    login, orders, menu, requests
                             ▼                ▼
                     server/index.js     routes, staff auth, live updates
                     server/assistant.js voice command pipeline
                     server/store.js     SQLite: menu, carts, orders, requests, security log
                     shared/engine.js    menu rules, pricing, guardrails, parser, schemas
```

The assistant pipeline runs on the server, so a guest can't bypass it from the browser:

1. **Rate limit**: 6 commands per minute per table (HTTP 429 with `Retry-After`).
2. **Speech safety parse**: control characters stripped and a 160-character cap, about 8 seconds of speech. The tablet also stops listening after 8 seconds.
3. **Input guardrail**: prompt injection, price manipulation and off-topic requests get a polite refusal and are logged.
4. **Schema validation**: every tool call is checked against a strict schema. Any price field is stripped and logged.
5. **Pricing engine**: totals come from the menu table only. The tablet never sends a price.

Staff-only routes (`/api/admin/*`) require the session cookie, and writes are refused when the `Origin` header is another site. Closing a bill request in the dashboard settles that table's orders, so the tablet starts fresh for the next guests.

## Project layout

Two separate front-end apps share one backend:

- `customer-app/`: the guest tablet app — `client/customer.jsx`, `client/landing.js`, and its own `public/index.html` + `public/table.html`
- `staff-app/`: the restaurant dashboard — `client/admin.jsx` and its own `public/admin.html`
- `client/ui.jsx`, `client/tailwind.css`: components and styles shared by both front ends
- `shared/engine.js`: menu/pricing/guardrail logic used by both the server and the browser
- `server/`: the one HTTP server, SQLite store and assistant pipeline both apps talk to
- `public/assets/`: the built JS/CSS output for both apps (generated by `npm run build`, not hand-edited)

## Moving to a hosted database later

All database access lives in `server/store.js`. To move to Postgres or Supabase, reimplement that one file with the same functions; the routes and both apps stay the same.
