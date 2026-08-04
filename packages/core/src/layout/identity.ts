import type { DiagramEdge, DiagramNode } from "../types.js";
import type { LayoutIdentity } from "./types.js";

type IdentitySource = Pick<DiagramNode, "id" | "semanticId" | "sourceKey">
  | Pick<DiagramEdge, "id" | "sourceKey"> & { semanticId?: string };

export function selectLayoutIdentity(source: IdentitySource): LayoutIdentity {
  if (isNonEmpty(source.semanticId)) return { kind: "semanticId", value: source.semanticId };
  if (isNonEmpty(source.sourceKey)) return { kind: "sourceKey", value: source.sourceKey };
  if (!isNonEmpty(source.id)) {
    throw new Error("A layout object requires id, sourceKey, or semanticId.");
  }
  return { kind: "id", value: source.id };
}

export function layoutIdentityKey(identity: LayoutIdentity): string {
  return `${identity.kind}:${identity.value}`;
}

export function sameLayoutIdentity(left: LayoutIdentity, right: LayoutIdentity): boolean {
  return left.kind === right.kind && left.value === right.value;
}

export function objectMatchesLayoutIdentity(
  source: IdentitySource,
  identity: LayoutIdentity,
): boolean {
  return identity.kind === "id"
    ? source.id === identity.value
    : identity.kind === "sourceKey"
      ? source.sourceKey === identity.value
      : source.semanticId === identity.value;
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
