// E2E: settings-page auth ensure + ts-fsrs v5 review/undo round-trip.
// Run from the app root: node scripts/e2e-auth-fsrs5.mjs
import { readFileSync } from 'node:fs'
import envPkg from '@next/env'

const APP = 'http://127.0.0.1:3000'
// IMPORTANT: parse .env exactly like the dev server does (@next/env =
// dotenv + dotenv-expand). The raw line can differ from the parsed value —
// e.g. a `#` starts an inline comment and truncates the password.
envPkg.loadEnvConfig(process.cwd())
const pw = process.env.APP_PASSWORD ?? ''
if (!pw) throw new Error('APP_PASSWORD not found in .env')

let cookie = ''
const j = async (path, init = {}) => {
  const res = await fetch(APP + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const body = await res.text().catch(() => '')
  return { status: res.status, body: body ? JSON.parse(body) : null }
}

const assert = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) process.exitCode = 1
}

// ---- login ----
const login = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: pw }) })
assert('login', login.status === 200, `status=${login.status}`)

// ---- 1. settings-page auth ensure: local auth.json is expired and the
//         gateway has no LOGSEQ_LOGIN_PASS → expect 409 auth_not_configured ----
const ensure = await j('/api/gateway/auth/ensure', { method: 'POST' })
assert(
  'ensure blocked with auth_not_configured (409)',
  ensure.status === 409 && ensure.body?.code === 'auth_not_configured',
  `status=${ensure.status} body=${JSON.stringify(ensure.body).slice(0, 120)}`,
)

// the gateway's read-only token endpoint must still work through the client
const cfg = (await j('/api/config')).body
const gw = `${(cfg.gatewayUrl ?? '').replace(/\/$/, '')}/api/auth/token`
const token = await fetch(gw).then((r) => r.json())
assert(
  'gateway GET /api/auth/token reachable',
  token?.status === 'ok' && token.data?.token?.exists === true,
  `expired=${token?.data?.token?.expired} parseable=${token?.data?.token?.parseable}`,
)

// ---- 2. sync still works when called directly (the settings UI blocks,
//         the API itself does not) — verifies v5 merge on FSRS-5 rows ----
const sync = await j('/api/sync', { method: 'POST', body: JSON.stringify({ fullCheck: true }) })
assert(
  'sync pull works under ts-fsrs v5',
  sync.status === 200 && sync.body && !('error' in sync.body),
  `pulled=${sync.body?.pulled ?? '-'} error=${sync.body?.error ?? '-'}`,
)

// ---- 3. review a card (v5 scheduler + learning_steps) then undo ----
const next = await j('/api/cards/next')
assert('next card fetched', next.status === 200 && next.body && !('error' in next.body), `body=${JSON.stringify(next.body).slice(0, 80)}`)
const cid = next.body?.cid
if (cid) {
  const detail = await j(`/api/cards/${cid}/detail`)
  assert('card detail via gateway', detail.status === 200 && detail.body && !('error' in detail.body), `dbId=${detail.body?.dbId ?? '-'}`)

  const rev = await j('/api/cards/review', {
    method: 'POST',
    body: JSON.stringify({ cid, grade: 3, duration: 5000 }),
  })
  assert(
    'review (ts-fsrs v5) computes + pushes',
    rev.status === 200 && rev.body && !('error' in rev.body),
    `state=${rev.body?.next_state} due=+${rev.body?.next_due ? Math.round((rev.body.next_due - Date.now()) / 60000) : '-'}min lid=${rev.body?.lid} conflict=${rev.body?.conflict}`,
  )
  const lid = rev.body?.lid

  const after = await j('/api/cards/stats')
  assert('stats after review', after.status === 200, `body=${JSON.stringify(after.body).slice(0, 80)}`)

  if (lid) {
    const undo = await j('/api/cards/undo', { method: 'POST', body: JSON.stringify({ cid, lid }) })
    assert(
      'undo (v5 rollback) + force push',
      undo.status === 200 && undo.body && !('error' in undo.body),
      `state=${undo.body?.next_state}`,
    )
  }

  // second review to leave the card actually reviewed (grade Hard)
  const rev2 = await j('/api/cards/review', {
    method: 'POST',
    body: JSON.stringify({ cid, grade: 2, duration: 5000 }),
  })
  assert('re-review after undo', rev2.status === 200 && rev2.body && !('error' in rev2.body), `state=${rev2.body?.next_state}`)
}

console.log(process.exitCode ? '\nE2E: FAILED' : '\nE2E: ALL GREEN')
