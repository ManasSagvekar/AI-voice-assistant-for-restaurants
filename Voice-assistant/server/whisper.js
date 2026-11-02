// Bridge to the local voice service (whisper-service/server.py): Whisper speech-to-text plus Piper, the
// "Amy" voice from the Alice assistant. When its virtualenv exists and nothing is already answering on
// WHISPER_URL, it is started alongside this server and stopped with it. If it isn't available, the
// tablets fall back to the browser's own speech recognition and voice.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function createWhisper(root) {
  const url = (process.env.WHISPER_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
  const venv = path.join(root, 'whisper-service', '.venv');
  const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let info = null; // { model, device } once healthy
  let child = null;

  async function check() {
    try {
      const r = await fetch(url + '/health', { signal: AbortSignal.timeout(1500) });
      info = r.ok ? await r.json() : null;
    } catch { info = null; }
    return info;
  }

  async function start() {
    if (await check()) return console.log(`  Voice:             Whisper ${info.model} on ${info.device}, ${info.voice ? 'Piper ' + info.voice : 'browser voice'} (already running)`);
    if (process.env.WHISPER_AUTOSTART === '0' || !existsSync(python)) {
      return console.log('  Voice:             browser speech recognition (Whisper not installed, see README)');
    }
    const port = new URL(url).port || '8765';
    child = spawn(python, [path.join(root, 'whisper-service', 'server.py')], {
      env: { ...process.env, WHISPER_PORT: port, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => { if (child) console.log(`[whisper] stopped (exit ${code}); tablets will use browser speech recognition`); child = null; info = null; });
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { stop(); process.exit(0); });
    process.once('exit', stop);
    // Loading the model takes a few seconds (and downloads it the first time); poll until ready.
    for (let i = 0; i < 300 && child && !(await check()); i++) await new Promise((r) => setTimeout(r, 1000));
  }

  function stop() { if (child) { const c = child; child = null; c.kill(); } }

  // Re-check now and then so a Whisper service started or stopped later is noticed.
  setInterval(check, 15000).unref();

  // Piper (Alice's "Amy" voice) runs in the same service. Repeated lines such as greetings are cached.
  const spoken = new Map(); // rate + text -> wav
  async function speak(text, rate = 'normal') {
    const key = rate + '|' + text;
    const hit = spoken.get(key);
    if (hit) { spoken.delete(key); spoken.set(key, hit); return hit; }
    const r = await fetch(url + '/speak', {
      method: 'POST', body: JSON.stringify({ text, rate }), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('piper ' + r.status);
    const wav = Buffer.from(await r.arrayBuffer());
    spoken.set(key, wav);
    if (spoken.size > 80) spoken.delete(spoken.keys().next().value);
    return wav;
  }

  // Non-English speech comes back translated to English (see whisper-service/server.py).
  async function transcribe(pcm, prompt, lang = 'en') {
    const r = await fetch(`${url}/transcribe?lang=${lang}&prompt=${encodeURIComponent(prompt)}`, {
      method: 'POST', body: pcm, headers: { 'Content-Type': 'application/octet-stream' }, signal: AbortSignal.timeout(30000),
    });
    if (r.status === 400 && (await r.clone().json().catch(() => ({}))).error === 'english_only') {
      throw Object.assign(new Error('The Whisper model is English-only'), { code: 'english_only' });
    }
    if (!r.ok) throw new Error('whisper ' + r.status);
    return r.json();
  }

  return { start, status: () => info, transcribe, speak };
}
