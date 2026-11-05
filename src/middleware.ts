import { NextResponse, type NextRequest } from 'next/server'

// Edge-compatible: only checks that a session cookie exists.
// Real signature verification happens in route handlers via requireAuth()
// (Node runtime, uses the crypto module).
const SESSION_COOKIE = 'fsrs_session'

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (
    pathname === '/login' ||
    pathname.startsWith('/api/auth/login') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next()
  }
  const session = req.cookies.get(SESSION_COOKIE)?.value
  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
