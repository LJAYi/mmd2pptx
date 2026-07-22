type ViewMode = "fit" | "fit-width" | "manual";

interface SvgPanZoomViewerOptions {
  getSource: () => string;
  root: HTMLElement;
}

interface Point {
  x: number;
  y: number;
}

interface ViewState extends Point {
  scale: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const VIEW_PADDING = 40;

export class SvgPanZoomViewer {
  private readonly canvas: HTMLElement;
  private readonly controls: HTMLButtonElement[];
  private readonly expandButton: HTMLButtonElement;
  private readonly feedback: HTMLElement;
  private readonly getSource: () => string;
  private readonly root: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly zoomLabel: HTMLOutputElement;
  private diagramHeight = 0;
  private diagramWidth = 0;
  private feedbackTimer = 0;
  private mode: ViewMode = "fit";
  private placeholder: Comment | undefined;
  private pointer: { id: number; x: number; y: number } | undefined;
  private state: ViewState = { scale: 1, x: 0, y: 0 };
  private svg: SVGSVGElement | undefined;

  constructor(options: SvgPanZoomViewerOptions) {
    this.root = options.root;
    this.getSource = options.getSource;
    this.canvas = required<HTMLElement>(this.root, "#preview-canvas");
    this.viewport = required<HTMLElement>(this.root, "#preview-viewport");
    this.zoomLabel = required<HTMLOutputElement>(this.root, "#viewer-zoom");
    this.feedback = required<HTMLElement>(this.root, "#viewer-feedback");
    this.expandButton = required<HTMLButtonElement>(this.root, '[data-viewer-action="expand"]');
    this.controls = Array.from(
      this.root.querySelectorAll<HTMLButtonElement>("[data-viewer-action]"),
    );

    this.bindControls();
    this.bindViewport();
    this.setControlsEnabled(false);

    new ResizeObserver(() => {
      if (!this.svg || this.mode === "manual") return;
      window.requestAnimationFrame(() => {
        if (this.mode === "fit-width") this.fitWidth();
        else this.fit();
      });
    }).observe(this.viewport);
  }

  setSvg(svg: SVGSVGElement): void {
    this.svg = svg;
    const dimensions = measureSvg(svg);
    this.diagramWidth = dimensions.width;
    this.diagramHeight = dimensions.height;
    this.root.classList.add("has-diagram");
    this.setControlsEnabled(true);
    this.fit();
  }

  clear(): void {
    this.svg = undefined;
    this.diagramWidth = 0;
    this.diagramHeight = 0;
    this.canvas.style.removeProperty("height");
    this.canvas.style.removeProperty("transform");
    this.canvas.style.removeProperty("width");
    this.canvas.removeAttribute("data-scale");
    this.canvas.removeAttribute("data-x");
    this.canvas.removeAttribute("data-y");
    this.root.classList.remove("has-diagram");
    this.setControlsEnabled(false);
    this.zoomLabel.value = "—";
  }

  fit(): void {
    if (!this.svg) return;
    this.mode = "fit";
    const available = this.availableSize();
    const scale = clamp(
      Math.min(available.width / this.diagramWidth, available.height / this.diagramHeight),
      MIN_SCALE,
      MAX_SCALE,
    );
    this.setView({
      scale,
      x: (this.viewport.clientWidth - this.diagramWidth * scale) / 2,
      y: (this.viewport.clientHeight - this.diagramHeight * scale) / 2,
    });
  }

  fitWidth(): void {
    if (!this.svg) return;
    this.mode = "fit-width";
    const available = this.availableSize();
    const scale = clamp(available.width / this.diagramWidth, MIN_SCALE, MAX_SCALE);
    const renderedHeight = this.diagramHeight * scale;
    this.setView({
      scale,
      x: (this.viewport.clientWidth - this.diagramWidth * scale) / 2,
      y: renderedHeight < available.height
        ? (this.viewport.clientHeight - renderedHeight) / 2
        : VIEW_PADDING / 2,
    });
  }

  reset(): void {
    if (!this.svg) return;
    this.mode = "manual";
    this.setView({
      scale: 1,
      x: (this.viewport.clientWidth - this.diagramWidth) / 2,
      y: (this.viewport.clientHeight - this.diagramHeight) / 2,
    });
  }

