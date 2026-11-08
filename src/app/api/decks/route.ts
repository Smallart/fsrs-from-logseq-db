import { NextResponse } from 'next/server'
import { sql } from 'kysely'
import { db } from '@server/models/db'
import { requireAuth } from '@server/libs/auth'
import { dayBoundaryMs } from '@server/services/scheduler'

// GET /api/decks — deck list with today's plan.
// Decks are defined in the Logseq graph by `#Cards` query blocks and mirrored
// during sync (GET gateway /api/decks, anchor = block uuid) — there is no
// manual deck creation in the app.
//   new      = max(0, min(day_limit.new - cards first-seen-today, remaining New cards))
//   learning = cards in Learning(1) / Relearning(3) state
//   review   = Review(2) cards due today or overdue (due <= next day boundary)
//   total    = ALL non-deleted cards in the deck (not today's plan)
export async function GET() {
  await requireAuth()
  const decks = await db
    .selectFrom('decks')
    .select(['id', 'name', 'anchorUuid', 'deskName', 'fsrs', 'cardLimit', 'pDue'])
    .where('deleted', '=', false)
    .orderBy('id', 'asc')
    .execute()

  const now = new Date()
  const out = []
  for (const deck of decks) {
    const dayStart = deck.fsrs.day_start ?? 3
    const { todayStart, nextBoundary } = dayBoundaryMs(now, dayStart)

    // note-level deck membership (shared cards)
    const memberNids = () =>
      db.selectFrom('note_decks').select('nid').where('did', '=', deck.id).where('deleted', '=', false)

    const boxes = await db
      .selectFrom('cards as c')
      .innerJoin('notes as n', 'n.id', 'c.nid')
      .where('c.deleted', '=', false)
      .where('c.suspended', '=', false)
      .where('c.nid', 'in', memberNids())
      .where('n.deleted', '=', false)
      .select([
        sql<number>`(count(*) filter (where c.state = 0 and c.due = 0))::int`.as('new_total'),
        sql<number>`(count(*) filter (where c.state in (1, 3)))::int`.as('learning'),
        sql<number>`(count(*) filter (where c.state = 2 and c.due <= ${nextBoundary}))::int`.as('review'),
        sql<number>`count(*)::int`.as('total'),
      ])
      .executeTakeFirst()

    // cards of this deck first reviewed today (same rule as scheduler's todayNewLearned)
    const firstSeenToday = db
      .selectFrom('revlog as r')
      .innerJoin('cards as c', 'c.id', 'r.cid')
      .where('r.deleted', '=', false)
      .where('c.deleted', '=', false)
      .where('c.nid', 'in', memberNids())
      .groupBy('r.cid')
      .having(sql`min(r.review)`, '>=', todayStart)
      .select('r.cid')
      .as('t')

    const learnedRow = await db
      .selectFrom(firstSeenToday)
      .select(sql<number>`count(*)::int`.as('cnt'))
      .executeTakeFirst()

    const learnedToday = learnedRow?.cnt ?? 0
    const newLimit = deck.cardLimit.new ?? 20
    const newAvail = Math.max(0, Math.min(newLimit - learnedToday, boxes?.new_total ?? 0))

    out.push({
      ...deck,
      stats: {
        new: newAvail,
        learning: boxes?.learning ?? 0,
        review: boxes?.review ?? 0,
        total: boxes?.total ?? 0,
      },
    })
  }

  return NextResponse.json({ decks: out })
}
