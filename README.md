# Restaurant Voice Assistant

A restaurant ordering system with a voice-enabled guest tablet, a live staff dashboard, and an optional super-admin portal for restaurant accounts and licensing.

## What’s included

- **Guest tablets** at `/table/1` and other configured table URLs: browse the menu, build an order, and interact with a voice assistant.
- **Staff dashboard** at `/restaurant`: manage orders, menus, tables, service requests, and restaurant settings.
- **Kitchen and floor views** at `/kitchen` and `/floor`, with live order updates.
- **Local-first backend**: one Node.js server stores restaurant data in SQLite and streams updates to connected screens.
- **Optional restaurant administration**: the Admin app uses Supabase to manage restaurant accounts, subscriptions, access, and voice usage.
- **Local speech recognition**: an optional Whisper service can transcribe guest audio on the restaurant’s machine.

## Repository layout

| Path | Description |
| --- | --- |
| [`Voice-assistant/`](./Voice-assistant/) | Guest and staff apps, Node.js server, SQLite storage, and optional Whisper service |
| [`Admin/`](./Admin/) | Next.js super-admin portal |
| [`supabase/migrations/`](./supabase/migrations/) | Supabase schema, policies, and licensing/billing migrations |

The two apps can run independently during development. The Voice Assistant is the restaurant-facing application; the Admin app is optional unless you need centralized restaurant accounts and licensing.

## Requirements

- Node.js **22.5 or newer** for the Voice Assistant (`node:sqlite` is built in).
- Python **3.10 or newer** for local Whisper speech recognition (optional).
- A Supabase project for the Admin app or licensed restaurant accounts.

## Run the Voice Assistant

From the repository root:

```sh
cd Voice-assistant
npm install
npm run build
npm start
```

Open [http://localhost:3000](http://localhost:3000). In standalone mode, the default staff PIN is `1801`; set a private `STAFF_PIN` before using the app beyond local development.

Copy `Voice-assistant/.env.example` to `Voice-assistant/.env` to configure the server. Common settings include:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `3000`) |
| `STAFF_PIN` | Staff dashboard PIN in standalone mode |
| `TABLE_COUNT` | Initial number of table URLs (default `8`) |
| `DB_FILE` | SQLite database location |
| `WHISPER_MODEL` | Whisper model (default `small`) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Enable Supabase-backed restaurant licensing |

The complete settings list and Whisper installation steps are in [`Voice-assistant/README.md`](./Voice-assistant/README.md).

## Run the Admin app

The Admin app requires a Supabase project and its migrations. Apply the SQL files in [`supabase/migrations/`](./supabase/migrations/) **in filename order**, then configure the app:

```sh
cd Admin
npm install
```

Copy `Admin/.env.example` to `Admin/.env.local`, then fill in the Supabase project URL, anon key, and service role key. Keep the service role key server-side; never expose it with a `NEXT_PUBLIC_` prefix.

Create the first administrator and start the app:

```sh
npm run create-admin -- admin@example.com "use-a-strong-password"
npm run dev
```

Open [http://localhost:3100/admin](http://localhost:3100/admin). For welcome emails and billing, configure the optional Resend and Razorpay values described in [`Admin/README.md`](./Admin/README.md).

## Connect a restaurant to Supabase licensing

1. Apply the Supabase migrations and configure the Admin app as described above.
2. In Admin, onboard a restaurant. It chooses its own password from a single-use link.
3. In `Voice-assistant/.env`, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` to the **same** Supabase project. The Voice Assistant must only use the anon key; do not put the service role key there.
4. Start the Voice Assistant and connect it with the restaurant credentials. Staff then use the restaurant’s configured PIN.

Orders, bills, and restaurant data remain in the Voice Assistant’s local SQLite database. Supabase is used for account/licensing status and usage counts.

## Tests and checks

Run the Voice Assistant tests:

```sh
cd Voice-assistant
npm test
```

Run the Admin type check and production build:

```sh
cd Admin
npm run typecheck
npm run build
```

## Code graph for AI coding tools

[code-review-graph](https://github.com/tirth8205/code-review-graph) (MIT) keeps a local map of this code's functions, callers and tests, so Claude Code can read only what a change touches. It is a developer tool, not a dependency of either app. The map is stored in `.code-review-graph/`, which git ignores, and its documentation says builds and reviews make no network calls and it has no telemetry.

`CLAUDE.md` and `.claude/skills/` are part of the repository. `.mcp.json` holds a path on one computer, so git ignores it and each computer creates its own. To set it up on Windows, from the repository root:

```sh
python -m venv "%LOCALAPPDATA%\code-review-graph\venv"
"%LOCALAPPDATA%\code-review-graph\venv\Scripts\python" -m pip install code-review-graph==2.3.9
"%LOCALAPPDATA%\code-review-graph\venv\Scripts\code-review-graph" install --platform claude-code --no-hooks -y
"%LOCALAPPDATA%\code-review-graph\venv\Scripts\code-review-graph" build
```

Then add `"--auto-watch"` after `"serve"` in `.mcp.json` and restart Claude Code. If you start Claude Code from a parent folder, it needs a copy of `.mcp.json` there too.

- **Updates:** the watcher runs while Claude Code does and updates the map as files are edited. `--no-hooks` leaves git commits untouched.
- **New files:** a full build only reads committed files. A new file is added once it is committed, or edited while the watcher runs.
- **Removing it:** run `code-review-graph uninstall --dry-run` to preview, then `code-review-graph uninstall`.

## Data and deployment notes

- SQLite databases, backups, uploaded media, environment files, and generated dependency/build folders are local runtime data; do not commit them.
- For deployment, use persistent storage for the Voice Assistant’s `data` directory and serve the apps over HTTPS.
- Use a unique staff PIN and keep all API credentials out of source control.
- Voice recognition runs locally when Whisper is installed. Browser speech features may use browser-provided online services; see the Voice Assistant documentation for details.

For detailed features, environment variables, licensing behavior, and deployment guidance, see the app-specific READMEs: [`Voice-assistant/README.md`](./Voice-assistant/README.md) and [`Admin/README.md`](./Admin/README.md).
