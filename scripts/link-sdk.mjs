#!/usr/bin/env node
// Symlinks the local typescript-sdk packages into node_modules/@modelcontextprotocol/.
// The SDK is a pnpm workspace that uses catalog: refs, so we can't install it as a
// plain `file:` dep — we link to the built source directly and let Wrangler/esbuild
// resolve its transitive runtime deps via the SDK workspace's own node_modules.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const sdkRoot = resolve(process.env.MCP_TYPESCRIPT_SDK ?? resolve(projectRoot, '..', 'typescript-sdk'));
const expectedBranch = process.env.MCP_TYPESCRIPT_SDK_BRANCH ?? 'fweinberger/v2-http-stateless';

const links = [
  ['@modelcontextprotocol/server', resolve(sdkRoot, 'packages/server')],
  ['@modelcontextprotocol/core', resolve(sdkRoot, 'packages/core')],
];

function git(args) {
  try {
    return execFileSync('git', ['-C', sdkRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function fail(message) {
  console.error(message);
  console.error(`Using SDK checkout: ${sdkRoot}`);
  console.error(`Set MCP_TYPESCRIPT_SDK=/absolute/path/to/typescript-sdk to override.`);
  process.exit(1);
}

if (!existsSync(sdkRoot)) {
  fail('Missing typescript-sdk checkout.');
}

const branch = git(['branch', '--show-current']);
const commit = git(['rev-parse', '--short', 'HEAD']);
if (branch && branch !== expectedBranch) {
  console.warn(`warning: expected SDK branch ${expectedBranch}, found ${branch}${commit ? ` (${commit})` : ''}`);
}

const scope = resolve(projectRoot, 'node_modules/@modelcontextprotocol');
mkdirSync(scope, { recursive: true });

for (const [name, target] of links) {
  if (!existsSync(target)) {
    fail(`SDK package missing: ${target}`);
  }
  const link = resolve(scope, name.split('/').pop());
  try { rmSync(link, { recursive: true, force: true }); } catch {}
  symlinkSync(target, link, 'dir');
  console.log(`linked ${name} → ${target}`);
}

const serverBuild = resolve(sdkRoot, 'packages/server/dist/index.mjs');
if (!existsSync(serverBuild)) {
  fail('SDK server package is not built. Run `pnpm install && pnpm -r build` in the SDK checkout.');
}
