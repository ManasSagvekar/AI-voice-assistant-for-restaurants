# AI Voice-Assistant for Restaurants

Two apps that share one live database:

| App | Address | Who uses it | Access |
| --- | --- | --- | --- |
| Customer tablet | `https://<computer's address>:3443/table/1` … | Guests, one tablet per table | The first device to open a table holds it until staff release it |
| Restaurant dashboard | `/restaurant` | Staff | Staff PIN, HttpOnly session cookie (12 h) |
| Kitchen screen | `/kitchen` | Kitchen | Same staff sign-in |
| Floor view | `/floor` | Waiters, on their phones | Same staff sign-in |

`/admin` redirects to `/restaurant` when this server runs on its own. When you run `npm run dev` from the workspace root, `/admin` on the same address is the super-admin app instead (see `../Admin`).

Both are served by one small Node.js server backed by SQLite. A change made in either app goes to the database and is pushed to every open screen over Server-Sent Events, usually in well under a second. That covers orders, order status, 86 toggles, prices, new dishes, server calls and bill requests.

## Run it

Requires Node.js 22.5 or newer. It uses the built-in `node:sqlite`, so there are no native modules to compile and no runtime dependencies.

```sh
npm install        # build tools only
npm run build      # writes public/assets (already included in this folder)
STAFF_PIN=1801 npm start
```

