#!/usr/bin/env node
/**
 * Build script for @devglide/design-tokens v3.0
 *
 * Reads tokens.json and generates:
 *   dist/tokens.css          — CSS custom properties with @layer architecture + OKLCH
 *   dist/components.css      — Shared component library (from components.src.css)
 *   dist/tailwind-preset.js  — Tailwind v3 preset
 *   dist/tokens.js           — ESM JS constants
 *   dist/tokens.d.ts         — TypeScript declarations
 *   dist/styleguide.html     — Auto-generated living style guide
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(readFileSync(resolve(__dir, 'tokens.json'), 'utf8'));

mkdirSync(resolve(__dir, 'dist'), { recursive: true });

// ── Flatten tokens to --df-{category}-{name}: value ──────────────────────────
function camelToKebab(str) {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function flatten(obj, prefix = '', skipKeys = []) {
  const vars = [];
  for (const [key, val] of Object.entries(obj)) {
    if (skipKeys.includes(key)) continue;
    const kebabKey = camelToKebab(key);
    const name = prefix ? `${prefix}-${kebabKey}` : kebabKey;
    if (typeof val === 'object') {
      vars.push(...flatten(val, name));
    } else {
      vars.push([`--df-${name}`, val]);
    }
  }
  return vars;
}

// Flatten all tokens except oklch (handled separately)
const vars = flatten(tokens, '', ['oklch']);

// Separate primitives from semantic tokens for organized output
const primitiveVars = vars.filter(([k]) => k.startsWith('--df-primitive-'));
const semanticVars = vars.filter(([k]) =>
  !k.startsWith('--df-primitive-')
);

// Flatten OKLCH tokens separately
const oklchVars = tokens.oklch ? flatten(tokens.oklch, 'oklch') : [];

// ── dist/tokens.css ───────────────────────────────────────────────────────────
const oklchBlock = oklchVars.length > 0 ? `
  /* ── OKLCH Color Space (progressive enhancement) ─────────────────── */
  @supports (color: oklch(0 0 0)) {
    :root {
${oklchVars.map(([k, v]) => `      ${k}: ${v};`).join('\n')}
    }
  }
` : '';

const css = `/* @devglide/design-tokens v3.0 — generated, do not edit */
/* Modern CSS architecture: @layer cascade, @property declarations, OKLCH, spring easings */

@layer df-tokens, df-keyframes, df-components, df-utilities;

/* ══════════════════════════════════════════════════════════════════════════════
   Layer: df-tokens — Design token custom properties
   ══════════════════════════════════════════════════════════════════════════════ */
@layer df-tokens {
  :root {
    color-scheme: dark;

    /* ── Primitive Palette ──────────────────────────────────────────────── */
${primitiveVars.map(([k, v]) => `    ${k}: ${v};`).join('\n')}

    /* ── Semantic Tokens ───────────────────────────────────────────────── */
${semanticVars.map(([k, v]) => `    ${k}: ${v};`).join('\n')}
  }
${oklchBlock}
  /* ── @property declarations for animatable tokens ──────────────────── */
  @property --df-hue {
    syntax: '<number>';
    initial-value: 185;
    inherits: true;
  }

  @property --df-glow-opacity {
    syntax: '<number>';
    initial-value: 0.4;
    inherits: true;
  }

  @property --df-scale {
    syntax: '<number>';
    initial-value: 1;
    inherits: true;
  }

  @property --df-oklch-accent-h {
    syntax: '<number>';
    initial-value: 185;
    inherits: true;
  }

}

/* ══════════════════════════════════════════════════════════════════════════════
   Layer: df-keyframes — Animations
   ══════════════════════════════════════════════════════════════════════════════ */
