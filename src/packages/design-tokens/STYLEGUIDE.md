# Devglide Design System — Style Guide

> **This document is deprecated.** The living style guide is now auto-generated and always in sync with the codebase.

## Living Style Guide

Open the interactive style guide at:

```
http://localhost:7000/df/styleguide.html
```

It includes:
- Token catalog with copy-to-clipboard
- Component gallery with all `df-*` variants
- OKLCH playground with hue slider
- Live contrast ratio audit
- Usage snippets for CSS, Tailwind, and JS

## Quick Reference

### Build

```bash
node src/packages/design-tokens/build.js
```

### Outputs

| File | Description |
|------|-------------|
| `dist/tokens.css` | CSS custom properties with `@layer`, OKLCH `@supports` block |
| `dist/components.css` | Shared component library (`df-btn`, `df-badge`, `df-modal`, etc.) |
| `dist/styleguide.html` | Auto-generated living style guide |
| `dist/tailwind-preset.js` | Tailwind v3 preset |
| `dist/tokens.js` | ESM JS constants |
| `dist/tokens.d.ts` | TypeScript declarations |

### Token Naming

All tokens use `--df-{category}-{name}` convention. See the living style guide for the full catalog.

### Historical Reference

The original v2.0 demo page is preserved at `demo/index.html` for historical reference.
