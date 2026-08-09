import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { JWT_SECRET } from '@/lib/jwt-secret'

const COOKIE_NAME = 'fy-admin-token'

function deleteSessionCookie(response: NextResponse) {
  const domain = process.env.COOKIE_DOMAIN?.trim()
  if (domain) {
    response.cookies.set(COOKIE_NAME, '', {
      domain,
      path: '/',
      expires: new Date(0),
    })
    return
  }
  response.cookies.delete(COOKIE_NAME)
}

function requestOrigin(request: NextRequest): string {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const host = forwardedHost || request.headers.get('host')
  const protocol = forwardedProto || request.nextUrl.protocol.replace(':', '') || 'http'
  return host ? `${protocol}://${host}` : request.nextUrl.origin
}

function addAnalystOrigins(allowedOrigins: Set<string>, baseOrigin: string) {
  // 优先使用显式配置的 analyst origin
  const configured = process.env.NEXT_PUBLIC_ANALYST_ORIGIN
  if (configured) {
    try {
      allowedOrigins.add(new URL(configured).origin)
    } catch {
      console.warn('[middleware] Invalid NEXT_PUBLIC_ANALYST_ORIGIN:', configured)
    }
  }

  // 仅在开发环境添加动态端口白名单
  if (process.env.NODE_ENV !== 'production') {
    const base = new URL(baseOrigin)
    allowedOrigins.add(`${base.protocol}//${base.hostname}:3001`)
    allowedOrigins.add(`${base.protocol}//${base.hostname}:3100`)
  }
}

function safeReturnTo(request: NextRequest): string | null {
  const raw = request.nextUrl.searchParams.get('returnTo')
  if (!raw) return null

  try {
    const origin = requestOrigin(request)
    const target = new URL(raw, origin)
    const allowedOrigins = new Set([origin])
    addAnalystOrigins(allowedOrigins, origin)

    if (!allowedOrigins.has(target.origin)) return null
    return target.toString()
  } catch {
    return null
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Auth pages: allow without token
  if (pathname.startsWith('/login') || pathname.startsWith('/change-password')) {
    // Session expired: clear stale cookie and stay on login
    if (pathname === '/login' && request.nextUrl.searchParams.has('expired')) {
      const response = NextResponse.redirect(new URL('/login', request.url))
      deleteSessionCookie(response)
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
        const returnTo = safeReturnTo(request)
        if (returnTo) {
          return NextResponse.redirect(returnTo)
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
    deleteSessionCookie(response)
    return response
  }
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
}
