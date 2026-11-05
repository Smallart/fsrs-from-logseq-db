import { NextRequest, NextResponse } from 'next/server'
import { db } from '@server/models/db'
import { requireAuth } from '@server/libs/auth'

export async function GET() {
  await requireAuth()
  const row = await db.selectFrom('config').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()
  return NextResponse.json(row)
}

export async function PUT(req: NextRequest) {
  await requireAuth()
  const { token, graph_id } = await req.json()
  await db.updateTable('config').set({ token: token ?? null, graph_id: graph_id ?? null }).where('id', '=', 1).execute()
  return NextResponse.json({ ok: true })
}
