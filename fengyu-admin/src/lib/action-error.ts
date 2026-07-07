
export function actionErrorMessage(err: unknown, fallback: string): string {
  const digest = (err as { digest?: unknown } | null)?.digest
  const raw =
    (typeof digest === "string" && digest) ||
    (err instanceof Error ? err.message : "")
  if (
    !raw ||
    raw.includes("Server Components render") ||
    raw.includes("omitted in production")
  ) {
    return fallback
  }
  return raw.replace(/^[A-Z_]+:\s*/, "")
}
