import { NextRequest, NextResponse } from 'next/server'
import { scheduler } from '@server/services/scheduler'
import { requireAuth } from '@server/libs/auth'

// The card shape carries no `answer` — answers live in Logseq and are
// fetched per-card from the gateway when the user hits 显示答案
// (GET /api/cards/:cid/detail).
export async function GET(req: NextRequest) {
  await requireAuth()
  const deckParam = new URL(req.url).searchParams.get('deck')
  const deckId = deckParam ? Number(deckParam) : undefined
  const card = await scheduler.next(deckId)
  return NextResponse.json(card ?? { empty: true })
}