@layer df-keyframes {
  /* CRT scanline sweep */
  @keyframes df-crt-sweep {
    0%   { background-position: 0 -100%; }
    100% { background-position: 0 200%; }
  }

  /* Accent glow pulse */
  @keyframes df-glow-pulse {
    0%, 100% { filter: drop-shadow(0 0 6px rgba(0,175,175,0.4)); }
    50%      { filter: drop-shadow(0 0 14px rgba(0,175,175,0.7)); }
  }

  /* Error/recording alert pulse */
  @keyframes df-alert-pulse {
    0%, 100% { box-shadow: 0 0 6px rgba(255,51,51,0.4); }
    50%      { box-shadow: 0 0 16px rgba(255,51,51,0.8); }
  }

  /* Processing amber pulse */
  @keyframes df-processing-pulse {
    0%, 100% { box-shadow: 0 0 6px rgba(227,179,65,0.3); }
    50%      { box-shadow: 0 0 12px rgba(227,179,65,0.6); }
  }

  /* Cursor blink */
  @keyframes df-blink {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0; }
  }

  /* Fade in (for @starting-style fallback) */
  @keyframes df-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  /* Slide up entrance */
  @keyframes df-slide-up {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* Spin (for loading indicators) */
  @keyframes df-spin {
    to { transform: rotate(360deg); }
  }

  /* View Transition: enter */
  @keyframes df-view-enter {
    from { opacity: 0; transform: translateY(6px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  /* View Transition: exit */
  @keyframes df-view-exit {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to   { opacity: 0; transform: translateY(-6px) scale(0.98); }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   Layer: df-components — Reusable component classes
   ══════════════════════════════════════════════════════════════════════════════ */
@layer df-components {
  /* ── CRT scanline overlay ──────────────────────────────────────────── */
  .df-crt {
    position: relative;
    overflow: hidden;
  }
  .df-crt::after {
    content: '';
    position: absolute; inset: 0;
    background: linear-gradient(
      to bottom,
      transparent 0%,
      rgba(0,175,175,0.03) 50%,
      transparent 100%
    );
    background-size: 100% 40px;
    animation: df-crt-sweep 4s linear infinite;
    pointer-events: none; z-index: 9;
  }

  /* ── Diagonal grid texture ─────────────────────────────────────────── */
  .df-grid {
    background-image: repeating-linear-gradient(
      -45deg,
      rgba(0,175,175,0.02) 0px,
      rgba(0,175,175,0.02) 1px,
      transparent 1px,
      transparent 8px
    );
  }

  /* ── Corner brackets ───────────────────────────────────────────────── */
  .df-brackets {
    position: relative;
  }
  .df-brackets::before,
  .df-brackets::after {
    content: '';
    position: absolute;
    width: 12px; height: 12px;
    border-color: var(--df-color-accent-default);
    border-style: solid;
    pointer-events: none;
  }
  .df-brackets::before {
    top: 0; left: 0;
    border-width: 2px 0 0 2px;
  }
  .df-brackets::after {
    bottom: 0; right: 0;
    border-width: 0 2px 2px 0;
  }

  /* ── Focus ring (WCAG 2.2 compliant) ───────────────────────────────── */
  .df-focus-ring:focus-visible {
    outline: var(--df-focus-ring-width) solid var(--df-focus-ring-color);
    outline-offset: var(--df-focus-ring-offset);
  }

  /* ── Panel component ───────────────────────────────────────────────── */
  .df-panel {
    background: var(--df-color-bg-surface);
    border: 1px solid var(--df-color-border-default);
    clip-path: var(--df-clip-md);
    padding: var(--df-space-4) var(--df-space-6);
  }

  /* ── Spinner ───────────────────────────────────────────────────────── */
  .df-spinner {
    width: 1em; height: 1em;
    border: 2px solid var(--df-color-border-default);
    border-top-color: var(--df-color-accent-default);
    border-radius: var(--df-radius-full);
    animation: df-spin 0.6s linear infinite;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   Layer: df-utilities — Utility classes
   ══════════════════════════════════════════════════════════════════════════════ */
@layer df-utilities {
  /* Screen reader only */
  .df-sr-only {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  /* Reduced motion: disable animations for users who prefer it */
  @media (prefers-reduced-motion: reduce) {
    .df-crt::after,
    .df-grid {
      animation: none;
      background-image: none;
    }
  }
}
`;

writeFileSync(resolve(__dir, 'dist/tokens.css'), css);

// ── dist/components.css ──────────────────────────────────────────────────────
const componentsSrc = resolve(__dir, 'components.src.css');
if (existsSync(componentsSrc)) {
  copyFileSync(componentsSrc, resolve(__dir, 'dist/components.css'));
  console.log(`✓ dist/components.css`);
} else {
  console.log(`⚠ components.src.css not found — skipping dist/components.css`);
}

// ── dist/tailwind-preset.js ───────────────────────────────────────────────────
const t = tokens;
const twPreset = `/* @devglide/design-tokens v3.0 — Tailwind v3 preset — generated, do not edit */
/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      colors: {
        'df-base':       '${t.color.bg.base}',
        'df-surface':    '${t.color.bg.surface}',
        'df-raised':     '${t.color.bg.raised}',
        'df-overlay':    '${t.color.bg.overlay}',
        'df-sunken':     '${t.color.bg.sunken}',
        'df-border':     '${t.color.border.default}',
        'df-border-subtle': '${t.color.border.subtle}',
        'df-border-strong': '${t.color.border.strong}',
        'df-text':       '${t.color.text.primary}',
        'df-muted':      '${t.color.text.secondary}',
        'df-accent':     '${t.color.accent.default}',
        'df-accent-subtle': '${t.color.accent.subtle}',
        'df-accent-dim': '${t.color.accent.dim}',
        'df-accent-bright': '${t.color.accent.bright}',
        'df-idle':       '${t.color.state.idle}',
        'df-active':     '${t.color.state.active}',
        'df-recording':  '${t.color.state.recording}',
        'df-processing': '${t.color.state.processing}',
        'df-success':    '${t.color.state.success}',
        'df-error':      '${t.color.state.error}',
        'df-warning':    '${t.color.state.warning}',
        'df-info':       '${t.color.state.info}',
        'df-link':       '${t.color.text.link}',
      },
      fontFamily: {
        'df-mono': ${JSON.stringify(t.font.mono.split(',').map(s => s.trim().replace(/'/g, '')))},
        'df-ui':   ${JSON.stringify(t.font.ui.split(',').map(s => s.trim().replace(/'/g, '')))},
        'df-display': ${JSON.stringify(t.font.display.split(',').map(s => s.trim().replace(/'/g, '')))},
      },
      spacing: ${JSON.stringify(
        Object.fromEntries(
          Object.entries(t.space).map(([k, v]) => [`df-${k}`, v])
        ), null, 8
      )},
      borderRadius: {
        'df-xs': '${t.radius.xs}',
        'df-sm': '${t.radius.sm}',
        'df-md': '${t.radius.md}',
        'df-lg': '${t.radius.lg}',
        'df-xl': '${t.radius.xl}',
        'df-full': '${t.radius.full}',
      },
      boxShadow: {
        'df-sm': '${t.shadow.sm}',
        'df-md': '${t.shadow.md}',
        'df-lg': '${t.shadow.lg}',
        'df-xl': '${t.shadow.xl}',
        'df-glow': '${t.glow.accent}',
        'df-glow-strong': '${t.glow['accent-strong']}',
        'df-error-glow': '${t.glow.error}',
      },
      transitionDuration: {
        'df-fast':   '${t.duration.fast}',
        'df-base':   '${t.duration.base}',
        'df-slow':   '${t.duration.slow}',
        'df-slower': '${t.duration.slower}',
      },
      transitionTimingFunction: {
        'df-spring': "${t.easing.spring}",
        'df-spring-bouncy': "${t.easing['spring-bouncy']}",
      },
      letterSpacing: {
        'df-tight':  '${t.letterSpacing.tight}',
        'df-normal': '${t.letterSpacing.normal}',
        'df-wide':   '${t.letterSpacing.wide}',
        'df-wider':  '${t.letterSpacing.wider}',
      },
      opacity: ${JSON.stringify(
        Object.fromEntries(
          Object.entries(t.opacity).map(([k, v]) => [`df-${k}`, v])
        ), null, 8
      )},
      zIndex: {
        'df-base':    '${t.zIndex.base}',
        'df-raised':  '${t.zIndex.raised}',
        'df-overlay': '${t.zIndex.overlay}',
        'df-modal':   '${t.zIndex.modal}',
        'df-toast':   '${t.zIndex.toast}',
      },
      maxWidth: {
        'df-prose': '${t.maxWidth.prose}',
        'df-sm':    '${t.maxWidth.sm}',
        'df-md':    '${t.maxWidth.md}',
        'df-lg':    '${t.maxWidth.lg}',
        'df-xl':    '${t.maxWidth.xl}',
      },
      screens: {
        'df-sm':  '${t.breakpoint.sm}',
        'df-md':  '${t.breakpoint.md}',
        'df-lg':  '${tokens.breakpoint.lg}',
        'df-xl':  '${tokens.breakpoint.xl}',
        'df-2xl': '${t.breakpoint['2xl']}',
      },
    },
  },
};
`;

writeFileSync(resolve(__dir, 'dist/tailwind-preset.js'), twPreset);

// ── dist/tokens.js ────────────────────────────────────────────────────────────
const jsConstants = `/* @devglide/design-tokens v3.0 — generated, do not edit */
export const tokens = ${JSON.stringify(tokens, null, 2)};

// Flat map of CSS variable name -> value
export const cssVars = Object.fromEntries([
${vars.map(([k, v]) => `  ['${k}', ${JSON.stringify(v)}],`).join('\n')}
]);

// OKLCH equivalents
export const oklchVars = Object.fromEntries([
${oklchVars.map(([k, v]) => `  ['${k}', ${JSON.stringify(v)}],`).join('\n')}
]);

// Convenience re-exports
export const primitives = tokens.primitive;
export const colors     = tokens.color;
export const fonts      = tokens.font;
export const fontSizes  = tokens.fontSize;
export const spacing    = tokens.space;
export const radii      = tokens.radius;
export const clips      = tokens.clip;
export const shadows    = tokens.shadow;
export const glows      = tokens.glow;
export const opacities  = tokens.opacity;
export const durations  = tokens.duration;
export const easings    = tokens.easing;
export const focusRing    = tokens.focus;
export const breakpoints  = tokens.breakpoint;
export const containers   = tokens.container;
export const maxWidths    = tokens.maxWidth;
export const oklch        = tokens.oklch;
`;

writeFileSync(resolve(__dir, 'dist/tokens.js'), jsConstants);

// ── dist/tokens.d.ts ──────────────────────────────────────────────────────────
const dts = `/* @devglide/design-tokens v3.0 — generated, do not edit */
export declare const tokens: ${JSON.stringify(tokens, null, 2)
  .replace(/"([^"]+)":/g, '$1:')
  .replace(/: "([^"]+)"/g, ': string')};

export declare const cssVars: Record<string, string>;
export declare const oklchVars: Record<string, string>;
export declare const primitives: typeof tokens.primitive;
export declare const colors: typeof tokens.color;
export declare const fonts: typeof tokens.font;
export declare const fontSizes: typeof tokens.fontSize;
export declare const spacing: typeof tokens.space;
export declare const radii: typeof tokens.radius;
export declare const clips: typeof tokens.clip;
export declare const shadows: typeof tokens.shadow;
export declare const glows: typeof tokens.glow;
export declare const opacities: typeof tokens.opacity;
export declare const durations: typeof tokens.duration;
export declare const easings: typeof tokens.easing;
export declare const focusRing: typeof tokens.focus;
export declare const breakpoints: typeof tokens.breakpoint;
export declare const containers: typeof tokens.container;
export declare const maxWidths: typeof tokens.maxWidth;
export declare const oklch: typeof tokens.oklch;
`;

writeFileSync(resolve(__dir, 'dist/tokens.d.ts'), dts);

// ── dist/styleguide.html ─────────────────────────────────────────────────────
function buildStyleguide() {
  const hasComponents = existsSync(resolve(__dir, 'components.src.css'));

  // Token counts
  const primCount = Object.values(tokens.primitive).reduce((n, s) => n + Object.keys(s).length, 0);
  const semCount = vars.length - primitiveVars.length;
  const oklchCount = oklchVars.length;

  // ── Data builders ──────────────────────────────────────────────────────

  // Primitive ramps as horizontal strips
  const primRamps = Object.entries(tokens.primitive).map(([scale, steps]) => {
    const chips = Object.entries(steps).map(([step, hex]) =>
      `<div class="ramp-chip" style="--c:${hex}" data-copy="--df-primitive-${scale}-${step}" title="${hex}"><span>${step}</span></div>`
    ).join('');
    return `<div class="ramp"><span class="ramp-label">${scale}</span><div class="ramp-chips">${chips}</div></div>`;
  }).join('\n');

  // OKLCH ramps
  const oklchRamps = tokens.oklch ? Object.entries(tokens.oklch).map(([scale, steps]) => {
    const chips = Object.entries(steps).map(([step, val]) =>
      `<div class="ramp-chip" style="--c:${val}" data-copy="--df-oklch-${scale}-${step}" title="${val}"><span>${step}</span></div>`
    ).join('');
    return `<div class="ramp"><span class="ramp-label">${scale}</span><div class="ramp-chips">${chips}</div></div>`;
  }).join('\n') : '';

  // Semantic color cards in a bento grid
  const semanticCards = ['bg', 'border', 'text', 'accent', 'state'].map(cat => {
    const entries = Object.entries(tokens.color[cat]);
    const pills = entries.map(([name, hex]) =>
      `<div class="sem-pill" data-copy="--df-color-${cat}-${name}">
        <div class="sem-dot" style="--c:${hex}"></div>
        <span class="sem-name">${name}</span>
        <span class="sem-hex">${hex}</span>
      </div>`
    ).join('');
    return `<div class="bento-card bento-color-card">
      <h3>${cat}</h3>
      <div class="sem-pills">${pills}</div>
    </div>`;
  }).join('\n');

  // Space scale as a visual bar chart
  const spaceBars = Object.entries(tokens.space).map(([k, v]) =>
    `<div class="space-item"><code>${k}</code><div class="space-track"><div class="space-fill" style="width:min(${v}, 100%)"></div></div><span>${v}</span></div>`
  ).join('\n');

  // Radius visual
  const radiusItems = Object.entries(tokens.radius).map(([k, v]) =>
    `<div class="radius-item"><div class="radius-box" style="border-radius:${v}"></div><code>${k}</code><span>${v}</span></div>`
  ).join('\n');

  // Shadow visual
  const shadowItems = Object.entries(tokens.shadow).map(([k, v]) =>
    `<div class="shadow-item"><div class="shadow-box" style="box-shadow:${v}"></div><code>${k}</code></div>`
  ).join('\n');

  // Glow visual
  const glowItems = Object.entries(tokens.glow).map(([k, v]) =>
    `<div class="shadow-item"><div class="shadow-box glow-box" style="box-shadow:${v}"></div><code>${k}</code></div>`
  ).join('\n');

  // Typography scale
  const typeScale = Object.entries(tokens.fontSize).map(([k]) =>
    `<div class="type-row"><code class="type-label">--df-font-size-${k}</code><span class="type-sample" style="font-size:var(--df-font-size-${k})">Design Tokens</span></div>`
  ).join('\n');

  // Contrast pairs
  const contrastPairs = [
    ['text-primary', tokens.color.text.primary, 'bg-base', tokens.color.bg.base],
    ['text-secondary', tokens.color.text.secondary, 'bg-base', tokens.color.bg.base],
    ['text-muted', tokens.color.text.muted, 'bg-base', tokens.color.bg.base],
    ['accent-default', tokens.color.accent.default, 'bg-base', tokens.color.bg.base],
    ['text-primary', tokens.color.text.primary, 'bg-surface', tokens.color.bg.surface],
    ['state-error', tokens.color.state.error, 'bg-surface', tokens.color.bg.surface],
    ['state-success', tokens.color.state.success, 'bg-surface', tokens.color.bg.surface],
    ['state-info', tokens.color.state.info, 'bg-surface', tokens.color.bg.surface],
  ];
  const contrastRows = contrastPairs.map(([fg, fgH, bg, bgH]) =>
    `<div class="a11y-row"><div class="a11y-sample" style="background:${bgH};color:${fgH}">Aa</div><span class="a11y-pair">${fg} / ${bg}</span><span class="a11y-ratio" data-fg="${fgH}" data-bg="${bgH}"></span></div>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Devglide Design System v3</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5/index.min.css">
<link rel="stylesheet" href="tokens.css">
${hasComponents ? '<link rel="stylesheet" href="components.css">' : ''}
<style>
/* ═══════════════════════════════════════════════════════════════════════
   STYLE GUIDE v3 — Fresh, modern, Geist-inspired
   ═══════════════════════════════════════════════════════════════════════ */
:root {
  --sg-accent: oklch(0.80 0.17 var(--df-oklch-accent-h, 185));
  --sg-accent-dim: oklch(0.45 0.12 var(--df-oklch-accent-h, 185));
  --sg-glass: color-mix(in srgb, var(--df-color-bg-surface) 60%, transparent);
  --sg-glass-border: color-mix(in srgb, var(--df-color-border-default) 50%, transparent);
  --sg-radius: 12px;
}

*, *::before, *::after { margin: 0; box-sizing: border-box; }

html { scroll-behavior: smooth; }

body {
  font-family: 'Inter Variable', 'Inter', system-ui, sans-serif;
  background: var(--df-color-bg-base);
  color: var(--df-color-text-primary);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

a { color: var(--sg-accent); text-decoration: none; }
code { font-family: var(--df-font-mono); font-size: 0.85em; }

/* ── Floating Nav ────────────────────────────────────────────────────── */
.sg-nav {
  position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 2px; padding: 4px;
  background: var(--sg-glass);
  backdrop-filter: blur(16px) saturate(1.4);
  -webkit-backdrop-filter: blur(16px) saturate(1.4);
  border: 1px solid var(--sg-glass-border);
  border-radius: 999px;
  z-index: 100;
  box-shadow: 0 4px 24px rgba(0,0,0,0.4);
}
.sg-nav a {
  padding: 6px 14px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--df-color-text-secondary);
  border-radius: 999px;
  transition: all 150ms;
  white-space: nowrap;
}
.sg-nav a:hover { color: var(--df-color-text-primary); background: color-mix(in srgb, var(--sg-accent) 10%, transparent); }
.sg-nav a.active { color: var(--df-color-bg-base); background: var(--sg-accent); }

/* ── Hero ────────────────────────────────────────────────────────────── */
.hero {
  position: relative;
  min-height: 80vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 120px 32px 80px;
  overflow: hidden;
}
.hero::before {
  content: '';
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 80% 60% at 50% 40%, color-mix(in srgb, var(--sg-accent) 8%, transparent), transparent),
    radial-gradient(ellipse 60% 50% at 80% 60%, color-mix(in srgb, var(--df-color-state-info) 6%, transparent), transparent),
    radial-gradient(ellipse 50% 40% at 20% 70%, color-mix(in srgb, var(--df-color-state-warning) 4%, transparent), transparent);
  pointer-events: none;
}
.hero-grid {
  position: absolute; inset: 0;
  background-image:
    linear-gradient(color-mix(in srgb, var(--sg-accent) 4%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--sg-accent) 4%, transparent) 1px, transparent 1px);
  background-size: 60px 60px;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 50%, black 20%, transparent 70%);
  -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 50%, black 20%, transparent 70%);
  pointer-events: none;
}
.hero-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 16px;
  background: color-mix(in srgb, var(--sg-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--sg-accent) 25%, transparent);
  border-radius: 999px;
  font-size: 12px; font-weight: 500;
  color: var(--sg-accent);
  letter-spacing: 0.06em; text-transform: uppercase;
  margin-bottom: 32px;
  position: relative;
}
.hero h1 {
  font-family: 'Inter Variable', 'Inter', system-ui, sans-serif;
  font-size: clamp(40px, 8vw, 80px);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1;
  color: var(--df-color-text-primary);
  margin-bottom: 20px;
  position: relative;
}
.hero h1 em {
  font-style: normal;
  background: linear-gradient(135deg, var(--sg-accent), var(--df-color-state-info));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.hero-sub {
  font-size: clamp(14px, 2vw, 18px);
  color: var(--df-color-text-secondary);
  max-width: 520px;
  line-height: 1.6;
  position: relative;
}
.hero-stats {
  display: flex; gap: 48px; margin-top: 56px;
  position: relative;
}
.hero-stat { text-align: center; }
.hero-stat-num {
  display: block;
  font-family: var(--df-font-mono);
  font-size: clamp(28px, 4vw, 44px);
  font-weight: 600;
  color: var(--sg-accent);
  line-height: 1;
  letter-spacing: -0.02em;
}
.hero-stat-label {
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--df-color-text-muted);
  margin-top: 6px;
}

/* ── Sections ────────────────────────────────────────────────────────── */
.sg-wrap {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 32px 120px;
}
section { scroll-margin-top: 80px; margin-bottom: 100px; }
section:last-child { margin-bottom: 0; }

.section-header {
  margin-bottom: 40px;
}
.section-header h2 {
  font-size: clamp(24px, 3vw, 36px);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--df-color-text-primary);
  margin-bottom: 8px;
}
.section-header p {
  font-size: 14px;
  color: var(--df-color-text-secondary);
  max-width: 600px;
}

/* ── Glass Card ──────────────────────────────────────────────────────── */
.card {
  background: var(--sg-glass);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--sg-glass-border);
  border-radius: var(--sg-radius);
  padding: 28px;
  transition: border-color 200ms, box-shadow 200ms;
}
.card:hover {
  border-color: color-mix(in srgb, var(--sg-accent) 30%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--sg-accent) 10%, transparent), 0 8px 32px rgba(0,0,0,0.3);
}
.card h3 {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--df-color-text-muted);
  margin-bottom: 16px;
}

/* ── Color Ramps ─────────────────────────────────────────────────────── */
.ramp { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.ramp-label {
  font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--df-color-text-muted); min-width: 70px; text-align: right;
}
.ramp-chips { display: flex; gap: 3px; flex: 1; }
.ramp-chip {
  flex: 1; height: 44px; border-radius: 6px;
  background: var(--c);
  cursor: pointer;
  display: flex; align-items: flex-end; justify-content: center; padding-bottom: 4px;
  transition: transform 150ms, box-shadow 150ms;
  position: relative;
}
.ramp-chip:hover {
  transform: translateY(-3px) scale(1.08);
  box-shadow: 0 6px 20px color-mix(in srgb, var(--c) 40%, transparent);
  z-index: 2;
}
.ramp-chip span {
  font-size: 9px; font-weight: 600; color: white; text-shadow: 0 1px 4px rgba(0,0,0,0.7);
  opacity: 0; transition: opacity 150ms;
}
.ramp-chip:hover span { opacity: 1; }

/* ── Semantic Pills ──────────────────────────────────────────────────── */
.bento { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.bento-color-card { }
.sem-pills { display: flex; flex-direction: column; gap: 6px; }
.sem-pill {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--df-color-bg-base) 50%, transparent);
  border-radius: 8px;
  cursor: pointer;
  transition: background 150ms;
}
.sem-pill:hover { background: color-mix(in srgb, var(--sg-accent) 8%, transparent); }
.sem-dot { width: 20px; height: 20px; border-radius: 6px; background: var(--c); flex-shrink: 0; }
.sem-name { font-family: var(--df-font-mono); font-size: 12px; flex: 1; color: var(--df-color-text-primary); }
.sem-hex { font-family: var(--df-font-mono); font-size: 11px; color: var(--df-color-text-muted); }

/* ── Space Scale ─────────────────────────────────────────────────────── */
.space-item {
  display: grid; grid-template-columns: 40px 1fr 50px; align-items: center; gap: 12px;
  margin-bottom: 4px; padding: 4px 0;
}
.space-item code { font-size: 12px; color: var(--df-color-text-secondary); text-align: right; }
.space-item span { font-size: 11px; color: var(--df-color-text-muted); }
.space-track { height: 6px; background: var(--df-color-bg-raised); border-radius: 999px; overflow: hidden; }
.space-fill {
  height: 100%; border-radius: 999px;
  background: linear-gradient(90deg, var(--sg-accent-dim), var(--sg-accent));
  transition: width 400ms var(--df-easing-spring);
}

/* ── Radius / Shadow ─────────────────────────────────────────────────── */
.flex-gallery { display: flex; gap: 20px; flex-wrap: wrap; }
.radius-item { text-align: center; }
.radius-box {
  width: 64px; height: 64px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--sg-accent) 15%, var(--df-color-bg-raised)), var(--df-color-bg-raised));
  border: 1px solid var(--sg-glass-border);
  margin-bottom: 8px;
}
.radius-item code { display: block; font-size: 11px; color: var(--df-color-text-primary); }
.radius-item span { font-size: 10px; color: var(--df-color-text-muted); }

.shadow-item { text-align: center; }
.shadow-box {
  width: 88px; height: 88px;
  background: var(--df-color-bg-surface);
  border: 1px solid var(--sg-glass-border);
  border-radius: var(--sg-radius);
  margin-bottom: 8px;
}
.glow-box { border: none; }
.shadow-item code { font-size: 11px; color: var(--df-color-text-primary); }

/* ── Typography ──────────────────────────────────────────────────────── */
.type-row {
  display: flex; align-items: baseline; gap: 24px;
  padding: 12px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--df-color-border-default) 40%, transparent);
}
.type-label { font-size: 11px; color: var(--df-color-text-muted); min-width: 180px; flex-shrink: 0; }
.type-sample { font-family: var(--df-font-mono); color: var(--df-color-text-primary); }

/* ── Contrast Audit ──────────────────────────────────────────────────── */
.a11y-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.a11y-row {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px;
  background: color-mix(in srgb, var(--df-color-bg-surface) 50%, transparent);
  border-radius: 10px;
  border: 1px solid var(--sg-glass-border);
}
.a11y-sample {
  width: 44px; height: 44px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; font-weight: 700; flex-shrink: 0;
}
.a11y-pair { font-size: 11px; color: var(--df-color-text-secondary); flex: 1; font-family: var(--df-font-mono); }
.a11y-ratio { font-size: 12px; font-weight: 700; font-family: var(--df-font-mono); }
.a11y-ratio.pass { color: var(--df-color-state-success); }
.a11y-ratio.fail { color: var(--df-color-state-error); }

/* ── OKLCH Playground ────────────────────────────────────────────────── */
.oklch-play {
  background: linear-gradient(135deg, var(--df-color-bg-surface), var(--df-color-bg-raised));
  border: 1px solid var(--sg-glass-border);
  border-radius: var(--sg-radius);
  padding: 40px;
}
.oklch-controls { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
.oklch-controls label {
  font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--df-color-text-secondary);
}
.oklch-controls input[type="range"] {
  flex: 1; height: 6px; -webkit-appearance: none; appearance: none;
  background: var(--df-color-bg-raised); border-radius: 999px; outline: none;
}
.oklch-controls input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 20px; height: 20px; border-radius: 50%;
  background: var(--sg-accent); border: 2px solid var(--df-color-bg-base);
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  cursor: pointer;
}
.oklch-hue-val {
  font-family: var(--df-font-mono); font-size: 24px; font-weight: 700;
  color: var(--sg-accent); min-width: 3ch; text-align: right;
}
.oklch-strip {
  display: flex; gap: 4px; height: 64px; border-radius: 10px; overflow: hidden;
}
.oklch-strip-chip { flex: 1; transition: background 300ms; }
.oklch-desc {
  font-size: 13px; color: var(--df-color-text-muted); margin-top: 16px;
  max-width: 500px;
}
.oklch-retheme-area {
  margin-top: 32px; padding: 24px;
  border: 1px dashed color-mix(in srgb, var(--sg-accent) 30%, transparent);
  border-radius: 10px;
}
.oklch-retheme-area h4 {
  font-size: 13px; color: var(--sg-accent); font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 16px;
}
.oklch-demo-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.oklch-demo-btn {
  padding: 8px 20px;
  background: color-mix(in srgb, var(--sg-accent) 12%, var(--df-color-bg-raised));
  color: var(--sg-accent);
  border: 1px solid color-mix(in srgb, var(--sg-accent) 40%, transparent);
  border-radius: 8px;
  font-family: var(--df-font-mono); font-size: 11px;
  letter-spacing: 0.06em; text-transform: uppercase;
  cursor: pointer;
  transition: all 150ms;
}
.oklch-demo-btn:hover {
  background: color-mix(in srgb, var(--sg-accent) 20%, var(--df-color-bg-raised));
  box-shadow: 0 0 16px color-mix(in srgb, var(--sg-accent) 30%, transparent);
}
.oklch-demo-badge {
  display: inline-flex; padding: 3px 10px;
  background: color-mix(in srgb, var(--sg-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--sg-accent) 30%, transparent);
  border-radius: 999px;
  font-size: 10px; font-weight: 600; color: var(--sg-accent);
  letter-spacing: 0.08em; text-transform: uppercase;
}

