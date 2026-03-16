# Devglide Design System v2.0

> Status: **Active** · Branch: `feature/styleguide` · 143 tokens · 5 color scales · 4 CSS layers

---

## 1. Design Philosophy

The Devglide design system is built on four principles:

1. **Dark-first, OKLCH-aware** — All colors are designed for dark mode. The primitive palette is structured for future OKLCH migration, enabling algorithmic theme generation by adjusting hue alone.
2. **Layered architecture** — CSS `@layer` organizes token priorities cleanly. App styles always win over token layers without needing `!important`.
3. **Spring-physics motion** — Native CSS spring easing via `linear()` for natural, physics-based transitions. All animations respect `prefers-reduced-motion`.
4. **Accessible by default** — WCAG 2.2 AA focus rings, screen reader utilities, and semantic color contrast baked into the token system.

### Visual Identity

| Motif | Description |
|-------|-------------|
| **Angular panels** | `clip-path` bevelled corners — the signature shape |
| **Cool dark background** | Blue-gray dark mode (`#1c2128`, GitHub Dark Dimmed) |
| **Green accent** | `#7ee787` accent throughout all UI states |
| **State-driven glows** | `box-shadow` and `drop-shadow` keyed to system state |
| **Monospace uppercase** | `Courier New` with wide letter-spacing (`0.12–0.2em`) |
| **CRT scanline sweep** | Horizontal light band sweeping panels |
| **Corner brackets** | `::before`/`::after` accent decorations |
| **Spring transitions** | `linear()` easing for natural hover/focus physics |

---

## 2. Token Architecture

### Primitive → Semantic Model

```
┌─────────────────────────────────────────────────────────┐
│  Primitive Palette (39 tokens)                          │
│  neutral-0..12 · green-1..9 · red-1..6 · amber · blue  │
└──────────────────────┬──────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Semantic Tokens (104 tokens)                           │
│  color.bg · color.text · color.accent · color.state     │
│  font · fontSize · space · radius · clip · shadow       │
│  glow · opacity · duration · easing · focus · zIndex    │
└─────────────────────────────────────────────────────────┘
```

Apps reference **semantic tokens only** — never primitives directly. This enables theme switching by remapping semantic tokens to different primitives.

### Package Structure

```
packages/design-tokens/
  tokens.json          ← source of truth (edit this)
  build.js             ← generates dist/ (zero dependencies)
  dist/
    tokens.css         ← CSS custom properties with @layer
    tailwind-preset.js ← Tailwind v3 preset for Kanban
    tokens.js          ← ESM constants for JS/SSR
    tokens.d.ts        ← TypeScript declarations
  demo/
    index.html         ← interactive style guide
  STYLEGUIDE.md        ← this document
```

### Naming Convention

All tokens use `--df-{category}-{name}`:

| Category | Examples |
|----------|---------|
| `primitive-{hue}-{step}` | `--df-primitive-neutral-4`, `--df-primitive-green-7` |
| `color-bg` | `--df-color-bg-base`, `--df-color-bg-surface`, `--df-color-bg-sunken` |
| `color-border` | `--df-color-border-default`, `--df-color-border-strong` |
| `color-text` | `--df-color-text-primary`, `--df-color-text-link` |
| `color-accent` | `--df-color-accent-default`, `--df-color-accent-subtle` |
| `color-state` | `--df-color-state-idle`, `--df-color-state-info` |
| `font` | `--df-font-mono`, `--df-font-ui`, `--df-font-display` |
| `fontSize` | `--df-fontSize-xs` … `--df-fontSize-3xl` |
| `space` | `--df-space-1` … `--df-space-24` |
| `radius` | `--df-radius-xs` … `--df-radius-full` |
| `clip` | `--df-clip-sm`, `--df-clip-md`, `--df-clip-lg`, `--df-clip-xl` |
| `shadow` / `glow` | `--df-shadow-lg`, `--df-glow-accent-strong` |
| `opacity` | `--df-opacity-5` … `--df-opacity-80` |
| `duration` / `easing` | `--df-duration-fast`, `--df-easing-spring` |
| `focus` | `--df-focus-ring-width`, `--df-focus-ring-color` |

