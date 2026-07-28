# mcpjam-stateless

An **"everything" reference server** for the **stateless** transport from the 2026-07-28 MCP spec — one endpoint exercising every modern protocol feature, so a client (Inspector, CLI, conformance runner) can test the whole surface against a single server.

Live at **https://stateless.mcpjam.com/mcp**.

## What's "stateless" MCP?

The older MCP transport opens with an `initialize` handshake, then keeps a long-lived connection where both sides remember things about each other — protocol version, capabilities, subscriptions, and so on.

The new transport is the opposite: **every request is self-contained**. No handshake, no session, no memory between requests. The client repeats its protocol version, identity, and capabilities on every call in a `_meta` field, and the server treats each request like the first one it's ever seen.

The server is built on `@modelcontextprotocol/server` v2, which implements the 2026-07-28 revision natively — header validation, envelope checks, MRTR dispatch, cache fields, subscription streams, and status mapping are all SDK behavior, not custom code. The endpoint is configured modern-only (`legacy: "reject"`), so 2025-era requests get an `Unsupported protocol version` error.

## Feature map

Every tool/prompt/resource demonstrates one protocol feature:

### Protocol plumbing (SDK-enforced, always on)

| Feature | How to test it |
| --- | --- |
| `server/discover` (replaces `initialize`) | Returns versions, capabilities, identity, `instructions` |
| Per-request `_meta` envelope | Omit/mangle it → `-32602` |
| Standard headers, SEP-2243 (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`) | Mismatch any of them → `400 -32020 HeaderMismatch` |
| Cacheable results, SEP-2549 (`ttlMs`/`cacheScope`) | All list results, `server/discover`, and `resources/read` carry them |
| Per-request logging (`_meta["io.modelcontextprotocol/logLevel"]`) | Logs appear on the request's SSE stream only when the key is sent |

### Tools

| Tool | Feature demonstrated |
| --- | --- |
| `echo` | Plain happy path + opt-in log notification |
| `execute-sql` | `x-mcp-header`: `region` mirrors into `Mcp-Param-Region` (mismatch → `-32020`) |
| `get-weather` | `outputSchema` + `structuredContent` (structured-output validation), icons |
| `long-task` | `notifications/progress` + log messages streamed on the response (send `_meta.progressToken`); honors cancellation |
| `fail` | `mode=result` → `isError: true` result; `mode=throw` → handler throw |
| `ask-name` | **MRTR** form elicitation, single round (needs `clientCapabilities.elicitation.form`) |
| `confirm-launch` | **MRTR multi-round**: two sequential elicitations correlated by HMAC-signed `requestState`; proves per-round response *replacement*; tamper with the state → `-32602` |
| `open-dashboard` | **MRTR URL-mode elicitation** (`mode: "url"`, no `elicitationId` on 2026) |
| `summarize` | **MRTR sampling** (`sampling/createMessage` embedded request) |
| `list-client-roots` | **MRTR roots** (`roots/list`) — deliberately included so clients that *don't* support roots can test their rejection path |
| `never-satisfied` | Infinite `input_required` loop — tests the client's max-rounds limit (`InputRequiredRoundsExceeded`) |
| `trigger-notifications` | Publishes change events to open `subscriptions/listen` streams |

### Resources

| Resource | Feature demonstrated |
| --- | --- |
| `demo://server-card` | Static text + per-resource cache hint (`public`, overrides the operation hint) |
| `demo://logo` | Binary `blob` contents (PNG) |
| `demo://counter` | Time-varying value, per-resource `ttlMs: 0` (never cacheable); target for `resources/updated` notifications |
| `demo://files/{name}` | Resource **template** with `list` enumeration and **argument completion**; unknown names → `-32602` resource-not-found |
| `demo://vault` | **MRTR from `resources/read`** — the read is gated on an elicited passphrase (`mcp`) |

### Prompts

| Prompt | Feature demonstrated |
| --- | --- |
| `code-review` | `completable` argument (`language` answers `completion/complete`), icons |
| `personalized-greeting` | **MRTR from `prompts/get`** — elicits a tone before rendering |

### Subscriptions (`subscriptions/listen`)

Long-lived SSE stream with ack-first semantics: the server sends `notifications/subscriptions/acknowledged` (echoing the filter, stamped with `io.modelcontextprotocol/subscriptionId`) before any notification, then delivers **only** the opted-in notification types. Drive it with `trigger-notifications` from a second request.

> Caveat: the change-event bus is in-memory per Workers isolate. The listen stream and the trigger call must land on the same isolate to observe delivery — normally true for a single client, and always true under `wrangler dev`.

## Running locally

    npm install
    npm run dev          # wrangler dev on http://127.0.0.1:8787

## Smoke test

```sh
BASE=https://stateless.mcpjam.com/mcp   # or http://127.0.0.1:8787/mcp
META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1"},"io.modelcontextprotocol/clientCapabilities":{"elicitation":{"form":{}}}}'

# Discover supported versions and capabilities
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Mcp-Method: server/discover' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$META}}"

# Call the echo tool
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: echo' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"echo\",\"arguments\":{\"message\":\"hi\"},$META}}"

# MRTR round 1: ask-name returns input_required…
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: ask-name' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"ask-name\",\"arguments\":{},$META}}"

# …round 2: replay with the answer attached
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: ask-name' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"ask-name\",\"arguments\":{},\"inputResponses\":{\"name\":{\"action\":\"accept\",\"content\":{\"name\":\"Ada\"}}},$META}}"

# Streamed progress + logs (note the reserved logLevel key and progressToken)
curl -sN -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: long-task' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"long-task\",\"arguments\":{\"steps\":3},\"_meta\":{\"io.modelcontextprotocol/logLevel\":\"debug\",\"progressToken\":\"p1\",\"io.modelcontextprotocol/protocolVersion\":\"2026-07-28\",\"io.modelcontextprotocol/clientInfo\":{\"name\":\"curl\",\"version\":\"1\"},\"io.modelcontextprotocol/clientCapabilities\":{}}}}"

# Subscribe (keep open in one terminal)…
curl -sN -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Method: subscriptions/listen' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"subscriptions/listen\",\"params\":{\"notifications\":{\"toolsListChanged\":true,\"resourceSubscriptions\":[\"demo://counter\"]},$META}}"

# …then trigger from another
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: trigger-notifications' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"trigger-notifications\",\"arguments\":{\"event\":\"resource-updated\"},$META}}"
```

Note `resources/read` requires the `Mcp-Name` header carrying the URI (e.g. `-H 'Mcp-Name: demo://vault'`), same as `tools/call` carries the tool name.

## Things you can break on purpose

| Try this                                                                  | You get                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------- |
| Send an `MCP-Protocol-Version` header that disagrees with the body        | `400 -32020 HeaderMismatch`                          |
| Send an `Mcp-Method` header that disagrees with the body's `method`, or omit it | `400 -32020 HeaderMismatch`                    |
| Send an `Mcp-Name` header that disagrees with `params.name` / `params.uri`, or omit it | `400 -32020 HeaderMismatch`             |
| Call `execute-sql` with an `Mcp-Param-Region` header that disagrees with the `region` argument | `400 -32020 HeaderMismatch`     |
| Use the retired placeholder version `DRAFT-2026-v1`                       | `400 -32022 Unsupported protocol version`            |
| Send a 2025-era `initialize` request                                      | `400 -32022 Unsupported protocol version`            |
| Call an unknown method                                                    | `404 -32601 Method not found`                        |
| `GET` or `DELETE` on `/mcp`                                               | `405`                                                |
| Call `ask-name` without declaring `clientCapabilities.elicitation`        | `400 -32021 MissingRequiredClientCapability`         |
| Tamper with the `requestState` echoed by `confirm-launch`                 | `400 -32602 Invalid or expired requestState`         |
| Read `demo://files/does-not-exist.md`                                     | `-32602` (resource not found)                        |
| Keep answering `never-satisfied`                                          | Client-side `InputRequiredRoundsExceeded`            |

The `MCP-Protocol-Version` header is a **cross-check only**: omitting it is fine (the body's `_meta` envelope is authoritative), but sending one that contradicts the body is rejected.

## Deliberately not included

- **Tasks extension** (`io.modelcontextprotocol/tasks`) — versioned outside core; the v2 SDK's 2026 wire codec strips `capabilities.tasks` / `execution.taskSupport`, so a faithful tasks fixture needs the extension package, not core serving.
- **Apps extension** (`io.modelcontextprotocol/ui`) — needs the `ext-apps` package and a host bridge; advertising an extension without its complete behavior would make this server a bad conformance target.
- **Legacy (2025-era) serving** — the endpoint is `legacy: "reject"` on purpose, so it doubles as the "modern-only strict server" fixture. Flip to the SDK default (`legacy: "stateless"`) if you ever want one handler serving both eras.

The `requestState` HMAC key in `src/index.ts` is deliberately public — this server holds no secrets; the point is exercising the mint/verify round-trip including tamper rejection.