/* ── Component Gallery ───────────────────────────────────────────────── */
.comp-grid { display: flex; flex-direction: column; gap: 20px; }
.comp-card {
  background: var(--sg-glass);
  backdrop-filter: blur(12px);
  border: 1px solid var(--sg-glass-border);
  border-radius: var(--sg-radius);
  overflow: hidden;
}
.comp-card-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--sg-glass-border);
}
.comp-card-title {
  font-size: 13px; font-weight: 600; color: var(--df-color-text-primary);
}
.comp-card-class {
  font-family: var(--df-font-mono); font-size: 11px; color: var(--sg-accent);
  padding: 3px 10px;
  background: color-mix(in srgb, var(--sg-accent) 8%, transparent);
  border-radius: 6px;
}
.comp-card-body { padding: 28px; }
.comp-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.comp-row + .comp-row { margin-top: 16px; }

/* ── Code Blocks ─────────────────────────────────────────────────────── */
.code-block {
  background: var(--df-color-bg-sunken);
  border: 1px solid var(--sg-glass-border);
  border-radius: 10px;
  padding: 20px 24px;
  font-family: var(--df-font-mono);
  font-size: 12px;
  color: var(--df-color-text-secondary);
  overflow-x: auto;
  white-space: pre;
  line-height: 1.7;
}
.code-block .hl-key { color: var(--df-color-state-info); }
.code-block .hl-val { color: var(--sg-accent); }
.code-block .hl-comment { color: var(--df-color-text-muted); }