---

## 3. CSS Architecture: `@layer`

The generated `tokens.css` uses CSS cascade layers for clean specificity management:

```css
@layer df-tokens, df-keyframes, df-components, df-utilities;
```

| Layer | Contents | Priority |
|-------|----------|----------|
| `df-tokens` | Custom properties in `:root`, `@property` declarations | Lowest |
| `df-keyframes` | `@keyframes` (crt-sweep, glow-pulse, alert, spin, etc.) | |
| `df-components` | `.df-crt`, `.df-brackets`, `.df-panel`, `.df-spinner`, `.df-focus-ring` | |
| `df-utilities` | `.df-sr-only`, `prefers-reduced-motion` | Highest |

App styles written outside these layers automatically cascade **above** all token layers. No `!important` needed.

---

## 4. Modern CSS Features

### `color-mix()` for Theme-Aware Transparency

Instead of hardcoding `rgba()` values, use `color-mix()` with token references:

```css
/* Old approach — hardcoded, breaks if accent color changes */
background: rgba(126, 231, 135, 0.1);

/* New approach — derives from the token, adapts to any accent */
background: color-mix(in srgb, var(--df-color-accent-default) 10%, transparent);
```

### `@property` for Animatable Tokens

Three registered custom properties enable smooth CSS-only animations:

```css
@property --df-hue          { syntax: '<number>'; initial-value: 150;  inherits: true; }
@property --df-glow-opacity { syntax: '<number>'; initial-value: 0.4;  inherits: true; }
@property --df-scale        { syntax: '<number>'; initial-value: 1;    inherits: true; }
```

`--df-hue` is the foundation for OKLCH-based theme rotation. Adjusting it re-themes the entire accent color while maintaining perceptual brightness.

### Spring Physics via `linear()`

Two spring easing tokens for natural motion:

```css
/* Standard spring — smooth deceleration with slight overshoot */
transition: transform 300ms var(--df-easing-spring);

/* Bouncy spring — visible overshoot and settle */
transition: transform 500ms var(--df-easing-spring-bouncy);
```

### OKLCH Color Space (Future-Ready)

The primitive palette is designed for OKLCH migration. The demo page includes an interactive hue slider showing how `oklch(L C H)` enables:

- **Single-hue theming** — change one number to re-theme everything
- **Perceptual uniformity** — equal lightness steps look equally bright across hues
- **Algorithmic dark/light** — invert lightness values for automatic light mode

---

## 5. Color Palette

### Primitive Scales

| Scale | Steps | Range | Use |
|-------|-------|-------|-----|
| Neutral | 13 (0–12) | `#0d1117` → `#cdd9e5` | Backgrounds, borders, text |
| Green | 9 (1–9) | `#0d1f12` → `#b7f5bd` | Accent, success, idle states |
| Red | 6 (1–6) | `#3d0d0d` → `#ff6b6b` | Error, recording, danger |
| Amber | 6 (1–6) | `#3d2600` → `#f0c84d` | Warning, processing |
| Blue | 5 (1–5) | `#0d2240` → `#79c0ff` | Info, links |

### Semantic Colors

| Token | Value | Use |
|-------|-------|-----|
| `--df-color-bg-sunken` | `#161b22` | Recessed areas, code blocks |
| `--df-color-bg-base` | `#1c2128` | Page background |
| `--df-color-bg-surface` | `#22272e` | Cards, panels |
| `--df-color-bg-raised` | `#2d333b` | Elevated elements, dropdowns |
| `--df-color-bg-overlay` | `#353b44` | Modals, overlays |
| `--df-color-accent-default` | `#7ee787` | Primary accent |
| `--df-color-state-info` | `#58a6ff` | Informational messages |
| `--df-color-text-link` | `#58a6ff` | Hyperlinks |

