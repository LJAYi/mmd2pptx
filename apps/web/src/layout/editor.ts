import {
  createEmptyLayoutSidecar,
  diagramPathPoints,
  layoutIdentityKey,
  parseLayoutSidecar,
  parseMermaidSvgElement,
  reconcileLayout,
  removeLayoutGroup,
  restoreAutomaticLayout,
  routeOrthogonal,
  selectLayoutIdentity,
  serializeLayoutSidecar,
  setManualEdgeLayout,
  setManualGroupLayout,
  setManualNodeLayout,
  setNodeZIndex,
  type DiagramIR,
  type DiagramPath,
  type DiagramPathSegment,
  type DiagramNode,
  type EdgeLayoutEntry,
  type LayoutBounds,
  type LayoutGroupEntry,
  type LayoutIdentity,
  type LayoutPoint,
  type LayoutPortSide,
  type LayoutSidecar,
  type MermaidSemanticGraph,
} from "@mmd2pptx/core";

import { LayoutHistory } from "./history.js";
import {
  alignItems,
  distributeItems,
  moveZOrder,
  type Alignment,
  type Distribution,
  type ZOrderAction,
} from "./arrange.js";

export interface LayoutEditorState {
  canGroup: boolean;
  canUngroup: boolean;
  canRedo: boolean;
  canUndo: boolean;
  collisionCount: number;
  editing: boolean;
  hasDiagram: boolean;
  hasOverrides: boolean;
  hasSavedLayout: boolean;
  persistenceEnabled: boolean;
  routingWarnings: string[];
  selectedNodeCount: number;
  selectedEdgeId?: string;
  selectedGroupId?: string;
  selectedNodeId?: string;
}

export interface SvgLayoutEditorOptions {
  onGeometryChange?: () => void;
  onLayoutMutation?: () => void;
  onStateChange?: (state: LayoutEditorState) => void;
  storage?: Storage;
  viewport: HTMLElement;
}

interface NodeHandle {
  autoBounds: LayoutBounds;
  element: SVGGElement;
  identity: LayoutIdentity;
  originalTransform: string | null;
}

interface EdgeHandle {
  element: SVGPathElement;
  identity: LayoutIdentity;
  label?: {
    autoCenter: { x: number; y: number };
    element: SVGGElement;
    originalTransform: string | null;
  };
  originalPath: string;
  originalPathGeometry?: DiagramPath;
  source: LayoutIdentity;
  target: LayoutIdentity;
}

interface GroupHandle {
  autoBounds: LayoutBounds;
  element: SVGGElement;
  originalTransform: string | null;
}

type DragKind =
  | "edge-control"
  | "edge-label"
  | "edge-waypoint"
  | "group-move"
  | "group-resize"
  | "node-move"
  | "node-resize";

interface DragState {
  control?: "control" | "control1" | "control2";
  edge?: EdgeHandle;
  identity?: LayoutIdentity;
  kind: DragKind;
  moved: boolean;
  pointerId: number;
  segmentIndex?: number;
  startBounds?: LayoutBounds;
  startEdge?: EdgeLayoutEntry;
  startGroup?: LayoutGroupEntry;
  startPoint: { x: number; y: number };
  startNodes?: Array<{ bounds: LayoutBounds; identity: LayoutIdentity }>;
}

export class SvgLayoutEditor {
  private readonly history = new LayoutHistory(createEmptyLayoutSidecar());
  private readonly onGeometryChange: (() => void) | undefined;
  private readonly onLayoutMutation: (() => void) | undefined;
  private readonly onStateChange: ((state: LayoutEditorState) => void) | undefined;
  private readonly storage: Storage | undefined;
  private readonly viewport: HTMLElement;
  private diagram: DiagramIR = emptyDiagram();
  private drag: DragState | undefined;
  private edgeHandles: EdgeHandle[] = [];
  private editing = false;
  private groupHandles = new Map<string, GroupHandle>();
  private loadStoredLayoutOnNextSource = true;
  private nodeHandles = new Map<string, NodeHandle>();
  private overlay: SVGGElement | undefined;
  private persistenceEnabled = true;
  private sourceStorageKey: string | undefined;
  private selectedEdgeKey: string | undefined;
  private selectedGroupId: string | undefined;
  private selectedKey: string | undefined;
  private selectedKeys = new Set<string>();
  private sidecar = createEmptyLayoutSidecar();
  private routingWarnings: string[] = [];
  private svg: SVGSVGElement | undefined;
  private zOrder: string[] = [];
  private baseViewBox: { height: number; width: number; x: number; y: number } | undefined;

  constructor(options: SvgLayoutEditorOptions) {
    this.viewport = options.viewport;
    this.onGeometryChange = options.onGeometryChange;
    this.onLayoutMutation = options.onLayoutMutation;
    this.onStateChange = options.onStateChange;
    this.storage = options.storage ?? safeLocalStorage();
    this.viewport.addEventListener("pointerdown", this.onPointerDown, true);
    this.viewport.addEventListener("pointermove", this.onPointerMove, true);
    this.viewport.addEventListener("pointerup", this.onPointerEnd, true);
    this.viewport.addEventListener("pointercancel", this.onPointerEnd, true);
    this.viewport.addEventListener("keydown", this.onKeyDown, true);
    this.notify();
  }

  clear(): void {
    this.svg = undefined;
    this.diagram = emptyDiagram();
    this.drag = undefined;
    this.edgeHandles = [];
    this.groupHandles.clear();
    this.nodeHandles.clear();
    this.overlay?.remove();
    this.overlay = undefined;
    this.selectedKey = undefined;
    this.selectedKeys.clear();
    this.routingWarnings = [];
    this.selectedEdgeKey = undefined;
    this.selectedGroupId = undefined;
    this.notify();
  }

  exportSidecar(): string {
    return serializeLayoutSidecar(this.sidecar);
  }

  importSidecar(source: string): void {
    if (!this.svg) throw new Error("Render a Mermaid diagram before importing layout.");
    const imported = parseLayoutSidecar(source);
    const reconciled = reconcileLayout(this.diagram, imported);
    this.sidecar = this.history.commit(reconciled.sidecar);
    this.applyLayout(true);
    this.onLayoutMutation?.();
    this.persist();
    this.notify();
  }

  loadPersistedForNextSource(): void {
    this.loadStoredLayoutOnNextSource = true;
  }

  clearSavedLayout(): void {
    if (this.sourceStorageKey) {
      try {
        this.storage?.removeItem(this.sourceStorageKey);
      } catch {
        // Storage can be denied; still reset the in-memory layout.
      }
    }
    if (this.svg) {
      const reconciled = reconcileLayout(this.diagram, createEmptyLayoutSidecar());
      this.sidecar = this.history.commit(reconciled.sidecar);
      this.zOrder = [...this.nodeHandles.keys()];
      this.applyLayout(true);
      this.onLayoutMutation?.();
    }
    this.notify();
  }

  redo(): void {
    if (!this.history.canRedo) return;
    this.sidecar = this.history.redo();
    this.applyLayout(true);
    this.onLayoutMutation?.();
    this.persist();
    this.notify();
  }

  arrangeSelection(action: Alignment | Distribution): void {
    const entries = this.selectedNodeEntries();
    if ((action === "horizontal" || action === "vertical") && entries.length < 3) return;
    const arranged = action === "horizontal" || action === "vertical"
      ? distributeItems(entries.map(({ entry, key }) => ({ bounds: entry.bounds, key })), action)
      : alignItems(entries.map(({ entry, key }) => ({ bounds: entry.bounds, key })), action);
    if (arranged.length < 2) return;
    let next = this.sidecar;
    for (const item of arranged) {
      const entry = entries.find(({ key }) => key === item.key)?.entry;
      if (entry) next = setManualNodeLayout(next, entry.identity, item.bounds);
    }
    this.sidecar = this.history.commit(next);
    this.applyLayout(true);
    this.onLayoutMutation?.();
    this.persist();
    this.notify();
  }

