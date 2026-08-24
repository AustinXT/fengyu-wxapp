export function buildFormNavigationHref(
  action: string,
  entries: Iterable<[string, FormDataEntryValue]>,
): string {
  const params = new URLSearchParams()
  for (const [name, value] of entries) {
    if (typeof value === "string" && value !== "") params.append(name, value)
  }
  return params.size ? `${action}?${params.toString()}` : action
}