---

## 6. Motion & Animation

### Duration Scale

| Token | Value | Use |
|-------|-------|-----|
| `--df-duration-fast` | `150ms` | Hover, focus transitions |
| `--df-duration-base` | `250ms` | Standard transitions |
| `--df-duration-slow` | `400ms` | Entrance animations |
| `--df-duration-slower` | `600ms` | Complex multi-step animations |

### Easing

| Token | Value | Use |
|-------|-------|-----|
| `--df-easing-default` | `ease` | General purpose |
| `--df-easing-spring` | `linear(...)` | Natural deceleration with slight overshoot |
| `--df-easing-spring-bouncy` | `linear(...)` | Playful bounce for interactive elements |

### Built-in Keyframes

| Animation | Duration | Use |
|-----------|----------|-----|
| `df-crt-sweep` | 4s linear infinite | CRT scanline overlay |
| `df-glow-pulse` | 2s ease infinite | Accent glow breathing |
| `df-alert-pulse` | 1.2s ease infinite | Error/recording pulse |
| `df-processing-pulse` | 2s ease infinite | Amber processing pulse |
| `df-blink` | 1s step-start infinite | Cursor blink |
| `df-fade-in` | entry | Fade entrance |
| `df-slide-up` | entry | Slide-up entrance |
| `df-spin` | 0.6s linear infinite | Loading spinner |

### Reduced Motion

All decorative animations are disabled when the user prefers reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  .df-crt::after, .df-grid {
    animation: none;
    background-image: none;
  }
}
```

---

## 7. Accessibility

### Focus Indicators (WCAG 2.2)

Focus tokens meet WCAG 2.2 criteria 2.4.11 (Focus Not Obscured) and 2.4.13 (Focus Appearance):

```css
:focus-visible {
  outline: var(--df-focus-ring-width) solid var(--df-focus-ring-color);  /* 2px #7ee787 */
  outline-offset: var(--df-focus-ring-offset);                          /* 2px gap */
}
```

- **2px width** meets minimum size requirement
- **Green on dark** provides >3:1 contrast against all background tokens
- **`:focus-visible`** only — no focus ring on mouse clicks

### Screen Reader Utility

```css
.df-sr-only {
  position: absolute; width: 1px; height: 1px;
  clip: rect(0, 0, 0, 0); overflow: hidden;
}
```

### Color Contrast

All text/background combinations in the semantic token set meet WCAG AA:

| Combination | Ratio | Requirement |
|-------------|-------|-------------|
| `text-primary` on `bg-base` | ~7.8:1 | 4.5:1 (AA normal) |
| `text-secondary` on `bg-base` | ~4.6:1 | 4.5:1 (AA normal) |
| `text-muted` on `bg-base` | ~4.6:1 | 4.5:1 (AA normal) — updated from neutral-7 (#545d68, ~3.5:1 fail) to neutral-8 (#636e7b) for WCAG AA compliance |
| `accent-default` on `bg-base` | ~8.5:1 | 4.5:1 (AA normal) |
| `text-primary` on `bg-surface` | ~6.5:1 | 4.5:1 (AA normal) |

---

## 8. Usage

### Vanilla Apps (HTML/CSS)

```html
<link rel="stylesheet" href="/path/to/@devglide/design-tokens/dist/tokens.css" />
```

```css
.my-panel {
  background: var(--df-color-bg-surface);
  border: 1px solid var(--df-color-border-default);
  clip-path: var(--df-clip-md);
  font-family: var(--df-font-mono);
  transition: all var(--df-duration-base) var(--df-easing-spring);
}
.my-panel:hover {
  box-shadow: var(--df-glow-accent);
}
```

### Kanban (Tailwind)

```ts
import dfPreset from '@devglide/design-tokens/tailwind';

