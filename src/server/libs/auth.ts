import 'server-only'
import { cookies } from 'next/headers'
import { createHmac } from 'crypto'

const SESSION_COOKIE = 'fsrs_session'
const SECRET = process.env.SESSION_SECRET ?? 'dev_secret'
const PASSWORD = process.env.APP_PASSWORD ?? 'dev_password'

// Tiny signed-cookie auth (single user). Not production-grade crypto, but
// sufficient for a single-user app behind a password on a known host.
function sign(payload: string): string {
  const mac = createHmac('sha256', SECRET).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

function verify(token: string): boolean {
  const idx = token.lastIndexOf('.')
  if (idx < 0) return false
  const payload = token.slice(0, idx)
  const mac = token.slice(idx + 1)
  return sign(payload) === token && payload === 'ok'
}

export async function login(password: string): Promise<boolean> {
  if (password !== PASSWORD) return false
  const token = await sign('ok')
  const c = await cookies()
  c.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  })
  return true
}

export async function logout(): Promise<void> {
  const c = await cookies()
  c.delete(SESSION_COOKIE)
}

export async function isAuthed(): Promise<boolean> {
  const c = await cookies()
  const token = c.get(SESSION_COOKIE)?.value
  if (!token) return false
  return verify(token)
}

export async function requireAuth(): Promise<void> {
  if (!(await isAuthed())) {
    throw new Response('Unauthorized', { status: 401 })
  }
}
