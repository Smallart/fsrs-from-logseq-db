import { NextRequest, NextResponse } from 'next/server'
import { sql, type SqlBool } from 'kysely'
import { db } from '@server/models/db'
import { requireAuth } from '@server/libs/auth'

// GET /api/cards — card browser with filters.
//   deck=<did>        filter by deck id
//   answer=<text>     substring match (ILIKE) against any element of notes.answer (jsonb)
//   suspended=<0|1>   filter by suspended flag (omitted = all)
//   deleted=<0|1>     filter by deleted flag (omitted = all)
//   state=<0|1|2|3>   filter by FSRS card state (0=New 1=Learning 2=Review 3=Relearning)
//   sort=<due|stability|difficulty|state>   server-side sort (whitelisted)
//   order=<asc|desc>  sort direction (default asc)
//   limit=<n>         page size, default 50, max 1000
//   offset=<n>        pagination offset, default 0
// Returns { cards, total } — total counts ALL rows matching the filters via a
// window function (count(*) over () is computed after WHERE, before LIMIT).
// Rows are always secondarily ordered by c.id as a stable tiebreaker, so
// offset pagination never skips or duplicates rows.
export async function GET(req: NextRequest) {
  await requireAuth()
  const sp = new URL(req.url).searchParams

  const deckParam = sp.get('deck')
  const deckId = deckParam !== null && /^\d+$/.test(deckParam) ? Number(deckParam) : undefined

  const answer = (sp.get('answer') ?? '').trim()
  const suspended = sp.get('suspended')
  const deleted = sp.get('deleted')
  const state = sp.get('state')

  const limit = Math.min(Math.max(Number(sp.get('limit')) || 50, 1), 1000)
  const offset = Math.max(Number(sp.get('offset')) || 0, 0)

  let query = db
    .selectFrom('cards as c')
    .innerJoin('notes as n', 'n.id', 'c.nid')
    .innerJoin('decks as d', 'd.id', 'c.did')
    .select([
      'c.id as id',
      'c.did as did',
      'd.name as deck_name',
      'n.question as question',
      'c.state as state',
      'c.stability as stability',
      'c.difficulty as difficulty',
      'c.due as due',
      'c.suspended as suspended',
      'c.deleted as deleted',
      sql<number>`(count(*) over ())::int`.as('total'),
    ])

  if (deckId !== undefined) {
    // note-level deck membership (shared cards)
    query = query.where(
      'c.nid',
      'in',
      db.selectFrom('note_decks').select('nid').where('did', '=', deckId).where('deleted', '=', false),
    )
  }
  if (answer) {
    query = query.where(
      sql<SqlBool>`exists (select 1 from jsonb_array_elements_text(n.answer) a where a ilike ${`%${answer}%`})`,
    )
  }
  if (suspended === '0') query = query.where('c.suspended', '=', false)
  if (suspended === '1') query = query.where('c.suspended', '=', true)
  if (deleted === '0') query = query.where('c.deleted', '=', false)
  if (deleted === '1') query = query.where('c.deleted', '=', true)
  if (state === '0' || state === '1' || state === '2' || state === '3') {
    query = query.where('c.state', '=', Number(state))
  }

  // optional server-side sort — whitelisted columns only (never injectable)
  const sort = sp.get('sort')
  const order: 'asc' | 'desc' = sp.get('order') === 'desc' ? 'desc' : 'asc'
  if (sort === 'due') query = query.orderBy('c.due', order)
  else if (sort === 'stability') query = query.orderBy('c.stability', order)
  else if (sort === 'difficulty') query = query.orderBy('c.difficulty', order)
  else if (sort === 'state') query = query.orderBy('c.state', order)
  // stable tiebreaker (also the default order when no sort is given)
  query = query.orderBy('c.id', 'asc')

  const rows = await query.limit(limit).offset(offset).execute()

  return NextResponse.json({
    cards: rows.map(({ total: _total, ...card }) => card),
    total: rows.length > 0 ? rows[0].total : 0,
  })
}
