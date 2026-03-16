#!/usr/bin/env node
/**
 * Build script for @devglide/design-tokens v2.0
 *
 * Reads tokens.json and generates:
 *   dist/tokens.css          — CSS custom properties with @layer architecture
 *   dist/tailwind-preset.js  — Tailwind v3 preset
 *   dist/tokens.js           — ESM JS constants
 *   dist/tokens.d.ts         — TypeScript declarations
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(readFileSync(resolve(__dir, 'tokens.json'), 'utf8'));

mkdirSync(resolve(__dir, 'dist'), { recursive: true });

// ── Flatten tokens to --df-{category}-{name}: value ──────────────────────────
function camelToKebab(str) {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function flatten(obj, prefix = '') {
  const vars = [];
  for (const [key, val] of Object.entries(obj)) {
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

const vars = flatten(tokens);

// Separate primitives from semantic tokens for organized output
const primitiveVars = vars.filter(([k]) => k.startsWith('--df-primitive-'));
const semanticVars = vars.filter(([k]) =>
  !k.startsWith('--df-primitive-')
);

// ── dist/tokens.css ───────────────────────────────────────────────────────────
const css = `/* @devglide/design-tokens v2.0 — generated, do not edit */
/* Modern CSS architecture: @layer cascade, @property declarations, spring easings */

@layer df-tokens, df-keyframes, df-components, df-utilities;

/* ══════════════════════════════════════════════════════════════════════════════
   Layer: df-tokens — Design token custom properties
   ══════════════════════════════════════════════════════════════════════════════ */
@layer df-tokens {
  :root {
    /* ── Primitive Palette ──────────────────────────────────────────────── */
${primitiveVars.map(([k, v]) => `    ${k}: ${v};`).join('\n')}

    /* ── Semantic Tokens ───────────────────────────────────────────────── */
${semanticVars.map(([k, v]) => `    ${k}: ${v};`).join('\n')}
  }

  /* ── @property declarations for animatable tokens ──────────────────── */
  @property --df-hue {
    syntax: '<number>';
    initial-value: 150;
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
    0%, 100% { filter: drop-shadow(0 0 6px rgba(126,231,135,0.4)); }
    50%      { filter: drop-shadow(0 0 14px rgba(126,231,135,0.7)); }
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
      rgba(126,231,135,0.03) 50%,
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
      rgba(126,231,135,0.02) 0px,
      rgba(126,231,135,0.02) 1px,
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

// ── dist/tailwind-preset.js ───────────────────────────────────────────────────
const t = tokens;
const twPreset = `/* @devglide/design-tokens v2.0 — Tailwind v3 preset — generated, do not edit */
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
const jsConstants = `/* @devglide/design-tokens v2.0 — generated, do not edit */
export const tokens = ${JSON.stringify(tokens, null, 2)};

// Flat map of CSS variable name -> value
export const cssVars = Object.fromEntries([
${vars.map(([k, v]) => `  ['${k}', ${JSON.stringify(v)}],`).join('\n')}
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
export const maxWidths    = tokens.maxWidth;
`;

writeFileSync(resolve(__dir, 'dist/tokens.js'), jsConstants);

// ── dist/tokens.d.ts ──────────────────────────────────────────────────────────
const dts = `/* @devglide/design-tokens v2.0 — generated, do not edit */
export declare const tokens: ${JSON.stringify(tokens, null, 2)
  .replace(/"([^"]+)":/g, '$1:')
  .replace(/: "([^"]+)"/g, ': string')};

export declare const cssVars: Record<string, string>;
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
export declare const maxWidths: typeof tokens.maxWidth;
`;

writeFileSync(resolve(__dir, 'dist/tokens.d.ts'), dts);

console.log(`✓ dist/tokens.css`);
console.log(`✓ dist/tailwind-preset.js`);
console.log(`✓ dist/tokens.js`);
console.log(`✓ dist/tokens.d.ts`);
console.log(`Built ${vars.length} tokens (${primitiveVars.length} primitive + ${semanticVars.length} semantic).`);
