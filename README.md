# mcpjam-stateless

A reference MCP server demonstrating the **stateless** transport from the upcoming 2026-07-28 spec

Live at **https://stateless.mcpjam.com/mcp**.

## What's "stateless" MCP?

The older MCP transport opens with an `initialize` handshake, then keeps a long-lived connection where both sides remember things about each other — protocol version, capabilities, subscriptions, and so on.

The new transport is the opposite: **every request is self-contained**. No handshake, no session, no memory between requests. The client repeats its protocol version, identity, and capabilities on every call in a `_meta` field, and the server treats each request like the first one it's ever seen.

This matters because it makes MCP servers trivial to host on edge platforms (Workers, Lambda) where cross-request state is awkward, and lets load balancers spread traffic across replicas without sticky sessions.

This repo is a small but complete server exercising the main moving parts of the spec:

- `server/discover` for version negotiation (replaces `initialize`)
- Per-request `_meta` carrying protocol version, client info, and client capabilities
- The standard HTTP header layer (`Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`) that lets proxies route and shape MCP traffic without parsing JSON bodies
- **MRTR** (Multi-Round-Trip Requests) — how a stateless server asks the client for input (elicitation), an LLM completion (sampling), or filesystem roots, without the server ever initiating its own request

`subscriptions/listen` (long-lived server→client notification streams) is part of the spec but not advertised by this server: the SDK's in-memory subscription backend isn't safe across Worker requests yet.

## A note on protocol version

The TypeScript SDK this example links against still uses the placeholder string `DRAFT-2026-v1`. The published spec, the MCPJam backend, and Inspector PR #2303 have all moved to the final `2026-07-28` string. Rather than fork the SDK, `src/index.ts` includes a small HTTP shim that translates the version at the network edge — inbound `2026-07-28` is rewritten to `DRAFT-2026-v1` before the SDK sees it, and outbound responses are rewritten back. Once the SDK ships a build pinning `2026-07-28`, that whole shim block can be deleted.

## Running locally

You need the TypeScript SDK checked out alongside this repo on the `fweinberger/v2-http-stateless` branch and built once:

    ~/typescript-sdk/    # pnpm install && pnpm -r build
    ~/mcpjam-stateless/  # this project

Then:

    npm install          # postinstall symlinks the SDK packages
    npm run dev          # wrangler dev on http://127.0.0.1:8787

The `postinstall` step symlinks the SDK's `packages/server` and `packages/core` into `node_modules/@modelcontextprotocol/`. A plain `file:` dependency won't work because the SDK is a pnpm workspace using `catalog:` deps; symlinks let esbuild walk up to the SDK's own `node_modules` for transitive runtime deps like `zod` and `@cfworker/json-schema`.

If your SDK checkout lives somewhere else:

    MCP_TYPESCRIPT_SDK=/absolute/path/to/typescript-sdk npm install

## Tools exposed

| Tool          | What it shows you                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `echo`        | The plain happy path. Emits a log notification if the caller opts in via `_meta.logLevel`.                 |
| `execute-sql` | The `x-mcp-header` annotation — the `region` argument is mirrored into an `Mcp-Param-Region` header.       |
| `ask-name`    | Server→client **elicitation** via MRTR. Requires `clientCapabilities.elicitation.form`.                    |
| `summarize`   | Server→client **sampling** via MRTR. Requires `clientCapabilities.sampling`.                               |

## Smoke test

```sh
META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}'

# Discover supported versions and capabilities
curl -s -X POST https://stateless.mcpjam.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$META}}"

# Call the echo tool
curl -s -X POST https://stateless.mcpjam.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: echo' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"echo\",\"arguments\":{\"message\":\"hi\"},$META}}"
```

Swap `https://stateless.mcpjam.com` for `http://127.0.0.1:8787` to point at a local `npm run dev`.

## Things you can break on purpose

| Try this                                                                  | You get                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------- |
| Omit the `MCP-Protocol-Version` header                                    | `400 -32001 HeaderMismatch`                          |
| Send an `MCP-Protocol-Version` header that disagrees with the body        | `400 -32001 HeaderMismatch`                          |
| Send an `Mcp-Method` header that disagrees with the body's `method`       | `400 -32001 HeaderMismatch`                          |
| Send an `Mcp-Name` header that disagrees with `params.name`               | `400 -32001 HeaderMismatch`                          |
| Use the retired placeholder version `DRAFT-2026-v1`                       | `400 -32004 Unsupported protocol version`            |
| Call an unknown method                                                    | `404 -32601 Method not found`                        |
| `GET` or `DELETE` on `/mcp`                                               | `405`                                                |
| Call `ask-name` without declaring `clientCapabilities.elicitation`        | `400 -32003 MissingRequiredClientCapability`         |
| Call `ask-name` *with* the capability declared                            | `200`; result has `resultType: "input_required"` — MRTR in action |