/* ── Toast ───────────────────────────────────────────────────────────── */
.sg-toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(12px);
  padding: 10px 24px;
  background: var(--df-color-bg-overlay);
  backdrop-filter: blur(12px);
  color: var(--sg-accent);
  border: 1px solid color-mix(in srgb, var(--sg-accent) 40%, transparent);
  border-radius: 999px;
  font-family: var(--df-font-mono);
  font-size: 12px;
  z-index: 9999;
  opacity: 0;
  transition: opacity 200ms, transform 200ms;
  pointer-events: none;
}
.sg-toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }

/* ── Scroll animations ───────────────────────────────────────────────── */
.reveal {
  opacity: 0; transform: translateY(20px);
  transition: opacity 500ms, transform 500ms var(--df-easing-spring);
}
.reveal.visible { opacity: 1; transform: translateY(0); }

/* ── Responsive ──────────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .sg-nav { display: none; }
  .hero { padding: 80px 20px 60px; min-height: 60vh; }
  .hero-stats { gap: 24px; }
  .sg-wrap { padding: 0 16px 60px; }
  .bento { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<!-- ── Floating Nav ──────────────────────────────────────────────────── -->
<nav class="sg-nav">
  <a href="#colors">Colors</a>
  <a href="#oklch-section">OKLCH</a>
  <a href="#typography">Type</a>
  <a href="#spacing">Space</a>
  <a href="#effects">Effects</a>
  <a href="#components">Components</a>
  <a href="#a11y">A11y</a>
  <a href="#playground">Playground</a>
</nav>

<!-- ── Hero ───────────────────────────────────────────────────────────── -->
<section class="hero">
  <div class="hero-grid"></div>
  <div class="hero-badge">v3.0 — Living Style Guide</div>
  <h1>Design<br><em>Tokens</em></h1>
  <p class="hero-sub">
    ${vars.length} tokens. 5 color scales. OKLCH-ready. Spring physics.
    The foundation for every Devglide interface.
  </p>
  <div class="hero-stats">
    <div class="hero-stat"><span class="hero-stat-num">${primCount}</span><span class="hero-stat-label">Primitives</span></div>
    <div class="hero-stat"><span class="hero-stat-num">${semCount}</span><span class="hero-stat-label">Semantic</span></div>
    <div class="hero-stat"><span class="hero-stat-num">${oklchCount}</span><span class="hero-stat-label">OKLCH</span></div>
    <div class="hero-stat"><span class="hero-stat-num">4</span><span class="hero-stat-label">Layers</span></div>
  </div>
</section>

<div class="sg-wrap">

  <!-- ── Colors ──────────────────────────────────────────────────────── -->
  <section id="colors">
    <div class="section-header reveal">
      <h2>Color System</h2>
      <p>5 primitive scales feed into semantic tokens for backgrounds, borders, text, accents, and state.</p>
    </div>

    <div class="card reveal" style="margin-bottom:20px">
      <h3>Primitive Ramps</h3>
      ${primRamps}
    </div>

    <div class="bento reveal">
      ${semanticCards}
    </div>
  </section>

  <!-- ── OKLCH ───────────────────────────────────────────────────────── -->
  <section id="oklch-section">
    <div class="section-header reveal">
      <h2>OKLCH Color Space</h2>
      <p>Perceptually uniform color — change the hue, keep the brightness. Progressive enhancement via <code>@supports</code>.</p>
    </div>
    <div class="card reveal">
      <h3>OKLCH Ramps</h3>
      ${oklchRamps}
    </div>
  </section>

  <!-- ── Typography ──────────────────────────────────────────────────── -->
  <section id="typography">
    <div class="section-header reveal">
      <h2>Typography</h2>
      <p>Three font stacks and a fluid type scale from xs to 3xl.</p>
    </div>
    <div class="card reveal" style="margin-bottom:20px">
      <h3>Font Stacks</h3>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="font-family:var(--df-font-mono);font-size:15px"><span style="color:var(--df-color-text-muted);font-size:11px;display:block;margin-bottom:2px">mono</span>The quick brown fox jumps over the lazy dog</div>
        <div style="font-family:var(--df-font-ui);font-size:15px"><span style="color:var(--df-color-text-muted);font-size:11px;display:block;margin-bottom:2px">ui</span>The quick brown fox jumps over the lazy dog</div>
        <div style="font-family:var(--df-font-display);font-size:15px"><span style="color:var(--df-color-text-muted);font-size:11px;display:block;margin-bottom:2px">display</span>The quick brown fox jumps over the lazy dog</div>
      </div>
    </div>
    <div class="card reveal">
      <h3>Type Scale</h3>
      ${typeScale}
    </div>
  </section>

  <!-- ── Spacing ─────────────────────────────────────────────────────── -->
  <section id="spacing">
    <div class="section-header reveal">
      <h2>Spacing</h2>
      <p>A 4px base unit with 14 steps from 1px to 96px.</p>
    </div>
    <div class="card reveal">
      ${spaceBars}
    </div>
  </section>

  <!-- ── Effects ─────────────────────────────────────────────────────── -->
  <section id="effects">
    <div class="section-header reveal">
      <h2>Effects</h2>
      <p>Border radius, shadows, and glows.</p>
    </div>
    <div class="card reveal" style="margin-bottom:20px">
      <h3>Radius</h3>
      <div class="flex-gallery">
        ${radiusItems}
      </div>
    </div>
    <div class="card reveal" style="margin-bottom:20px">
      <h3>Shadows</h3>
      <div class="flex-gallery">
        ${shadowItems}
      </div>
    </div>
    <div class="card reveal">
      <h3>Glows</h3>
      <div class="flex-gallery">
        ${glowItems}
      </div>
    </div>
  </section>

  <!-- ── Components ──────────────────────────────────────────────────── -->
  <section id="components">
    <div class="section-header reveal">
      <h2>Components</h2>
      <p>Shared <code>df-*</code> component library. Import <code>components.css</code> and use these classes directly.</p>
    </div>

${hasComponents ? `
    <div class="comp-grid">
      <!-- Buttons -->
      <div class="comp-card reveal">
        <div class="comp-card-header">
          <span class="comp-card-title">Buttons</span>
          <code class="comp-card-class">.df-btn</code>
        </div>
        <div class="comp-card-body">
          <div class="comp-row">
            <button class="df-btn df-btn--primary">Primary</button>
            <button class="df-btn df-btn--secondary">Secondary</button>
            <button class="df-btn df-btn--danger">Danger</button>
            <button class="df-btn df-btn--ghost">Ghost</button>
            <button class="df-btn df-btn--primary" disabled>Disabled</button>
          </div>
          <div class="comp-row">
            <button class="df-btn df-btn--primary df-btn--sm">Small Primary</button>
            <button class="df-btn df-btn--secondary df-btn--sm">Small</button>
            <button class="df-btn df-btn--icon">+</button>
            <a class="df-btn df-btn--link">Link Style</a>
          </div>
        </div>
      </div>

      <!-- Badges -->
      <div class="comp-card reveal">
        <div class="comp-card-header">
          <span class="comp-card-title">Badges</span>
          <code class="comp-card-class">.df-badge</code>
        </div>
        <div class="comp-card-body">
          <div class="comp-row">
            <span class="df-badge">Default</span>
            <span class="df-badge df-badge--accent">Accent</span>
            <span class="df-badge df-badge--success">Success</span>
            <span class="df-badge df-badge--error">Error</span>
            <span class="df-badge df-badge--warning">Warning</span>
            <span class="df-badge df-badge--info">Info</span>
          </div>
        </div>
      </div>

      <!-- Forms -->
      <div class="comp-card reveal">
        <div class="comp-card-header">
          <span class="comp-card-title">Form Controls</span>
          <code class="comp-card-class">.df-input .df-select .df-label</code>
        </div>
        <div class="comp-card-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:600px">
            <div>
              <label class="df-label">Text Input</label>
              <input class="df-input" type="text" placeholder="Type something...">
            </div>
            <div>
              <label class="df-label">Select</label>
              <select class="df-select">
                <option>Option one</option>
                <option>Option two</option>
              </select>
            </div>
          </div>
          <div style="margin-top:16px;max-width:600px">
            <label class="df-label">Textarea</label>
            <textarea class="df-textarea" rows="2" placeholder="Multi-line..."></textarea>
          </div>
        </div>
      </div>

      <!-- Modal -->
      <div class="comp-card reveal">
        <div class="comp-card-header">
          <span class="comp-card-title">Modal</span>
          <code class="comp-card-class">.df-modal</code>
        </div>
        <div class="comp-card-body">
          <div style="background:color-mix(in srgb, var(--df-color-bg-base) 80%, transparent);padding:32px;border-radius:10px;display:flex;justify-content:center">
            <div class="df-modal" style="position:relative;max-width:380px">
              <div class="df-modal__header">
                <h2>Confirm Action</h2>
                <p class="df-modal__desc">This will permanently delete the selected items.</p>
              </div>
              <div class="df-modal__actions">
                <button class="df-btn df-btn--secondary">Cancel</button>
                <button class="df-btn df-btn--danger">Delete</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Tabs -->
      <div class="comp-card reveal">
        <div class="comp-card-header">
          <span class="comp-card-title">Tabs</span>
          <code class="comp-card-class">.df-tabs .df-tab</code>
        </div>
        <div class="comp-card-body" style="padding:0">
          <div class="df-tabs" style="border-radius:0 0 var(--sg-radius) var(--sg-radius)">
            <button class="df-tab df-tab--active">Overview</button>
            <button class="df-tab">Settings</button>
            <button class="df-tab">History</button>
            <button class="df-tab">Logs</button>
          </div>
        </div>
      </div>

      <!-- Toast + Empty -->
      <div class="comp-card reveal">
        <div class="comp-card-header">
          <span class="comp-card-title">Toast & Empty State</span>
          <code class="comp-card-class">.df-toast .df-empty</code>
        </div>
        <div class="comp-card-body">
          <div class="comp-row" style="margin-bottom:24px">
            <div class="df-toast df-toast--visible" style="position:relative;transform:none;opacity:1;pointer-events:auto">Operation complete</div>
            <div class="df-toast df-toast--error df-toast--visible" style="position:relative;transform:none;opacity:1;pointer-events:auto">Something failed</div>
          </div>
          <div class="df-empty" style="padding:32px;background:var(--df-color-bg-sunken);border-radius:10px">
            <div class="df-empty__icon" style="font-size:28px">&#128237;</div>
            <div class="df-empty__text">No items yet</div>
          </div>
        </div>
      </div>
    </div>
` : '<div class="card"><p style="color:var(--df-color-text-muted)">Create <code>components.src.css</code> to enable the component gallery.</p></div>'}
  </section>

  <!-- ── Accessibility ───────────────────────────────────────────────── -->
  <section id="a11y">
    <div class="section-header reveal">
      <h2>Contrast Audit</h2>
      <p>Live WCAG AA contrast checks for all text/background pairs. Requires 4.5:1 for normal text.</p>
    </div>
    <div class="a11y-grid reveal">
      ${contrastRows}
    </div>
  </section>

  <!-- ── OKLCH Playground ────────────────────────────────────────────── -->
  <section id="playground">
    <div class="section-header reveal">
      <h2>OKLCH Playground</h2>
      <p>Drag the hue slider to re-theme this entire page in real time.</p>
    </div>
    <div class="oklch-play reveal">
      <div class="oklch-controls">
        <label for="hue-slider">Hue</label>
        <input type="range" id="hue-slider" min="0" max="360" value="185" step="1">
        <span id="hue-value" class="oklch-hue-val">185</span>
      </div>
      <div id="oklch-preview" class="oklch-strip"></div>
      <p class="oklch-desc">One number controls the entire accent palette — buttons, badges, glows, gradients.</p>

      <div class="oklch-retheme-area">
        <h4>Live re-themed components</h4>
        <div class="oklch-demo-btns">
          <button class="oklch-demo-btn">Primary</button>
          <button class="oklch-demo-btn" style="background:transparent;border-style:dashed">Ghost</button>
          <span class="oklch-demo-badge">Active</span>
          <span class="oklch-demo-badge">Badge</span>
        </div>
      </div>
    </div>
  </section>

  <!-- ── Usage ───────────────────────────────────────────────────────── -->
  <section id="usage">
    <div class="section-header reveal">
      <h2>Usage</h2>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">
      <div class="card reveal">
        <h3>CSS</h3>
        <div class="code-block"><span class="hl-comment">/* Import tokens + components */</span>
