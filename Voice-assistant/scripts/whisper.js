// Runs the local Whisper service on its own (npm start also launches it automatically).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const python = process.platform === 'win32' ? 'whisper-service/.venv/Scripts/python.exe' : 'whisper-service/.venv/bin/python';
if (!existsSync(python)) {
  console.error('Whisper is not installed. See "Voice input with Whisper" in README.md.');
  process.exit(1);
}
spawn(python, ['whisper-service/server.py'], { stdio: 'inherit', env: { ...process.env, PYTHONUNBUFFERED: '1' } }).on('exit', (code) => process.exit(code ?? 0));
