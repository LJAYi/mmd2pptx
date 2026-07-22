import {
  parseMermaidSvgElement,
  type ConversionDiagnostic,
  type ConversionSummary,
} from "@mmd2pptx/core";
import mermaid from "mermaid";

import { EXAMPLE_DIAGRAM, MINI_EXAMPLE } from "./example.js";
import { SvgPanZoomViewer } from "./svg-viewer.js";
import "./styles.css";

type MermaidTheme = "base" | "default" | "forest" | "dark" | "neutral";

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
            <small>.pptx</small>
          </span>
        </label>
        <label class="field">
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
            <span>Preview reflects the selected theme</span>
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
          <p>Ready for your deck?</p>
          <h2>Export one clean, editable slide.</h2>
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
  fileName: required<HTMLInputElement>("#file-name"),
  fitPreview: required<HTMLButtonElement>("#fit-preview"),
  fullExample: required<HTMLButtonElement>("#full-example"),
  layout: required<HTMLSelectElement>("#layout"),
  metrics: {
    editable: required<HTMLElement>("#metric-editable"),
    edges: required<HTMLElement>("#metric-edges"),
    fallback: required<HTMLElement>("#metric-fallback"),
    nodes: required<HTMLElement>("#metric-nodes"),
  },
  miniExample: required<HTMLButtonElement>("#mini-example"),
  preview: required<HTMLDivElement>("#preview"),
  previewStage: required<HTMLDivElement>("#preview-stage"),
  renderState: required<HTMLDivElement>("#render-state"),
  source: required<HTMLTextAreaElement>("#source"),
  sourceLink: required<HTMLAnchorElement>("#source-link"),
  sourceCount: required<HTMLSpanElement>("#source-count"),
  theme: required<HTMLSelectElement>("#theme"),
};

const svgViewer = new SvgPanZoomViewer({
  getSource: () => elements.source.value,
  root: elements.previewStage,
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
let renderSequence = 0;
let lastState: RenderState = { diagnostics: [] };

elements.source.value = EXAMPLE_DIAGRAM;
updateSourceCount();
scheduleRender(0);

elements.source.addEventListener("input", () => {
  updateSourceCount();
  scheduleRender();
});
elements.theme.addEventListener("change", () => scheduleRender(0));
elements.background.addEventListener("input", () => {
  elements.backgroundValue.value = elements.background.value.toUpperCase();
  elements.previewStage.style.backgroundColor = elements.background.value;
  scheduleReadinessCheck();
});
elements.layout.addEventListener("change", scheduleReadinessCheck);
elements.fullExample.addEventListener("click", () => loadExample(EXAMPLE_DIAGRAM));
elements.miniExample.addEventListener("click", () => loadExample(MINI_EXAMPLE));
elements.fitPreview.addEventListener("click", () => svgViewer.fit());
elements.exportButton.addEventListener("click", () => void exportPowerPoint());
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    if (!elements.exportButton.disabled) void exportPowerPoint();
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
  setRenderState("rendering", "Rendering");
  debounceTimer = window.setTimeout(() => void renderDiagram(), delay);
}

function scheduleReadinessCheck(): void {
  if (elements.preview.querySelector("svg")) void inspectConversion();
}

async function renderDiagram(): Promise<void> {
  const source = elements.source.value.trim();
  const sequence = ++renderSequence;

  if (!source) {
    elements.preview.replaceChildren();
    svgViewer.clear();
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
      flowchart: { curve: "linear", nodeSpacing: 30, rankSpacing: 42 },
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

    elements.preview.innerHTML = rendered.svg;
    elements.previewStage.style.backgroundColor = elements.background.value;
    elements.emptyState.hidden = true;
    const svg = elements.preview.querySelector("svg");
    if (svg) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Rendered Mermaid diagram");
      svgViewer.setSvg(svg);
    }
    setRenderState("ready", "Rendered");
    await inspectConversion();
  } catch (error) {
    if (sequence !== renderSequence) return;
    const message = readableError(error);
    elements.preview.replaceChildren();
    svgViewer.clear();
    elements.emptyState.hidden = false;
    lastState = { diagnostics: [], syntaxError: message };
    setRenderState("error", "Syntax error");
    updateDiagnostics(lastState);
  }
}

async function inspectConversion(): Promise<void> {
  const svg = elements.preview.querySelector<SVGSVGElement>("svg");
  if (!svg) return;

  try {
    const parsed = parseMermaidSvgElement(svg);
    lastState = {
      diagnostics: parsed.diagnostics,
      summary: parsed.summary,
    };
    updateDiagnostics(lastState);
  } catch (error) {
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
  elements.diagnosticList.replaceChildren(
    ...items.slice(0, 8).map((diagnostic) => {
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

async function exportPowerPoint(): Promise<void> {
  const svg = elements.preview.querySelector<SVGSVGElement>("svg");
  if (!svg) return;

  elements.exportButton.disabled = true;
  elements.exportButton.classList.add("busy");
  elements.exportButton.querySelector("span")!.textContent = "Building slide…";

  try {
    const parsed = parseMermaidSvgElement(svg);
    if (parsed.diagnostics.some((item) => item.severity === "error")) {
      throw new Error("The diagram contains conversion errors. Review diagnostics before exporting.");
    }

    // PowerPoint generation is the heaviest dependency; load it only when requested.
    const { diagramToPptxBlob } = await import("@mmd2pptx/core");
    const result = await diagramToPptxBlob(parsed.data, {
      backgroundColor: elements.background.value,
      fileName: normalizedFileName(),
      layout: elements.layout.value as "wide" | "standard",
    });
    const outputDiagnostics = [...parsed.diagnostics, ...result.diagnostics];
    lastState = { diagnostics: outputDiagnostics, summary: result.summary };
    updateDiagnostics(lastState);

    if (outputDiagnostics.some((item) => item.severity === "error")) {
      throw new Error("PowerPoint validation failed. No file was downloaded.");
    }

    downloadBlob(result.data, normalizedFileName());
    elements.exportButton.querySelector("span")!.textContent = "Downloaded";
    window.setTimeout(() => resetExportButton(), 1600);
  } catch (error) {
    const diagnostic: ConversionDiagnostic = {
      code: "EXPORT_FAILED",
      message: readableError(error),
      severity: "error",
    };
    lastState = lastState.summary
      ? { diagnostics: [...lastState.diagnostics, diagnostic], summary: lastState.summary }
      : { diagnostics: [...lastState.diagnostics, diagnostic] };
    updateDiagnostics(lastState);
    resetExportButton();
  }
}

function resetExportButton(): void {
  elements.exportButton.classList.remove("busy");
  elements.exportButton.querySelector("span")!.textContent = "Export PowerPoint";
  const hasErrors = lastState.diagnostics.some((item) => item.severity === "error");
  elements.exportButton.disabled = hasErrors || Boolean(lastState.syntaxError) || !lastState.summary;
}

function normalizedFileName(): string {
  const base = elements.fileName.value
    .trim()
    .replace(/\.pptx$/i, "")
    .replace(/[\\/:*?"<>|]/g, "-") || "mmd2pptx-diagram";
  return `${base}.pptx`;
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
