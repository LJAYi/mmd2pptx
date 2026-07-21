export function normalizeFontFamily(raw: string | null | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const first = raw.trim().match(/^(?:(["'])(.*?)\1|([^,]+))/);
  const normalized = (first?.[2] ?? first?.[3] ?? "")
    .replace(/[\u0000-\u001f\u007f"<>]/g, "")
    .trim();
  return normalized || undefined;
}
