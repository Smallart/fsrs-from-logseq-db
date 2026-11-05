import { NextRequest, NextResponse } from 'next/server'
import { scheduler } from '@server/services/scheduler'
import { requireAuth } from '@server/libs/auth'

export async function GET(req: NextRequest) {
  await requireAuth()
  const deckParam = new URL(req.url).searchParams.get('deck')
  const deckId = deckParam ? Number(deckParam) : undefined
  const card = await scheduler.next(deckId)
  return NextResponse.json(card ?? { empty: true })
}
