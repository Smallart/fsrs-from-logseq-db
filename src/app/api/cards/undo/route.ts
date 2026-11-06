import { NextRequest, NextResponse } from 'next/server'
import { scheduler } from '@server/services/scheduler'
import { requireAuth } from '@server/libs/auth'
import { log } from '@server/libs/logger'

// body: { cid: number, lid: number }
export async function POST(req: NextRequest) {
  await requireAuth()
  const { cid, lid } = await req.json()
  if (typeof cid !== 'number' || typeof lid !== 'number') {
    return NextResponse.json({ error: 'invalid cid or lid' }, { status: 400 })
  }
  const r = await scheduler.undo(cid, lid)
  log('info', 'undo', { cid, lid, ok: !!r })
  return NextResponse.json(r)
}
