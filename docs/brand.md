# Brand assets

The mmd2pptx mark combines a Mermaid-style diagram flow with a presentation
page. The square, circle, and triangle represent editable slide objects rather
than a flattened image.

## Files

| Asset | Use |
| --- | --- |
| [`logo.svg`](../apps/web/public/brand/logo.svg) | Default horizontal logo on light backgrounds |
| [`logo-dark.svg`](../apps/web/public/brand/logo-dark.svg) | Horizontal logo on dark backgrounds |
| [`mark.svg`](../apps/web/public/brand/mark.svg) | Icon-only mark on light backgrounds |
| [`mark-dark.svg`](../apps/web/public/brand/mark-dark.svg) | Icon-only mark on dark backgrounds |
| [`avatar.png`](../apps/web/public/brand/avatar.png) | 1024 × 1024 transparent PNG for GitHub and package profiles |
| [`favicon.svg`](../apps/web/public/favicon.svg) | Browser favicon |

All assets are SVG so they remain sharp at any size. Keep the aspect ratio when
resizing and leave clear space around the mark.

## Colors

| Role | Light asset | Dark asset |
| --- | --- | --- |
| Diagram flow | `#4338CA` | `#6366F1` |
| Presentation page | `#F15A24` | `#FB6A32` |
| Wordmark | `#111C36` | `#F8FAFC` |

The rotated square uses the presentation color with `fill-opacity=".5"`. Do
not replace the square's transparency with a separate opaque tint: its overlap
with the outlined circle is part of the mark.

## Usage

- Use the horizontal logo when the wordmark has enough room to remain legible.
- Use the mark alone for favicons, avatars, and compact controls.
- Do not change the relative positions or rotations of the three slide shapes.
- Do not add shadows, gradients, or third-party product logos.
