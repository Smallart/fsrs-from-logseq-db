import { NextRequest, NextResponse } from 'next/server'
import { scheduler } from '@server/services/scheduler'
import { requireAuth } from '@server/libs/auth'
import { log } from '@server/libs/logger'

// body: { cid: number, grade: 1|2|3|4 }  (1=Again 2=Hard 3=Good 4=Easy)
// The app computes (ts-fsrs) and pushes the result to the gateway; on a
// conflict the block's state wins and is adopted locally (§4.2).
export async function POST(req: NextRequest) {
  await requireAuth()
  const { cid, grade } = await req.json()
  if (typeof cid !== 'number' || ![1, 2, 3, 4].includes(grade)) {
    return NextResponse.json({ error: 'invalid cid or grade' }, { status: 400 })
  }
  const r = await scheduler.review(cid, grade)
  log('info', 'review', {
    cid,
    grade,
    next_state: r.next_state,
    next_due: r.next_due,
    conflict: r.conflict,
  })
  return NextResponse.json(r)
}
