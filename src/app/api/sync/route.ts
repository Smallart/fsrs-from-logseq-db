import { NextRequest, NextResponse } from 'next/server'
import { sync } from '@server/services/sync'
import { requireAuth } from '@server/libs/auth'

export async function POST(req: NextRequest) {
  await requireAuth()
  const body = await req.json().catch(() => ({}))
  try {
    const report = await sync({ fullCheck: body?.fullCheck === true })
    return NextResponse.json(report)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'sync failed' }, { status: 500 })
  }
}
