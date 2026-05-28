# mcpjam-stateless

Stateless MCP server (2026-07-28 RC) on Cloudflare Workers.

Demonstrates the per-request `_meta` model from PR #2575 / #2567 / #2243 /
#2549: no `initialize` handshake, `server/discover` for version negotiation,
`subscriptions/listen` for streamed notifications, `InputRequiredResult` (MRTR)
for server→client interactions, and the `Mcp-Method` / `Mcp-Name` /
`Mcp-Param-*` header layer.

> **Version-bridge note.** The SDK build this example symlinks still pins
> the placeholder literal `DRAFT-2026-v1`. The spec (and mcpjam-backend +
> inspector PR #2303) have moved to `2026-07-28`. A small HTTP shim in
> `src/index.ts` translates the version string at the edge so the server
> interops with bumped clients without forking the SDK. Delete the shim
> once the SDK ships a build pinning `2026-07-28`.

## Setup

Requires the local typescript-sdk checked out on `fweinberger/v2-http-stateless`
and built. Expected layout:

    ~/typescript-sdk/                ← branch fweinberger/v2-http-stateless, `pnpm install && pnpm -r build`
    ~/mcpjam-stateless/              ← this project

Then:

    npm install                      # also runs scripts/link-sdk.mjs
    npm run dev                      # wrangler dev on http://127.0.0.1:8787

`postinstall` symlinks the SDK's `packages/server` and `packages/core` into
`node_modules/@modelcontextprotocol/`. The SDK is a pnpm workspace using
`catalog:` deps, so installing it via `file:` from outside the workspace
doesn't work — symlinks let esbuild walk up to the SDK's own `node_modules`
for transitive runtime deps (`zod`, `@cfworker/json-schema`, etc.).

## Tools

| Name           | What it exercises                                                |
| -------------- | ---------------------------------------------------------------- |
| `echo`         | Happy path; emits `notifications/message` if `_meta.logLevel` ≥ info |
| `execute-sql`  | `x-mcp-header` annotation → `Mcp-Param-Region` header validation |
| `ask-name`     | MRTR elicitation; needs `clientCapabilities.elicitation.form`    |
| `summarize`    | MRTR sampling; needs `clientCapabilities.sampling`               |
| `retoggle-echo`| Toggles echo and fires `notifications/tools/list_changed`        |

## Smoke test

```sh
META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}'

# Discover supported versions + capabilities
# (response's `supportedVersions` will read "2026-07-28" thanks to the shim)
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' -H 'MCP-Protocol-Version: 2026-07-28' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$META}}"

# Call echo
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: echo' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"echo\",\"arguments\":{\"message\":\"hi\"},$META}}"
```

Expected error paths:

- Wrong `MCP-Protocol-Version` header (vs body) → `400 -32001 HeaderMismatch`
- Unknown method → `404 -32601`
- GET / DELETE → `405`
- `tools/call ask-name` without `clientCapabilities.elicitation` → `400 -32003 MissingRequiredClientCapability`
- `tools/call ask-name` with the cap → `200 result.resultType = "input_required"`
