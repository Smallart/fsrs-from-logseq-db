import { NextResponse } from 'next/server'
import { requireAuth } from '@server/libs/auth'
import { GatewayClient, GatewayError } from '@server/libs/gateway'
import { loadConfig } from '@server/services/sync'
import { log } from '@server/libs/logger'

// POST /api/gateway/auth/ensure — proxy to the gateway's POST /api/auth/ensure.
// Called by the settings page before every sync pull so a dead Logseq cloud
// token surfaces immediately (with the reason) instead of as opaque sync
// failures. The gateway re-logins only when the token is missing/expired/
// expiring-soon; a valid token is returned as-is.
// Request: no body. Reply: the gateway's TokenCheck (metadata only — the
// token itself is never exposed) or { error, code } on failure.
export async function POST() {
  await requireAuth()
  try {
    const { gatewayUrl } = await loadConfig()
    const check = await new GatewayClient(gatewayUrl).ensureAuth()
    log('info', 'gateway auth ensure', {
      expired: check.token.expired,
      expiringSoon: check.token.expiringSoon,
      remainingMs: check.token.remainingMs,
      email: check.token.email,
    })
    return NextResponse.json(check)
  } catch (e: any) {
    if (e instanceof GatewayError) {
      log('warn', 'gateway auth ensure failed', { status: e.status, code: e.code, message: e.message })
      return NextResponse.json(
        { error: e.message, code: e.code ?? 'gateway_error' },
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      )
    }
    log('error', 'gateway auth ensure error', { message: e?.message })
    return NextResponse.json({ error: e?.message ?? '鉴权检查失败' }, { status: 500 })
  }
}