&lt;link rel="stylesheet" href="<span class="hl-val">/df/tokens.css</span>"&gt;
&lt;link rel="stylesheet" href="<span class="hl-val">/df/components.css</span>"&gt;

<span class="hl-key">.panel</span> {
  <span class="hl-key">background</span>: var(<span class="hl-val">--df-color-bg-surface</span>);
  <span class="hl-key">border</span>: 1px solid var(<span class="hl-val">--df-color-border-default</span>);
}</div>
      </div>
      <div class="card reveal">
        <h3>Tailwind</h3>
        <div class="code-block"><span class="hl-key">import</span> dfPreset <span class="hl-key">from</span> <span class="hl-val">'@devglide/design-tokens/tailwind'</span>;

<span class="hl-key">export default</span> {
  <span class="hl-key">presets</span>: [dfPreset]
};

<span class="hl-comment">// Then use: bg-df-surface text-df-text</span></div>
      </div>
      <div class="card reveal">
        <h3>JavaScript</h3>
        <div class="code-block"><span class="hl-key">import</span> { colors, oklch } <span class="hl-key">from</span>
  <span class="hl-val">'@devglide/design-tokens'</span>;

colors.accent.default <span class="hl-comment">// '#7ee787'</span>
oklch.green[5]        <span class="hl-comment">// 'oklch(0.65 0.17 150)'</span></div>
      </div>
    </div>
  </section>

