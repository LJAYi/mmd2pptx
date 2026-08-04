import { describe, expect, it } from "vitest";

import {
  applyLayoutSidecar,
  createEmptyLayoutSidecar,
  layoutIdentityKey,
  parseLayoutSidecar,
  reconcileLayout,
  removeLayoutGroup,
  restoreAutomaticLayout,
  selectLayoutIdentity,
  serializeLayoutSidecar,
  setManualEdgeLayout,
  setManualGroupLayout,
  setManualNodeLayout,
  setNodeZIndex,
} from "../src/layout/index.js";
import type { DiagramIR } from "../src/types.js";
import type { LayoutSidecar } from "../src/layout/types.js";

const DIAGRAM: DiagramIR = {
  width: 320,
  height: 180,
  nodes: [
    {
      id: "renderer-flowchart-alpha-0",
      semanticId: "alpha",
      sourceKey: "alpha",
      kind: "rect",
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      text: { text: "Alpha", bounds: { x: 10, y: 10, width: 80, height: 30 } },
    },
    {
      id: "renderer-flowchart-beta-1",
      semanticId: "beta",
      sourceKey: "beta",
      kind: "roundRect",
      bounds: { x: 200, y: 0, width: 100, height: 50 },
    },
  ],
  edges: [{
    id: "renderer-edge-alpha-beta",
    sourceKey: "L_alpha_beta_0",
    sourceId: "alpha",
    targetId: "beta",
    start: { x: 100, y: 25 },
    end: { x: 200, y: 25 },
    points: [{ x: 100, y: 25 }, { x: 200, y: 25 }],
    path: { segments: [
      { kind: "move", to: { x: 100, y: 25 } },
      {
        kind: "cubic",
        control1: { x: 130, y: -20 },
        control2: { x: 170, y: 70 },
        to: { x: 200, y: 25 },
      },
    ] },
    label: { text: "route", bounds: { x: 130, y: 15, width: 40, height: 20 } },
  }],
};

