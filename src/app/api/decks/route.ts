import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'kysely'
import { db } from '@server/models/db'
import { requireAuth } from '@server/libs/auth'
import { dayBoundaryMs } from '@server/services/scheduler'
import { LogseqClient } from '@server/libs/logseq'
import { loadConfig } from '@server/services/sync'

// Today's plan per deck (mirrors the scheduler's pick order):
//   new      = max(0, min(day_limit.new - cards first-seen-today, remaining New cards))
//   learning = cards in Learning(1) / Relearning(3) state
//   review   = Review(2) cards due today or overdue (due <= next day boundary)
//   total    = new + learning + review
export async function GET() {
  await requireAuth()
  const decks = await db
    .selectFrom('decks')
    .select(['id', 'name', 'logseq_uuid', 'tag_name', 'desk_name', 'fsrs', 'card_limit', 'p_due', 'deleted'])
    .where('deleted', '=', false)
    .orderBy('id', 'asc')
    .execute()

  const now = new Date()
  const out = []
  for (const deck of decks) {
    const dayStart = (deck.fsrs as { day_start?: number } | null)?.day_start ?? 3
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
    const newLimit = (deck.card_limit as { new?: number } | null)?.new ?? 20
    const newAvail = Math.max(0, Math.min(newLimit - learnedToday, boxes?.new_total ?? 0))
    const learning = boxes?.learning ?? 0
    const review = boxes?.review ?? 0

    out.push({
      ...deck,
      stats: {
        new: newAvail,
        learning,
        review,
        // total = ALL non-deleted cards in the deck (not today's plan)
        total: boxes?.total ?? 0,
      },
    })
  }

  return NextResponse.json({ decks: out })
}

// POST /api/decks — create a deck from a Logseq tag.
//   body: { tagUuid, tagName, deskName? }
//   - system name = tagName; display name (desk_name) = user input, null → UI falls back
//   - classifies EXISTING notes carrying the tag into the new deck
//     (no content is pulled — shared-card classification model)
//   - validation failures return { error } for inline display in the dialog
export async function POST(req: NextRequest) {
  await requireAuth()
  const body = await req.json().catch(() => null)
  const tagUuid = typeof body?.tagUuid === 'string' ? body.tagUuid.trim() : ''
  const tagName = typeof body?.tagName === 'string' ? body.tagName.trim() : ''
  const deskName = typeof body?.deskName === 'string' ? body.deskName.trim() : ''
  if (!tagUuid || !tagName) {
    return NextResponse.json({ error: '请选择 tag' }, { status: 400 })
  }

  // tag already used by a deck?
  const dup = await db
    .selectFrom('decks')
    .select('id')
    .where('logseq_uuid', '=', tagUuid)
    .where('deleted', '=', false)
    .executeTakeFirst()
  if (dup) {
    return NextResponse.json({ error: '该 tag 已是 deck' }, { status: 409 })
  }

  const cfg = await loadConfig().catch(() => null)
  if (!cfg) {
    return NextResponse.json({ error: 'Logseq token 或 graph 未配置' }, { status: 400 })
  }
  const client = new LogseqClient(cfg.token)

  // find local notes carrying the tag (classification only — no new content)
  let noteIds: number[] = []
  try {
    // the base #card tag powers the All deck — reject it as a separate deck
    const baseTagId = await client.findCardTagId(cfg.graphId)
    if (baseTagId && tagUuid === baseTagId) {
      return NextResponse.json({ error: '#card 是基础 tag，不能作为独立 deck' }, { status: 400 })
    }
    const objects = await client.listTagObjects(cfg.graphId, tagUuid)
    const uuids = objects.map((o) => o.uuid)
    if (uuids.length > 0) {
      const notes = await db
        .selectFrom('notes')
        .select('id')
        .where('deleted', '=', false)
        .where('logseq_uuid', 'in', uuids)
        .execute()
      noteIds = notes.map((n) => n.id)
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Logseq 请求失败' }, { status: 400 })
  }

  const now = Date.now()
  let deckId: number
  try {
    deckId = await db
      .transaction()
      .execute(async (trx) => {
        // deck row + memberships are atomic: a failed classification rolls
        // the deck back too (no orphan "empty deck")
        const d = await trx
          .insertInto('decks')
          .values({
            name: tagName,
            desk_name: deskName || null,
            tag_name: tagName,
            logseq_uuid: tagUuid,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        if (noteIds.length > 0) {
          await trx
            .insertInto('note_decks')
            .values(noteIds.map((nid) => ({ nid, did: d.id, deleted: false, created: now })))
            .onConflict((oc) => oc.columns(['nid', 'did']).doUpdateSet({ deleted: false }))
            .execute()
        }
        return d.id
      })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? '创建失败' }, { status: 500 })
  }

  return NextResponse.json({
    deck: { id: deckId, name: deskName || tagName },
    matched: noteIds.length,
  })
}
