// Daily DB backup — runs mysqldump, gzips, rotates old files.
// Standalone: `node scripts/backup-db.js`
// Or called from server cron (see server.js).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(require('os').homedir(), 'db-backups');
const KEEP_BACKUPS = parseInt(process.env.KEEP_BACKUPS || '30', 10);

function parseDbUrl(url) {
  // mysql://user:pass@host:port/dbname?params
  const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:/]+):?(\d+)?\/([^/?]+)/);
  if (!m) throw new Error('Invalid DATABASE_URL');
  return {
    user: decodeURIComponent(m[1]),
    pass: decodeURIComponent(m[2]),
    host: m[3],
    port: m[4] || '3306',
    name: m[5],
  };
}

async function backup() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
  const db = parseDbUrl(process.env.DATABASE_URL);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const file = path.join(BACKUP_DIR, `${db.name}-${ts}.sql.gz`);

  console.log(`[${new Date().toISOString()}] Backing up ${db.name}@${db.host}:${db.port} -> ${file}`);

  await new Promise((resolve, reject) => {
    const dump = spawn('mysqldump', [
      '--single-transaction', '--routines', '--triggers', '--events',
      '-h', db.host, '-P', db.port, '-u', db.user, db.name,
    ], { env: { ...process.env, MYSQL_PWD: db.pass } });

    const out = fs.createWriteStream(file);
    const gz = zlib.createGzip();

    dump.stdout.pipe(gz).pipe(out);

    let stderr = '';
    dump.stderr.on('data', d => { stderr += d.toString(); });
    dump.on('error', reject);
    dump.on('close', code => {
      if (code !== 0) return reject(new Error(`mysqldump exited ${code}: ${stderr}`));
      out.on('close', resolve);
      out.on('error', reject);
    });
  });

  const size = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
  console.log(`[${new Date().toISOString()}] Backup OK (${size} MB)`);

  // Rotate
  const all = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith(`${db.name}-`) && f.endsWith('.sql.gz'))
    .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  for (const { f } of all.slice(KEEP_BACKUPS)) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`Rotated old: ${f}`);
  }

  console.log(`Total backups kept: ${Math.min(all.length, KEEP_BACKUPS)}`);
}

if (require.main === module) {
  backup().catch(err => { console.error('Backup failed:', err.message); process.exit(1); });
}

module.exports = { backup };