  changeLayerOrder(action: ZOrderAction): void {
    if (this.selectedKeys.size === 0) return;
    this.zOrder = moveZOrder(this.zOrder, this.selectedKeys, action);
    let next = this.sidecar;
    this.zOrder.forEach((key, zIndex) => {
      const entry = next.nodes.find((node) => layoutIdentityKey(node.identity) === key);
      if (entry) next = setNodeZIndex(next, entry.identity, zIndex);
    });
    this.sidecar = this.history.commit(next);
    this.applyZOrder();
    this.onLayoutMutation?.();
    this.persist();
    this.notify();
  }

  createGroupFromSelection(): void {
    const selected = this.selectedNodeEntries();
    if (selected.length < 2) return;
    const grouped = new Set((this.sidecar.groups ?? [])
      .flatMap(({ children }) => children.map(layoutIdentityKey)));
    if (selected.some(({ key }) => grouped.has(key))) return;
    const bounds = unionBounds(selected.map(({ entry }) => entry.bounds), 18);
    const used = new Set((this.sidecar.groups ?? []).map(({ id }) => id));
    let index = 1;
    while (used.has(`layout-group-${index}`)) index += 1;
    const group: LayoutGroupEntry = {
      bounds,
      children: selected.map(({ entry }) => ({ ...entry.identity })),
      id: `layout-group-${index}`,
    };
    this.sidecar = this.history.commit(setManualGroupLayout(this.sidecar, group));
    this.selectedKeys.clear();
    this.selectedKey = undefined;
    this.selectedEdgeKey = undefined;
    this.selectedGroupId = group.id;
    this.applyLayout(true);
    this.onLayoutMutation?.();
    this.persist();
    this.notify();
  }

  getSidecar(): LayoutSidecar {
    return parseLayoutSidecar(this.sidecar);
  }

  ungroupSelection(): void {
    if (!this.selectedGroupId?.startsWith("layout-group-")) return;
    this.sidecar = this.history.commit(removeLayoutGroup(this.sidecar, this.selectedGroupId));
    this.selectedGroupId = undefined;
    this.applyLayout(true);
    this.onLayoutMutation?.();
    this.persist();
    this.notify();
  }

  routeSelectedEdge(): void {
    if (!this.selectedEdgeKey) return;
    const edge = this.edgeHandles.find(
      (candidate) => layoutIdentityKey(candidate.identity) === this.selectedEdgeKey,
    );
    if (!edge) return;
    const entries = new Map(
      this.sidecar.nodes.map((entry) => [layoutIdentityKey(entry.identity), entry]),
    );
    const sourceKey = layoutIdentityKey(edge.source);
    const targetKey = layoutIdentityKey(edge.target);
    const source = entries.get(sourceKey);
    const target = entries.get(targetKey);
    if (!source || !target) return;
    const current = this.edgeOverride(edge);
    const routed = routeOrthogonal({
      obstacles: [...entries]
        .filter(([key]) => key !== sourceKey && key !== targetKey)
        .map(([, entry]) => entry.bounds),
      source: source.bounds,
      ...(current.sourcePort && current.sourcePort !== "auto"
        ? { sourcePort: current.sourcePort }
        : {}),
      target: target.bounds,
      ...(current.targetPort && current.targetPort !== "auto"
        ? { targetPort: current.targetPort }
        : {}),
    });
    current.points = routed.points.map((point) => ({ ...point }));
    delete current.path;
    this.sidecar = this.history.commit(setManualEdgeLayout(this.sidecar, current));
    this.routingWarnings = routed.diagnostics.map(({ message }) => message);
    this.applyLayout(true);
    this.onLayoutMutation?.();
    this.persist();
    this.notify();
  }

  resetAutomaticLayout(): void {
    if (!this.svg) return;
    const reset = restoreAutomaticLayout(this.sidecar);
    const reconciled = reconcileLayout(this.diagram, reset);
    this.sidecar = this.history.commit(reconciled.sidecar);
    this.selectedKey = undefined;
    this.selectedKeys.clear();
    this.selectedEdgeKey = undefined;
    this.applyLayout(true);
    this.onLayoutMutation?.();
    this.persist();
    this.notify();
  }

  setEditing(editing: boolean): void {
    this.editing = editing;
    this.viewport.classList.toggle("is-layout-editing", editing);
    if (!editing) this.select(undefined);
    else this.applyLayout();
    this.notify();
  }

  setPersistenceEnabled(enabled: boolean): void {
    this.persistenceEnabled = enabled;
    if (enabled) this.persist();
    this.notify();
  }

  setSvg(svg: SVGSVGElement, source?: string, semantics?: MermaidSemanticGraph): void {
    this.svg = svg;
    this.baseViewBox = readViewBox(svg);
    const built = buildDiagram(svg, semantics);
    this.diagram = built.diagram;
    this.groupHandles = built.groups;
    this.nodeHandles = built.nodes;
    this.edgeHandles = built.edges;
    let migratedSource = false;
    if (source !== undefined) {
      const storageKey = layoutStorageKey(source);
      if (storageKey !== this.sourceStorageKey) {
        const shouldLoadStored = this.sourceStorageKey === undefined
          || this.loadStoredLayoutOnNextSource;
        migratedSource = this.sourceStorageKey !== undefined && !shouldLoadStored;
        this.sourceStorageKey = storageKey;
        if (shouldLoadStored) {
          const persisted = this.loadPersisted();
          this.sidecar = persisted ?? createEmptyLayoutSidecar();
          this.zOrder = [];
        }
        this.loadStoredLayoutOnNextSource = false;
      } else if (this.loadStoredLayoutOnNextSource) {
        const persisted = this.loadPersisted();
        this.sidecar = persisted ?? createEmptyLayoutSidecar();
        this.zOrder = [];
        this.loadStoredLayoutOnNextSource = false;
      }
    }
    const reconciled = reconcileLayout(this.diagram, this.sidecar);
    this.sidecar = this.history.reset(reconciled.sidecar);
    this.selectedKey = undefined;
    this.selectedKeys.clear();
    this.selectedEdgeKey = undefined;
    this.selectedGroupId = undefined;
    this.routingWarnings = [];
    this.zOrder = zOrderFromSidecar(this.sidecar, this.nodeHandles);
    this.applyLayout(true);
    if (migratedSource) this.persist();
    this.notify();
  }

  toggleEditing(): void {
    this.setEditing(!this.editing);
  }

