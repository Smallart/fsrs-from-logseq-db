import { NextRequest, NextResponse } from 'next/server'
import { sync } from '@server/services/sync'
import { requireAuth } from '@server/libs/auth'
import { log } from '@server/libs/logger'

export async function POST(req: NextRequest) {
  await requireAuth()
  const body = await req.json().catch(() => ({}))
  const fullCheck = body?.fullCheck === true
  log('info', 'sync start', { fullCheck })
  const t0 = Date.now()
  try {
    const report = await sync({ fullCheck })
    log('info', 'sync done', { ...report, durationMs: Date.now() - t0 })
    return NextResponse.json(report)
  } catch (e: any) {
    log('error', 'sync failed', { message: e?.message, stack: e?.stack })
    return NextResponse.json({ error: e?.message ?? 'sync failed' }, { status: 500 })
  }
}