describe("layout sidecar schema", () => {
  it("selects stable identities and canonicalizes parse/serialize order", () => {
    expect(selectLayoutIdentity(DIAGRAM.nodes[0]!)).toEqual({
      kind: "semanticId",
      value: "alpha",
    });
    expect(layoutIdentityKey(selectLayoutIdentity(DIAGRAM.edges[0]!)))
      .toBe("sourceKey:L_alpha_beta_0");

    const sidecar: LayoutSidecar = {
      schema: "mmd2pptx-layout",
      version: 1,
      nodes: [
        { identity: { kind: "semanticId", value: "beta" }, mode: "auto", bounds: { x: 200, y: 0, width: 100, height: 50 } },
        { identity: { kind: "semanticId", value: "alpha" }, mode: "manual", bounds: { x: 20, y: 100, width: 100, height: 50 } },
      ],
      edges: [],
    };
    const serialized = serializeLayoutSidecar(sidecar);
    expect(parseLayoutSidecar(serialized).nodes.map(({ identity }) => identity.value))
      .toEqual(["alpha", "beta"]);
    expect(serializeLayoutSidecar(parseLayoutSidecar(serialized))).toBe(serialized);
  });

  it("keeps legacy v1 edges valid and round-trips optional port and label fields", () => {
    const base = withDiagramNodes();
    const legacy = {
      ...base,
      edges: [{
        identity: { kind: "sourceKey" as const, value: "L_alpha_beta_0" },
        points: [{ x: 100, y: 25 }, { x: 200, y: 25 }],
        source: { kind: "semanticId" as const, value: "alpha" },
        target: { kind: "semanticId" as const, value: "beta" },
      }],
    };
    expect(parseLayoutSidecar(legacy).edges[0]).not.toHaveProperty("sourcePort");

    const extended = {
      ...legacy,
      nodes: legacy.nodes.map((node, index) => ({ ...node, zIndex: index + 3 })),
      edges: [{
        ...legacy.edges[0]!,
        labelOffset: { x: 8, y: -6 },
        labelZIndex: 12,
        sourcePort: "bottom" as const,
        targetPort: "top" as const,
        zIndex: 4,
      }],
    };
    expect(parseLayoutSidecar(serializeLayoutSidecar(extended)).edges[0]).toMatchObject({
      labelOffset: { x: 8, y: -6 },
      labelZIndex: 12,
      sourcePort: "bottom",
      targetPort: "top",
      zIndex: 4,
    });
    expect(parseLayoutSidecar(serializeLayoutSidecar(extended)).nodes[0]?.zIndex).toBe(3);
  });

  it("round-trips canonical curves and optional layout groups without breaking legacy v1", () => {
    let extended = setManualEdgeLayout(withDiagramNodes(), {
      identity: { kind: "sourceKey", value: "L_alpha_beta_0" },
      path: DIAGRAM.edges[0]!.path,
      points: [{ x: 100, y: 25 }, { x: 200, y: 25 }],
      source: { kind: "semanticId", value: "alpha" },
      target: { kind: "semanticId", value: "beta" },
    });
    extended = setManualGroupLayout(extended, {
      bounds: { x: -10, y: -20, width: 320, height: 100 },
      children: extended.nodes.map(({ identity }) => identity),
      id: "layout-group-1",
      zIndex: -1,
    });

    const parsed = parseLayoutSidecar(serializeLayoutSidecar(extended));
    expect(parsed.edges[0]?.path?.segments[1]).toMatchObject({
      kind: "cubic",
      control1: { x: 130, y: -20 },
      control2: { x: 170, y: 70 },
    });
    expect(parsed.groups?.[0]).toMatchObject({ id: "layout-group-1", zIndex: -1 });
    expect(parseLayoutSidecar(withDiagramNodes())).not.toHaveProperty("groups");
  });

  it("rejects malformed or dangling sidecar data with typed errors", () => {
    expect(() => parseLayoutSidecar("{oops"))
      .toThrow(expect.objectContaining({ code: "INVALID_JSON" }));
    expect(() => parseLayoutSidecar({
      schema: "mmd2pptx-layout",
      version: 1,
      nodes: [],
      edges: [{
        identity: { kind: "id", value: "edge" },
        source: { kind: "id", value: "missing" },
        target: { kind: "id", value: "missing" },
        points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      }],
    })).toThrow(expect.objectContaining({ code: "INVALID_SIDECAR" }));
    expect(() => parseLayoutSidecar({
      ...withDiagramNodes(),
      edges: [{
        identity: { kind: "sourceKey", value: "L_alpha_beta_0" },
        path: { segments: [
          { kind: "move", to: { x: 0, y: 0 } },
          { kind: "arc", largeArc: false, radiusX: -1, radiusY: 2, rotation: 0, sweep: true, to: { x: 1, y: 1 } },
        ] },
        points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        source: { kind: "semanticId", value: "alpha" },
        target: { kind: "semanticId", value: "beta" },
      }],
    })).toThrow(expect.objectContaining({ code: "INVALID_SIDECAR" }));
  });
});