  undo(): void {
    if (!this.history.canUndo) return;
    this.sidecar = this.history.undo();
    this.applyLayout(true);
    this.onLayoutMutation?.();
    this.persist();
    this.notify();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.editing || !this.svg || event.button !== 0 || this.drag) return;
    const target = event.target instanceof Element ? event.target : undefined;
    const control = target?.closest<SVGElement>("[data-layout-handle]");
    if (control) {
      const edgeKey = control.dataset.edgeKey;
      const groupId = control.dataset.groupId;
      const nodeKey = control.dataset.nodeKey;
      if ((control.dataset.layoutHandle === "group-select"
        || control.dataset.layoutHandle === "group-resize") && groupId) {
        const group = this.sidecar.groups?.find(({ id }) => id === groupId);
        if (group) {
          this.selectGroup(groupId);
          const childKeys = new Set(group.children.map(layoutIdentityKey));
          this.beginDrag(event, {
            kind: control.dataset.layoutHandle === "group-resize" ? "group-resize" : "group-move",
            startGroup: cloneGroupEntry(group),
            startNodes: this.sidecar.nodes
              .filter(({ identity }) => childKeys.has(layoutIdentityKey(identity)))
              .map((node) => ({ bounds: { ...node.bounds }, identity: { ...node.identity } })),
          });
        }
        return;
      }
      if (control.dataset.layoutHandle === "edge-port" && edgeKey) {
        const edge = this.edgeHandles.find(
          (candidate) => layoutIdentityKey(candidate.identity) === edgeKey,
        );
        const end = control.dataset.edgeEnd;
        const side = control.dataset.portSide as LayoutPortSide | undefined;
        if (edge && (end === "source" || end === "target") && side) {
          this.setEdgePort(edge, end, side);
          stopPointer(event);
        }
        return;
      }
      if (control.dataset.layoutHandle === "node-resize" && nodeKey) {
        const handle = this.nodeHandles.get(nodeKey);
        const entry = this.sidecar.nodes.find(
          (node) => layoutIdentityKey(node.identity) === nodeKey,
        );
        if (handle && entry) {
          this.selectOnly(nodeKey);
          this.beginDrag(event, {
            identity: handle.identity,
            kind: "node-resize",
            startBounds: { ...entry.bounds },
          });
        }
        return;
      }
      if (control.dataset.layoutHandle === "edge-waypoint" && edgeKey) {
        const edge = this.edgeHandles.find(
          (candidate) => layoutIdentityKey(candidate.identity) === edgeKey,
        );
        if (edge) {
          this.selectEdge(edgeKey);
          this.beginDrag(event, {
            edge,
            kind: "edge-waypoint",
            startEdge: this.edgeOverride(edge),
          });
        }
        return;
      }
      if (control.dataset.layoutHandle === "edge-control" && edgeKey) {
        const edge = this.edgeHandles.find(
          (candidate) => layoutIdentityKey(candidate.identity) === edgeKey,
        );
        const segmentIndex = Number(control.dataset.segmentIndex);
        const controlName = control.dataset.controlName;
        if (edge && Number.isSafeInteger(segmentIndex)
          && (controlName === "control" || controlName === "control1" || controlName === "control2")) {
          this.selectEdge(edgeKey);
          this.beginDrag(event, {
            control: controlName,
            edge,
            kind: "edge-control",
            segmentIndex,
            startEdge: this.edgeOverride(edge),
          });
        }
        return;
      }
    }

    const labelEdge = this.edgeHandles.find(({ label }) =>
      Boolean(label && target && label.element.contains(target)));
    if (labelEdge) {
      this.selectEdge(layoutIdentityKey(labelEdge.identity));
      this.beginDrag(event, {
        edge: labelEdge,
        kind: "edge-label",
        startEdge: this.edgeOverride(labelEdge),
      });
      return;
    }

    const path = target?.closest<SVGPathElement>("g.edgePaths path");
    const selectedEdge = path
      ? this.edgeHandles.find((candidate) => candidate.element === path)
      : undefined;
    if (selectedEdge) {
      this.selectEdge(layoutIdentityKey(selectedEdge.identity));
      stopPointer(event);
      return;
    }

    const element = findNodeElement(event.target);
    if (!element) return;
    const handle = [...this.nodeHandles.values()].find(
      (candidate) => candidate.element === element,
    );
    if (!handle) return;
    const entry = this.sidecar.nodes.find(
      (node) => layoutIdentityKey(node.identity) === layoutIdentityKey(handle.identity),
    );
    if (!entry) return;