  private availableSize(): { height: number; width: number } {
    return {
      height: Math.max(this.viewport.clientHeight - VIEW_PADDING, 1),
      width: Math.max(this.viewport.clientWidth - VIEW_PADDING, 1),
    };
  }

  private bindControls(): void {
    for (const control of this.controls) {
      control.addEventListener("click", () => {
        switch (control.dataset.viewerAction) {
          case "zoom-in":
            this.zoomBy(1.2);
            break;
          case "zoom-out":
            this.zoomBy(1 / 1.2);
            break;
          case "reset":
            this.reset();
            break;
          case "fit":
            this.fit();
            break;
          case "fit-width":
            this.fitWidth();
            break;
          case "expand":
            this.toggleExpanded();
            break;
          case "copy-source":
            void this.copySource();
            break;
          case "copy-svg":
            void this.copySvg();
            break;
        }
      });
    }
  }

  private bindViewport(): void {
    this.viewport.addEventListener("wheel", (event) => {
      if (!this.svg) return;
      event.preventDefault();
      const point = this.localPoint(event.clientX, event.clientY);
      this.zoomAt(this.state.scale * Math.exp(-event.deltaY * 0.0015), point);
    }, { passive: false });

    this.viewport.addEventListener("pointerdown", (event) => {
      if (!this.svg || event.button !== 0 || this.pointer) return;
      this.mode = "manual";
      this.viewport.focus();
      this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      this.viewport.setPointerCapture(event.pointerId);
      this.viewport.classList.add("is-panning");
      event.preventDefault();
    });

    this.viewport.addEventListener("pointermove", (event) => {
      if (!this.pointer || event.pointerId !== this.pointer.id) return;
      const dx = event.clientX - this.pointer.x;
      const dy = event.clientY - this.pointer.y;
      this.pointer.x = event.clientX;
      this.pointer.y = event.clientY;
      this.setView({ ...this.state, x: this.state.x + dx, y: this.state.y + dy });
    });

    const stopPanning = (event: PointerEvent): void => {
      if (!this.pointer || event.pointerId !== this.pointer.id) return;
      if (this.viewport.hasPointerCapture(event.pointerId)) {
        this.viewport.releasePointerCapture(event.pointerId);
      }
      this.pointer = undefined;
      this.viewport.classList.remove("is-panning");
    };
    this.viewport.addEventListener("pointerup", stopPanning);
    this.viewport.addEventListener("pointercancel", stopPanning);

    this.viewport.addEventListener("keydown", (event) => {
      if (!this.svg) return;
      const panStep = event.shiftKey ? 100 : 40;
      switch (event.key) {
        case "+":
        case "=":
          this.zoomBy(1.2);
          break;
        case "-":
          this.zoomBy(1 / 1.2);
          break;
        case "0":
          this.reset();
          break;
        case "f":
        case "F":
          this.fit();
          break;
        case "w":
        case "W":
          this.fitWidth();
          break;
        case "ArrowUp":
          this.pan(0, panStep);
          break;
        case "ArrowDown":
          this.pan(0, -panStep);
          break;
        case "ArrowLeft":
          this.pan(panStep, 0);
          break;
        case "ArrowRight":
          this.pan(-panStep, 0);
          break;
        default:
          return;
      }
      event.preventDefault();
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.root.classList.contains("is-expanded")) {
        this.toggleExpanded(false);
      }
    });
  }

  private localPoint(clientX: number, clientY: number): Point {
    const bounds = this.viewport.getBoundingClientRect();
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  }

  private pan(dx: number, dy: number): void {
    this.mode = "manual";
    this.setView({ ...this.state, x: this.state.x + dx, y: this.state.y + dy });
  }

  private setView(next: ViewState): void {
    this.state = next;
    // Give the SVG a real viewport at the requested size so the browser paints
    // vectors at the destination resolution. Scaling a promoted HTML layer
    // would instead magnify its cached raster texture and blur text and lines.
    this.canvas.style.width = `${this.diagramWidth * next.scale}px`;
    this.canvas.style.height = `${this.diagramHeight * next.scale}px`;
    this.canvas.style.transform = `translate(${next.x}px, ${next.y}px)`;
    this.canvas.dataset.scale = String(next.scale);
    this.canvas.dataset.x = String(next.x);
    this.canvas.dataset.y = String(next.y);
    this.zoomLabel.value = `${Math.round(next.scale * 100)}%`;
  }