describe("applyLayoutSidecar", () => {
  it("applies manual bounds and edge route to points/path/endpoints/label midpoint", () => {
    let sidecar = withDiagramNodes();
    sidecar = setManualNodeLayout(sidecar, { kind: "semanticId", value: "alpha" }, {
      x: 20, y: 100, width: 100, height: 50,
    });
    sidecar = setManualEdgeLayout(sidecar, {
      identity: { kind: "sourceKey", value: "L_alpha_beta_0" },
      source: { kind: "semanticId", value: "alpha" },
      target: { kind: "semanticId", value: "beta" },
      points: [{ x: 120, y: 125 }, { x: 160, y: 75 }, { x: 200, y: 25 }],
    });

    const applied = applyLayoutSidecar(DIAGRAM, sidecar);
    expect(applied.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(applied.data.nodes[0]).toMatchObject({
      bounds: { x: 20, y: 100, width: 100, height: 50 },
      text: { bounds: { x: 30, y: 110, width: 80, height: 30 } },
    });
    expect(applied.data.edges[0]).toMatchObject({
      start: { x: 120, y: 125 },
      end: { x: 200, y: 25 },
      points: [{ x: 120, y: 125 }, { x: 160, y: 75 }, { x: 200, y: 25 }],
      path: { segments: [
        { kind: "move", to: { x: 120, y: 125 } },
        { kind: "line", to: { x: 160, y: 75 } },
        { kind: "line", to: { x: 200, y: 25 } },
      ] },
      label: { bounds: { x: 140, y: 65, width: 40, height: 20 } },
    });
    expect(DIAGRAM.nodes[0]?.bounds).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(DIAGRAM.edges[0]?.path?.segments[1]?.kind).toBe("cubic");
  });

  it("reroutes incident edges when a node moves without an explicit edge override", () => {
    const sidecar = setManualNodeLayout(
      withDiagramNodes(),
      { kind: "semanticId", value: "alpha" },
      { x: 20, y: 100, width: 100, height: 50 },
    );
    const applied = applyLayoutSidecar(DIAGRAM, sidecar);

    expect(applied.data.edges[0]?.points).toHaveLength(2);
    expect(applied.data.edges[0]?.path?.segments.map(({ kind }) => kind))
      .toEqual(["move", "line"]);
    expect(applied.diagnostics).toContainEqual(expect.objectContaining({
      code: "LAYOUT_EDGE_AUTO_REROUTED",
      elementId: "renderer-edge-alpha-beta",
    }));
  });

  it("resolves explicit ports and offsets the edge label from the routed midpoint", () => {
    const sidecar = setManualEdgeLayout(withDiagramNodes(), {
      identity: { kind: "sourceKey", value: "L_alpha_beta_0" },
      labelOffset: { x: 7, y: -9 },
      points: [{ x: 100, y: 25 }, { x: 150, y: 70 }, { x: 200, y: 25 }],
      source: { kind: "semanticId", value: "alpha" },
      sourcePort: "bottom",
      target: { kind: "semanticId", value: "beta" },
      targetPort: "top",
    });
    const applied = applyLayoutSidecar(DIAGRAM, sidecar);
    const withoutOffset = applyLayoutSidecar(DIAGRAM, {
      ...sidecar,
      edges: sidecar.edges.map(({ labelOffset: _labelOffset, ...edge }) => edge),
    });

    expect(applied.data.edges[0]).toMatchObject({
      start: { x: 50, y: 50 },
      end: { x: 250, y: 0 },
      points: [{ x: 50, y: 50 }, { x: 150, y: 70 }, { x: 250, y: 0 }],
    });
    expect(applied.data.edges[0]!.label!.bounds.x)
      .toBeCloseTo(withoutOffset.data.edges[0]!.label!.bounds.x + 7);
    expect(applied.data.edges[0]!.label!.bounds.y)
      .toBeCloseTo(withoutOffset.data.edges[0]!.label!.bounds.y - 9);
  });

  it("applies and preserves node, edge, and label z-index values", () => {
    let sidecar = setNodeZIndex(
      withDiagramNodes(),
      { kind: "semanticId", value: "alpha" },
      7,
    );
    sidecar = setManualNodeLayout(sidecar, { kind: "semanticId", value: "alpha" }, {
      x: 5, y: 5, width: 100, height: 50,
    });
    sidecar = setManualEdgeLayout(sidecar, {
      identity: { kind: "sourceKey", value: "L_alpha_beta_0" },
      labelZIndex: 9,
      points: [{ x: 105, y: 30 }, { x: 200, y: 25 }],
      source: { kind: "semanticId", value: "alpha" },
      target: { kind: "semanticId", value: "beta" },
      zIndex: 3,
    });
    const applied = applyLayoutSidecar(DIAGRAM, sidecar);

    expect(sidecar.nodes.find(({ identity }) => identity.value === "alpha")?.zIndex).toBe(7);
    expect(applied.data.nodes[0]?.zIndex).toBe(7);
    expect(applied.data.edges[0]?.zIndex).toBe(3);
    expect(applied.data.edges[0]?.label?.zIndex).toBe(9);
  });

  it("applies canonical curve controls and layout-only group parent semantics", () => {
    let sidecar = setManualEdgeLayout(withDiagramNodes(), {
      identity: { kind: "sourceKey", value: "L_alpha_beta_0" },
      path: DIAGRAM.edges[0]!.path,
      points: [{ x: 100, y: 25 }, { x: 200, y: 25 }],
      source: { kind: "semanticId", value: "alpha" },
      sourcePort: "bottom",
      target: { kind: "semanticId", value: "beta" },
      targetPort: "top",
    });
    sidecar = setManualGroupLayout(sidecar, {
      bounds: { x: -10, y: -20, width: 320, height: 100 },
      children: sidecar.nodes.map(({ identity }) => identity),
      id: "layout-group-1",
    });

    const applied = applyLayoutSidecar(DIAGRAM, sidecar);
    expect(applied.data.edges[0]?.path?.segments[1]).toMatchObject({
      kind: "cubic",
      control1: { x: 130, y: -20 },
      control2: { x: 170, y: 70 },
      to: { x: 250, y: 0 },
    });
    expect(applied.data.groups?.[0]).toMatchObject({
      bounds: { x: -10, y: -20, width: 320, height: 100 },
      id: "layout-group-1",
    });
    expect(applied.data.nodes.map(({ parentId }) => parentId))
      .toEqual(["layout-group-1", "layout-group-1"]);
    expect(removeLayoutGroup(sidecar, "layout-group-1").groups).toEqual([]);
  });

  it("resolves semantic source group ids back to renderer ids and counts editable text/groups", () => {
    const groupedDiagram: DiagramIR = {
      ...DIAGRAM,
      groups: [{
        bounds: { x: -10, y: -10, width: 320, height: 90 },
        id: "renderer-cluster-team",
        semanticId: "team",
        text: { bounds: { x: 100, y: -5, width: 60, height: 20 }, text: "Team" },
      }],
      nodes: DIAGRAM.nodes.map((node) => ({ ...node, parentId: "renderer-cluster-team" })),
    };
    const sidecar = {
      ...withDiagramNodes(),
      groups: [{
        bounds: { x: -20, y: -20, width: 340, height: 110 },
        children: withDiagramNodes().nodes.map(({ identity }) => identity),
        id: "team",
      }],
    };
    const applied = applyLayoutSidecar(groupedDiagram, sidecar);

    expect(applied.data.groups?.[0]?.id).toBe("renderer-cluster-team");
    expect(applied.data.nodes.map(({ parentId }) => parentId))
      .toEqual(["renderer-cluster-team", "renderer-cluster-team"]);
    expect(applied.summary.editableObjects).toBe(7);
  });

  it("diagnoses and ignores an edge override whose endpoint identities changed", () => {
    let sidecar = withDiagramNodes();
    sidecar = setManualEdgeLayout(sidecar, {
      identity: { kind: "sourceKey", value: "L_alpha_beta_0" },
      source: { kind: "semanticId", value: "alpha" },
      target: { kind: "semanticId", value: "alpha" },
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
    });
    const applied = applyLayoutSidecar(DIAGRAM, sidecar);

    expect(applied.diagnostics).toContainEqual(expect.objectContaining({
      code: "LAYOUT_EDGE_ENDPOINT_MISMATCH",
    }));
    expect(applied.data.edges[0]?.path?.segments[1]?.kind).toBe("cubic");
  });
});

describe("reconcileLayout", () => {
  it("preserves original curved routes when empty reconciliation does not move nodes", () => {
    const reconciled = reconcileLayout(DIAGRAM, createEmptyLayoutSidecar());

    expect(reconciled.diagram.edges[0]?.path?.segments[1]?.kind).toBe("cubic");
    expect(reconciled.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "LAYOUT_EDGE_AUTO_REROUTED",
    }));
  });

  it("preserves semantic overrides across renderer ID changes and relocates new collisions", () => {
    const previous: LayoutSidecar = {
      schema: "mmd2pptx-layout",
      version: 1,
      edges: [],
      nodes: [
        { identity: { kind: "semanticId", value: "alpha" }, mode: "manual", bounds: { x: 40, y: 90, width: 100, height: 50 } },
        { identity: { kind: "semanticId", value: "beta" }, mode: "auto", bounds: { x: 200, y: 0, width: 100, height: 50 } },
        { identity: { kind: "semanticId", value: "removed" }, mode: "manual", bounds: { x: 0, y: 200, width: 80, height: 40 } },
      ],
    };
    const next: DiagramIR = {
      ...DIAGRAM,
      nodes: [
        { ...DIAGRAM.nodes[0]!, id: "my-svg-flowchart-alpha-9" },
        { ...DIAGRAM.nodes[1]!, id: "my-svg-flowchart-beta-10" },
        {
          id: "my-svg-flowchart-gamma-11",
          semanticId: "gamma",
          kind: "ellipse",
          bounds: { x: 200, y: 0, width: 100, height: 50 },
        },
      ],
    };
    const reconciled = reconcileLayout(next, previous);

    expect(reconciled.diagram.nodes[0]?.bounds).toMatchObject({ x: 40, y: 90 });
    expect(reconciled.changes.preservedNodeIds).toEqual([
      "my-svg-flowchart-alpha-9",
      "my-svg-flowchart-beta-10",
    ]);
    expect(reconciled.changes.newNodeIds).toEqual(["my-svg-flowchart-gamma-11"]);
    expect(reconciled.changes.relocatedNodeIds).toEqual(["my-svg-flowchart-gamma-11"]);
    expect(reconciled.diagram.nodes[2]?.bounds.y).toBeGreaterThan(0);
    expect(reconciled.sidecar.nodes.find(({ identity }) => identity.value === "gamma")?.mode)
      .toBe("auto");
    expect(reconciled.changes.removedNodeKeys).toEqual(["semanticId:removed"]);
  });

  it("reconciles custom group children and removes groups that become too small", () => {
    const grouped = setManualGroupLayout(withDiagramNodes(), {
      bounds: { x: -10, y: -10, width: 320, height: 80 },
      children: withDiagramNodes().nodes.map(({ identity }) => identity),
      id: "layout-group-1",
    });
    const oneNode = { ...DIAGRAM, nodes: [DIAGRAM.nodes[0]!] };
    const reconciled = reconcileLayout(oneNode, grouped);

    expect(reconciled.sidecar.groups).toEqual([]);
    expect(reconciled.changes.removedGroupIds).toEqual(["layout-group-1"]);
  });

  it("removes reset nodes from groups and drops undersized groups", () => {
    const grouped = setManualGroupLayout(withDiagramNodes(), {
      bounds: { x: -10, y: -10, width: 320, height: 80 },
      children: withDiagramNodes().nodes.map(({ identity }) => identity),
      id: "layout-group-1",
    });
    const reset = restoreAutomaticLayout(grouped, [{ kind: "semanticId", value: "alpha" }]);

    expect(reset.groups).toEqual([]);
    expect(reset.nodes.map(({ identity }) => identity.value)).toEqual(["beta"]);
  });
});

function withDiagramNodes(): LayoutSidecar {
  return {
    ...createEmptyLayoutSidecar(),
    nodes: DIAGRAM.nodes.map((node) => ({
      bounds: { ...node.bounds },
      identity: selectLayoutIdentity(node),
      mode: "auto" as const,
    })),
  };
}
