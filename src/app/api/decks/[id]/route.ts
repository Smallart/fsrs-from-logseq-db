import { NextRequest, NextResponse } from 'next/server'
import { db } from '@server/models/db'
import { requireAuth } from '@server/libs/auth'
import type { CardLimitRow, FSRSParametersRow } from '@server/models'

// pg serializes JS arrays as PG array literals (invalid JSON for jsonb), so
// stringify explicitly — same fix as notes.answer in the sync service.
const jsonb = <T>(v: unknown) => JSON.stringify(v) as unknown as T

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  await requireAuth()
  const id = Number(params.id)
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: 'invalid deck id' }, { status: 400 })
  }
  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  await db
    .updateTable('decks')
    .set({
      ...(body.fsrs ? { fsrs: jsonb<FSRSParametersRow>(body.fsrs) } : {}),
      ...(body.card_limit ? { card_limit: jsonb<CardLimitRow>(body.card_limit) } : {}),
      ...(typeof body.p_due === 'number' ? { p_due: body.p_due } : {}),
      updated: Date.now(),
    })
    .where('id', '=', id)
    .execute()

  const row = await db.selectFrom('decks').selectAll().where('id', '=', id).executeTakeFirst()
  return NextResponse.json(row ?? { ok: true })
}