    const key = layoutIdentityKey(handle.identity);
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (additive) {
      this.toggleNodeSelection(key);
      if (!this.selectedKeys.has(key)) {
        stopPointer(event);
        return;
      }
    } else if (!this.selectedKeys.has(key)) {
      this.selectOnly(key);
    }
    this.beginDrag(event, {
      kind: "node-move",
      startNodes: this.selectedNodeEntries().map(({ entry: selectedEntry }) => ({
        bounds: { ...selectedEntry.bounds },
        identity: { ...selectedEntry.identity },
      })),
    });
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.svg || !this.drag || event.pointerId !== this.drag.pointerId) return;
    const point = screenToSvg(this.svg, event.clientX, event.clientY);
    const dx = point.x - this.drag.startPoint.x;
    const dy = point.y - this.drag.startPoint.y;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
    this.drag.moved = true;
    if (this.drag.kind === "node-move" && this.drag.startNodes) {
      let next = this.sidecar;
      for (const node of this.drag.startNodes) {
        next = setManualNodeLayout(next, node.identity, {
          ...node.bounds,
          x: node.bounds.x + dx,
          y: node.bounds.y + dy,
        });
      }
      this.sidecar = next;
    } else if (this.drag.kind === "node-resize"
      && this.drag.identity && this.drag.startBounds) {
      this.sidecar = setManualNodeLayout(this.sidecar, this.drag.identity, {
        ...this.drag.startBounds,
        height: Math.max(24, this.drag.startBounds.height + dy),
        width: Math.max(32, this.drag.startBounds.width + dx),
      });
    } else if ((this.drag.kind === "group-move" || this.drag.kind === "group-resize")
      && this.drag.startGroup) {
      const group = cloneGroupEntry(this.drag.startGroup);
      group.bounds = this.drag.kind === "group-resize"
        ? {
            ...group.bounds,
            height: Math.max(36, group.bounds.height + dy),
            width: Math.max(48, group.bounds.width + dx),
          }
        : { ...group.bounds, x: group.bounds.x + dx, y: group.bounds.y + dy };
      let next = setManualGroupLayout(this.sidecar, group);
      if (this.drag.kind === "group-move" && this.drag.startNodes) {
        for (const node of this.drag.startNodes) {
          next = setManualNodeLayout(next, node.identity, {
            ...node.bounds,
            x: node.bounds.x + dx,
            y: node.bounds.y + dy,
          });
        }
      }
      this.sidecar = next;
    } else if (this.drag.edge && this.drag.startEdge) {
      const next = cloneEdgeEntry(this.drag.startEdge);
      if (this.drag.kind === "edge-label") {
        next.labelOffset = {
          x: (this.drag.startEdge.labelOffset?.x ?? 0) + dx,
          y: (this.drag.startEdge.labelOffset?.y ?? 0) + dy,
        };
      } else if (this.drag.kind === "edge-control" && next.path
        && this.drag.segmentIndex !== undefined && this.drag.control) {
        const segment = next.path.segments[this.drag.segmentIndex];
        if (segment?.kind === "cubic" && this.drag.control === "control1") {
          segment.control1 = { x: segment.control1.x + dx, y: segment.control1.y + dy };
        } else if (segment?.kind === "cubic" && this.drag.control === "control2") {
          segment.control2 = { x: segment.control2.x + dx, y: segment.control2.y + dy };
        } else if (segment?.kind === "quadratic" && this.drag.control === "control") {
          segment.control = { x: segment.control.x + dx, y: segment.control.y + dy };
        }
      } else {
        const index = Math.floor(next.points.length / 2);
        next.points[index] = {
          x: next.points[index]!.x + dx,
          y: next.points[index]!.y + dy,
        };
      }
      this.sidecar = setManualEdgeLayout(this.sidecar, next);
    }
    this.applyLayout();
    this.onLayoutMutation?.();
    this.notify();
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    if (this.viewport.hasPointerCapture(event.pointerId)) {
      this.viewport.releasePointerCapture(event.pointerId);
    }
    const moved = this.drag.moved;
    if (moved) this.sidecar = this.history.commit(this.sidecar);
    this.drag = undefined;
    this.viewport.classList.remove("is-node-dragging");
    if (moved) {
      this.updateCanvasBounds();
      this.persist();
    }
    this.notify();
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private beginDrag(
    event: PointerEvent,
    state: Omit<DragState, "moved" | "pointerId" | "startPoint">,
  ): void {
    if (!this.svg) return;
    this.drag = {
      ...state,
      moved: false,
      pointerId: event.pointerId,
      startPoint: screenToSvg(this.svg, event.clientX, event.clientY),
    };
    this.viewport.setPointerCapture(event.pointerId);
    this.viewport.classList.add("is-node-dragging");
    stopPointer(event);
  }

  private applyLayout(updateCanvas = false): void {
    const entries = new Map(
      this.sidecar.nodes.map((entry) => [layoutIdentityKey(entry.identity), entry]),
    );
    for (const [key, handle] of this.nodeHandles) {
      const entry = entries.get(key);
      restoreTransform(handle);
      if (!entry) continue;
      applyNodeBounds(this.svg, handle, entry.bounds);
      handle.element.classList.toggle("layout-node-manual", entry.mode === "manual");
      handle.element.classList.toggle("layout-node-selected", this.selectedKeys.has(key));
    }
    this.zOrder = zOrderFromSidecar(this.sidecar, this.nodeHandles);
    this.applyZOrder();
    this.applyGroupLayout();
    this.applyEdgeLayout(entries);
    this.updateCollisions(entries);
    this.renderOverlay(entries);
    if (updateCanvas) this.updateCanvasBounds();
  }

  private edgeOverride(edge: EdgeHandle): EdgeLayoutEntry {
    const key = layoutIdentityKey(edge.identity);
    const existing = this.sidecar.edges.find(
      (candidate) => layoutIdentityKey(candidate.identity) === key,
    );
    if (existing) {
      const cloned = cloneEdgeEntry(existing);
      return cloned.path && hasCurve(cloned.path) ? cloned : ensureWaypoint(cloned);
    }
    if (!this.svg) throw new Error("An SVG is required to edit an edge.");
    const length = edge.element.getTotalLength();
    const path = edge.originalPathGeometry ? clonePath(edge.originalPathGeometry) : undefined;
    const points = path ? diagramPathPoints(path) : [
      pathPointInSvg(this.svg, edge.element, 0),
      pathPointInSvg(this.svg, edge.element, length / 2),
      pathPointInSvg(this.svg, edge.element, length),
    ];
    return {
      identity: { ...edge.identity },
      ...(path ? { path } : {}),
      points,
      source: { ...edge.source },
      target: { ...edge.target },
    };
  }

  private setEdgePort(
    edge: EdgeHandle,
    end: "source" | "target",
    side: LayoutPortSide,
  ): void {
    const next = this.edgeOverride(edge);
    if (end === "source") next.sourcePort = side;
    else next.targetPort = side;
    this.sidecar = this.history.commit(setManualEdgeLayout(this.sidecar, next));
    this.applyLayout(true);
    this.onLayoutMutation?.();
    this.persist();
    this.notify();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.editing || this.selectedKeys.size === 0 || isTextEntry(event.target)) return;
    const delta = event.shiftKey ? 10 : 1;
    const movement = event.key === "ArrowLeft" ? { x: -delta, y: 0 }
      : event.key === "ArrowRight" ? { x: delta, y: 0 }
        : event.key === "ArrowUp" ? { x: 0, y: -delta }
          : event.key === "ArrowDown" ? { x: 0, y: delta }
            : undefined;
    if (!movement) return;
    let next = this.sidecar;
    for (const { entry } of this.selectedNodeEntries()) {
      next = setManualNodeLayout(next, entry.identity, {
        ...entry.bounds,
        x: entry.bounds.x + movement.x,
        y: entry.bounds.y + movement.y,
      });
    }
    this.sidecar = this.history.commit(next);
    this.applyLayout(true);
    this.onLayoutMutation?.();
    this.persist();
    this.notify();
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private renderOverlay(
    entries: Map<string, { bounds: LayoutBounds; mode: string }>,
  ): void {
    this.overlay?.remove();
    this.overlay = undefined;
    if (!this.svg || !this.editing) return;
    const overlay = svgElement("g");
    overlay.classList.add("layout-overlay");
    this.svg.append(overlay);
    this.overlay = overlay;

    if (this.selectedKey && this.selectedKeys.size === 1) {
      const entry = entries.get(this.selectedKey);
      if (entry) {
        const handle = svgElement("rect");
        setSvgAttributes(handle, {
          "data-layout-handle": "node-resize",
          "data-node-key": this.selectedKey,
          height: 12,
          width: 12,
          x: entry.bounds.x + entry.bounds.width - 6,
          y: entry.bounds.y + entry.bounds.height - 6,
        });
        handle.classList.add("layout-resize-handle");
        overlay.append(handle);
      }
    }

    if (this.selectedEdgeKey) {
      const edge = this.edgeHandles.find(
        (candidate) => layoutIdentityKey(candidate.identity) === this.selectedEdgeKey,
      );
      if (!edge) return;
      const source = entries.get(layoutIdentityKey(edge.source));
      const target = entries.get(layoutIdentityKey(edge.target));
      if (!source || !target) return;
      for (const [end, bounds] of [["source", source.bounds], ["target", target.bounds]] as const) {
        for (const side of ["top", "right", "bottom", "left"] as const) {
          const point = portPoint(bounds, side);
          const port = svgElement("circle");
          setSvgAttributes(port, {
            "data-edge-end": end,
            "data-edge-key": this.selectedEdgeKey,
            "data-layout-handle": "edge-port",
            "data-port-side": side,
            cx: point.x,
            cy: point.y,
            r: 5,
          });
          port.classList.add("layout-port-handle");
          overlay.append(port);
        }
      }
      const route = resolvedEdgePoints(this.edgeOverride(edge), source.bounds, target.bounds);
      const override = this.edgeOverride(edge);
      if (override.path && hasCurve(override.path)) {
        renderPathControlHandles(overlay, this.selectedEdgeKey, override.path);
      } else {
        const waypoint = route[Math.floor(route.length / 2)];
        if (!waypoint) return;
        const handle = svgElement("circle");
        setSvgAttributes(handle, {
          "data-edge-key": this.selectedEdgeKey,
          "data-layout-handle": "edge-waypoint",
          cx: waypoint.x,
          cy: waypoint.y,
          r: 7,
        });
        handle.classList.add("layout-waypoint-handle");
        overlay.append(handle);
      }
    }

    for (const group of this.sidecar.groups ?? []) {
      const outline = svgElement("rect");
      setSvgAttributes(outline, {
        "data-group-id": group.id,
        "data-layout-handle": "group-select",
        height: group.bounds.height,
        width: group.bounds.width,
        x: group.bounds.x,
        y: group.bounds.y,
      });
      outline.classList.add("layout-group-outline");
      if (group.id === this.selectedGroupId) outline.classList.add("layout-group-selected");
      overlay.prepend(outline);
    }
    if (this.selectedGroupId) {
      const group = this.sidecar.groups?.find(({ id }) => id === this.selectedGroupId);
      if (group) {
        const handle = svgElement("rect");
        setSvgAttributes(handle, {
          "data-group-id": group.id,
          "data-layout-handle": "group-resize",
          height: 12,
          width: 12,
          x: group.bounds.x + group.bounds.width - 6,
          y: group.bounds.y + group.bounds.height - 6,
        });
        handle.classList.add("layout-resize-handle");
        overlay.append(handle);
      }
    }
  }

  private persist(): void {
    if (!this.persistenceEnabled || !this.storage || !this.sourceStorageKey) return;
    try {
      this.storage.setItem(this.sourceStorageKey, serializeLayoutSidecar(this.sidecar));
    } catch {
      // Storage can be denied or full; layout editing remains usable in-memory.
    }
  }

  private loadPersisted(): LayoutSidecar | undefined {
    if (!this.persistenceEnabled || !this.storage || !this.sourceStorageKey) return undefined;
    try {
      const value = this.storage.getItem(this.sourceStorageKey);
      return value ? parseLayoutSidecar(value) : undefined;
    } catch {
      return undefined;
    }
  }

  private applyEdgeLayout(entries: Map<string, { bounds: LayoutBounds; mode: string }>): void {
    const overrides = new Map(
      this.sidecar.edges.map((edge) => [layoutIdentityKey(edge.identity), edge]),
    );
    for (const edge of this.edgeHandles) {
      edge.element.classList.toggle(
        "layout-edge-selected",
        layoutIdentityKey(edge.identity) === this.selectedEdgeKey,
      );
      restoreElementTransform(edge.label);
      const override = overrides.get(layoutIdentityKey(edge.identity));
      if (override) {
        const source = entries.get(layoutIdentityKey(edge.source));
        const target = entries.get(layoutIdentityKey(edge.target));
        const points = resolvedEdgePoints(override, source?.bounds, target?.bounds);
        const path = override.path
          ? resolvedEdgePath(override.path, points[0]!, points.at(-1)!)
          : undefined;
        edge.element.setAttribute("d", path ? pathToSvgData(path) : pointsToPath(points));
        moveLabelToPathMidpoint(this.svg, edge, override.labelOffset);
        continue;
      }
      const source = entries.get(layoutIdentityKey(edge.source));
      const target = entries.get(layoutIdentityKey(edge.target));
      if (!source || !target || (source.mode !== "manual" && target.mode !== "manual")) {
        edge.element.setAttribute("d", edge.originalPath);
        continue;
      }
      const [start, end] = rectangleConnection(source.bounds, target.bounds);
      edge.element.setAttribute("d", pointsToPath([start, end]));
      moveLabelToPathMidpoint(this.svg, edge);
    }
  }

  private applyGroupLayout(): void {
    if (!this.svg) return;
    for (const [id, handle] of this.groupHandles) {
      restoreTransform(handle);
      const entry = this.sidecar.groups?.find((group) => group.id === id);
      if (entry) applyNodeBounds(this.svg, handle, entry.bounds);
    }
    this.svg.querySelector("g.layout-custom-groups")?.remove();
    const custom = (this.sidecar.groups ?? []).filter(({ id }) => id.startsWith("layout-group-"));
    if (custom.length === 0) return;
    const layer = svgElement("g");
    layer.classList.add("layout-custom-groups");
    for (const group of custom) {
      const element = svgElement("g");
      element.classList.add("cluster", "layout-custom-group");
      element.dataset.id = group.id;
      element.id = group.id;
      const rect = svgElement("rect");
      setSvgAttributes(rect, {
        fill: "none",
        height: group.bounds.height,
        rx: 8,
        stroke: "#7e898f",
        "stroke-dasharray": "6 4",
        width: group.bounds.width,
        x: group.bounds.x,
        y: group.bounds.y,
      });
      element.append(rect);
      layer.append(element);
    }
    this.svg.append(layer);
  }

  private updateCanvasBounds(): void {
    if (!this.svg || !this.baseViewBox) return;
    this.svg.setAttribute(
      "viewBox",
      `${this.baseViewBox.x} ${this.baseViewBox.y} ${this.baseViewBox.width} ${this.baseViewBox.height}`,
    );
    const content = boundsInSvg(this.svg, this.svg);
    const padding = 24;
    const baseRight = this.baseViewBox.x + this.baseViewBox.width;
    const baseBottom = this.baseViewBox.y + this.baseViewBox.height;
    const contentRight = content.x + content.width;
    const contentBottom = content.y + content.height;
    const left = content.x < this.baseViewBox.x ? content.x - padding : this.baseViewBox.x;
    const top = content.y < this.baseViewBox.y ? content.y - padding : this.baseViewBox.y;
    const right = contentRight > baseRight ? contentRight + padding : baseRight;
    const bottom = contentBottom > baseBottom ? contentBottom + padding : baseBottom;
    this.svg.setAttribute("viewBox", `${left} ${top} ${right - left} ${bottom - top}`);
    this.onGeometryChange?.();
  }

  private updateCollisions(
    entries: Map<string, { bounds: LayoutBounds; mode: string }>,
  ): void {
    const collisions = collisionKeys(entries);
    for (const [key, handle] of this.nodeHandles) {
      handle.element.classList.toggle("layout-node-collision", collisions.has(key));
    }
  }

  private notify(): void {
    const selected = this.selectedKey
      ? this.nodeHandles.get(this.selectedKey)?.element.id
      : undefined;
    const nodeOrder = [...this.nodeHandles.keys()];
    const state: LayoutEditorState = {
      canGroup: this.selectedKeys.size >= 2 && this.selectedNodeEntries().every(({ key }) =>
        !(this.sidecar.groups ?? []).some(({ children }) =>
          children.some((identity) => layoutIdentityKey(identity) === key))),
      canUngroup: Boolean(this.selectedGroupId?.startsWith("layout-group-")),
      canRedo: this.history.canRedo,
      canUndo: this.history.canUndo,
      collisionCount: collisionKeys(
        new Map(
          this.sidecar.nodes.map((entry) => [layoutIdentityKey(entry.identity), entry]),
        ),
      ).size,
      editing: this.editing,
      hasDiagram: Boolean(this.svg),
      hasOverrides:
        this.sidecar.nodes.some(({ mode }) => mode === "manual") ||
        this.sidecar.edges.length > 0 ||
        (this.sidecar.groups ?? []).some(({ id }) => id.startsWith("layout-group-")) ||
        this.zOrder.some((key, index) => key !== nodeOrder[index]),
      hasSavedLayout: this.hasPersisted(),
      persistenceEnabled: this.persistenceEnabled,
      routingWarnings: [...this.routingWarnings],
      selectedNodeCount: this.selectedKeys.size,
    };
    if (selected) state.selectedNodeId = selected;
    const selectedEdge = this.selectedEdgeKey
      ? (() => {
          const edge = this.edgeHandles.find(
            (candidate) => layoutIdentityKey(candidate.identity) === this.selectedEdgeKey,
          );
          return edge ? edge.element.id || edge.identity.value : undefined;
        })()
      : undefined;
    if (selectedEdge) state.selectedEdgeId = selectedEdge;
    if (this.selectedGroupId) state.selectedGroupId = this.selectedGroupId;
    this.onStateChange?.(state);
  }

  private select(key: string | undefined): void {
    if (key === undefined) {
      this.selectedKeys.clear();
      this.selectedKey = undefined;
    } else {
      this.selectOnly(key);
      return;
    }
    this.selectedEdgeKey = undefined;
    this.selectedGroupId = undefined;
    this.applyLayout();
    this.notify();
  }

  private selectOnly(key: string): void {
    this.selectedKeys = new Set([key]);
    this.selectedKey = key;
    this.selectedEdgeKey = undefined;
    this.selectedGroupId = undefined;
    this.applyLayout();
    this.notify();
  }

  private toggleNodeSelection(key: string): void {
    if (this.selectedKeys.has(key)) this.selectedKeys.delete(key);
    else this.selectedKeys.add(key);
    this.selectedKey = this.selectedKeys.has(key) ? key : this.selectedKeys.values().next().value;
    this.selectedEdgeKey = undefined;
    this.selectedGroupId = undefined;
    this.applyLayout();
    this.notify();
  }

  private selectEdge(key: string): void {
    this.selectedKey = undefined;
    this.selectedKeys.clear();
    this.selectedEdgeKey = key;
    this.selectedGroupId = undefined;
    this.applyLayout();
    this.notify();
  }

  private selectGroup(id: string): void {
    this.selectedKey = undefined;
    this.selectedKeys.clear();
    this.selectedEdgeKey = undefined;
    this.selectedGroupId = id;
    this.applyLayout();
    this.notify();
  }

  private selectedNodeEntries(): Array<{
    entry: LayoutSidecar["nodes"][number];
    key: string;
  }> {
    return this.sidecar.nodes.flatMap((entry) => {
      const key = layoutIdentityKey(entry.identity);
      return this.selectedKeys.has(key) ? [{ entry, key }] : [];
    });
  }

  private applyZOrder(): void {
    for (const key of this.zOrder) {
      const element = this.nodeHandles.get(key)?.element;
      if (element?.parentElement) element.parentElement.append(element);
    }
  }

  private hasPersisted(): boolean {
    if (!this.storage || !this.sourceStorageKey) return false;
    try {
      return this.storage.getItem(this.sourceStorageKey) !== null;
    } catch {
      return false;
    }
  }
}

