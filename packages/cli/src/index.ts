export { HELP_TEXT, parseCliArguments } from "./arguments.js";
export type { CliOptions, CliOutputFormat, SlideLayout } from "./arguments.js";
export { runCli } from "./run.js";
export type { CliDependencies, CliIo } from "./run.js";
export {
  defaultMermaidRenderRuntime,
  renderMermaidSourceToSvg,
} from "./render-mermaid.js";
export type { MermaidRenderRuntime } from "./render-mermaid.js";
