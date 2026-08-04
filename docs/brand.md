# Brand assets

The mmd2pptx mark combines a Mermaid-style diagram flow with a presentation
page. The square, circle, and triangle represent editable slide objects rather
than a flattened image.

## Files

| Asset | Use |
| --- | --- |
| [`logo.svg`](../apps/web/public/brand/logo.svg) | Default horizontal logo on light backgrounds |
| [`logo-dark.svg`](../apps/web/public/brand/logo-dark.svg) | Horizontal logo on dark backgrounds |
| [`logo-reference.png`](../apps/web/public/brand/logo-reference.png) | 2029 × 775 approved raster reference artwork |
| [`mark.svg`](../apps/web/public/brand/mark.svg) | Icon-only mark on light backgrounds |
| [`mark-dark.svg`](../apps/web/public/brand/mark-dark.svg) | Icon-only mark on dark backgrounds |
| [`avatar.png`](../apps/web/public/brand/avatar.png) | 1024 × 1024 transparent PNG for GitHub and package profiles |
| [`favicon.svg`](../apps/web/public/favicon.svg) | Browser favicon |
| [`favicon.png`](../apps/web/public/favicon.png) | 64 × 64 raster fallback for browsers without SVG favicon support |

The primary logo and mark assets are SVG so they remain sharp at any size.
`logo-reference.png` preserves the approved raster artwork for visual
comparison and should not replace the SVG assets in the website. `avatar.png`
and `favicon.png` are raster exports for fixed-size profile and browser use.
Keep the aspect ratio when resizing and leave clear space around the mark.

## Colors

| Role | Light asset | Dark asset |
| --- | --- | --- |
| Diagram flow | `#2A1EF1` | `#635BFF` |
| Presentation page | `#F55A13` | `#FF6A2A` |
| Wordmark | `#121E38` | `#F8FAFC` |

The rotated square uses the presentation color with `fill-opacity=".5"`. Do
not replace the square's transparency with a separate opaque tint: its overlap
with the outlined circle is part of the mark.

## Usage

- Use the horizontal logo when the wordmark has enough room to remain legible.
- Use the mark alone for favicons, avatars, and compact controls.
- Do not change the relative positions or rotations of the three slide shapes.
- Do not add shadows, gradients, or third-party product logos.
