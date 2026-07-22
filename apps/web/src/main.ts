import {
  extractMermaidFlowchartSemantics,
  parseMermaidSvgElement,
  type ConversionDiagnostic,
  type ConversionSummary,
  type MermaidSemanticGraph,
} from "@mmd2pptx/core";
import mermaid from "mermaid";

import { EXAMPLE_DIAGRAM, MINI_EXAMPLE } from "./example.js";
import { SvgLayoutEditor, type LayoutEditorState } from "./layout/index.js";
import { SvgPanZoomViewer } from "./svg-viewer.js";
import "./styles.css";

type MermaidTheme = "base" | "default" | "forest" | "dark" | "neutral";
type ExportFormat = "drawio" | "json-canvas" | "pptx" | "svg";
type PptxMode = "exact" | "faithful" | "smart";

const MAX_MERMAID_FILE_BYTES = 1024 * 1024;
const MAX_LAYOUT_FILE_BYTES = 5 * 1024 * 1024;

const EXPORT_FORMATS = {
  drawio: {
    button: "Export draw.io",
    extension: ".drawio",
    mime: "application/xml",
    title: "Export an editable draw.io diagram.",
  },
  "json-canvas": {
    button: "Export JSON Canvas",
    extension: ".canvas",
    mime: "application/json",
    title: "Export an open JSON Canvas document.",
  },
  pptx: {
    button: "Export PowerPoint",
    extension: ".pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    title: "Export one clean, editable slide.",
  },
  svg: {
    button: "Export SVG",
    extension: ".svg",
    mime: "image/svg+xml",
    title: "Export a normalized standalone SVG.",
  },
} as const;

interface RenderState {
  diagnostics: ConversionDiagnostic[];
  summary?: ConversionSummary;
  syntaxError?: string;
}

