import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"

const CHAT_ACTION = process.env.ANALYST_CHAT_ACTION || process.env.ANALYST_VIEW_ACTION || "data_center:dashboard"

export async function POST() {
  const session = await getSession()

  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 })
  }

  if (!hasPermission(session, CHAT_ACTION)) {
    return NextResponse.json({ error: "PERMISSION_DENIED" }, { status: 403 })
  }

  return NextResponse.json(
    { error: "NOT_IMPLEMENTED", message: "Agent chat route is reserved for Vercel AI SDK integration." },
    { status: 501 },
  )
}