  private zoomAt(nextScale: number, point: Point): void {
    if (!this.svg) return;
    this.mode = "manual";
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const ratio = scale / this.state.scale;
    this.setView({
      scale,
      x: point.x - (point.x - this.state.x) * ratio,
      y: point.y - (point.y - this.state.y) * ratio,
    });
  }

  private zoomBy(factor: number): void {
    this.zoomAt(this.state.scale * factor, {
      x: this.viewport.clientWidth / 2,
      y: this.viewport.clientHeight / 2,
    });
  }

  private toggleExpanded(force?: boolean): void {
    const expanded = force ?? !this.root.classList.contains("is-expanded");
    if (expanded) {
      this.placeholder = document.createComment("mmd2pptx preview position");
      this.root.before(this.placeholder);
      document.body.append(this.root);
      this.root.classList.add("is-expanded");
      this.root.setAttribute("aria-label", "Expanded Mermaid preview");
      this.root.setAttribute("aria-modal", "true");
      this.root.setAttribute("role", "dialog");
      document.querySelector<HTMLElement>(".shell")?.setAttribute("inert", "");
      document.body.classList.add("preview-expanded");
      this.expandButton.setAttribute("aria-label", "Close expanded preview");
      this.expandButton.setAttribute("title", "Close expanded preview (Esc)");
      this.expandButton.setAttribute("aria-expanded", "true");
      this.expandButton.querySelector("span")!.textContent = "×";
    } else {
      this.root.classList.remove("is-expanded");
      this.root.removeAttribute("aria-label");
      this.root.removeAttribute("aria-modal");
      this.root.removeAttribute("role");
      document.querySelector<HTMLElement>(".shell")?.removeAttribute("inert");
      document.body.classList.remove("preview-expanded");
      this.expandButton.setAttribute("aria-label", "Expand preview");
      this.expandButton.setAttribute("title", "Expand preview");
      this.expandButton.setAttribute("aria-expanded", "false");
      this.expandButton.querySelector("span")!.textContent = "⛶";
      this.placeholder?.replaceWith(this.root);
      this.placeholder = undefined;
    }
    window.requestAnimationFrame(() => {
      if (this.mode === "fit-width") this.fitWidth();
      else this.fit();
      if (expanded) this.viewport.focus();
      else this.expandButton.focus();
    });
  }

  private async copySource(): Promise<void> {
    const source = this.getSource();
    if (!source) return;
    try {
      await copyText(source);
      this.showFeedback("Mermaid source copied");
    } catch {
      this.showFeedback("Could not copy Mermaid source");
    }
  }

  private async copySvg(): Promise<void> {
    if (!this.svg) return;
    try {
      await copyText(new XMLSerializer().serializeToString(this.svg));
      this.showFeedback("SVG copied");
    } catch {
      this.showFeedback("Could not copy SVG");
    }
  }

  private setControlsEnabled(enabled: boolean): void {
    for (const control of this.controls) {
      const canCloseExpanded = control === this.expandButton
        && this.root.classList.contains("is-expanded");
      control.disabled = !enabled && !canCloseExpanded;
    }
  }

  private showFeedback(message: string): void {
    window.clearTimeout(this.feedbackTimer);
    this.feedback.textContent = message;
    this.feedback.classList.add("visible");
    this.feedbackTimer = window.setTimeout(() => {
      this.feedback.classList.remove("visible");
    }, 1800);
  }
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Viewer element not found: ${selector}`);
  return element;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function measureSvg(svg: SVGSVGElement): { height: number; width: number } {
  const viewBox = svg.viewBox.baseVal;
  if (viewBox.width > 0 && viewBox.height > 0) {
    return { height: viewBox.height, width: viewBox.width };
  }

  const width = Number.parseFloat(svg.getAttribute("width") ?? "");
  const height = Number.parseFloat(svg.getAttribute("height") ?? "");
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { height, width };
  }

  const bounds = svg.getBBox();
  return {
    height: Math.max(bounds.height, 1),
    width: Math.max(bounds.width, 1),
  };
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard API is unavailable.");
}
