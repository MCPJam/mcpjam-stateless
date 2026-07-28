# mcpjam-stateless

A reference MCP server demonstrating the **stateless** transport from the 2026-07-28 spec

Live at **https://stateless.mcpjam.com/mcp**.

## What's "stateless" MCP?

The older MCP transport opens with an `initialize` handshake, then keeps a long-lived connection where both sides remember things about each other — protocol version, capabilities, subscriptions, and so on.

The new transport is the opposite: **every request is self-contained**. No handshake, no session, no memory between requests. The client repeats its protocol version, identity, and capabilities on every call in a `_meta` field, and the server treats each request like the first one it's ever seen.

This matters because it makes MCP servers trivial to host on edge platforms (Workers, Lambda) where cross-request state is awkward, and lets load balancers spread traffic across replicas without sticky sessions.

This repo is a small but complete server exercising the main moving parts of the spec:

- `server/discover` for version negotiation (replaces `initialize`)
- Per-request `_meta` carrying protocol version, client info, and client capabilities
- The standard HTTP header layer (`Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`) that lets proxies route and shape MCP traffic without parsing JSON bodies
- **MRTR** (Multi-Round-Trip Requests) — how a stateless server asks the client for input (elicitation), an LLM completion (sampling), or filesystem roots, without the server ever initiating its own request: the handler returns an `input_required` result, and the client replays the call with the responses attached
- **Cacheable results** (SEP-2549) — list results and `server/discover` carry `ttlMs`/`cacheScope` so shared caches can serve them

`subscriptions/listen` (long-lived server→client notification streams) is part of the spec but not advertised by this server: the SDK's default subscription bus is in-memory and per-isolate, which isn't meaningful across Worker requests.

The server is built on `@modelcontextprotocol/server` v2, which implements the 2026-07-28 revision natively — the whole HTTP surface (header validation, envelope checks, MRTR dispatch, cache fields, status mapping) is SDK behavior, not custom code. The endpoint is configured modern-only (`legacy: "reject"`), so 2025-era requests get an `Unsupported protocol version` error naming the supported revision.

## Running locally

    npm install
    npm run dev          # wrangler dev on http://127.0.0.1:8787

## Tools exposed

| Tool          | What it shows you                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `echo`        | The plain happy path. Emits a log notification if the caller opts in via `_meta.logLevel`.                 |
| `execute-sql` | The `x-mcp-header` annotation — the `region` argument is mirrored into an `Mcp-Param-Region` header (and the server rejects requests where they disagree). |
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
| Send an `MCP-Protocol-Version` header that disagrees with the body        | `400 -32020 HeaderMismatch`                          |
| Send an `Mcp-Method` header that disagrees with the body's `method`, or omit it | `400 -32020 HeaderMismatch`                    |
| Send an `Mcp-Name` header that disagrees with `params.name`, or omit it   | `400 -32020 HeaderMismatch`                          |
| Call `execute-sql` with an `Mcp-Param-Region` header that disagrees with the `region` argument, or omit it | `400 -32020 HeaderMismatch` |
| Use the retired placeholder version `DRAFT-2026-v1`                       | `400 -32022 Unsupported protocol version`            |
| Send a 2025-era `initialize` request                                      | `400 -32022 Unsupported protocol version`            |
| Call an unknown method                                                    | `404 -32601 Method not found`                        |
| `GET` or `DELETE` on `/mcp`                                               | `405`                                                |
| Call `ask-name` without declaring `clientCapabilities.elicitation`        | `400 -32021 MissingRequiredClientCapability`         |
| Call `ask-name` *with* the capability declared                            | `200`; result has `resultType: "input_required"` — MRTR in action |

Note the `MCP-Protocol-Version` header is a **cross-check only**: omitting it is fine (the body's `_meta` envelope is authoritative), but sending one that contradicts the body is rejected.
