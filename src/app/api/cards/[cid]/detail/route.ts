import { NextRequest, NextResponse } from 'next/server'
import { db } from '@server/models/db'
import { requireAuth } from '@server/libs/auth'
import { GatewayClient } from '@server/libs/gateway'
import { loadConfig } from '@server/services/sync'
import { tsCardValues } from '@server/services/sync'
import { log } from '@server/libs/logger'

// GET /api/cards/:cid/detail — the review page's 显示答案 fetch.
// Answers are NEVER stored locally; they are requested from the gateway's
// single-card endpoint (§4.5) together with the block's freshest question +
// fsrs state. The returned state also wins last-write-wins locally when it
// is newer than our cached row (the block may have been reviewed by the
// desktop plugin in the meantime).
export async function GET(_req: NextRequest, { params }: { params: { cid: string } }) {
  await requireAuth()
  const cid = Number(params.cid)
  if (!Number.isInteger(cid) || cid <= 0) {
    return NextResponse.json({ error: 'invalid cid' }, { status: 400 })
  }

  const row = await db
    .selectFrom('cards as c')
    .innerJoin('notes as n', 'n.id', 'c.nid')
    .selectAll('c')
    .select('n.dbId as dbId')
    .where('c.id', '=', cid)
    .where('c.deleted', '=', false)
    .executeTakeFirst()
  if (!row) return NextResponse.json({ error: 'card not found' }, { status: 404 })

  const dbId = (row as { dbId: number | null }).dbId
  if (dbId === null) {
    return NextResponse.json({ error: 'card has no dbId (sync first)' }, { status: 409 })
  }

  const { gatewayUrl } = await loadConfig()
  const client = new GatewayClient(gatewayUrl)
  let fresh
  try {
    fresh = await client.fetchCardById(dbId)
  } catch (e: any) {
    log('error', 'card detail: gateway fetch failed', { cid, dbId, message: e?.message })
    return NextResponse.json({ error: e?.message ?? '网关请求失败' }, { status: 502 })
  }

  // last-write-wins: adopt the block's state when it is newer than ours
  const gw = fresh.card.lastReview
  const local = row.lastReview
  if (gw !== null && (local === null || gw > local)) {
    await db
      .updateTable('cards')
      .set({ ...tsCardValues(fresh.card), cardSource: fresh.cardSource, dirty: false, updated: Date.now() })
      .where('id', '=', cid)
      .execute()
  }

  return NextResponse.json({
    cid,
    question: fresh.question,
    answer: fresh.answer,
    card: fresh.card,
  })
}
