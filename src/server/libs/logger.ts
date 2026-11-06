import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import path from 'path'

// Daily-rotated file + stdout logger. Every line goes both to the console
// (so `docker compose logs -f app` shows it) and to a date-stamped file
// app-YYYY-MM-DD.log under LOG_DIR (default /app/logs, mapped to
// /opt/fsrs/logs on the VPS via docker-compose).
//
// Retention: files older than LOG_KEEP_DAYS days (default 14) are deleted
// automatically on the first write of each day — logs never grow unbounded.
// Default LOG_DIR = <cwd>/logs so local dev (Windows) writes into the project
// folder, while in the container cwd is /app → /app/logs (matched by the
// docker-compose bind mount). Override with the LOG_DIR env var if needed.
const LOG_DIR = process.env.LOG_DIR ?? path.join(process.cwd(), 'logs')
const KEEP_DAYS = Number(process.env.LOG_KEEP_DAYS ?? 14)

const dateStamp = (d: Date) => d.toISOString().slice(0, 10)
const logFileFor = (d: Date) => path.join(LOG_DIR, `app-${dateStamp(d)}.log`)

/** best-effort cleanup: drop app-YYYY-MM-DD.log files older than KEEP_DAYS */
function cleanupOldLogs(now: Date): void {
  try {
    const cutoff = now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000
    for (const f of readdirSync(LOG_DIR)) {
      const m = /^app-(\d{4}-\d{2}-\d{2})\.log$/.exec(f)
      if (!m) continue
      const t = Date.parse(m[1])
      if (Number.isFinite(t) && t < cutoff) {
        try {
          unlinkSync(path.join(LOG_DIR, f))
        } catch {
          /* best-effort only */
        }
      }
    }
  } catch {
    /* best-effort only */
  }
}

// run cleanup once per day (first write of the day), not on every line
let cleanupStamp: string | null = null

type Level = 'info' | 'warn' | 'error'

export function log(level: Level, msg: string, extra?: unknown): void {
  const now = new Date()
  const line = `[${now.toISOString()}] [${level.toUpperCase()}] ${msg}${
    extra === undefined ? '' : ' ' + JSON.stringify(extra)
  }`
  // console: stdout for info/warn, stderr for error → both captured by docker logs
  if (level === 'error') console.error(line)
  else console.log(line)
  // file: never let logging break the app
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const stamp = dateStamp(now)
    if (cleanupStamp !== stamp) {
      cleanupStamp = stamp
      cleanupOldLogs(now)
    }
    appendFileSync(logFileFor(now), line + '\n')
  } catch (e) {
    console.error('[logger] failed to write log file:', e)
  }
}
