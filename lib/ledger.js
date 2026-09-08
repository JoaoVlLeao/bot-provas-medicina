import { DatabaseSync } from 'node:sqlite';

export class Ledger {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT, status TEXT NOT NULL,
        created TEXT, hash TEXT, answer TEXT, target TEXT, attempts INTEGER DEFAULT 0,
        retry_at INTEGER DEFAULT 0, error TEXT, message_id TEXT, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS file_status ON files(status,retry_at);
      CREATE INDEX IF NOT EXISTS file_hash ON files(hash);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    `);
    // Never resend a delivery whose outcome became unknown during a restart.
    this.db.prepare("UPDATE files SET status='uncertain', error='Envio interrompido: conferir no WhatsApp antes de tentar novamente.' WHERE status='sending'").run();
    this.db.prepare("UPDATE files SET status='queued' WHERE status='analyzing'").run();
  }
  get(key) { return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; }
  set(key,value) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value)); }
  discover(files) {
    const initial = !this.get('initialized');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO files(id,name,mime,status,created,updated) VALUES (?,?,?,?,?,?)');
      for(const f of files) insert.run(f.id,f.name,f.mimeType,initial?'baseline':'queued',f.createdTime||'',Date.now());
      if(initial) this.set('initialized',new Date().toISOString());
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
    return initial;
  }
  update(id, fields) {
    const allowed = ['status','hash','answer','target','attempts','retry_at','error','message_id'];
    const keys = Object.keys(fields).filter(k=>allowed.includes(k));
    this.db.prepare(`UPDATE files SET ${keys.map(k=>`${k}=?`).join(',')},updated=? WHERE id=?`).run(...keys.map(k=>fields[k]),Date.now(),id);
  }
  next() { return this.db.prepare("SELECT * FROM files WHERE status='queued' AND retry_at<=? ORDER BY created,id LIMIT 1").get(Date.now()); }
  knownHash(hash,id) { return this.db.prepare("SELECT id FROM files WHERE hash=? AND id<>? AND status IN ('sent','sending','uncertain') LIMIT 1").get(hash,id); }
  recent() { return this.db.prepare('SELECT id,name,status,attempts,error,updated FROM files ORDER BY updated DESC LIMIT 15').all(); }
  counts() { return Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) n FROM files GROUP BY status').all().map(r=>[r.status,r.n])); }
  close() { this.db.close(); }
}