</div>

<div id="copy-toast" class="sg-toast">Copied!</div>

<script>
// ── Copy-to-clipboard ────────────────────────────────────────────────
document.querySelectorAll('[data-copy]').forEach(el => {
  el.style.cursor = 'pointer';
  el.addEventListener('click', () => {
    navigator.clipboard.writeText(el.dataset.copy);
    const toast = document.getElementById('copy-toast');
    toast.textContent = 'Copied: ' + el.dataset.copy;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 1500);
  });
});

// ── Contrast ratio calc ──────────────────────────────────────────────
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3), 16) / 255;
  const g = parseInt(hex.slice(3,5), 16) / 255;
  const b = parseInt(hex.slice(5,7), 16) / 255;
  return [r, g, b].map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
}
function lum(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }
function cr(a, b) { const l1 = lum(hexToRgb(a)), l2 = lum(hexToRgb(b)); return ((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)); }
document.querySelectorAll('.a11y-ratio').forEach(el => {
  const r = cr(el.dataset.fg, el.dataset.bg);
  el.textContent = r.toFixed(1) + ':1';
  el.classList.add(r >= 4.5 ? 'pass' : 'fail');
});

// ── OKLCH Playground ─────────────────────────────────────────────────
const slider = document.getElementById('hue-slider');
const hueVal = document.getElementById('hue-value');
const preview = document.getElementById('oklch-preview');
const Ls = [0.20, 0.30, 0.43, 0.56, 0.65, 0.72, 0.80, 0.87, 0.91];
const Cs = [0.04, 0.07, 0.12, 0.15, 0.17, 0.175, 0.17, 0.14, 0.115];