function buildDiagram(svg: SVGSVGElement, semantics?: MermaidSemanticGraph): {
  diagram: DiagramIR;
  edges: EdgeHandle[];
  groups: Map<string, GroupHandle>;
  nodes: Map<string, NodeHandle>;
} {
  const parsed = parseMermaidSvgElement(svg, semantics ? { semantics } : {}).data;
  if (semantics) applyWebSemanticMembership(parsed, semantics);
  const parsedNodes = new Map(parsed.nodes.map((node) => [node.id, node]));
  const parsedEdges = new Map(parsed.edges.map((edge) => [edge.id, edge]));
  const nodes = new Map<string, NodeHandle>();
  const groups = new Map<string, GroupHandle>();
  for (const group of parsed.groups ?? []) {
    const id = group.semanticId ?? group.sourceKey ?? group.id;
    const element = [...svg.querySelectorAll<SVGGElement>("g.cluster")].find((candidate) =>
      candidate.id === group.id || candidate.dataset.id === id);
    if (!element) continue;
    groups.set(id, {
      autoBounds: { ...group.bounds },
      element,
      originalTransform: element.getAttribute("transform"),
    });
  }
  const tokenToNode = new Map<string, { id: string; identity: LayoutIdentity }>();
  for (const element of svg.querySelectorAll<SVGGElement>("g.node")) {
    if (!element.id) continue;
    const parsedNode = parsedNodes.get(element.id);
    const semanticId = parsedNode?.semanticId ?? element.dataset.id ?? element.dataset.node;
    const sourceKey = parsedNode?.sourceKey ?? (semanticId ? undefined : mermaidNodeKey(element.id));
    const input: DiagramNode = {
      bounds: boundsInSvg(svg, element),
      id: element.id,
      kind: "rect" as const,
    };
    if (semanticId) input.semanticId = semanticId;
    if (sourceKey) input.sourceKey = sourceKey;
    const identity = selectLayoutIdentity(parsedNode ?? input);
    const handle: NodeHandle = {
      autoBounds: { ...input.bounds },
      element,
      identity,
      originalTransform: element.getAttribute("transform"),
    };
    nodes.set(layoutIdentityKey(identity), handle);
    tokenToNode.set(semanticId ?? sourceKey ?? element.id, {
      id: element.id,
      identity,
    });
  }

  const edges: EdgeHandle[] = [];
  for (const element of svg.querySelectorAll<SVGPathElement>("g.edgePaths path")) {
    const endpoints = edgeEndpointTokens(element, [...tokenToNode.keys()]);
    if (!endpoints) continue;
    const source = tokenToNode.get(endpoints.source);
    const target = tokenToNode.get(endpoints.target);
    if (!source || !target) continue;
    const id = element.id || `edge-${edges.length}`;
    const sourceKey = element.dataset.id ?? id;
    const input = parsedEdges.get(id) ?? {
      end: { x: 0, y: 0 },
      id,
      start: { x: 0, y: 0 },
      sourceId: source.id,
      sourceKey,
      targetId: target.id,
    };
    const identity = selectLayoutIdentity(input);
    edges.push({
      element,
      identity,
      originalPath: element.getAttribute("d") ?? "",
      ...(input.path ? { originalPathGeometry: clonePath(input.path) } : {}),
      source: source.identity,
      target: target.identity,
    });
  }

  associateEdgeLabels(svg, edges);

  const boundsByIdentity = new Map(
    [...nodes].map(([key, handle]) => [key, handle.autoBounds]),
  );
  const diagram: DiagramIR = {
    ...parsed,
    nodes: parsed.nodes.map((node) => ({
      ...node,
      bounds: {
        ...(boundsByIdentity.get(layoutIdentityKey(selectLayoutIdentity(node))) ?? node.bounds),
      },
    })),
  };
  return { diagram, edges, groups, nodes };
}

