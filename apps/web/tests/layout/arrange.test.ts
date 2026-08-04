import { describe, expect, it } from "vitest";

import { alignItems, distributeItems, moveZOrder } from "../../src/layout/arrange.js";

const ITEMS = [
  { key: "a", bounds: { x: 10, y: 30, width: 40, height: 20 } },
  { key: "b", bounds: { x: 100, y: 80, width: 20, height: 40 } },
  { key: "c", bounds: { x: 200, y: 10, width: 60, height: 30 } },
];

describe("layout arrange operations", () => {
  it("aligns mixed-size nodes to selection bounds", () => {
    expect(alignItems(ITEMS, "left").map(({ bounds }) => bounds.x)).toEqual([10, 10, 10]);
    expect(alignItems(ITEMS, "right").map(({ bounds }) => bounds.x)).toEqual([220, 240, 200]);
    expect(alignItems(ITEMS, "middle").map(({ bounds }) => bounds.y)).toEqual([55, 45, 50]);
  });

  it("distributes edges evenly while preserving endpoint extents", () => {
    const horizontal = distributeItems(ITEMS, "horizontal");
    expect(horizontal.map(({ bounds }) => bounds.x)).toEqual([10, 115, 200]);
    expect(horizontal.at(-1)!.bounds.x + horizontal.at(-1)!.bounds.width).toBe(260);
  });

  it("moves one or many selected nodes through paint order deterministically", () => {
    const selected = new Set(["b", "c"]);
    expect(moveZOrder(["a", "b", "c", "d"], selected, "front"))
      .toEqual(["a", "d", "b", "c"]);
    expect(moveZOrder(["a", "b", "c", "d"], selected, "forward"))
      .toEqual(["a", "d", "b", "c"]);
    expect(moveZOrder(["a", "b", "c", "d"], selected, "back"))
      .toEqual(["b", "c", "a", "d"]);
  });
});