const DEFAULT_SUMMARY: ConversionSummary = {
  editableObjects: 0,
  edges: 0,
  fallbackObjects: 0,
  nodes: 0,
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Application root was not found.");

app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="./" aria-label="mmd2pptx home">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>mmd<span>2</span>pptx</span>
      </a>
      <div class="topbar-note">
        <span class="privacy-dot" aria-hidden="true"></span>
        Your diagram stays in this browser
      </div>
      <a id="source-link" class="github-link" target="_blank" rel="noreferrer">
        Open source <span aria-hidden="true">↗</span>
      </a>
    </header>

    <main>
      <section class="intro" aria-labelledby="page-title">
        <div>
          <p class="eyebrow">MERMAID → NATIVE SHAPES</p>
          <h1 id="page-title">Diagrams that stay <em>editable.</em></h1>
        </div>
        <p class="intro-copy">Turn Mermaid flowcharts into PowerPoint slides made of real shapes, connectors, and text—not a flattened screenshot.</p>
      </section>

      <section class="controls-card" aria-label="Export settings">
        <label class="field filename-field">
          <span>File name</span>
          <span class="input-suffix-wrap">
            <input id="file-name" value="mmd2pptx-diagram" autocomplete="off" spellcheck="false" />
            <small id="file-suffix">.pptx</small>
          </span>
        </label>
        <label class="field">
          <span>Export format</span>
          <select id="export-format">
            <option value="pptx">PowerPoint (.pptx)</option>
            <option value="svg">SVG (.svg)</option>
            <option value="drawio">draw.io (.drawio)</option>
            <option value="json-canvas">JSON Canvas (.canvas)</option>
          </select>
        </label>
        <label class="field" id="pptx-mode-field">
          <span>PPTX mode</span>
          <select id="pptx-mode">
            <option value="smart">Smart — editable connectors</option>
            <option value="faithful">Faithful — visual geometry</option>
            <option value="exact">Exact — one SVG object</option>
          </select>
        </label>
        <label class="field" id="pptx-layout-field">
          <span>Mermaid theme</span>
          <select id="theme">
            <option value="base">Base</option>
            <option value="neutral">Neutral</option>
            <option value="default">Default</option>
            <option value="forest">Forest</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label class="field color-field">
          <span>Slide background</span>
          <span class="color-control">
            <input id="background" type="color" value="#ffffff" />
            <output id="background-value" for="background">#FFFFFF</output>
          </span>
        </label>
        <label class="field">
          <span>Slide format</span>
          <select id="layout">
            <option value="wide">Widescreen 16:9</option>
            <option value="standard">Standard 4:3</option>
          </select>
        </label>
      </section>

      <section class="workspace" aria-label="Mermaid conversion workspace">
        <article class="panel editor-panel">
          <div class="panel-head">
            <div>
              <span class="step">01</span>
              <h2>Mermaid source</h2>
            </div>
            <div class="examples">
              <button class="text-button" id="source-file-open" type="button">Open .mmd</button>
              <input id="source-file" type="file" accept=".mmd,.mermaid,text/plain" hidden />
              <button class="text-button" id="mini-example" type="button">Simple example</button>
              <button class="text-button" id="full-example" type="button">Detailed example</button>
            </div>
          </div>
          <div class="editor-wrap">
            <div class="line-number" aria-hidden="true">1</div>
            <textarea id="source" aria-label="Mermaid source" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
          </div>
          <footer class="panel-footer editor-footer">
            <span id="source-count">0 lines · 0 characters</span>
            <span class="keyboard-hint"><kbd>⌘</kbd><kbd>↵</kbd> export</span>
          </footer>
        </article>

        <article class="panel preview-panel">
          <div class="panel-head">
            <div>
              <span class="step">02</span>
              <h2>Live preview</h2>
            </div>
            <div id="render-state" class="render-state waiting">
              <span></span><b>Waiting</b>
            </div>
          </div>
          <div id="preview-stage" class="preview-stage">
            <div
              id="preview-viewport"
              class="preview-viewport"
              tabindex="0"
              role="region"
              aria-label="Interactive Mermaid preview. Drag to pan; use the mouse wheel or toolbar to zoom."
            >
              <div id="preview-canvas" class="preview-canvas">
                <div id="preview" class="preview" aria-live="polite"></div>
              </div>
            </div>
            <div id="empty-state" class="empty-state" hidden>
              <span aria-hidden="true">⌁</span>
              <p>Add a Mermaid diagram to see it here.</p>
            </div>
            <div id="viewer-feedback" class="viewer-feedback" role="status" aria-live="polite"></div>
            <div class="layout-toolbar" role="toolbar" aria-label="Layout adjustment controls">
              <button id="layout-toggle" type="button" aria-pressed="false" title="Adjust node positions">
                Adjust layout
              </button>
              <span class="toolbar-divider" aria-hidden="true"></span>
              <button id="layout-undo" class="layout-icon-button" type="button" aria-label="Undo layout change" title="Undo layout change (⌘Z)" disabled>↶</button>
              <button id="layout-redo" class="layout-icon-button" type="button" aria-label="Redo layout change" title="Redo layout change (⇧⌘Z)" disabled>↷</button>
              <button id="layout-reset" type="button" title="Restore Mermaid automatic layout" disabled>Reset</button>
              <button id="layout-route-edge" type="button" title="Route the selected edge around nodes" disabled>Auto-route</button>
              <select id="layout-arrange" aria-label="Align or distribute selected nodes" title="Align or distribute selected nodes" disabled>
                <option value="">Arrange…</option>
                <option value="left">Align left</option>
                <option value="center">Align center</option>
                <option value="right">Align right</option>
                <option value="top">Align top</option>
                <option value="middle">Align middle</option>
                <option value="bottom">Align bottom</option>
                <option value="horizontal">Distribute horizontally</option>
                <option value="vertical">Distribute vertically</option>
              </select>
              <select id="layout-layer" aria-label="Change selected node layer" title="Change selected node layer" disabled>
                <option value="">Layer…</option>
                <option value="front">Bring to front</option>
                <option value="forward">Bring forward</option>
                <option value="backward">Send backward</option>
                <option value="back">Send to back</option>
              </select>
              <button id="layout-group" type="button" title="Group selected nodes" disabled>Group</button>
              <button id="layout-ungroup" type="button" title="Ungroup the selected container" disabled>Ungroup</button>
              <span class="toolbar-divider" aria-hidden="true"></span>
              <button id="layout-import" type="button" title="Import a .layout.json sidecar">Import</button>
              <button id="layout-export" type="button" title="Export a .layout.json sidecar">Save layout</button>
              <label class="layout-persist" title="Recover this source's layout after a reload">
                <input id="layout-persist" type="checkbox" checked /> Auto-save
              </label>
              <button id="layout-clear-saved" type="button" title="Clear the saved layout for this Mermaid source" disabled>Clear saved</button>
              <input id="layout-file" type="file" accept=".json,.layout.json,application/json" hidden />
            </div>
            <div class="preview-toolbar" role="toolbar" aria-label="Diagram view controls">
              <button data-viewer-action="zoom-out" type="button" aria-label="Zoom out" title="Zoom out (−)" aria-keyshortcuts="-">
                <span aria-hidden="true">−</span>
              </button>
              <output id="viewer-zoom" aria-label="Current zoom">—</output>
              <button data-viewer-action="zoom-in" type="button" aria-label="Zoom in" title="Zoom in (+)" aria-keyshortcuts="+">
                <span aria-hidden="true">+</span>
              </button>
              <span class="toolbar-divider" aria-hidden="true"></span>
              <button data-viewer-action="reset" type="button" aria-label="Reset to 100 percent" title="Reset to 100% (0)" aria-keyshortcuts="0">
                <span aria-hidden="true">↺</span>
              </button>
              <button data-viewer-action="fit" type="button" aria-label="Fit diagram to view" title="Fit diagram to view (F)" aria-keyshortcuts="F">
                <span aria-hidden="true">⊡</span>
              </button>
              <button data-viewer-action="fit-width" type="button" aria-label="Fit diagram width" title="Fit diagram width (W)" aria-keyshortcuts="W">
                <span aria-hidden="true">↔</span>
              </button>
              <span class="toolbar-divider" aria-hidden="true"></span>
              <button data-viewer-action="copy-source" type="button" aria-label="Copy Mermaid source" title="Copy Mermaid source">
                <span class="toolbar-code-icon" aria-hidden="true">{ }</span>
              </button>
              <button data-viewer-action="copy-svg" type="button" aria-label="Copy SVG" title="Copy SVG">
                <span class="toolbar-code-icon" aria-hidden="true">&lt; &gt;</span>
              </button>
              <button data-viewer-action="expand" type="button" aria-label="Expand preview" title="Expand preview" aria-expanded="false">
                <span aria-hidden="true">⛶</span>
              </button>
            </div>
          </div>
          <footer class="panel-footer preview-footer">
            <span id="layout-status">Mermaid automatic layout</span>
            <button id="fit-preview" class="text-button" type="button">Fit to view</button>
          </footer>
        </article>
      </section>

      <section class="export-row">
        <div class="diagnostics-card" aria-live="polite">
          <div class="diagnostics-head">
            <div>
              <p class="eyebrow">EXPORT READINESS</p>
              <h2 id="diagnostic-title">Checking diagram…</h2>
            </div>
            <span id="diagnostic-badge" class="badge checking">Checking</span>
          </div>
          <div class="metrics" id="metrics" aria-label="Conversion summary">
            <div><strong id="metric-nodes">—</strong><span>nodes</span></div>
            <div><strong id="metric-edges">—</strong><span>edges</span></div>
            <div><strong id="metric-editable">—</strong><span>editable</span></div>
            <div><strong id="metric-fallback">—</strong><span>fallbacks</span></div>
          </div>
          <ul id="diagnostic-list" class="diagnostic-list"></ul>
        </div>

        <div class="download-card">
          <p id="export-lead">Ready for your deck?</p>
          <h2 id="export-title">Export one clean, editable slide.</h2>
          <button id="export" class="export-button" type="button" disabled>
            <span>Export PowerPoint</span>
            <i aria-hidden="true">↓</i>
          </button>
          <small>No upload. No account. No diagram data retained.</small>
        </div>
      </section>
    </main>

    <footer class="site-footer">
      <p><strong>mmd2pptx</strong> · clean-room, open-source Mermaid conversion</p>
      <p>Built for editable diagrams and verifiable output.</p>
    </footer>
  </div>`;

const elements = {
  background: required<HTMLInputElement>("#background"),
  backgroundValue: required<HTMLOutputElement>("#background-value"),
  diagnosticBadge: required<HTMLSpanElement>("#diagnostic-badge"),
  diagnosticList: required<HTMLUListElement>("#diagnostic-list"),
  diagnosticTitle: required<HTMLHeadingElement>("#diagnostic-title"),
  emptyState: required<HTMLDivElement>("#empty-state"),
  exportButton: required<HTMLButtonElement>("#export"),
  exportFormat: required<HTMLSelectElement>("#export-format"),
  exportLead: required<HTMLParagraphElement>("#export-lead"),
  exportTitle: required<HTMLHeadingElement>("#export-title"),
  fileName: required<HTMLInputElement>("#file-name"),
  fileSuffix: required<HTMLElement>("#file-suffix"),
  fitPreview: required<HTMLButtonElement>("#fit-preview"),
  fullExample: required<HTMLButtonElement>("#full-example"),
  layout: required<HTMLSelectElement>("#layout"),
  layoutArrange: required<HTMLSelectElement>("#layout-arrange"),
  layoutClearSaved: required<HTMLButtonElement>("#layout-clear-saved"),
  layoutField: required<HTMLElement>("#pptx-layout-field"),
  layoutExport: required<HTMLButtonElement>("#layout-export"),
  layoutFile: required<HTMLInputElement>("#layout-file"),
  layoutGroup: required<HTMLButtonElement>("#layout-group"),
  layoutImport: required<HTMLButtonElement>("#layout-import"),
  layoutLayer: required<HTMLSelectElement>("#layout-layer"),
  layoutPersist: required<HTMLInputElement>("#layout-persist"),
  layoutRedo: required<HTMLButtonElement>("#layout-redo"),
  layoutReset: required<HTMLButtonElement>("#layout-reset"),
  layoutRouteEdge: required<HTMLButtonElement>("#layout-route-edge"),
  layoutStatus: required<HTMLSpanElement>("#layout-status"),
  layoutToggle: required<HTMLButtonElement>("#layout-toggle"),
  layoutUndo: required<HTMLButtonElement>("#layout-undo"),
  layoutUngroup: required<HTMLButtonElement>("#layout-ungroup"),
  metrics: {
    editable: required<HTMLElement>("#metric-editable"),
    edges: required<HTMLElement>("#metric-edges"),
    fallback: required<HTMLElement>("#metric-fallback"),
    nodes: required<HTMLElement>("#metric-nodes"),
  },
  miniExample: required<HTMLButtonElement>("#mini-example"),
  preview: required<HTMLDivElement>("#preview"),
  previewStage: required<HTMLDivElement>("#preview-stage"),
  pptxMode: required<HTMLSelectElement>("#pptx-mode"),
  pptxModeField: required<HTMLElement>("#pptx-mode-field"),
  renderState: required<HTMLDivElement>("#render-state"),
  source: required<HTMLTextAreaElement>("#source"),
  sourceFile: required<HTMLInputElement>("#source-file"),
  sourceFileOpen: required<HTMLButtonElement>("#source-file-open"),
  sourceLink: required<HTMLAnchorElement>("#source-link"),
  sourceCount: required<HTMLSpanElement>("#source-count"),
  theme: required<HTMLSelectElement>("#theme"),
};

const svgViewer = new SvgPanZoomViewer({
  getSource: () => elements.source.value,
  root: elements.previewStage,
});
const layoutEditor = new SvgLayoutEditor({
  onGeometryChange: () => svgViewer.refreshDimensions(),
  onLayoutMutation: scheduleReadinessCheck,
  onStateChange: updateLayoutControls,
  viewport: required<HTMLElement>("#preview-viewport"),
});

const repositoryUrl = import.meta.env.VITE_REPOSITORY_URL;
if (repositoryUrl) {
  elements.sourceLink.href = repositoryUrl;
} else {
  elements.sourceLink.classList.add("disabled");
  elements.sourceLink.textContent = "Apache-2.0";
  elements.sourceLink.removeAttribute("target");
}

let debounceTimer = 0;
let inspectionSequence = 0;
let renderSequence = 0;
let lastState: RenderState = { diagnostics: [] };
let semanticDiagnostics: ConversionDiagnostic[] = [];
let semantics: MermaidSemanticGraph | undefined;

updateExportControls();
elements.source.value = EXAMPLE_DIAGRAM;
updateSourceCount();
scheduleRender(0);

elements.source.addEventListener("input", () => {
  updateSourceCount();
  scheduleRender();
});
elements.sourceFileOpen.addEventListener("click", () => elements.sourceFile.click());
elements.sourceFile.addEventListener("change", () => void importMermaidFile());
elements.theme.addEventListener("change", () => scheduleRender(0));
elements.background.addEventListener("input", () => {
  elements.backgroundValue.value = elements.background.value.toUpperCase();
  elements.previewStage.style.backgroundColor = elements.background.value;
  scheduleReadinessCheck();
});
elements.layout.addEventListener("change", scheduleReadinessCheck);
elements.exportFormat.addEventListener("change", () => {
  updateExportControls();
  scheduleReadinessCheck();
});
elements.pptxMode.addEventListener("change", scheduleReadinessCheck);
elements.fullExample.addEventListener("click", () => loadExample(EXAMPLE_DIAGRAM));
elements.miniExample.addEventListener("click", () => loadExample(MINI_EXAMPLE));
elements.fitPreview.addEventListener("click", () => svgViewer.fit());
elements.layoutToggle.addEventListener("click", () => layoutEditor.toggleEditing());
elements.layoutUndo.addEventListener("click", () => layoutEditor.undo());
elements.layoutRedo.addEventListener("click", () => layoutEditor.redo());
elements.layoutReset.addEventListener("click", () => {
  layoutEditor.resetAutomaticLayout();
  scheduleReadinessCheck();
});
elements.layoutRouteEdge.addEventListener("click", () => {
  layoutEditor.routeSelectedEdge();
  scheduleReadinessCheck();
});
elements.layoutArrange.addEventListener("change", () => {
  const action = elements.layoutArrange.value;
  elements.layoutArrange.value = "";
  if (action) layoutEditor.arrangeSelection(
    action as Parameters<SvgLayoutEditor["arrangeSelection"]>[0],
  );
});
elements.layoutLayer.addEventListener("change", () => {
  const action = elements.layoutLayer.value;
  elements.layoutLayer.value = "";
  if (action) layoutEditor.changeLayerOrder(
    action as Parameters<SvgLayoutEditor["changeLayerOrder"]>[0],
  );
});
elements.layoutGroup.addEventListener("click", () => layoutEditor.createGroupFromSelection());
elements.layoutUngroup.addEventListener("click", () => layoutEditor.ungroupSelection());
elements.layoutImport.addEventListener("click", () => elements.layoutFile.click());
elements.layoutPersist.addEventListener("change", () => {
  layoutEditor.setPersistenceEnabled(elements.layoutPersist.checked);
});
elements.layoutClearSaved.addEventListener("click", () => {
  layoutEditor.clearSavedLayout();
  scheduleReadinessCheck();
});
elements.layoutExport.addEventListener("click", () => {
  downloadBlob(
    new Blob([layoutEditor.exportSidecar()], { type: "application/json" }),
    normalizedLayoutFileName(),
  );
});
elements.layoutFile.addEventListener("change", () => void importLayoutFile());
elements.exportButton.addEventListener("click", () => void exportCurrentFormat());
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    if (!elements.exportButton.disabled) void exportCurrentFormat();
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "z" &&
    !isTextEntry(event.target)
  ) {
    event.preventDefault();
    if (event.shiftKey) layoutEditor.redo();
    else layoutEditor.undo();
  }
});

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required element not found: ${selector}`);
  return element;
}