function zOrderFromSidecar(
  sidecar: LayoutSidecar,
  nodes: ReadonlyMap<string, NodeHandle>,
): string[] {
  const current = [...nodes.keys()];
  const indices = new Map(current.map((key, index) => [key, index]));
  const zIndices = new Map(sidecar.nodes.map((entry) => [
    layoutIdentityKey(entry.identity),
    entry.zIndex,
  ]));
  return current.sort((left, right) =>
    (zIndices.get(left) ?? indices.get(left) ?? 0)
      - (zIndices.get(right) ?? indices.get(right) ?? 0)
    || (indices.get(left) ?? 0) - (indices.get(right) ?? 0));
}

function applyWebSemanticMembership(diagram: DiagramIR, semantics: MermaidSemanticGraph): void {
  for (const semanticGroup of semantics.groups) {
    const group = diagram.groups?.find((candidate) =>
      candidate.id === semanticGroup.id
      || candidate.semanticId === semanticGroup.id
      || candidate.sourceKey === semanticGroup.id
      || candidate.id.endsWith(`-${semanticGroup.id}`));
    if (group) {
      group.semanticId = semanticGroup.id;
      group.sourceKey = semanticGroup.id;
    }
  }
  for (const semanticNode of semantics.nodes) {
    if (!semanticNode.parentId) continue;
    const node = diagram.nodes.find((candidate) =>
      candidate.id === semanticNode.id
      || candidate.semanticId === semanticNode.id
      || candidate.sourceKey === semanticNode.id
      || candidate.id.endsWith(`-${semanticNode.id}`));
    if (node) node.parentId = semanticNode.parentId;
  }
}

function emptyDiagram(): DiagramIR {
  return { edges: [], height: 1, nodes: [], width: 1 };
}

function associateEdgeLabels(svg: SVGSVGElement, edges: EdgeHandle[]): void {
  const labels = svg.querySelectorAll<SVGGElement>("g.edgeLabels > g.edgeLabel");
  for (const label of labels) {
    if (!label.querySelector("foreignObject, text")) continue;
    const bounds = boundsInSvg(svg, label);
    const center = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    const edge = edges.filter((candidate) => !candidate.label).sort(
      (left, right) =>
        distanceToPath(svg, left.element, center) -
        distanceToPath(svg, right.element, center),
    )[0];
    if (!edge) continue;
    edge.label = {
      autoCenter: center,
      element: label,
      originalTransform: label.getAttribute("transform"),
    };
  }
}

