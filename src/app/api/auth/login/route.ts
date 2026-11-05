import { NextRequest, NextResponse } from 'next/server'
import { login } from '@server/libs/auth'

export async function POST(req: NextRequest) {
  const { password } = await req.json()
  const ok = await login(password)
  if (!ok) return NextResponse.json({ error: 'wrong password' }, { status: 401 })
  return NextResponse.json({ ok: true })
}