function loadExample(source: string): void {
  elements.source.value = source;
  updateSourceCount();
  scheduleRender(0);
  elements.source.focus();
}

function updateSourceCount(): void {
  const value = elements.source.value;
  const lines = value ? value.split("\n").length : 0;
  elements.sourceCount.textContent = `${lines} ${lines === 1 ? "line" : "lines"} · ${value.length} characters`;
}

function scheduleRender(delay = 320): void {
  window.clearTimeout(debounceTimer);
  inspectionSequence += 1;
  elements.exportButton.disabled = true;
  setRenderState("rendering", "Rendering");
  debounceTimer = window.setTimeout(() => void renderDiagram(), delay);
}

function scheduleReadinessCheck(): void {
  if (elements.preview.querySelector("svg")) {
    elements.exportButton.disabled = true;
    setDiagnosticStatus("checking", "Checking export readiness…", "Checking");
    void inspectConversion();
  }
}

async function renderDiagram(): Promise<void> {
  const source = elements.source.value.trim();
  const sequence = ++renderSequence;

  if (!source) {
    elements.preview.replaceChildren();
    svgViewer.clear();
    layoutEditor.clear();
    elements.emptyState.hidden = false;
    lastState = { diagnostics: [], syntaxError: "Enter Mermaid source to continue." };
    setRenderState("waiting", "Waiting");
    updateDiagnostics(lastState);
    return;
  }

  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: elements.theme.value as MermaidTheme,
      flowchart: { nodeSpacing: 30, rankSpacing: 42 },
      themeVariables: {
        fontFamily: "Arial, sans-serif",
        lineColor: "#24323d",
        primaryBorderColor: "#24323d",
        primaryColor: "#ffffff",
        primaryTextColor: "#202830",
      },
    });

    const rendered = await mermaid.render(`mmd2pptx-preview-${sequence}`, source);
    if (sequence !== renderSequence) return;

    let nextSemantics: MermaidSemanticGraph | undefined;
    let nextSemanticDiagnostics: ConversionDiagnostic[] = [];
    try {
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
      if (sequence !== renderSequence) return;
      const extracted = extractMermaidFlowchartSemantics(diagram);
      nextSemantics = extracted.graph ?? undefined;
      nextSemanticDiagnostics = extracted.diagnostics.map((diagnostic) =>
        !extracted.graph && diagnostic.severity === "error"
          ? { ...diagnostic, severity: "warning" as const }
          : diagnostic);
    } catch (error) {
      nextSemanticDiagnostics = [{
        code: "MERMAID_FLOWDB_READ_FAILED",
        message: `Mermaid source semantics were unavailable; SVG fallback remains active: ${readableError(error)}`,
        severity: "warning",
      }];
    }
    if (sequence !== renderSequence) return;
    semantics = nextSemantics;
    semanticDiagnostics = nextSemanticDiagnostics;
    elements.preview.innerHTML = rendered.svg;
    elements.previewStage.style.backgroundColor = elements.background.value;
    elements.emptyState.hidden = true;
    const svg = elements.preview.querySelector("svg");
    if (svg) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Rendered Mermaid diagram");
      svgViewer.setSvg(svg);
      layoutEditor.setSvg(svg, source, semantics);
    }
    setRenderState("ready", "Rendered");
    await inspectConversion();
  } catch (error) {
    if (sequence !== renderSequence) return;
    const message = readableError(error);
    elements.preview.replaceChildren();
    svgViewer.clear();
    layoutEditor.clear();
    semantics = undefined;
    semanticDiagnostics = [];
    elements.emptyState.hidden = false;
    lastState = { diagnostics: [], syntaxError: message };
    setRenderState("error", "Syntax error");
    updateDiagnostics(lastState);
  }
}

