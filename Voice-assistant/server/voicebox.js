// Bridge to Voicebox (github.com/jamiepine/voicebox), a local voice studio, for the assistant's spoken
// replies. Replies come from its /generate/stream endpoint (which keeps nothing on disk) in one voice
// profile, created on first start from VOICEBOX_PRESET. Voicebox has no speed setting there, so the
// tablet applies VOICEBOX_SPEED when it plays the reply. When the standalone Voicebox server is installed and nothing answers
// on VOICEBOX_URL, it is started alongside this server and stopped with it. Without Voicebox, tablets
// use Piper or the browser's voice as before. Like Piper, it runs on this computer: no audio leaves it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
export const DEFAULT_SERVER = path.join(LOCAL, 'voicebox-server', 'data', 'backends', 'cuda', 'voicebox-server-cuda.exe');

// "engine:voice" for a ready-made voice, or "qwen_voice_design" plus VOICEBOX_DESIGN for a described one.
export function profileFor(env) {
  const name = env.VOICEBOX_VOICE || 'Restaurant host';
  const [engine, voiceId] = (env.VOICEBOX_PRESET || 'kokoro:af_heart').split(':');
  const base = { name, description: 'The assistant voice for the restaurant tablets', language: 'en', default_engine: engine };
  if (engine === 'qwen_voice_design') return { ...base, voice_type: 'designed', design_prompt: env.VOICEBOX_DESIGN || 'A warm, friendly young woman with a clear voice and lively, natural expression' };
  return { ...base, voice_type: 'preset', preset_engine: engine, preset_voice_id: voiceId };
}

export function createVoicebox(env = process.env) {
  const off = { start() {}, status: () => null, speak: async () => { throw new Error('Voicebox is off'); } };
  if (env.VOICEBOX === 'off') return off;
  const url = (env.VOICEBOX_URL || 'http://127.0.0.1:17493').replace(/\/$/, '');
  const wanted = profileFor(env);
  const size = env.VOICEBOX_MODEL_SIZE || '0.6B'; // Qwen engines only: 0.6B or 1.7B
  const instructions = env.VOICEBOX_INSTRUCTIONS || '';
  const speed = Math.min(2, Math.max(0.5, Number(env.VOICEBOX_SPEED) || 0.93));
  const exe = env.VOICEBOX_SERVER || DEFAULT_SERVER;
  let ready = null; // { voice, engine, rate, id } once the profile exists
  let child = null;

  async function call(p, init = {}, ms = 3000) {
    const r = await fetch(url + p, { ...init, signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(`voicebox ${p} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  }

  // Ready means the server answers and the voice profile exists; a missing profile is created once.
  async function check() {
    try {
      const profiles = await (await call('/profiles')).json();
      let p = profiles.find((x) => x.name.toLowerCase() === wanted.name.toLowerCase());
      if (!p) {
        p = await (await call('/profiles', { method: 'POST', body: JSON.stringify(wanted), headers: { 'Content-Type': 'application/json' } }, 10000)).json();
        console.log(`[voicebox] Created the voice profile "${p.name}" (${wanted.preset_voice_id || 'designed'} on ${wanted.default_engine})`);
      }
      ready = { voice: p.name, engine: p.default_engine || p.preset_engine || wanted.default_engine, rate: speed, id: p.id };
    } catch (e) {
      if (ready) console.log(`[voicebox] Not answering (${e.message}); tablets will use the next available voice`);
      ready = null;
    }
    return ready;
  }

  // Repeated lines such as greetings are cached, as with Piper. The tablet sets the pace when it plays them.
  const spoken = new Map(); // text -> wav
  async function speak(text) {
    if (!ready) throw new Error('Voicebox is not ready');
    const hit = spoken.get(text);
    if (hit) { spoken.delete(text); spoken.set(text, hit); return hit; }
    const qwen = ready.engine.startsWith('qwen');
    const body = { profile_id: ready.id, text, language: 'en', engine: ready.engine, ...(qwen ? { model_size: size } : {}), ...(qwen && instructions ? { instruct: instructions } : {}) };
    // The first reply after a start loads the model, so it gets longer than the rest.
    const r = await call('/generate/stream', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, spoken.size ? 30000 : 120000);
    const wav = Buffer.from(await r.arrayBuffer());
    spoken.set(text, wav);
    if (spoken.size > 80) spoken.delete(spoken.keys().next().value);
    return wav;
  }

  function stop() {
    if (!child) return;
    const c = child; child = null;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill();
  }

  // Loads the model before the first guest speaks, so their first reply isn't the slow one.
  const warm = () => speak('Welcome!').then(() => console.log(`[voicebox] Voice "${ready.voice}" is ready`)).catch((e) => console.log(`[voicebox] Warm-up failed: ${e.message}`));

  async function start() {
    if (await check()) { console.log(`  Assistant voice:   Voicebox "${ready.voice}" on ${ready.engine} (already running)`); warm(); }
    else if (env.VOICEBOX_AUTOSTART !== '0' && existsSync(exe)) {
      const port = new URL(url).port || '17493';
      const dataDir = env.VOICEBOX_DATA_DIR || path.resolve(path.dirname(exe), '..', '..');
      console.log(`  Assistant voice:   starting Voicebox (${exe})`);
      child = spawn(exe, ['--host', '127.0.0.1', '--port', port, '--data-dir', dataDir], { stdio: 'ignore', windowsHide: true });
      child.on('exit', (code) => { if (child) console.log(`[voicebox] stopped (exit ${code}); tablets will use the next available voice`); child = null; ready = null; });
      for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { stop(); process.exit(0); });
      process.once('exit', stop);
      for (let i = 0; i < 180 && child && !(await check()); i++) await new Promise((r) => setTimeout(r, 1000));
      if (ready) { console.log(`[voicebox] Using voice "${ready.voice}" on ${ready.engine}`); warm(); }
    }
    // Re-check now and then so a Voicebox started or stopped later is noticed.
    setInterval(check, 30000).unref();
  }

  return { start, status: () => ready, speak, stop };
}
