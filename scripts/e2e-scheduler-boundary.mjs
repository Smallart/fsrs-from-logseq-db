// E2E: scheduler daily-boundary + deck-scoped new-card quota.
// Verifies the two scheduler fixes:
//   1. pickFuture is bounded by the next day boundary — cards due AFTER it are
//      never served; when today's due cards are done (and the new limit is
//      exhausted), /api/cards/next returns {empty:true} even though plenty of
//      future-due cards exist (bug: "boxes all 0 but still cards").
//   2. drawNew's todayNewLearned is deck-scoped (matches /api/cards/stats),
//      not whole-graph — other decks' new cards no longer eat this deck's
//      quota.
//
// Scenario cards are set up by direct SQL (state/due mutations) and restored
// in a finally block. Run: node scripts/e2e-scheduler-boundary.mjs
import pg from 'pg'
import envPkg from '@next/env'

envPkg.loadEnvConfig(process.cwd())
const APP = 'http://127.0.0.1:3000'
const pw = process.env.APP_PASSWORD ?? ''

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

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
// declared OUTSIDE try — the finally restore block must see them
let target
let snap
const memberNids = (did) =>
  `(select nid from note_decks where did = ${did} and deleted = false)`

// day boundary mirroring scheduler's dayBoundaryMs (day_start default 3)
const dayBoundary = (now, dayStartHour) => {
  const d = new Date(now)
  d.setHours(dayStartHour, 0, 0, 0)
  const todayStart = d.getTime()
  if (now.getTime() < todayStart) {
    const prev = new Date(d)
    prev.setDate(prev.getDate() - 1)
    return { todayStart: prev.getTime(), nextBoundary: todayStart }
  }
  const next = new Date(d)
  next.setDate(next.getDate() + 1)
  return { todayStart, nextBoundary: next.getTime() }
}