function edgeEndpointTokens(
  edge: SVGPathElement,
  nodeTokens: readonly string[],
): { source: string; target: string } | undefined {
  let source: string | undefined;
  let target: string | undefined;
  for (const className of edge.classList) {
    if (className.startsWith("LS-")) source = className.slice(3);
    if (className.startsWith("LE-")) target = className.slice(3);
  }
  if (source && target) return { source, target };

  const edgeKey = edge.dataset.id ?? edge.id;
  for (const sourceToken of nodeTokens) {
    for (const targetToken of nodeTokens) {
      const prefix = `L_${sourceToken}_${targetToken}_`;
      if (edgeKey.startsWith(prefix) && /^\d+$/.test(edgeKey.slice(prefix.length))) {
        return { source: sourceToken, target: targetToken };
      }
    }
  }
  return undefined;
}

function mermaidNodeKey(id: string): string | undefined {
  const match = /(?:^|-)flowchart-(.+)-\d+$/.exec(id);
  return match?.[1];
}

function boundsInSvg(svg: SVGSVGElement, element: SVGGraphicsElement): LayoutBounds {
  const bounds = element.getBBox();
  const rootMatrix = svg.getScreenCTM();
  const elementMatrix = element.getScreenCTM();
  if (!rootMatrix || !elementMatrix) {
    return { height: bounds.height, width: bounds.width, x: bounds.x, y: bounds.y };
  }
  const matrix = rootMatrix.inverse().multiply(elementMatrix);
  const corners = [
    new DOMPoint(bounds.x, bounds.y),
    new DOMPoint(bounds.x + bounds.width, bounds.y),
    new DOMPoint(bounds.x, bounds.y + bounds.height),
    new DOMPoint(bounds.x + bounds.width, bounds.y + bounds.height),
  ].map((point) => point.matrixTransform(matrix));
  const xs = corners.map(({ x }) => x);
  const ys = corners.map(({ y }) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    height: Math.max(...ys) - top,
    width: Math.max(...xs) - left,
    x: left,
    y: top,
  };
}

function applyRootTranslation(
  svg: SVGSVGElement | undefined,
  handle: Pick<NodeHandle, "element" | "originalTransform">,
  dx: number,
  dy: number,
): void {
  if (!svg) return;
  const rootMatrix = svg.getScreenCTM();
  const parent = handle.element.parentNode;
  const parentMatrix =
    parent instanceof SVGGraphicsElement ? parent.getScreenCTM() : rootMatrix;
  let localDx = dx;
  let localDy = dy;
  if (rootMatrix && parentMatrix) {
    const rootToParent = rootMatrix.inverse().multiply(parentMatrix).inverse();
    localDx = rootToParent.a * dx + rootToParent.c * dy;
    localDy = rootToParent.b * dx + rootToParent.d * dy;
  }
  const original = handle.originalTransform?.trim();
  handle.element.setAttribute(
    "transform",
    `translate(${localDx} ${localDy})${original ? ` ${original}` : ""}`,
  );
}

function moveLabelToPathMidpoint(
  svg: SVGSVGElement | undefined,
  edge: EdgeHandle,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): void {
  if (!svg || !edge.label) return;
  const length = edge.element.getTotalLength();
  if (!Number.isFinite(length) || length <= 0) return;
  const midpoint = pathPointInSvg(svg, edge.element, length / 2);
  applyRootTranslation(
    svg,
    edge.label,
    midpoint.x - edge.label.autoCenter.x + offset.x,
    midpoint.y - edge.label.autoCenter.y + offset.y,
  );
}

function pathPointInSvg(
  svg: SVGSVGElement,
  path: SVGPathElement,
  length: number,
): { x: number; y: number } {
  const point = path.getPointAtLength(length);
  const rootMatrix = svg.getScreenCTM();
  const pathMatrix = path.getScreenCTM();
  if (!rootMatrix || !pathMatrix) return { x: point.x, y: point.y };
  const transformed = new DOMPoint(point.x, point.y).matrixTransform(
    rootMatrix.inverse().multiply(pathMatrix),
  );
  return { x: transformed.x, y: transformed.y };
}

function distanceToPath(
  svg: SVGSVGElement,
  path: SVGPathElement,
  point: { x: number; y: number },
): number {
  const length = path.getTotalLength();
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= 20; index += 1) {
    const candidate = pathPointInSvg(svg, path, length * index / 20);
    nearest = Math.min(nearest, Math.hypot(candidate.x - point.x, candidate.y - point.y));
  }
  return nearest;
}

function restoreTransform(handle: Pick<NodeHandle, "element" | "originalTransform">): void {
  if (handle.originalTransform === null) handle.element.removeAttribute("transform");
  else handle.element.setAttribute("transform", handle.originalTransform);
  handle.element.classList.remove(
    "layout-node-collision",
    "layout-node-manual",
    "layout-node-selected",
  );
}

function restoreElementTransform(
  handle:
    | { element: SVGGraphicsElement; originalTransform: string | null }
    | undefined,
): void {
  if (!handle) return;
  if (handle.originalTransform === null) handle.element.removeAttribute("transform");
  else handle.element.setAttribute("transform", handle.originalTransform);
}

