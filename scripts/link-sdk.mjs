#!/usr/bin/env node
// Symlinks the local typescript-sdk packages into node_modules/@modelcontextprotocol/.
// The SDK is a pnpm workspace that uses catalog: refs, so we can't install it as a
// plain `file:` dep — we link to the built source directly and let Wrangler/esbuild
// resolve its transitive runtime deps via the SDK workspace's own node_modules.

import { mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const sdkRoot = resolve(projectRoot, '..', 'typescript-sdk');

const links = [
  ['@modelcontextprotocol/server', resolve(sdkRoot, 'packages/server')],
  ['@modelcontextprotocol/core', resolve(sdkRoot, 'packages/core')],
];

const scope = resolve(projectRoot, 'node_modules/@modelcontextprotocol');
mkdirSync(scope, { recursive: true });

for (const [name, target] of links) {
  if (!existsSync(target)) {
    console.error(`SDK package missing: ${target}`);
    console.error('Expected the typescript-sdk repo as a sibling of this project, on branch fweinberger/v2-http-stateless with pnpm install + pnpm build run.');
    process.exit(1);
  }
  const link = resolve(scope, name.split('/').pop());
  try { rmSync(link, { recursive: true, force: true }); } catch {}
  symlinkSync(target, link, 'dir');
  console.log(`linked ${name} → ${target}`);
}
