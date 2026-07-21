# `@mmd2pptx/cli`

Convert SVG rendered by Mermaid into an editable PowerPoint presentation.

```bash
mmd2pptx diagram.svg --output diagram.pptx
```

Options include `--layout wide|standard` and `--background <color>`. Run
`mmd2pptx --help` for complete usage.

The CLI intentionally does not install Chromium or Mermaid CLI. Render `.mmd`
source to SVG in your existing Mermaid toolchain, or use the mmd2pptx browser
app, then pass the SVG to this command.

Licensed under Apache-2.0 as part of the mmd2pptx project.
