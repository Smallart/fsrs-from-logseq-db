import { NextResponse } from 'next/server'
import { logout } from '@server/libs/auth'

export async function POST() {
  await logout()
  return NextResponse.json({ ok: true })
}
