import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isCurrent, build } from '../../scripts/build-design-tokens.mjs';

const STANDARD = [
  'color-background', 'color-surface', 'color-surface-raised', 'color-ink', 'color-ink-muted',
  'color-border', 'color-primary', 'color-primary-ink', 'color-accent', 'color-ring',
  'color-ok', 'color-warn', 'color-err',
  'space-1', 'space-2', 'space-3', 'space-4', 'space-6', 'space-8',
  'radius-sm', 'radius-md', 'radius-lg',
  'font-display', 'font-body', 'text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl',
  'shadow-sm', 'shadow-md',
  'duration-fast', 'duration-base', 'ease-standard',
];

test('tokens.json matches tokens/*.css', () => {
  assert.ok(isCurrent(), 'run `npm run tokens`');
});

test('the 36 standard token names exist', () => {
  const t = build();
  const names = new Set([
    ...t.color.tokens, ...t.spacing.tokens, ...t.radius.tokens, ...t.shadow.tokens, ...t.motion.tokens,
    ...t.type.groups[0].styles,
    ...Object.keys(t.type.families).map((k) => ({ name: `font-${k}` })),
  ].map((x) => x.name));
  assert.deepEqual(STANDARD.filter((n) => !names.has(n)), []);
  assert.equal(STANDARD.length, 36);
});

test('no app file uses an old token name', () => {
  const css = fs.readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /color-(foreground|on-accent|status-|line\b)/);
});
