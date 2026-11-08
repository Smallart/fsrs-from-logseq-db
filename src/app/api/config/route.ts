import { NextRequest, NextResponse } from 'next/server'
import { db } from '@server/models/db'
import { requireAuth } from '@server/libs/auth'

export async function GET() {
  await requireAuth()
  const row = await db.selectFrom('config').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()
  return NextResponse.json(row)
}

// PUT /api/config — save the logseq-cli2http gateway base URL
export async function PUT(req: NextRequest) {
  await requireAuth()
  const { gatewayUrl } = await req.json()
  const url = typeof gatewayUrl === 'string' ? gatewayUrl.trim() : null
  if (url !== null && !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: '网关 URL 必须以 http:// 或 https:// 开头' }, { status: 400 })
  }
  await db.updateTable('config').set({ gatewayUrl: url }).where('id', '=', 1).execute()
  return NextResponse.json({ ok: true })
}
