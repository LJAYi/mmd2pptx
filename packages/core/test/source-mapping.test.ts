import { describe, expect, it } from "vitest";

import {
  extractMermaidFlowchartSemantics,
  mergeMermaidSemantics,
  parseMermaidSvg,
  type DiagramIR,
} from "../src/index.js";

function flowDbFixture() {
  return {
    getVertices() {
      return new Map([
        ["A", { id: "A", domId: "flowchart-A-0", text: "Start" }],
        ["B", { id: "B", domId: "flowchart-B-1", text: "Review" }],
        ["C", { id: "C", domId: "flowchart-C-2", text: "Done" }],
      ]);
    },
    getEdges() {
      return [
        { id: "L_A_B_0", start: "A", end: "B", text: "primary" },
        { id: "L_A_B_2", start: "A", end: "B", text: "alternate" },
        { id: "L_B_C_0", start: "B", end: "C", text: "" },
      ];
    },
    getSubGraphs() {
      // FlowDB represents nesting by including a subgraph id in nodes.
      return [
        { id: "inner", nodes: ["B"], title: "Inner" },
        { id: "outer", nodes: ["A", "inner"], title: "Outer" },
      ];
    },
  };
}

function diagramFixture(): DiagramIR {
  return {
    edges: [
      edge("svg-edge-one", "L_A_B_0", "flowchart-A-0", "flowchart-B-1", 20),
      edge("svg-edge-two", "L_A_B_2", "flowchart-A-0", "flowchart-B-1", 30),
      edge("svg-edge-three", "L_B_C_0", "flowchart-B-1", "flowchart-C-2", 40),
    ],
    groups: [
      { bounds: { x: 0, y: 0, width: 120, height: 80 }, id: "outer" },
      { bounds: { x: 40, y: 0, width: 40, height: 80 }, id: "inner" },
    ],
    height: 100,
    nodes: [
      node("flowchart-A-0", 0),
      node("flowchart-B-1", 40),
      node("flowchart-C-2", 80),
    ],
    width: 120,
  };
}