async function inspectConversion(): Promise<void> {
  const svg = elements.preview.querySelector<SVGSVGElement>("svg");
  if (!svg) return;
  const sequence = ++inspectionSequence;
  const selectedFormat = selectedExportFormat();
  const selectedMode = elements.pptxMode.value as PptxMode;

  try {
    const parsed = parseMermaidSvgElement(svg, semantics ? { semantics } : {});
    const core = await import("@mmd2pptx/core");
    const laidOut = core.applyLayoutSidecar(parsed.data, layoutEditor.getSidecar());
    const diagram = laidOut.data;
    const format = selectedFormat;
    const commonOptions = { backgroundColor: elements.background.value };
    let preflight;
    if (format === "pptx") {
      preflight = core.preflightDiagramToPptx(diagram, {
        ...commonOptions,
        layout: elements.layout.value as "wide" | "standard",
        mode: selectedMode,
      });
    } else if (!isSupportedForwardDiagram(diagram.source?.diagramType)) {
      const diagramType = diagram.source?.diagramType ?? "this diagram type";
      preflight = {
        diagnostics: [{
          code: `${format.toUpperCase().replaceAll("-", "_")}_DIAGRAM_TYPE_UNSUPPORTED`,
          message: `${formatLabel(format)} export does not yet support ${diagramType}; use PowerPoint exact mode to preserve the live SVG.`,
          severity: "error" as const,
        }],
        summary: parsed.summary,
      };
    } else {
      preflight = await (format === "svg"
        ? core.svgExporter.export(diagram, commonOptions)
        : format === "drawio"
          ? core.drawioExporter.export(diagram, commonOptions)
          : core.jsonCanvasExporter.export(diagram, commonOptions));
    }
    if (sequence !== inspectionSequence
      || selectedFormat !== selectedExportFormat()
      || selectedMode !== elements.pptxMode.value
      || svg !== elements.preview.querySelector("svg")) return;
    lastState = {
      diagnostics: [
        ...semanticDiagnostics,
        ...parsed.diagnostics,
        ...laidOut.diagnostics,
        ...preflight.diagnostics,
      ],
      summary: preflight.summary,
    };
    updateDiagnostics(lastState);
  } catch (error) {
    if (sequence !== inspectionSequence) return;
    lastState = {
      diagnostics: [{ code: "SVG_PARSE_FAILED", message: readableError(error), severity: "error" }],
    };
    updateDiagnostics(lastState);
  }
}

