import type { LayoutBounds } from "@mmd2pptx/core";

export type Alignment = "bottom" | "center" | "left" | "middle" | "right" | "top";
export type Distribution = "horizontal" | "vertical";
export type ZOrderAction = "back" | "backward" | "forward" | "front";

export interface ArrangeItem {
  bounds: LayoutBounds;
  key: string;
}

export function alignItems(
  items: readonly ArrangeItem[],
  alignment: Alignment,
): ArrangeItem[] {
  if (items.length < 2) return cloneItems(items);
  const left = Math.min(...items.map(({ bounds }) => bounds.x));
  const top = Math.min(...items.map(({ bounds }) => bounds.y));
  const right = Math.max(...items.map(({ bounds }) => bounds.x + bounds.width));
  const bottom = Math.max(...items.map(({ bounds }) => bounds.y + bounds.height));
  const center = (left + right) / 2;
  const middle = (top + bottom) / 2;
  return items.map((item) => ({
    key: item.key,
    bounds: {
      ...item.bounds,
      x: alignment === "left" ? left
        : alignment === "right" ? right - item.bounds.width
          : alignment === "center" ? center - item.bounds.width / 2
            : item.bounds.x,
      y: alignment === "top" ? top
        : alignment === "bottom" ? bottom - item.bounds.height
          : alignment === "middle" ? middle - item.bounds.height / 2
            : item.bounds.y,
    },
  }));
}

export function distributeItems(
  items: readonly ArrangeItem[],
  direction: Distribution,
): ArrangeItem[] {
  if (items.length < 3) return cloneItems(items);
  const horizontal = direction === "horizontal";
  const sorted = cloneItems(items).sort((left, right) => {
    const leftPosition = horizontal ? left.bounds.x : left.bounds.y;
    const rightPosition = horizontal ? right.bounds.x : right.bounds.y;
    return leftPosition - rightPosition || left.key.localeCompare(right.key);
  });
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  const start = horizontal ? first.bounds.x : first.bounds.y;
  const end = horizontal
    ? last.bounds.x + last.bounds.width
    : last.bounds.y + last.bounds.height;
  const totalSize = sorted.reduce((sum, item) =>
    sum + (horizontal ? item.bounds.width : item.bounds.height), 0);
  const gap = (end - start - totalSize) / (sorted.length - 1);
  let cursor = start;
  for (const item of sorted) {
    if (horizontal) item.bounds.x = cursor;
    else item.bounds.y = cursor;
    cursor += (horizontal ? item.bounds.width : item.bounds.height) + gap;
  }
  return sorted;
}

export function moveZOrder(
  order: readonly string[],
  selected: ReadonlySet<string>,
  action: ZOrderAction,
): string[] {
  if (selected.size === 0) return [...order];
  if (action === "front") {
    return [...order.filter((key) => !selected.has(key)), ...order.filter((key) => selected.has(key))];
  }
  if (action === "back") {
    return [...order.filter((key) => selected.has(key)), ...order.filter((key) => !selected.has(key))];
  }
  const next = [...order];
  if (action === "forward") {
    for (let index = next.length - 2; index >= 0; index -= 1) {
      if (selected.has(next[index]!) && !selected.has(next[index + 1]!)) {
        [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
      }
    }
  } else {
    for (let index = 1; index < next.length; index += 1) {
      if (selected.has(next[index]!) && !selected.has(next[index - 1]!)) {
        [next[index], next[index - 1]] = [next[index - 1]!, next[index]!];
      }
    }
  }
  return next;
}

function cloneItems(items: readonly ArrangeItem[]): ArrangeItem[] {
  return items.map((item) => ({ bounds: { ...item.bounds }, key: item.key }));
}