describe("Mermaid FlowDB source semantics", () => {
  it("extracts stable nodes, parallel edges, and nested subgraphs structurally", () => {
    const result = extractMermaidFlowchartSemantics({
      db: flowDbFixture(),
      type: "flowchart-v2",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.graph?.edges).toEqual([
      { id: "L_A_B_0", order: 0, sourceId: "A", targetId: "B" },
      { id: "L_A_B_2", order: 1, sourceId: "A", targetId: "B" },
      { id: "L_B_C_0", order: 2, sourceId: "B", targetId: "C" },
    ]);
    expect(result.graph?.nodes).toEqual([
      { id: "A", parentId: "outer", rendererId: "flowchart-A-0" },
      { id: "B", parentId: "inner", rendererId: "flowchart-B-1" },
      { id: "C", rendererId: "flowchart-C-2" },
    ]);
    expect(result.graph?.groups).toEqual([
      { id: "inner", groupIds: [], nodeIds: ["B"], parentId: "outer" },
      { id: "outer", groupIds: ["inner"], nodeIds: ["A"] },
    ]);
  });

  it("returns diagnostics instead of throwing for unsupported or failing databases", () => {
    expect(extractMermaidFlowchartSemantics({ type: "sequence", db: {} }))
      .toMatchObject({ graph: null, diagnostics: [{ code: "MERMAID_FLOWDB_UNSUPPORTED" }] });
    expect(extractMermaidFlowchartSemantics({
      getEdges: () => [],
      getSubGraphs: () => [],
      getVertices: () => { throw new Error("not initialized"); },
    })).toMatchObject({
      graph: null,
      diagnostics: [{ code: "MERMAID_FLOWDB_READ_FAILED" }],
    });
  });

  it("immutably overlays semantics while retaining SVG geometry and styles", () => {
    const diagram = diagramFixture();
    const before = structuredClone(diagram);
    const graph = extractMermaidFlowchartSemantics(flowDbFixture()).graph!;
    const result = mergeMermaidSemantics(diagram, graph);

    expect(diagram).toEqual(before);
    expect(result.diagnostics).toEqual([]);
    expect(result.data.nodes.map(({ semanticId, sourceKey, parentId }) => ({
      parentId,
      semanticId,
      sourceKey,
    }))).toEqual([
      { parentId: "outer", semanticId: "A", sourceKey: "A" },
      { parentId: "inner", semanticId: "B", sourceKey: "B" },
      { parentId: undefined, semanticId: "C", sourceKey: "C" },
    ]);
    expect(result.data.groups).toEqual([
      expect.objectContaining({ id: "outer", semanticId: "outer", sourceKey: "outer" }),
      expect.objectContaining({ id: "inner", parentId: "outer", semanticId: "inner" }),
    ]);
    expect(result.data.edges.map(({ sourceKey, sourceId, targetId, path }) => ({
      path,
      sourceId,
      sourceKey,
      targetId,
    }))).toEqual([
      expect.objectContaining({ sourceId: "A", sourceKey: "L_A_B_0", targetId: "B" }),
      expect.objectContaining({ sourceId: "A", sourceKey: "L_A_B_2", targetId: "B" }),
      expect.objectContaining({ sourceId: "B", sourceKey: "L_B_C_0", targetId: "C" }),
    ]);
  });

  it("accepts semantics in parseMermaidSvg and order-matches parallel edges", () => {
    const graph = extractMermaidFlowchartSemantics(flowDbFixture()).graph!;
    const parsed = parseMermaidSvg(`
      <svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg">
        <g class="node" id="flowchart-A-0" data-id="A"><rect x="0" y="20" width="20" height="20"/></g>
        <g class="node" id="flowchart-B-1" data-id="B"><rect x="80" y="20" width="20" height="20"/></g>
        <g class="node" id="flowchart-C-2" data-id="C"><rect x="100" y="60" width="20" height="20"/></g>
        <path class="flowchart-link" id="renderer-edge-1" d="M 20 25 L 80 25"/>
        <path class="flowchart-link" id="renderer-edge-2" d="M 20 35 L 80 35"/>
        <path class="flowchart-link" id="renderer-edge-3" d="M 100 40 L 110 60"/>
      </svg>
    `, { semantics: graph });

    expect(parsed.data.edges.map(({ sourceKey, sourceId, targetId }) => ({
      sourceId,
      sourceKey,
      targetId,
    }))).toEqual([
      { sourceId: "A", sourceKey: "L_A_B_0", targetId: "B" },
      { sourceId: "A", sourceKey: "L_A_B_2", targetId: "B" },
      { sourceId: "B", sourceKey: "L_B_C_0", targetId: "C" },
    ]);
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({
      code: "MERMAID_SEMANTIC_EDGE_ORDER_MATCH",
      elementId: "L_A_B_0",
    }));
  });

  it("diagnoses missing and ambiguous SVG identity matches explicitly", () => {
    const graph = extractMermaidFlowchartSemantics(flowDbFixture()).graph!;
    const diagram = diagramFixture();
    diagram.nodes.push({ ...diagram.nodes[0]!, id: "copy-of-a" });
    diagram.nodes = diagram.nodes.filter(({ id }) => id !== "flowchart-C-2");

    const result = mergeMermaidSemantics(diagram, graph);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MERMAID_SEMANTIC_NODE_AMBIGUOUS", elementId: "A" }),
      expect.objectContaining({ code: "MERMAID_SEMANTIC_NODE_MISSING", elementId: "C" }),
    ]));
  });
});

function node(id: string, x: number) {
  return {
    bounds: { x, y: 20, width: 20, height: 20 },
    fill: "#ffffff",
    id,
    kind: "rect" as const,
    sourceKey: id,
  };
}

function edge(id: string, sourceKey: string, sourceId: string, targetId: string, y: number) {
  return {
    color: "#111111",
    end: { x: 80, y },
    id,
    path: {
      segments: [
        { kind: "move" as const, to: { x: 20, y } },
        { kind: "line" as const, to: { x: 80, y } },
      ],
    },
    sourceId,
    sourceKey,
    start: { x: 20, y },
    targetId,
  };
}
