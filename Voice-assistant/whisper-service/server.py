"""Local voice service for the Tazte table tablets.

Speech-to-text: Whisper (github.com/openai/whisper). The Node server forwards each spoken turn here
as raw 16 kHz mono 16-bit PCM and gets text back, so audio never leaves this machine and ffmpeg
isn't needed.
Text-to-speech: Piper with the "Amy" voice, the local voice used by the Alice assistant
(github.com/pmbstyle/Alice). Optional; without piper-tts installed the tablets use the browser voice.

Started automatically by `npm start` when whisper-service/.venv exists; run it on its own with
`npm run whisper`.

Languages: English is transcribed as spoken. Supported non-English speech is translated to English
by Whisper (task "translate"), so the same menu parser understands it; that needs a multilingual
model (the default `small`, not `small.en`).

Environment: WHISPER_MODEL (default small), WHISPER_HOST (127.0.0.1), WHISPER_PORT (8765),
PIPER_VOICE (default en_US-amy-medium).
"""
import io
import json
import os
import threading
import time
import wave
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
import torch
import whisper

MODEL = os.environ.get("WHISPER_MODEL", "small")
HOST = os.environ.get("WHISPER_HOST", "127.0.0.1")
PORT = int(os.environ.get("WHISPER_PORT", "8765"))
SAMPLE_RATE = 16000
MAX_SECONDS = 25
MULTILINGUAL = not MODEL.endswith(".en")
LANGUAGES = ("en", "hi", "mr", "es", "fr", "ar", "de", "pt", "zh", "ja", "bn", "ta", "te")
NO_SPEECH = 0.6  # segments Whisper itself rates as probably-silence are dropped (avoids "Thank you." on noise)

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"[whisper] loading {MODEL} on {device}{' (' + torch.cuda.get_device_name(0) + ')' if device == 'cuda' else ''}", flush=True)
model = whisper.load_model(MODEL, device=device)
lock = threading.Lock()  # one model, one transcription at a time

# Warm up so the first guest doesn't wait for CUDA kernels to compile.
with lock:
    model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), fp16=device == "cuda", language="en")
print(f"[whisper] ready on http://{HOST}:{PORT}", flush=True)

# ---------- Piper text-to-speech (Alice's local voice) ----------
PIPER_VOICE = os.environ.get("PIPER_VOICE", "en_US-amy-medium")
MAX_SPEAK_CHARS = 400
voice = None
SynthesisConfig = None
voice_lock = threading.Lock()  # Piper runs on the CPU, separately from Whisper's GPU lock
try:
    from piper import PiperVoice
    from piper.download_voices import download_voice

    voices_dir = Path(__file__).parent / "voices"
    model_path = voices_dir / f"{PIPER_VOICE}.onnx"
    if not model_path.exists():
        print(f"[piper] downloading voice {PIPER_VOICE}", flush=True)
        voices_dir.mkdir(exist_ok=True)
        download_voice(PIPER_VOICE, voices_dir)
    voice = PiperVoice.load(model_path)
    try:
        from piper import SynthesisConfig  # newer piper-tts only: lets guests choose a slower voice
    except ImportError:
        SynthesisConfig = None
    with voice_lock, wave.open(io.BytesIO(), "wb") as warm:  # first synthesis is slow; do it now
        voice.synthesize_wav("Ready.", warm)
    print(f"[piper] voice {PIPER_VOICE} ready", flush=True)
except Exception as e:  # piper-tts missing or the voice couldn't load: speech-to-text still works
    voice = None
    print(f"[piper] text-to-speech off ({e})", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "model": MODEL, "device": device, "voice": PIPER_VOICE if voice else None,
                                    "languages": list(LANGUAGES) if MULTILINGUAL else ["en"]})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/speak":
            return self._speak()
        if url.path != "/transcribe":
            return self._send(404, {"error": "not found"})
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0 or size % 2 or size > MAX_SECONDS * SAMPLE_RATE * 2:
            return self._send(400, {"error": f"send 1 sample to {MAX_SECONDS}s of 16 kHz mono int16 PCM"})
        query = parse_qs(url.query)
        lang = (query.get("lang") or ["en"])[0]
        if lang not in LANGUAGES:
            return self._send(400, {"error": "unknown language"})
        if lang != "en" and not MULTILINGUAL:
            return self._send(400, {"error": "english_only"})
        audio = np.frombuffer(self.rfile.read(size), dtype="<i2").astype(np.float32) / 32768.0
        prompt = (query.get("prompt") or [""])[0][:800] or None

        started = time.perf_counter()
        with lock:
            result = model.transcribe(
                audio, language=lang, task="transcribe" if lang == "en" else "translate",
                fp16=device == "cuda", temperature=0.0, initial_prompt=prompt, condition_on_previous_text=False,
            )
        text = " ".join(s["text"].strip() for s in result["segments"] if s["no_speech_prob"] < NO_SPEECH).strip()
        self._send(200, {"text": text, "ms": round((time.perf_counter() - started) * 1000)})

    def _speak(self):
        if voice is None:
            return self._send(503, {"error": "text-to-speech is off"})
        size = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(min(size, 8192)) or b"{}")
            text = str(body.get("text", "")).strip()[:MAX_SPEAK_CHARS]
        except ValueError:
            return self._send(400, {"error": "send JSON {\"text\": ...}"})
        if not text:
            return self._send(400, {"error": "nothing to say"})
        buf = io.BytesIO()
        with voice_lock, wave.open(buf, "wb") as wav:
            if body.get("rate") == "slow" and SynthesisConfig is not None:
                voice.synthesize_wav(text, wav, syn_config=SynthesisConfig(length_scale=1.25))  # ~20% slower
            else:
                voice.synthesize_wav(text, wav)
        data = buf.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass  # the Node server logs requests


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