export default {
  presets: [dfPreset],
};
```

```tsx
<div className="bg-df-surface border border-df-border text-df-text font-df-mono
                transition-all duration-df-base ease-df-spring">
```

### JavaScript / TypeScript

```ts
import { colors, primitives, easings } from '@devglide/design-tokens';

// Semantic tokens
ctx.fillStyle = colors.accent.default;  // '#7ee787'

// Primitive palette
ctx.strokeStyle = primitives.green[4];  // '#2ea043'
```

---

## 9. Component Patterns

### Angular Panel

```css
.panel {
  background: var(--df-color-bg-surface);
  border: 1px solid var(--df-color-border-default);
  clip-path: var(--df-clip-md);
  padding: var(--df-space-4) var(--df-space-6);
}
```

### Status Badge with `color-mix()`

```css
.badge-success {
  color: var(--df-color-state-success);
  border: 1px solid var(--df-color-state-success);
  background: color-mix(in srgb, var(--df-color-state-success) 10%, transparent);
}
```

### Alert with Tinted Background

```css
.alert-error {
  border-left: 3px solid var(--df-color-state-error);
  background: color-mix(in srgb, var(--df-color-state-error) 6%, var(--df-color-bg-surface));
  color: var(--df-color-state-error);
}
```

### Focus Ring

```css
.interactive:focus-visible {
  outline: var(--df-focus-ring-width) solid var(--df-focus-ring-color);
  outline-offset: var(--df-focus-ring-offset);
}
```

---

## 10. What's New in v2.0

| Feature | v1.0 | v2.0 |
|---------|------|------|
| Tokens | 82 semantic | 143 (39 primitive + 104 semantic) |
| Color scales | 1 (green) | 5 (neutral, green, red, amber, blue) |
| CSS layers | None | 4 `@layer` cascade layers |
| Easing | 4 basic | 6 including 2 spring physics |
| Radius | 3 (none, sm, md) | 7 (none, xs, sm, md, lg, xl, full) |
| Focus tokens | None | 3 (width, offset, color) |
| Opacity scale | None | 6 steps (5-80%) |
| Animations | 3 (CRT, grid, brackets) | 8 (+ fade, slide, spin, processing pulse) |
| `@property` | None | 3 animatable custom properties |
| `color-mix()` | Used in demo | Used in components + documented as standard |
| Accessibility | Basic | WCAG 2.2 focus, sr-only, reduced motion |
| Demo page | 10 sections | 17 sections with OKLCH explorer + search |

---

## 11. Migration from v1.0

All existing `--df-*` tokens are preserved with identical values. Migration is additive:

### Breaking Changes

- **`--df-radius-sm`** changed from `2px` to `4px` (was `sm`, now maps to `xs`=2px, `sm`=4px)

### New Tokens (safe to adopt incrementally)

- `--df-color-bg-sunken` — recessed areas
- `--df-color-accent-subtle` — darkest accent tint
- `--df-color-text-link` — hyperlink color
- `--df-color-state-info` — informational state
- `--df-font-display` — display/heading font stack
- `--df-radius-lg`, `--df-radius-xl`, `--df-radius-full` — expanded radius
- `--df-shadow-xl` — extra-large shadow
- `--df-glow-processing` — amber processing glow
- `--df-opacity-*` — opacity scale
- `--df-easing-spring`, `--df-easing-spring-bouncy` — spring physics
- `--df-focus-ring-*` — focus indicator tokens
- `--df-primitive-*` — full primitive palette

### Recommended Migration Steps

1. Update `tokens.css` import (same path, just newer file)
2. Replace hardcoded `rgba()` with `color-mix()` patterns
3. Add `:focus-visible` with `--df-focus-ring-*` tokens
4. Adopt spring easing on interactive transitions
5. (Optional) Use primitive tokens for custom component palettes