function render(h) {
  preview.innerHTML = Ls.map((L, i) =>
    '<div class="oklch-strip-chip" style="background:oklch('+L+' '+Cs[i]+' '+h+')"></div>'
  ).join('');
}

slider.addEventListener('input', () => {
  const h = slider.value;
  hueVal.textContent = h;
  document.documentElement.style.setProperty('--df-oklch-accent-h', h);
  render(h);
});
render(185);

// ── Scroll-reveal ────────────────────────────────────────────────────
const io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); }});
}, { threshold: 0.1 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

// ── Active nav highlight ─────────────────────────────────────────────
const navLinks = document.querySelectorAll('.sg-nav a');
const sections = [...document.querySelectorAll('.sg-wrap section[id]')];
const sio = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
    }
  });
}, { rootMargin: '-40% 0px -50% 0px' });
sections.forEach(s => sio.observe(s));
</script>
</body>
</html>`;
}

writeFileSync(resolve(__dir, 'dist/styleguide.html'), buildStyleguide());

console.log(`✓ dist/tokens.css`);
console.log(`✓ dist/tailwind-preset.js`);
console.log(`✓ dist/tokens.js`);
console.log(`✓ dist/tokens.d.ts`);
console.log(`✓ dist/styleguide.html`);
console.log(`Built ${vars.length} tokens (${primitiveVars.length} primitive + ${semanticVars.length} semantic) + ${oklchVars.length} OKLCH vars.`);
