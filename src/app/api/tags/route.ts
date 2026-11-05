import { NextResponse } from 'next/server'
import { requireAuth } from '@server/libs/auth'
import { LogseqClient } from '@server/libs/logseq'
import { loadConfig } from '@server/services/sync'

// GET /api/tags — Logseq tag list for the "create tag deck" dropdown.
export async function GET() {
  await requireAuth()
  try {
    const { token, graphId } = await loadConfig()
    const client = new LogseqClient(token)
    const tags = await client.listTags(graphId)
    return NextResponse.json({ tags })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? '获取 tags 失败' }, { status: 400 })
  }
}