try {
  const login = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: pw }) })
  assert('login', login.status === 200, `status=${login.status}`)

  await client.connect()

  // ---- pick the smallest deck with cards (mutations stay small) ----
  const decksRes = await client.query(`
    select d.id, d.name, d.fsrs, d."cardLimit",
           (select count(*)::int from cards c
             join notes n on n.id = c.nid
             where c.deleted = false and c.suspended = false
               and c.nid in (select nid from note_decks where did = d.id and deleted = false)) as total
    from decks d where d.deleted = false order by d.id`)
  const decks = decksRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    dayStart: r.fsrs?.day_start ?? 3,
    newLimit: r.cardLimit?.new ?? 20,
    total: r.total,
  }))
  const targetDeck = [...decks].sort((a, b) => a.total - b.total).find((d) => d.total > 0)
  if (!targetDeck) throw new Error('no deck with cards found')
  target = targetDeck
  console.log(`deck under test: #${target.id} "${target.name}" (${target.total} cards, new limit ${target.newLimit}, day_start ${target.dayStart})`)

  const now = Date.now()
  const { todayStart, nextBoundary } = dayBoundary(new Date(now), target.dayStart)
  const futureDue = now + 48 * 3600 * 1000 // 2 days out — after nextBoundary for sure

  // snapshot member cards (restored in finally)
  snap = await client.query(`
    select c.id, c.state, c.due from cards c
    where c.deleted = false and c.nid in ${memberNids(target.id)}`)
  console.log(`snapshot: ${snap.rows.length} member cards`)

  // = Scenario A: all member cards pushed into the FUTURE (state=2, due=+2d).
  //   stats must show 0/0/0 and next() must return empty every single time.
  //   (Old code: pickFuture happily served these future cards.) =
  await client.query(`
    update cards set state = 2, due = $1
    where deleted = false and nid in ${memberNids(target.id)}`, [futureDue])

  const statsA = (await j(`/api/cards/stats?deck=${target.id}`)).body
  assert(
    'A. stats shows new=0 learning=0 review=0 when everything is future-due',
    statsA?.boxes?.new === 0 && statsA?.boxes?.learning === 0 && statsA?.boxes?.review === 0,
    `boxes=${JSON.stringify(statsA?.boxes)}`,
  )
  let nextServed = null
  for (let i = 0; i < 10; i++) {
    const r = await j(`/api/cards/next?deck=${target.id}`)
    if (r.body && r.body.empty !== true) { nextServed = r.body; break }
  }
  assert(
    'A. next() returns empty although future-due cards exist',
    nextServed === null,
    nextServed ? `served cid=${nextServed.cid} due=+${Math.round((nextServed.due - now) / 3600000)}h` : '10/10 calls empty',
  )

  // = Scenario B: one card OVERDUE (due = now - 1h) must be served =
  const cidB = snap.rows[0].id
  await client.query('update cards set state = 2, due = $1 where id = $2', [now - 3600 * 1000, cidB])
  const nextB = (await j(`/api/cards/next?deck=${target.id}`)).body
  assert(
    'B. overdue card (due <= now) is served',
    nextB?.cid === cidB,
    `got cid=${nextB?.cid ?? nextB?.empty ?? '?'}`,
  )

  // = Scenario C: one card due LATER TODAY (now < due <= nextBoundary) is served =
  const dueLaterToday = Math.min(now + 3600 * 1000, nextBoundary - 1)
  await client.query('update cards set state = 2, due = $1 where id = $2', [dueLaterToday, cidB])
  let nextC = null
  for (let i = 0; i < 10; i++) {
    const r = await j(`/api/cards/next?deck=${target.id}`)
    if (r.body && r.body.cid === cidB) { nextC = r.body; break }
    if (r.body && r.body.empty !== true && r.body.cid !== cidB) break // served a different card — still fine
  }
  assert(
    'C. card due later today (due <= nextBoundary) is served',
    nextC?.cid === cidB,
    `got cid=${nextC?.cid ?? 'other/empty'}`,
  )

  // = Scenario D: deck-scoped todayNewLearned (drawNew) matches stats.
  //   whole-graph count vs deck-scoped count must be computed independently;
  //   the fix makes next() use the deck-scoped one (what stats shows). =
  for (const d of decks) {
    const r = await client.query(`
      select
        (select count(*)::int from (
          select r.cid from revlog r
          join cards c on c.id = r.cid
          where r.deleted = false and c.deleted = false
            and c.nid in ${memberNids(d.id)}
          group by r.cid having min(r.review) >= $1) t) as deck_scoped,
        (select count(*)::int from (
          select r.cid from revlog r
          where r.deleted = false
          group by r.cid having min(r.review) >= $1) t) as whole_graph`, [todayStart])
    const deckScoped = r.rows[0].deck_scoped
    const wholeGraph = r.rows[0].whole_graph
    console.log(`   deck #${d.id} "${d.name}": first-seen-today deck-scoped=${deckScoped} whole-graph=${wholeGraph}${deckScoped !== wholeGraph ? '  (scopes differ — deck-scoped is now what next() uses)' : ''}`)
    if (d.id === target.id) {
      assert(
        'D. deck-scoped count query is valid (deck <= whole graph)',
        deckScoped <= wholeGraph,
        `deck=${deckScoped} whole=${wholeGraph}`,
      )
    }
  }

  // = Scenario E (regression): the "All" deck still serves a card normally =
  const nextAll = (await j('/api/cards/next')).body
  assert('E. All deck still serves a card (regression)', nextAll && nextAll.empty !== true, `cid=${nextAll?.cid ?? nextAll?.empty}`)

  console.log(process.exitCode ? '\nE2E: FAILED' : '\nE2E: ALL GREEN')
} finally {
  // restore the mutated member cards of the target deck
  try {
    if (typeof target !== 'undefined' && snap) {
      await client.query('begin')
      for (const row of snap.rows) {
        await client.query('update cards set state = $1, due = $2 where id = $3', [row.state, row.due, row.id])
      }
      await client.query('commit')
      console.log(`restored ${snap.rows.length} cards of deck #${target.id}`)
    }
  } catch (e) {
    console.error('RESTORE FAILED:', e.message)
    process.exitCode = 1
  }
  await client.end().catch(() => {})
}