function updateDiagnostics(state: RenderState): void {
  const summary = state.summary ?? DEFAULT_SUMMARY;
  const hasSummary = Boolean(state.summary);
  const errors = state.diagnostics.filter((item) => item.severity === "error");
  const warnings = state.diagnostics.filter((item) => item.severity === "warning");
  const items = state.syntaxError
    ? [{ code: "MERMAID_SYNTAX", message: state.syntaxError, severity: "error" as const }]
    : state.diagnostics;

  elements.metrics.nodes.textContent = hasSummary ? String(summary.nodes) : "—";
  elements.metrics.edges.textContent = hasSummary ? String(summary.edges) : "—";
  elements.metrics.editable.textContent = hasSummary ? String(summary.editableObjects) : "—";
  elements.metrics.fallback.textContent = hasSummary ? String(summary.fallbackObjects) : "—";
  const displayedItems = items.filter((diagnostic, index, all) =>
    all.findIndex((candidate) => candidate.code === diagnostic.code) === index,
  );
  elements.diagnosticList.replaceChildren(
    ...displayedItems.slice(0, 8).map((diagnostic) => {
      const item = document.createElement("li");
      item.className = `diagnostic-${diagnostic.severity}`;
      const code = document.createElement("code");
      code.textContent = diagnostic.code;
      const message = document.createElement("span");
      message.textContent = diagnostic.message;
      item.append(code, message);
      return item;
    }),
  );

  if (state.syntaxError || errors.length > 0) {
    setDiagnosticStatus("blocked", "Needs attention", "Export blocked");
    elements.exportButton.disabled = true;
  } else if (!hasSummary) {
    setDiagnosticStatus("checking", "Checking diagram…", "Checking");
    elements.exportButton.disabled = true;
  } else if (selectedExportFormat() === "pptx" && elements.pptxMode.value === "exact") {
    setDiagnosticStatus("ready", "Appearance preserved as one SVG", "Ready");
    elements.exportButton.disabled = false;
  } else if (warnings.length > 0 || summary.fallbackObjects > 0) {
    setDiagnosticStatus("warning", "Exportable with notes", `${warnings.length || summary.fallbackObjects} notes`);
    elements.exportButton.disabled = false;
  } else {
    setDiagnosticStatus("ready", "Everything can stay editable", "Ready");
    elements.exportButton.disabled = false;
  }
}

