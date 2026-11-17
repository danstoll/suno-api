#!/usr/bin/env node
/**
 * Makes DesignSystem/tokens.json FROM DesignSystem/tokens/*.css.
 * The CSS is the one source the app imports. tokens.json is the copy that the
 * Claude Design System format reads. A test (src/lib/designTokens.test.mjs)
 * fails when the two differ.
 *
 *   node scripts/build-design-tokens.mjs           write tokens.json
 *   node scripts/build-design-tokens.mjs --check   exit 1 if tokens.json is stale
 *
 * The CSS is flat: an @theme block, and a dark block inside a
 * prefers-color-scheme media query (`:root { ... }`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DS = path.join(ROOT, 'DesignSystem');
export const TOKENS_JSON = path.join(DS, 'tokens.json');

const clean = (raw) => raw.replace(/\s+/g, ' ').trim();

/** Read `--name: value;` lines of one block body, with the comment above each as usage. */
function decls(body, header) {
  const out = [];
  let last = header;
  const re = /\/\*([\s\S]*?)\*\/|(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) last = clean(m[1]);
    else out.push({ name: m[2].slice(2), value: clean(m[3]), usage: last });
  }
  return out;
}

function read(file) {
  const css = fs.readFileSync(path.join(DS, 'tokens', file), 'utf8');
  const header = clean((css.match(/^\s*\/\*([\s\S]*?)\*\//) || [, ''])[1]).split(/\.\s/)[0];
  const theme = css.match(/@theme\s*\{([\s\S]*?)\n\}/);
  const dark = css.match(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n  \}\n\}/);
  const parsed = {
    theme: theme ? decls(theme[1], header) : [],
    dark: dark ? decls(dark[1], header) : [],
  };
  const total = (css.match(/^\s*--[\w-]+\s*:/gm) || []).length;
  const seen = parsed.theme.length + parsed.dark.length;
  if (seen !== total) throw new Error(`${file}: read ${seen} of ${total} declarations`);
  return parsed;
}

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|oklab|lab|lch)\([0-9 .,%/-]+\))$/i;

export function build() {
  const colors = read('colors.css');
  const dark = new Map(colors.dark.map((d) => [d.name, d.value]));
  const known = new Set(colors.theme.map((d) => d.name));
  for (const name of dark.keys()) if (!known.has(name)) throw new Error(`--${name} is in the dark block but not in @theme`);
  const colorTokens = colors.theme.map((d) => {
    for (const v of [d.value, dark.get(d.name)]) {
      if (v && !COLOR.test(v)) throw new Error(`--${d.name}: "${v}" cannot go in tokens.json`);
    }
    return {
      name: d.name,
      value: { light: d.value, dark: dark.get(d.name) ?? d.value },
      usage: d.usage,
    };
  });
  const space = read('spacing.css').theme;
  const fx = read('effects.css').theme;
  const typo = read('typography.css').theme;
  const pick = (list, prefix) =>
    list.filter((d) => d.name.startsWith(prefix)).map(({ name, value, usage }) => ({ name, value, usage }));
  const families = {};
  for (const d of typo.filter((x) => x.name.startsWith('font-'))) families[d.name.slice(5)] = d.value;
  return {
    color: { themes: [{ id: 'light' }, { id: 'dark' }], tokens: colorTokens },
    spacing: { tokens: pick(space, 'space-') },
    radius: { tokens: pick(space, 'radius-').filter((t) => !t.value.startsWith('var(')) },
    shadow: { tokens: pick(fx, 'shadow-').filter((t) => !t.value.startsWith('var(')) },
    motion: { tokens: [...pick(fx, 'duration-'), ...pick(fx, 'ease-')] },
    type: {
      fonts: [],
      families,
      groups: [
        {
          name: 'Scale',
          family: 'body',
          styles: typo
            .filter((d) => d.name.startsWith('text-'))
            .map((d) => ({ name: d.name, fontSize: d.value, usage: d.usage })),
        },
      ],
    },
  };
}

export const render = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

export function isCurrent() {
  return fs.existsSync(TOKENS_JSON) && fs.readFileSync(TOKENS_JSON, 'utf8') === render(build());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    if (isCurrent()) console.log('tokens.json matches tokens/*.css');
    else {
      console.error('tokens.json is stale: run `npm run tokens`');
      process.exit(1);
    }
  } else {
    fs.writeFileSync(TOKENS_JSON, render(build()));
    console.log('wrote DesignSystem/tokens.json');
  }
}
