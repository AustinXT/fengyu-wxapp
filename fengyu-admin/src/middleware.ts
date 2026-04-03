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
    // Session expired: clear stale cookie and stay on login
    if (pathname === '/login' && request.nextUrl.searchParams.has('expired')) {
      const response = NextResponse.redirect(new URL('/login', request.url))
      response.cookies.delete(COOKIE_NAME)
      return response
    }

    // If user has valid token and is on /login, redirect appropriately
    const token = request.cookies.get(COOKIE_NAME)?.value
    if (token && pathname === '/login') {
      try {
        const { payload } = await jwtVerify(token, JWT_SECRET)
        // AC-03: 首次登录或重置后必须先改密码
        if (payload.mustChange === true) {
          return NextResponse.redirect(new URL('/change-password', request.url))
        }
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
    const { payload } = await jwtVerify(token, JWT_SECRET)

    // AC-03: mustChange=true 时强制跳转到改密码页，阻止访问任何其他路由
    if (payload.mustChange === true) {
      return NextResponse.redirect(new URL('/change-password', request.url))
    }

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