function screenToSvg(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const matrix = svg.getScreenCTM();
  if (!matrix) return { x: clientX, y: clientY };
  const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

function rectangleConnection(
  source: LayoutBounds,
  target: LayoutBounds,
): [{ x: number; y: number }, { x: number; y: number }] {
  const sourceCenter = center(source);
  const targetCenter = center(target);
  return [
    rectangleBoundary(source, sourceCenter, targetCenter),
    rectangleBoundary(target, targetCenter, sourceCenter),
  ];
}

function rectangleBoundary(
  bounds: LayoutBounds,
  from: { x: number; y: number },
  toward: { x: number; y: number },
): { x: number; y: number } {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return from;
  const xScale = Math.abs(dx) < 0.001 ? Number.POSITIVE_INFINITY : bounds.width / 2 / Math.abs(dx);
  const yScale = Math.abs(dy) < 0.001 ? Number.POSITIVE_INFINITY : bounds.height / 2 / Math.abs(dy);
  const scale = Math.min(xScale, yScale);
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

function center(bounds: LayoutBounds): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function pointsToPath(points: readonly { x: number; y: number }[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");
}

function findNodeElement(target: EventTarget | null): SVGGElement | undefined {
  return target instanceof Element
    ? (target.closest<SVGGElement>("g.node") ?? undefined)
    : undefined;
}

function applyNodeBounds(
  svg: SVGSVGElement | undefined,
  handle: Pick<NodeHandle, "autoBounds" | "element" | "originalTransform">,
  bounds: LayoutBounds,
): void {
  if (!svg) return;
  const dx = bounds.x - handle.autoBounds.x;
  const dy = bounds.y - handle.autoBounds.y;
  const sx = bounds.width / handle.autoBounds.width;
  const sy = bounds.height / handle.autoBounds.height;
  if (
    Math.abs(dx) <= 0.001 && Math.abs(dy) <= 0.001 &&
    Math.abs(sx - 1) <= 0.001 && Math.abs(sy - 1) <= 0.001
  ) return;
  const original = handle.originalTransform?.trim();
  handle.element.setAttribute(
    "transform",
    [
      `translate(${dx} ${dy})`,
      `translate(${handle.autoBounds.x} ${handle.autoBounds.y})`,
      `scale(${sx} ${sy})`,
      `translate(${-handle.autoBounds.x} ${-handle.autoBounds.y})`,
      original,
    ].filter(Boolean).join(" "),
  );
}

function resolvedEdgePoints(
  edge: EdgeLayoutEntry,
  source: LayoutBounds | undefined,
  target: LayoutBounds | undefined,
): LayoutPoint[] {
  const points = edge.points.map((point) => ({ ...point }));
  if (source && edge.sourcePort && edge.sourcePort !== "auto") {
    points[0] = portPoint(source, edge.sourcePort);
  }
  if (target && edge.targetPort && edge.targetPort !== "auto") {
    points[points.length - 1] = portPoint(target, edge.targetPort);
  }
  return points;
}

function portPoint(
  bounds: LayoutBounds,
  side: Exclude<LayoutPortSide, "auto">,
): LayoutPoint {
  const middle = center(bounds);
  switch (side) {
    case "top": return { x: middle.x, y: bounds.y };
    case "right": return { x: bounds.x + bounds.width, y: middle.y };
    case "bottom": return { x: middle.x, y: bounds.y + bounds.height };
    case "left": return { x: bounds.x, y: middle.y };
  }
}

function cloneEdgeEntry(edge: EdgeLayoutEntry): EdgeLayoutEntry {
  return {
    identity: { ...edge.identity },
    ...(edge.labelOffset ? { labelOffset: { ...edge.labelOffset } } : {}),
    ...(edge.labelZIndex === undefined ? {} : { labelZIndex: edge.labelZIndex }),
    ...(edge.path ? { path: clonePath(edge.path) } : {}),
    points: edge.points.map((point) => ({ ...point })),
    source: { ...edge.source },
    ...(edge.sourcePort ? { sourcePort: edge.sourcePort } : {}),
    target: { ...edge.target },
    ...(edge.targetPort ? { targetPort: edge.targetPort } : {}),
    ...(edge.zIndex === undefined ? {} : { zIndex: edge.zIndex }),
  };
}

function cloneGroupEntry(group: LayoutGroupEntry): LayoutGroupEntry {
  return {
    bounds: { ...group.bounds },
    children: group.children.map((identity) => ({ ...identity })),
    id: group.id,
    ...(group.zIndex === undefined ? {} : { zIndex: group.zIndex }),
  };
}

function clonePath(path: DiagramPath): DiagramPath {
  return { segments: path.segments.map(clonePathSegment) };
}

function clonePathSegment(segment: DiagramPathSegment): DiagramPathSegment {
  if (segment.kind === "close") return segment;
  if (segment.kind === "cubic") return {
    ...segment,
    control1: { ...segment.control1 },
    control2: { ...segment.control2 },
    to: { ...segment.to },
  };
  if (segment.kind === "quadratic") return {
    ...segment,
    control: { ...segment.control },
    to: { ...segment.to },
  };
  return { ...segment, to: { ...segment.to } };
}

function hasCurve(path: DiagramPath): boolean {
  return path.segments.some(({ kind }) => kind === "cubic" || kind === "quadratic");
}

function resolvedEdgePath(path: DiagramPath, start: LayoutPoint, end: LayoutPoint): DiagramPath {
  const resolved = clonePath(path);
  const first = resolved.segments[0];
  if (first?.kind === "move") first.to = { ...start };
  for (let index = resolved.segments.length - 1; index > 0; index -= 1) {
    const segment = resolved.segments[index];
    if (segment && segment.kind !== "close") {
      segment.to = { ...end };
      break;
    }
  }
  return resolved;
}

function pathToSvgData(path: DiagramPath): string {
  return path.segments.map((segment) => {
    if (segment.kind === "close") return "Z";
    if (segment.kind === "move") return `M${segment.to.x},${segment.to.y}`;
    if (segment.kind === "line") return `L${segment.to.x},${segment.to.y}`;
    if (segment.kind === "quadratic") {
      return `Q${segment.control.x},${segment.control.y} ${segment.to.x},${segment.to.y}`;
    }
    if (segment.kind === "cubic") {
      return `C${segment.control1.x},${segment.control1.y} ${segment.control2.x},${segment.control2.y} ${segment.to.x},${segment.to.y}`;
    }
    return `A${segment.radiusX},${segment.radiusY} ${segment.rotation} ${segment.largeArc ? 1 : 0},${segment.sweep ? 1 : 0} ${segment.to.x},${segment.to.y}`;
  }).join(" ");
}

function renderPathControlHandles(
  overlay: SVGGElement,
  edgeKey: string,
  path: DiagramPath,
): void {
  let previous: LayoutPoint | undefined;
  path.segments.forEach((segment, segmentIndex) => {
    if (segment.kind === "close") return;
    if (segment.kind === "cubic") {
      if (previous) appendControlHandle(overlay, edgeKey, segmentIndex, "control1", previous, segment.control1);
      appendControlHandle(overlay, edgeKey, segmentIndex, "control2", segment.to, segment.control2);
    } else if (segment.kind === "quadratic") {
      if (previous) appendControlHandle(overlay, edgeKey, segmentIndex, "control", previous, segment.control);
    }
    previous = segment.to;
  });
}

function appendControlHandle(
  overlay: SVGGElement,
  edgeKey: string,
  segmentIndex: number,
  controlName: "control" | "control1" | "control2",
  anchor: LayoutPoint,
  control: LayoutPoint,
): void {
  const guide = svgElement("line");
  setSvgAttributes(guide, { x1: anchor.x, x2: control.x, y1: anchor.y, y2: control.y });
  guide.classList.add("layout-control-guide");
  overlay.append(guide);
  const handle = svgElement("circle");
  setSvgAttributes(handle, {
    "data-control-name": controlName,
    "data-edge-key": edgeKey,
    "data-layout-handle": "edge-control",
    "data-segment-index": segmentIndex,
    cx: control.x,
    cy: control.y,
    r: 6,
  });
  handle.classList.add("layout-control-handle");
  overlay.append(handle);
}

function unionBounds(bounds: readonly LayoutBounds[], padding = 0): LayoutBounds {
  const left = Math.min(...bounds.map(({ x }) => x));
  const top = Math.min(...bounds.map(({ y }) => y));
  const right = Math.max(...bounds.map(({ x, width }) => x + width));
  const bottom = Math.max(...bounds.map(({ y, height }) => y + height));
  return {
    height: bottom - top + padding * 2,
    width: right - left + padding * 2,
    x: left - padding,
    y: top - padding,
  };
}

function ensureWaypoint(edge: EdgeLayoutEntry): EdgeLayoutEntry {
  if (edge.points.length >= 3) return edge;
  const start = edge.points[0]!;
  const end = edge.points.at(-1)!;
  edge.points.splice(1, 0, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
  return edge;
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
): SVGElementTagNameMap[K] {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}

function setSvgAttributes(
  element: SVGElement,
  attributes: Record<string, string | number>,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
}

function stopPointer(event: PointerEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function layoutStorageKey(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `mmd2pptx:layout:v1:${(hash >>> 0).toString(36)}`;
}

function readViewBox(svg: SVGSVGElement): {
  height: number;
  width: number;
  x: number;
  y: number;
} {
  const viewBox = svg.viewBox.baseVal;
  if (viewBox.width > 0 && viewBox.height > 0) {
    return {
      height: viewBox.height,
      width: viewBox.width,
      x: viewBox.x,
      y: viewBox.y,
    };
  }
  return {
    height: Number.parseFloat(svg.getAttribute("height") ?? "0") || 1,
    width: Number.parseFloat(svg.getAttribute("width") ?? "0") || 1,
    x: 0,
    y: 0,
  };
}

function collisionKeys(
  entries: Map<string, { bounds: LayoutBounds }>,
): Set<string> {
  const collisions = new Set<string>();
  const nodes = [...entries];
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex];
      if (!right) continue;
      if (boundsOverlap(left[1].bounds, right[1].bounds)) {
        collisions.add(left[0]);
        collisions.add(right[0]);
      }
    }
  }
  return collisions;
}

function boundsOverlap(left: LayoutBounds, right: LayoutBounds): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}
