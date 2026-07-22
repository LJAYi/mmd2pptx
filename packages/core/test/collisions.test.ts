import { describe, expect, it } from "vitest";

import { analyzeDiagramCollisions } from "../src/routing/index.js";
import type { DiagramIR } from "../src/types.js";

describe("analyzeDiagramCollisions", () => {
  it("reports all required collision kinds in deterministic order", () => {
    const diagram: DiagramIR = {
      width: 260,
      height: 260,
      nodes: [
        { id: "overlap-a", kind: "rect", bounds: { x: 0, y: 0, width: 40, height: 40 } },
        { id: "overlap-b", kind: "rect", bounds: { x: 20, y: 20, width: 40, height: 40 } },
        { id: "blocker", kind: "rect", bounds: { x: 80, y: 0, width: 40, height: 40 } },
        {
          id: "label-owner",
          kind: "rect",
          bounds: { x: 200, y: 200, width: 40, height: 40 },
          text: { text: "floating", bounds: { x: 95, y: 12, width: 20, height: 16 } },
        },
      ],
      edges: [{
        id: "crossing",
        start: { x: 60, y: 20 },
        end: { x: 150, y: 20 },
        label: { text: "on node", bounds: { x: 5, y: 5, width: 20, height: 15 } },
      }],
    };

    const first = analyzeDiagramCollisions(diagram);
    const second = analyzeDiagramCollisions(diagram);

    expect(first).toEqual(second);
    expect(new Set(first.map(({ kind }) => kind))).toEqual(new Set([
      "label-edge",
      "node-edge",
      "node-label",
      "node-node",
    ]));
    expect(first).toContainEqual(expect.objectContaining({
      first: { id: "blocker", kind: "node" },
      kind: "node-edge",
      second: { id: "crossing", kind: "edge" },
    }));
  });

  it("does not report expected owner or endpoint intersections", () => {
    const diagram: DiagramIR = {
      width: 200,
      height: 80,
      nodes: [
        {
          id: "renderer-a",
          semanticId: "A",
          kind: "rect",
          bounds: { x: 0, y: 0, width: 40, height: 40 },
          text: { text: "A", bounds: { x: 5, y: 5, width: 30, height: 30 } },
        },
        {
          id: "renderer-b",
          semanticId: "B",
          kind: "rect",
          bounds: { x: 160, y: 0, width: 40, height: 40 },
          text: { text: "B", bounds: { x: 165, y: 5, width: 30, height: 30 } },
        },
      ],
      edges: [{
        id: "A-to-B",
        sourceId: "A",
        targetId: "B",
        start: { x: 40, y: 20 },
        end: { x: 160, y: 20 },
        label: { text: "self", bounds: { x: 85, y: 12, width: 30, height: 16 } },
      }],
    };

    expect(analyzeDiagramCollisions(diagram)).toEqual([]);
  });

  it("flattens curved paths deterministically for intersection checks", () => {
    const diagram: DiagramIR = {
      width: 120,
      height: 80,
      nodes: [{
        id: "curve-blocker",
        kind: "rect",
        bounds: { x: 45, y: 5, width: 10, height: 20 },
      }],
      edges: [{
        id: "curve",
        start: { x: 0, y: 50 },
        end: { x: 100, y: 50 },
        path: { segments: [
          { kind: "move", to: { x: 0, y: 50 } },
          {
            kind: "cubic",
            control1: { x: 30, y: 0 },
            control2: { x: 70, y: 0 },
            to: { x: 100, y: 50 },
          },
        ] },
      }],
    };

    expect(analyzeDiagramCollisions(diagram)).toContainEqual({
      first: { id: "curve-blocker", kind: "node" },
      kind: "node-edge",
      second: { id: "curve", kind: "edge" },
    });
  });
});
