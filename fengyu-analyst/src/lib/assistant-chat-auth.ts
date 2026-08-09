import "server-only"

import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"
import type { AuthSession } from "@/lib/types"

export const ANALYST_CHAT_ACTION =
  process.env.ANALYST_CHAT_ACTION || process.env.ANALYST_VIEW_ACTION || "data_center:dashboard"

export async function getAuthorizedAssistantChatSession(): Promise<AuthSession | NextResponse> {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 })
  }
  if (!hasPermission(session, ANALYST_CHAT_ACTION)) {
    return NextResponse.json({ error: "PERMISSION_DENIED" }, { status: 403 })
  }
  return session
}
