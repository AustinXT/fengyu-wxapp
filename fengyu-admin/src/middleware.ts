import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'fengyu-admin-jwt-secret-dev-only'
)
const COOKIE_NAME = 'fy-admin-token'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Auth pages: allow without token
  if (pathname.startsWith('/login') || pathname.startsWith('/change-password')) {
    // If user has valid token and is on /login, redirect to dashboard
    const token = request.cookies.get(COOKIE_NAME)?.value
    if (token && pathname === '/login') {
      try {
        await jwtVerify(token, JWT_SECRET)
        return NextResponse.redirect(new URL('/dashboard', request.url))
      } catch {
        // Invalid token, let them stay on login
      }
    }
    return NextResponse.next()
  }

  // Protected routes: require valid JWT
  const token = request.cookies.get(COOKIE_NAME)?.value
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  try {
    await jwtVerify(token, JWT_SECRET)
    return NextResponse.next()
  } catch {
    // Expired or invalid token
    const response = NextResponse.redirect(new URL('/login', request.url))
    response.cookies.delete(COOKIE_NAME)
    return response
  }
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
}
