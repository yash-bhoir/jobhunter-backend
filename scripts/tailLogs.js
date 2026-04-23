/**
 * Watch backend log files (Winston writes under ./logs).
 * Usage: node scripts/tailLogs.js [error|combined]
 *   npm run logs:errors
 *   npm run logs:combined
 */
const fs = require('fs');
const path = require('path');

const kind = (process.argv[2] || 'error').toLowerCase() === 'combined' ? 'combined.log' : 'error.log';
const logDir = path.join(__dirname, '..', 'logs');
const logPath = path.join(logDir, kind);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '', 'utf8');

function printTail() {
  try {
    if (!fs.existsSync(logPath)) {
      process.stdout.write(`\r\x1b[2KWaiting for ${logPath}…`);
      return;
    }
    const s = fs.readFileSync(logPath, 'utf8');
    const lines = s.trim().split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-60);
    console.clear();
    console.log(`=== logs/${kind} (last ${tail.length} lines) — Ctrl+C to stop ===\n`);
    console.log(tail.join('\n'));
  } catch (e) {
    console.error('Read error:', e.message);
  }
}

printTail();
fs.watchFile(logPath, { interval: 1500 }, printTail);

process.on('SIGINT', () => {
  try { fs.unwatchFile(logPath); } catch { /* ignore */ }
  process.exit(0);
});