function setDiagnosticStatus(kind: string, title: string, badge: string): void {
  elements.diagnosticTitle.textContent = title;
  elements.diagnosticBadge.className = `badge ${kind}`;
  elements.diagnosticBadge.textContent = badge;
}

function setRenderState(kind: string, label: string): void {
  elements.renderState.className = `render-state ${kind}`;
  const text = elements.renderState.querySelector("b");
  if (text) text.textContent = label;
}

async function exportCurrentFormat(): Promise<void> {
  const svg = elements.preview.querySelector<SVGSVGElement>("svg");
  if (!svg) return;

  const format = selectedExportFormat();
  const pptxMode = elements.pptxMode.value as PptxMode;
  const slideLayout = elements.layout.value as "wide" | "standard";
  const sourceAtStart = elements.source.value;
  const spec = EXPORT_FORMATS[format];

  elements.exportButton.disabled = true;
  elements.exportFormat.disabled = true;
  elements.pptxMode.disabled = true;
  elements.layout.disabled = true;
  elements.exportButton.classList.add("busy");
  elements.exportButton.querySelector("span")!.textContent = `Building ${formatLabel(format)}…`;

  try {
    const parsed = parseMermaidSvgElement(svg, semantics ? { semantics } : {});
    if (parsed.diagnostics.some((item) => item.severity === "error")) {
      throw new Error("The diagram contains conversion errors. Review diagnostics before exporting.");
    }

    // Exporters are loaded only when requested; PowerPoint remains the heaviest path.
    const core = await import("@mmd2pptx/core");
    const laidOut = core.applyLayoutSidecar(parsed.data, layoutEditor.getSidecar());
    const diagram = laidOut.data;
    const commonOptions = { backgroundColor: elements.background.value };
    const result = format === "pptx"
      ? pptxMode === "exact"
        ? await core.svgStringToPptxBlob(serializeLiveSvgForExport(svg), {
            ...commonOptions,
            fileName: normalizedFileName(format),
            layout: slideLayout,
            mode: "exact",
          })
        : await core.diagramToPptxBlob(diagram, {
          ...commonOptions,
          fileName: normalizedFileName(format),
          layout: slideLayout,
          mode: pptxMode,
        })
      : format === "svg"
        ? await core.svgExporter.export(diagram, {
            ...commonOptions,
            title: normalizedBaseName(),
          })
        : format === "drawio"
          ? await core.drawioExporter.export(diagram, {
              ...commonOptions,
              pageName: normalizedBaseName(),
            })
          : await core.jsonCanvasExporter.export(diagram, commonOptions);
    const outputDiagnostics = [
      ...semanticDiagnostics,
      ...parsed.diagnostics,
      ...laidOut.diagnostics,
      ...result.diagnostics,
    ];
    const requestIsCurrent = sourceAtStart === elements.source.value
      && svg === elements.preview.querySelector("svg")
      && format === selectedExportFormat()
      && pptxMode === elements.pptxMode.value;
    if (requestIsCurrent) {
      lastState = { diagnostics: outputDiagnostics, summary: result.summary };
      updateDiagnostics(lastState);
    }

    if (outputDiagnostics.some((item) => item.severity === "error")) {
      throw new Error(`${formatLabel(format)} validation failed. No file was downloaded.`);
    }

    const blob = result.data instanceof Blob
      ? result.data
      : new Blob([result.data], { type: spec.mime });
    downloadBlob(blob, normalizedFileName(format));
    elements.exportButton.querySelector("span")!.textContent = "Downloaded";
    window.setTimeout(() => resetExportButton(), 1600);
    restoreExportSelectors();
  } catch (error) {
    const diagnostic: ConversionDiagnostic = {
      code: "EXPORT_FAILED",
      message: readableError(error),
      severity: "error",
    };
    if (sourceAtStart === elements.source.value && svg === elements.preview.querySelector("svg")) {
      lastState = lastState.summary
        ? { diagnostics: [...lastState.diagnostics, diagnostic], summary: lastState.summary }
        : { diagnostics: [...lastState.diagnostics, diagnostic] };
      updateDiagnostics(lastState);
    }
    resetExportButton();
    restoreExportSelectors();
  }
}