Then open `http://localhost:3000`. If you don't set `STAFF_PIN`, the server uses the default PIN `1801`. (That applies to standalone mode; see [Restaurant licence](#restaurant-licence-admin-app) for running it under the admin app.)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `STAFF_PIN` | generated | PIN for the dashboard |
| `TABLE_COUNT` | `8` | Number of table tablets |
| `DB_FILE` | `data/flavoria.db` | SQLite file. Put it on a persistent disk when hosting |
| `WHISPER_URL` | `http://127.0.0.1:8765` | Whisper service address |
| `WHISPER_MODEL` | `small` | Whisper model the service loads. Multilingual models also understand Hindi and Marathi; `small.en` is English-only |
| `WHISPER_AUTOSTART` | on | Set to `0` to stop `npm start` launching the Whisper service |
| `PIPER_VOICE` | `en_US-amy-medium` | Backup assistant voice ([Piper voices](https://huggingface.co/rhasspy/piper-voices)), used when Voicebox isn't running; downloaded on first start |
| `VOICEBOX_PRESET` | `kokoro:af_heart` | Assistant voice in Voicebox, as `engine:voice`, for example `kokoro:af_bella` or `qwen_custom_voice:Serena` |
| `VOICEBOX_SPEED` | `0.93` | Speaking pace, applied on the tablet with pitch kept. 0.93 is about 160 words a minute |
| `VOICEBOX_VOICE` | `Restaurant host` | Name of the Voicebox voice profile, created on first start if missing |
| `VOICEBOX_INSTRUCTIONS`, `VOICEBOX_MODEL_SIZE` | none, `0.6B` | Delivery instructions and model size, for Qwen voices only |
| `VOICEBOX_URL`, `VOICEBOX_SERVER`, `VOICEBOX_AUTOSTART` | `http://127.0.0.1:17493`, see below, on | Where Voicebox answers, its program file, and `0` to stop `npm start` launching it. `VOICEBOX=off` turns Voicebox off |
| `HTTPS_PORT`, `HTTPS` | `3443`, on | The secure port for tablets. `HTTPS=off` turns it off, but then tablets on the network have no microphone |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | unset | Use your own certificate (a real domain name) instead of the one created here |
| `HOST` | all interfaces | Network interface to listen on. The root `npm run dev` sets `127.0.0.1`, because its proxy on port 3000 is the way in |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | unset | Turns on the restaurant licence (below). Anon key only |
| `BACKUP_DIR` | `data/backups` | Where nightly database copies go |
| `BACKUP_COPY_DIR` | unset | A second place for each copy, such as a USB drive or a synced cloud folder |
| `BACKUP_KEEP`, `BACKUP_HOUR` | `14`, `3` | How many copies to keep, and the hour (local time) of the nightly backup |
| `RESTAURANT_NAME` | `Restaurant` | Name shown in standalone mode |

Settings can also go in a `.env` file next to `package.json` (see `.env.example`); it is read on start and is git-ignored.

## Restaurant licence (admin app)

With `SUPABASE_URL` and `SUPABASE_ANON_KEY` set, this server is licensed by the admin app in `../Admin`, and `STAFF_PIN` is ignored:

1. **Connect once.** The first visit to `/restaurant` asks for the restaurant username and password from the welcome email. The server signs in to Supabase as that restaurant and keeps only the refresh token (in the `settings` table), so it stays connected across restarts.
2. **Staff PIN.** Staff then sign in with the 6-digit PIN set in the admin app, checked by Supabase (`verify_staff_pin`). A PIN only works on its own restaurant's server.
3. **Access checks.** The status is re-checked every 10 seconds and on every voice request (`increment_usage`, which also counts it against the restaurant's rate limit). When the admin marks the restaurant unpaid or suspends it, or it is flagged for abuse or its plan expires, the server closes every staff session and live screen, refuses table and staff requests with `403 service_suspended`, and both apps show a paused screen.
   **Voice limit.** Reaching the plan's voice limit does not close the restaurant. Each table then gets one voice turn every 20 seconds until the hour or day resets, and the tablet uses its own voice instead of Piper; ordering by touch and the staff dashboard are never limited. Staff see a notice from 80%. Because tablets are open to anyone on the network, this server stops counting at twice the limit (voice then pauses until the window resets) and allows each device 40 counted voice requests a minute, so guests can never push their own restaurant into the abuse flag. Only three times the limit in one window counts as abuse and revokes access (this needs the `20261102000000_soft_limits_and_billing.sql` migration).
4. **Signing out of a restaurant.** To use this computer for another restaurant, choose **Switch restaurant** in the dashboard header, or, without the staff PIN, **Not <name>? Sign out of this restaurant** under the sign-in form (it asks for that restaurant's username and password; it is also on the paused screen). The server ends its Supabase session and shows **Connect** again. Each restaurant keeps its menu, orders, tables and settings in its own file, `data/restaurants/<restaurant id>.db`, with backups in `data/backups/<restaurant id>/`, so connecting it again brings everything back. The first restaurant connected before this change takes over the data that was in `data/flavoria.db`, which now holds only this computer's link.
5. **Branding.** Both apps show the restaurant's name from the admin app in place of any product logo.
6. **Privacy.** Only request counts are sent to Supabase. Orders, bills and totals never leave this server.

If Supabase can't be reached, the server keeps serving on the last known status until the plan's end date, so an internet outage never stops dinner service; staff see an "offline" notice. A suspension made in the admin app while the restaurant is offline takes effect when it reconnects. `server/license.js` holds this logic and `server/supabase.js` the minimal REST client.

Staff can change the active table count from the dashboard's **Tables** tab (1–99). The value is stored in SQLite and takes precedence over `TABLE_COUNT` on later starts; `TABLE_COUNT` is used as the initial value for a fresh database. Reducing the count disables those table URLs but retains their saved data.

## Tablets, ordering and service

**Secure connection.** Browsers only allow the microphone on secure pages, and `localhost` is the only plain-HTTP exception, so tablets must use HTTPS. On first start the server creates a small certificate authority and a server certificate for this computer's private network addresses (`data/tls/`, renewed by itself if the address changes). The authority is limited by name constraints to private addresses and `.local` names, so even a stolen key can't impersonate a public website. Set up each tablet once: open `http://<address>:3000/tablet-setup` on it and install the certificate. The tablet and setup addresses are printed in the server window at startup. Plain HTTP from another device redirects to HTTPS (except the setup page) and refuses anything but page loads, so a staff PIN is never sent unencrypted. This computer can still use plain HTTP. Give the computer a fixed address on the router, because tablets are pointed at it.

**One device per table.** The first device to open a table holds it; other devices can't see its orders or order for it, and the home page shows it as in use. A tablet holds one table, and a device on the network can take one new table every ten minutes, so nobody can quietly hold them all. This computer is exempt, for trying things out. Signed-in staff can open any table without taking it. If a tablet is replaced, press **Release** on that table in the **Tables** tab; the old tablet stops and says so, and the next device to open the table takes it over.

**Sizes.** A dish can come in 2 to 6 sizes (Menu Control, **Details**). The tablet shows "from" the lowest price and asks which size; by voice, "two full biryani" uses it, and otherwise the assistant asks. A menu import recognises "Half 120 / Full 220" and size columns under a heading. A range such as "AED 31–38" doesn't say what its prices are for, so staff must choose sizes or one price before publishing.

**Tax and the bill.** In the **Tables** tab, **Tax and bill** sets the tax name and rate, whether menu prices already include it, the service charge, and the address, tax number and closing line on the bill. The service charge is worked out first and is itself taxed. Until this is saved, no tax is charged and the dashboard says so. Each order keeps the rates it was sent with. **Bill**, on a table or a bill request, opens a numbered bill to print on an 80 mm receipt printer. Printing again keeps the number, changed orders make a new bill, and a paid table's last bill prints as a copy.

**Sending an order.** Nothing reaches the kitchen until the guest confirms a read-back: tapping **Send to kitchen** shows the order and total first, and saying "send my order" makes the assistant read it back and wait for a yes. If the owner has chosen a dish to suggest with something in the order (Menu Control, **Details**, "Suggest with this dish"), it is offered once per order. For one minute after sending, and only until the kitchen starts it, the guest can take the order back (**Undo** on the tablet, or "cancel my order"); the dishes return to the cart.

**Importing a menu.** In the dashboard's **Import Menu** tab, drop the restaurant's PDF menu, photos of its pages, or a .txt/.csv price list. It is read on the staff computer, with PDF.js and, for photos and scanned PDFs, Tesseract (`shared/menuparse.js`), and nothing is uploaded: each section heading becomes one of the tablet's categories, in the menu's order, and each dish keeps its price and the menu's currency (AED, ₹, $, € and others; the currency then applies to every price in the app). Price ranges such as "AED 31–38" are flagged to check, and diet, spice and allergen tags are only suggestions. Before publishing, staff choose whether the import replaces the current menu (the default while it is still the sample menu) or adds to it, and whether to add dish photos. With photos on, `server/photos.js` finds a free-licensed photo for each dish on Wikipedia, saves it in `data/media/` and serves it from `/media/`, so tablets never load images from the internet; Menu Control, **Details**, can find another photo or remove one, and links each photo's author and licence. Photos and scans are read in English. Hold the camera straight above the page, in good light. A misread price would be charged to guests, so publishing from a picture requires ticking that every name and price was checked; lines the reader was unsure of are highlighted, a price that lost its decimal point is recovered and flagged, and a picture that mostly read badly says so and suggests retaking it. iPhone HEIC photos need saving as JPG first.

**Health.** The dashboard's **Health** tab shows whether the licence is working, and what to do when it isn't, with a count on the tab when it needs a look. The dashboard also shows a reminder until tax is set up.

**Allergies.** Each dish has an allergen list and a "the kitchen has checked this list" tick (Menu Control, **Details**). The assistant answers allergy questions ("does the korma have nuts?") only for ticked dishes; otherwise it calls a server and says so. "Nut-free" style filters show only ticked dishes. Every allergy question and its answer is listed under Service Requests. Dishes can also be tagged Jain and Halal.

**Guests.** The tablet has a language dropdown for English, Hindi, Marathi, Spanish, French, Arabic, German, Portuguese, Mandarin Chinese, Japanese, Bengali, Tamil and Telugu, plus a display menu for larger text, a slower voice and more time to speak. Every spoken reply is also shown as a large caption. Non-English speech is translated to English by Whisper, so it needs a multilingual model (the default). Tablet labels and assistant replies are translated for English, Hindi and Marathi; the other selected languages currently use English text. Staff can add Hindi and Marathi dish names. Typed requests are understood in English. Holding the mic button records until it's released, for a loud room; staff can switch tablets to **Noisy room** (Tables tab), which ignores more background noise. A note under the assistant tells guests where their voice goes, and **Voice privacy: This computer only** turns off Google's online voices and the browser's speech recognition.

**Kitchen and floor.** `/kitchen` shows tickets oldest first with a timer against the dish's prep time, a bump button, a sound for new orders and optional printing (80 mm receipt layout; with **Print new tickets**, each ticket prints once the guest's undo minute has passed). `/floor` is for waiters' phones: open requests by waiting time with sound and vibration, seated tables with how long they've been seated, and a "my tables" choice kept on the phone.

**Backups.** The database is copied every night, and soon after start if the last copy is over a day old, to `BACKUP_DIR`, plus `BACKUP_COPY_DIR` if set. This runs by itself, with nothing to press in the dashboard. To check on it, look at the dated files in the backup folder. To restore, stop the server and replace the restaurant's database file (`data/restaurants/<restaurant id>.db`, or `data/flavoria.db` in standalone mode) with a backup file.

Tables start **Available** and become **Occupied** when the first order is sent to the kitchen. On upgrade, old session-only occupancy is reconciled against unpaid orders. The staff dashboard's **Tables** tab has a status switch for manually marking a table occupied or available. Guests can only select available tables from the landing page; opening an occupied table URL redirects them back to the table chooser. Marking a bill request paid also returns its table to **Available**.

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

(On macOS/Linux the interpreter is `whisper-service/.venv/bin/python`.) After that, `npm start` launches the Whisper service automatically; the first start downloads the model (~460 MB for `small`). `npm run whisper` runs it on its own. In English, the assistant's spoken replies use the Voicebox voice described below. Without Voicebox, and in other languages, they use Chrome's **Google UK English Female** voice at 1.12× speed, or 0.9× when the guest picks a slower voice (`VOICE_NAME` and `VOICE_RATE` in `customer-app/client/customer.jsx`), spoken a sentence at a time; Hindi and Marathi use the browser's hi-IN or mr-IN voice. Google's voices are synthesized online, so reply text (not guest audio) goes to Google. On browsers without it, another British female voice is used, then **Amy**, the local [Piper](https://github.com/OHF-Voice/piper1-gpl) voice from the Alice assistant, synthesized by the same service (`POST /api/tables/:t/speak`, cached, 30 replies per minute per table; the voice file, ~60 MB, downloads on first start). If Whisper isn't installed or stops responding, tablets fall back to the browser's built-in speech recognition and voice; if the VAD can't load, a simple loudness detector ends turns instead. The VAD's runtime files (`public/assets/vendor/ort`, `vad`, about 17 MB) are copied by `npm run build` and cached by tablets for a day.

## The assistant's voice with Voicebox

The assistant answers in English with a female voice from [Voicebox](https://github.com/jamiepine/voicebox) (MIT), made on the restaurant's computer, so reply text never leaves it. The default is Kokoro's **Heart** voice (`hexgrad/Kokoro-82M`, Apache 2.0), played at 0.93× (about 160 words a minute). In English it takes priority over the browser's voices. Hindi, Marathi and other languages keep using the browser's voices. `server/voicebox.js` creates the voice profile on first start. It makes each reply through `POST /generate/stream`, which keeps no copy, and caches repeated lines. If Voicebox stops, replies fall back to Piper's Amy, then to the browser's voice.

Measured on an RTX 4050 laptop GPU, a Kokoro reply takes about 0.3 to 0.4 seconds through the app. Qwen CustomVoice voices are more expressive, but took 33 to 39 seconds per reply on that GPU, so they are too slow for guests on similar hardware.

One-time setup on Windows with an NVIDIA GPU: download `voicebox-server-cuda.tar.gz` and `cuda-libs-cu128-v1.tar.gz` from the [v0.5.0 release](https://github.com/jamiepine/voicebox/releases/tag/v0.5.0), check their `.sha256` files, and unpack both into `%LOCALAPPDATA%\voicebox-server\data\backends\cuda`, about 5 GB in total. Copy `cuda-libs.json` there too. `npm start` then launches `voicebox-server-cuda.exe` with that `data` folder and stops it on exit. Set `VOICEBOX_SERVER` if it lives elsewhere. The first start downloads the Kokoro model, about 330 MB, into the Hugging Face cache. Two endpoints the app could have used, the OpenAI-compatible `/v1/audio/speech` and Qwen VoiceDesign, exist only in Voicebox's unreleased code, not in 0.5.0.

## How it fits together

```
customer tablet (/table/4) ──┐                ┌── restaurant dashboard (/restaurant)
   speech capture, UI        │  JSON + SSE    │    login, orders, menu, requests
                             ▼                ▼
                     server/index.js     routes, staff auth, live updates
                     server/assistant.js voice command pipeline
                     server/store.js     SQLite: menu, carts, orders, requests, security log
                     shared/engine.js    menu rules, pricing, guardrails, parser, schemas
```

The assistant pipeline runs on the server, so a guest can't bypass it from the browser:

1. **Rate limit**: 6 commands per minute per table (HTTP 429 with `Retry-After`).
2. **Speech safety parse**: control characters stripped and a 240-character cap. The tablet stops listening after 12 seconds (18 when the guest chooses more time).
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
- `shared/menuparse.js`: reads an uploaded menu's text into sections and dishes (staff browser, tested in Node)
- `server/health.js`: turns the licence status into the Health tab's card
- `server/tls.js`: the local certificates behind HTTPS for tablets
- `server/voicebox.js`: the assistant's voice from Voicebox, which is started, checked and stopped with the server
- `server/`: the one HTTP server, SQLite store and assistant pipeline both apps talk to
- `public/assets/`: the built JS/CSS output for both apps (generated by `npm run build`, not hand-edited)

## Moving to a hosted database later

All database access lives in `server/store.js`. To move to Postgres or Supabase, reimplement that one file with the same functions; the routes and both apps stay the same.
