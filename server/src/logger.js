// logger.js - minimal logger (console + a rotating-free file per run)
import fs from 'node:fs';
import path from 'node:path';

export function createLogger(file) {
  const lines = [];
  const write = (level, msg) => {
    const line = `${new Date().toISOString()}  [${level}] ${msg}`;
    lines.push(line);
    if (level === 'ERROR') console.error(line);
    else console.log(line);
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line + '\n', 'utf8');
      } catch {
        /* logging must never break the run */
      }
    }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    lines,
  };
}
