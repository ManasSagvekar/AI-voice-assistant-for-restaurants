import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createVoicebox, profileFor } from '../server/voicebox.js';

// A stand-in for Voicebox's REST API: profiles, and the streaming generate endpoint.
async function fakeVoicebox() {
  const state = { profiles: [], speech: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.method === 'GET' && req.url === '/profiles') return res.end(JSON.stringify(state.profiles));
      if (req.method === 'POST' && req.url === '/profiles') {
        const p = { id: String(state.profiles.length + 1), ...body };
        state.profiles.push(p);
        return res.end(JSON.stringify(p));
      }
      if (req.method === 'POST' && req.url === '/generate/stream') {
        state.speech.push(body);
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        return res.end(Buffer.from('RIFF' + body.text));
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('the voice profile is built from VOICEBOX_PRESET, or from a description', () => {
  assert.deepEqual(profileFor({}), { name: 'Restaurant host', description: 'The assistant voice for the restaurant tablets', language: 'en', default_engine: 'kokoro', voice_type: 'preset', preset_engine: 'kokoro', preset_voice_id: 'af_heart' });
  const designed = profileFor({ VOICEBOX_PRESET: 'qwen_voice_design', VOICEBOX_DESIGN: 'A cheerful host' });
  assert.equal(designed.voice_type, 'designed');
  assert.equal(designed.design_prompt, 'A cheerful host');
});

test('creates the profile once, then speaks through it with the chosen speed and style', async () => {
  const vb = await fakeVoicebox();
  try {
    const env = { VOICEBOX_URL: vb.url, VOICEBOX_AUTOSTART: '0', VOICEBOX_VOICE: 'Host', VOICEBOX_PRESET: 'qwen_custom_voice:Serena', VOICEBOX_MODEL_SIZE: '1.7B', VOICEBOX_SPEED: '1.1', VOICEBOX_INSTRUCTIONS: 'Warm and cheerful' };
    const a = createVoicebox(env);
    await a.start();
    assert.deepEqual(a.status(), { voice: 'Host', engine: 'qwen_custom_voice', rate: 1.1, id: '1' });
    assert.equal(vb.state.profiles.length, 1);
    assert.equal(vb.state.profiles[0].preset_voice_id, 'Serena');
    await createVoicebox(env).start();
    assert.equal(vb.state.profiles.length, 1, 'an existing profile is reused, by name');

    const wav = await a.speak('Your order is on its way.');
    assert.equal(wav.toString(), 'RIFFYour order is on its way.');
    const last = vb.state.speech.at(-1);
    assert.deepEqual(last, { profile_id: '1', text: 'Your order is on its way.', language: 'en', engine: 'qwen_custom_voice', model_size: '1.7B', instruct: 'Warm and cheerful' });
    const sent = vb.state.speech.length;
    await a.speak('Your order is on its way.');
    assert.equal(vb.state.speech.length, sent, 'a repeated line comes from the cache');
  } finally { vb.close(); }
});

test('Kokoro voices get no Qwen-only fields', async () => {
  const vb = await fakeVoicebox();
  try {
    const a = createVoicebox({ VOICEBOX_URL: vb.url, VOICEBOX_AUTOSTART: '0', VOICEBOX_INSTRUCTIONS: 'Warm' });
    await a.start();
    await a.speak('Hello there.');
    assert.deepEqual(vb.state.speech.at(-1), { profile_id: '1', text: 'Hello there.', language: 'en', engine: 'kokoro' });
    assert.equal(a.status().rate, 0.93, 'about 160 words a minute by default');
  } finally { vb.close(); }
});

test('reports nothing ready when Voicebox is off or not running', async () => {
  assert.equal(createVoicebox({ VOICEBOX: 'off' }).status(), null);
  const a = createVoicebox({ VOICEBOX_URL: 'http://127.0.0.1:9', VOICEBOX_AUTOSTART: '0' });
  await a.start();
  assert.equal(a.status(), null);
  await assert.rejects(a.speak('Hello'));
});
