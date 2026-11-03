// Nightly copies of the restaurant database: menu, orders, settings and the licence link all live in
// one SQLite file, so a dead disk would otherwise lose everything. Keeps the newest BACKUP_KEEP copies
// in BACKUP_DIR, and optionally a second set in BACKUP_COPY_DIR (a USB drive or a synced cloud folder).
// `dir` and `copyDir` may be functions, for a folder that depends on the restaurant signed in.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const NAME = /^flavoria-\d{4}-\d{2}-\d{2}-\d{6}\.db$/;

export function createBackups(store, { dir: dirOption, copyDir: copyOption, keep = 14, hour = 3 }) {
  const resolve = (d) => (typeof d === 'function' ? d() : d);
  const last = () => { try { return JSON.parse(store.setting('last_backup') || 'null'); } catch { return null; } };

  function prune(folder) {
    const files = readdirSync(folder).filter((f) => NAME.test(f)).sort().reverse();
    for (const f of files.slice(keep)) rmSync(path.join(folder, f), { force: true });
  }

  function run() {
    const started = Date.now();
    const dir = resolve(dirOption);
    const copyDir = resolve(copyOption);
    try {
      mkdirSync(dir, { recursive: true });
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const name = `flavoria-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`;
      const file = path.join(dir, name);
      store.backupTo(file);
      prune(dir);
      let copied = false;
      if (copyDir) {
        mkdirSync(copyDir, { recursive: true });
        copyFileSync(file, path.join(copyDir, name));
        prune(copyDir);
        copied = true;
      }
      const info = { at: started, file: name, copied, error: null };
      store.setting('last_backup', JSON.stringify(info));
      console.log(`[backup] Saved ${name}${copied ? ` (also copied to ${copyDir})` : ''}`);
      return info;
    } catch (e) {
      const info = { ...(last() || {}), failedAt: started, error: e.message };
      store.setting('last_backup', JSON.stringify(info));
      console.error('[backup] Failed:', e.message);
      return info;
    }
  }

  // One backup a night at BACKUP_HOUR, plus one soon after start if the last is over a day old.
  function start() {
    const due = () => { const l = last(); return !l || !l.at || Date.now() - l.at > 20 * 3600e3; };
    setTimeout(() => due() && run(), 60e3).unref();
    setInterval(() => { if (new Date().getHours() === hour && due()) run(); }, 10 * 60e3).unref();
  }

  return { run, start, status: () => ({ ...(last() || {}), dir: resolve(dirOption), copyDir: resolve(copyOption) || null, keep }) };
}
