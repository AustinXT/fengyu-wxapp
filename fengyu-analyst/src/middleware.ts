import { NextRequest, NextResponse } from "next/server"
import { jwtVerify } from "jose"

const COOKIE_NAME = "fy-admin-token"
const DEV_ONLY_FALLBACK = "fengyu-admin-jwt-secret-dev-only"

function jwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET
  if (secret && secret.length > 0) {
    return new TextEncoder().encode(secret)
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production")
  }
  return new TextEncoder().encode(DEV_ONLY_FALLBACK)
}

function redirectToAdminLogin(request: NextRequest) {
  const loginUrl = new URL(process.env.ADMIN_LOGIN_URL || "http://localhost:3000/login")
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  const host = forwardedHost || request.headers.get("host")
  const protocol = forwardedProto || request.nextUrl.protocol.replace(":", "") || "http"
  const returnTo = host
    ? `${protocol}://${host}${request.nextUrl.pathname}${request.nextUrl.search}`
    : request.nextUrl.href
  loginUrl.searchParams.set("returnTo", returnTo)
  return NextResponse.redirect(loginUrl)
}

export async function middleware(request: NextRequest) {
  const secret = jwtSecret()

  const token = request.cookies.get(COOKIE_NAME)?.value
  if (!token) return redirectToAdminLogin(request)

  try {
    await jwtVerify(token, secret)
    return NextResponse.next()
  } catch {
    const response = redirectToAdminLogin(request)
    response.cookies.delete(COOKIE_NAME)
    return response
  }
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|forbidden).*)"],
}
