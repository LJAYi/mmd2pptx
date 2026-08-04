import { describe, expect, it } from "vitest";

import { LayoutHistory } from "../../src/layout/index.js";

describe("LayoutHistory", () => {
  it("supports undo, redo, branch replacement, and reset", () => {
    const history = new LayoutHistory("auto");
    history.commit("move-1");
    history.commit("move-2");

    expect(history.undo()).toBe("move-1");
    expect(history.undo()).toBe("auto");
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toBe("move-1");
    expect(history.canRedo).toBe(true);

    history.commit("branch");
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBe("move-1");

    history.reset("fresh-source");
    expect(history.value).toBe("fresh-source");
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