function restoreExportSelectors(): void {
  elements.exportFormat.disabled = false;
  const isPptx = selectedExportFormat() === "pptx";
  elements.pptxMode.disabled = !isPptx;
  elements.layout.disabled = !isPptx;
}

function resetExportButton(): void {
  elements.exportButton.classList.remove("busy");
  elements.exportButton.querySelector("span")!.textContent =
    EXPORT_FORMATS[selectedExportFormat()].button;
  const hasErrors = lastState.diagnostics.some((item) => item.severity === "error");
  elements.exportButton.disabled = hasErrors || Boolean(lastState.syntaxError) || !lastState.summary;
}

function normalizedBaseName(): string {
  return elements.fileName.value
    .trim()
    .replace(/\.(?:pptx|svg|drawio|canvas|layout\.json)$/i, "")
    .replace(/[\\/:*?"<>|]/g, "-") || "mmd2pptx-diagram";
}

function normalizedFileName(format: ExportFormat = selectedExportFormat()): string {
  return `${normalizedBaseName()}${EXPORT_FORMATS[format].extension}`;
}

function normalizedLayoutFileName(): string {
  return `${normalizedBaseName()}.layout.json`;
}

async function importLayoutFile(): Promise<void> {
  const file = elements.layoutFile.files?.[0];
  elements.layoutFile.value = "";
  if (!file) return;
  try {
    if (file.size > MAX_LAYOUT_FILE_BYTES) {
      throw new Error("Layout sidecars must be 5 MiB or smaller.");
    }
    layoutEditor.importSidecar(await file.text());
    scheduleReadinessCheck();
  } catch (error) {
    elements.layoutStatus.textContent = `Layout import failed: ${readableError(error)}`;
  }
}

async function importMermaidFile(): Promise<void> {
  const file = elements.sourceFile.files?.[0];
  elements.sourceFile.value = "";
  if (!file) return;
  if (file.size > MAX_MERMAID_FILE_BYTES) {
    lastState = {
      diagnostics: [{
        code: "MERMAID_FILE_TOO_LARGE",
        message: "Mermaid files must be 1 MiB or smaller.",
        severity: "error",
      }],
    };
    setRenderState("error", "File too large");
    updateDiagnostics(lastState);
    return;
  }
  layoutEditor.loadPersistedForNextSource();
  elements.source.value = await file.text();
  const baseName = file.name.replace(/\.(?:mmd|mermaid)$/i, "").trim();
  if (baseName) elements.fileName.value = baseName;
  updateSourceCount();
  scheduleRender(0);
  elements.source.focus();
}

function updateLayoutControls(state: LayoutEditorState): void {
  elements.layoutToggle.disabled = !state.hasDiagram;
  elements.layoutToggle.setAttribute("aria-pressed", String(state.editing));
  elements.layoutToggle.textContent = state.editing ? "Done adjusting" : "Adjust layout";
  elements.layoutUndo.disabled = !state.canUndo;
  elements.layoutRedo.disabled = !state.canRedo;
  elements.layoutReset.disabled = !state.hasOverrides;
  elements.layoutRouteEdge.disabled = !state.selectedEdgeId;
  elements.layoutArrange.disabled = state.selectedNodeCount < 2;
  elements.layoutLayer.disabled = state.selectedNodeCount < 1;
  elements.layoutGroup.disabled = !state.canGroup;
  elements.layoutUngroup.disabled = !state.canUngroup;
  elements.layoutExport.disabled = !state.hasDiagram;
  elements.layoutImport.disabled = !state.hasDiagram;
  elements.layoutPersist.checked = state.persistenceEnabled;
  elements.layoutClearSaved.disabled = !state.hasSavedLayout;
  elements.layoutStatus.classList.toggle("has-collision", state.collisionCount > 0);
  elements.layoutStatus.textContent = state.collisionCount > 0
    ? `${state.collisionCount} overlapping nodes · positions kept`
    : state.routingWarnings.length > 0
      ? `Routing note · ${state.routingWarnings[0]}`
    : state.editing
    ? state.selectedGroupId
      ? `Adjusting group ${state.selectedGroupId} · drag, resize, or ungroup`
      : state.selectedNodeId
      ? state.selectedNodeCount > 1
        ? `${state.selectedNodeCount} nodes selected · drag, align, distribute, or change layer`
        : `Adjusting ${state.selectedNodeId} · drag, resize, or use arrow keys`
      : state.selectedEdgeId
        ? `Adjusting ${state.selectedEdgeId} · choose ports or drag its path/label`
        : "Adjust mode · select a node or edge"
    : state.hasOverrides
      ? state.persistenceEnabled && state.hasSavedLayout
        ? "Custom layout · auto-saved for this Mermaid source"
        : "Custom layout · save the sidecar to reuse it"
      : "Mermaid automatic layout";
}

function selectedExportFormat(): ExportFormat {
  return elements.exportFormat.value as ExportFormat;
}

function updateExportControls(): void {
  const format = selectedExportFormat();
  const spec = EXPORT_FORMATS[format];
  const isPptx = format === "pptx";
  elements.fileSuffix.textContent = spec.extension;
  elements.pptxMode.disabled = !isPptx;
  elements.layout.disabled = !isPptx;
  elements.pptxModeField.classList.toggle("is-disabled", !isPptx);
  elements.layoutField.classList.toggle("is-disabled", !isPptx);
  elements.exportLead.textContent = isPptx ? "Ready for your deck?" : "Ready for another canvas?";
  elements.exportTitle.textContent = spec.title;
  resetExportButton();
}

function formatLabel(format: ExportFormat): string {
  switch (format) {
    case "drawio": return "draw.io";
    case "json-canvas": return "JSON Canvas";
    case "svg": return "SVG";
    default: return "PowerPoint";
  }
}

function isSupportedForwardDiagram(diagramType: string | undefined): boolean {
  return diagramType === undefined || diagramType === "flowchart" || diagramType === "flowchart-v2";
}

function serializeLiveSvgForExport(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelector(".layout-overlay")?.remove();
  for (const handle of clone.querySelectorAll("[data-layout-handle]")) handle.remove();
  for (const element of clone.querySelectorAll(
    ".layout-node-manual, .layout-node-selected, .layout-node-collision, .layout-edge-selected",
  )) {
    element.classList.remove(
      "layout-node-manual",
      "layout-node-selected",
      "layout-node-collision",
      "layout-edge-selected",
    );
  }
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(clone);
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readableError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error:\s*/i, "").split("\n")[0] || "Unknown error";
  }
  return String(error);
}
