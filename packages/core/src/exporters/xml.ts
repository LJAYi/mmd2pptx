export function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function finite(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

export function number(value: number, field = "geometry"): string {
  const checked = finite(value, field);
  return Number.isInteger(checked)
    ? String(checked)
    : checked.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/** Stable, readable, XML-name-safe ID derived only from source identity. */
export function stableId(kind: string, sourceId: string): string {
  const slug = sourceId
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "item";
  return `${kind}-${slug}-${fnv1a(sourceId)}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function normalizeColor(value: string | undefined, fallback: string): string {
  const color = (value ?? fallback).trim();
  if (/^[0-9a-f]{3,8}$/i.test(color)) {
    return `#${color}`;
  }
  return color;
}

/**
 * Keep untrusted public-IR values inside a single CSS/draw.io style value.
 *
 * XML escaping alone is insufficient here: a semicolon remains a declaration
 * separator after the XML attribute is decoded. Deliberately accept only the
 * portable color forms emitted by Mermaid and fall back for everything else.
 */
export function styleColor(value: string | undefined, fallback: string): string {
  const color = normalizeColor(value, fallback);
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^[a-z][a-z0-9-]*$/i.test(color)) return color;
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[-+.\d%]+(?:\s*[,/]?\s*[-+.\d%]+){2,4}\s*\)$/i.test(color)) {
    return color;
  }
  return normalizeColor(fallback, fallback);
}

/** Restrict a font family to inert CSS/draw.io text, never style syntax. */
export function styleFontFamily(value: string | undefined, fallback = "Arial"): string {
  const family = (value ?? fallback).trim();
  return family.length > 0
    && family.length <= 200
    && !/[;={}<>\\\u0000-\u001f\u007f]/.test(family)
    && !/url\s*\(/i.test(family)
    ? family
    : fallback;
}

export function assertUniqueIds(
  kind: string,
  values: readonly { readonly id: string }[],
): void {
  const ids = new Set<string>();
  for (const { id } of values) {
    if (ids.has(id)) throw new TypeError(`Duplicate ${kind} id: ${id}`);
    ids.add(id);
  }
}
