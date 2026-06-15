// ─────────────────────────────────────────────────────────────────────────────
// LOGGER — minimal tagged console logger
// ─────────────────────────────────────────────────────────────────────────────
type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level: Level, tag: string, msg: string): void {
  const line = `${stamp()} [${level}] [${tag}] ${msg}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (tag: string, msg: string) => emit('INFO', tag, msg),
  warn: (tag: string, msg: string) => emit('WARN', tag, msg),
  error: (tag: string, msg: string) => emit('ERROR', tag, msg),
  debug: (tag: string, msg: string) => {
    if (process.env.DEBUG) emit('DEBUG', tag, msg);
  },
};
