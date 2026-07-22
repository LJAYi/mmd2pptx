import type {
  ConversionOptions,
  ConversionResult,
  DiagramIR,
} from "./types.js";

export type DiagramExportFormat = "drawio" | "json-canvas" | "pptx" | "svg";
export type DiagramExportMode = "exact" | "faithful" | "smart";
export type CapabilitySupport = "exact" | "fallback" | "native" | "unsupported";

export interface ExportCapabilityDecision {
  elementId?: string;
  feature: string;
  format: DiagramExportFormat;
  mode: DiagramExportMode;
  reason?: string;
  support: CapabilitySupport;
}

export interface DiagramExportOptions extends ConversionOptions {
  mode?: DiagramExportMode;
}

export interface DiagramExporter<TOutput, TOptions extends DiagramExportOptions = DiagramExportOptions> {
  readonly format: DiagramExportFormat;
  export(
    diagram: DiagramIR,
    options?: TOptions,
  ): Promise<ConversionResult<TOutput>> | ConversionResult<TOutput>;
}

export interface ExportCapabilityReport {
  decisions: ExportCapabilityDecision[];
  format: DiagramExportFormat;
  mode: DiagramExportMode;
}

export function fallbackDecision(
  decision: Omit<ExportCapabilityDecision, "support">,
): ExportCapabilityDecision {
  return { ...decision, support: "fallback" };
}
