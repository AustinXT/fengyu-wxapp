import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { JWT_SECRET } from '@/lib/jwt-secret'

const COOKIE_NAME = 'fy-admin-token'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  
  if (pathname.startsWith('/login') || pathname.startsWith('/change-password')) {
    
    if (pathname === '/login' && request.nextUrl.searchParams.has('expired')) {
      const response = NextResponse.redirect(new URL('/login', request.url))
      response.cookies.delete(COOKIE_NAME)
      return response
    }

    
    const token = request.cookies.get(COOKIE_NAME)?.value
    if (token && pathname === '/login') {
      try {
        const { payload } = await jwtVerify(token, JWT_SECRET)
        
        if (payload.mustChange === true) {
          return NextResponse.redirect(new URL('/change-password', request.url))
        }
        return NextResponse.redirect(new URL('/dashboard', request.url))
      } catch {
        
      }
    }
    return NextResponse.next()
  }

  
  const token = request.cookies.get(COOKIE_NAME)?.value
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET)

    
    if (payload.mustChange === true) {
      return NextResponse.redirect(new URL('/change-password', request.url))
    }

    return NextResponse.next()
  } catch {
    
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
