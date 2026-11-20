# mcpjam-stateless

An **"everything" reference server** for the **stateless** transport from the 2026-07-28 MCP spec — one endpoint exercising every modern protocol feature, so a client (Inspector, CLI, conformance runner) can test the whole surface against a single server.

Live at **https://stateless.mcpjam.com/mcp**. Fixtures for testing hosts live beside it: odd tool names and a per-run call counter (see [Fixture endpoints](#fixture-endpoints)).

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
| `run-task` | **Tasks extension**: returns `CreateTaskResult` (`resultType: "task"`) — see the Tasks section below |

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

### Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663)

The server advertises `capabilities.extensions["io.modelcontextprotocol/tasks"]` in `server/discover` and implements the full draft extension: `tasks/get`, `tasks/update`, `tasks/cancel`, `resultType: "task"` creation on `tools/call`, and `notifications/tasks` over `subscriptions/listen` with the `taskIds` filter member.

The core SDK cannot serve extension methods, so they live in a thin interception layer (`src/tasks.ts`) in front of `createMcpHandler`, routed on the required `Mcp-Method` header. The one piece the SDK does carry is the create-task envelope itself: its 2026 encode contract passes a handler-provided `resultType` through verbatim on `tools/call`, so `run-task` is an ordinary registered tool.

**`run-task` scenarios** (`scenario` argument):

| Scenario | Lifecycle exercised |
| --- | --- |
| `complete` (default) | `working` → `completed` with a `CallToolResult` after `delayMs` |
| `tool-error` | `working` → `completed` with `isError: true` (spec: tool errors are NOT `failed`) |
| `protocol-error` | `working` → `failed` with a JSON-RPC `error` object |
| `needs-input` | `working` → `input_required` (elicitation in `inputRequests`) → answer via `tasks/update` → `working` → `completed` using the answer |
| `stubborn` | acks `tasks/cancel` but completes anyway (cancellation is cooperative) |

Plus `confirm: true` on any scenario, which runs a synchronous MRTR elicitation *before* returning `CreateTaskResult` (the spec's recommended ordering), and `delayMs` to control the simulated work per phase.

`run-task` is deliberately task-only: calling it without declaring the extension in per-request `clientCapabilities` answers `-32003 Missing required client capability` naming the extension — same for `tasks/*` methods and for `subscriptions/listen` filters containing `taskIds`. Per the extension's routing-header rule, `tasks/*` requests must carry `Mcp-Name: <taskId>`.

**Statelessness**: task IDs are HMAC-signed tokens carrying the task's plan (scenario, delay, creation time), so create → poll-to-terminal → reconnect works across Workers isolates with zero storage — a `tasks/get` for a returned ID resolves immediately anywhere, as the spec requires. Mutations (`tasks/update` answers, cancellation) live in a tiny per-task Durable Object, so an answer or cancel is visible from every isolate — found the hard way when the MCPJam CLI's reconnect-per-command style landed `tasks/update` and the follow-up `tasks/get` on different isolates. Tasks expire 10 minutes after creation (`ttlMs`), after which `tasks/get` answers `-32602 Task has expired`.

```sh
META_TASKS='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1"},"io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}}}'

# Create a task…
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: run-task' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"run-task\",\"arguments\":{\"scenario\":\"needs-input\",\"delayMs\":2000},$META_TASKS}}"

# …poll it (Mcp-Name carries the taskId)…
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Mcp-Method: tasks/get' -H "Mcp-Name: $TASK_ID" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tasks/get\",\"params\":{\"taskId\":\"$TASK_ID\",$META_TASKS}}"

# …answer its elicitation…
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Mcp-Method: tasks/update' -H "Mcp-Name: $TASK_ID" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tasks/update\",\"params\":{\"taskId\":\"$TASK_ID\",\"inputResponses\":{\"name\":{\"action\":\"accept\",\"content\":{\"name\":\"Ada\"}}},$META_TASKS}}"

# …or watch it over subscriptions/listen (ack intersects taskIds to known tasks)
curl -sN -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Method: subscriptions/listen' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"subscriptions/listen\",\"params\":{\"notifications\":{\"taskIds\":[\"$TASK_ID\"]},$META_TASKS}}"
```

## Fixture endpoints

Separate endpoints for testing how clients and hosts behave. `/mcp` itself stays exactly as described above.

| URL | What it serves |
| --- | --- |
| `https://stateless.mcpjam.com/fixtures/odd-names/mcp` | Tools with odd names (below) |
| `https://stateless.mcpjam.com/runs/<run-id>/mcp` | Everything `/mcp` serves, with tool calls counted |
| `https://stateless.mcpjam.com/runs/<run-id>/fixtures/odd-names/mcp` | The odd names, with tool calls counted |
| `GET https://stateless.mcpjam.com/runs/<run-id>/calls` | That run's counts: `{ "total": n, "byTool": { "<name>": n } }` |

### Odd tool names (`/fixtures/odd-names/mcp`)

| Tool name | Length | Why it's there |
| --- | --- | --- |
| `control` | 7 | A conforming name. If a host lists only this tool, it dropped every odd name. |
| `dotted.tool.name` | 16 | Dots |
| `slashed/tool/name` | 17 | Slashes (outside SEP-986's allowed characters) |
| `collide.pair` | 12 | Collides with `collide_pair` when a host replaces characters outside `[A-Za-z0-9_-]` with `_` |
| `collide_pair` | 12 | The other half of that pair |
| `long_name_123456789012345678901234567890123456789012345678901234` | 64 | Exactly at the 64-character cap several hosts enforce |
| `long_name_1234567890123456789012345678901234567890123456789012345` | 65 | One over: the 64-character name plus one, so a host that truncates to 64 makes the two identical |
| `longest_allowed_name_23456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678` | 128 | The longest name SEP-986 allows |

In the long names, each digit after the prefix is its 1-based position mod 10, so the last digit gives the length mod 10. Every tool takes an optional `message` and replies with its own exact name: `called <name> (<length> chars)`, plus `: <message>` when one was sent, and `structuredContent` of `{ tool, length, message? }`. A call that a host routed to the wrong tool shows up in the reply.

Unlike `/mcp`, this endpoint also serves 2025-era clients (`initialize`, no per-request envelope), since many of the hosts worth testing still speak that protocol.

### Per-run call counter (`/runs/<run-id>/…`)

Prefix an endpoint with `/runs/<run-id>` and every `tools/call` request it receives is counted under the tool name the client sent. Then `GET /runs/<run-id>/calls` answers `{ total, byTool }`, which is how a QA run proves a host sent the server zero calls.

- **Run ids** are yours to choose: 16 to 64 characters from `A-Z a-z 0-9 - _`. Use a fresh random one per run (a UUID works). Anything else gets `400`.
- **What counts:** every `tools/call` request, counted on arrival under `params.name` exactly as sent, before the server validates anything. A call to a name the server doesn't have (say, a host's sanitized `dotted_tool_name`) and a call the server rejects both count. Each round of a multi-round (MRTR) call is its own request and counts once. Nothing else counts: `tools/list`, `server/discover` and the rest are free.
- **Consistency:** a call is recorded before it is served, so its count is visible as soon as its response arrives. If the counter can't record a call, the call fails with HTTP `503` and JSON-RPC `-32603` instead of being served uncounted.
- **A run nobody called** reads `{ "total": 0, "byTool": {} }`.
- **Expiry:** a run's counts delete themselves 24 hours after its most recent counted call (a Durable Object alarm), and then read as zeros again. Read the counts during the run.
- **Limits:** `total` counts every call; `byTool` itemizes up to 256 distinct names of up to 256 characters each.
- **Isolation:** each run id is its own Durable Object, reachable only by its exact id. Nothing lists runs or totals across them, and `/runs/<run-id>/mcp` streams `subscriptions/listen` notifications only from `trigger-notifications` calls made in the same run.

```sh
RUN=$(uuidgen)
BASE=https://stateless.mcpjam.com/runs/$RUN/fixtures/odd-names/mcp
META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}'

# Point a host at $BASE (or https://stateless.mcpjam.com/runs/$RUN/mcp), or call a tool yourself…
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: dotted.tool.name' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"dotted.tool.name\",\"arguments\":{},$META}}"

# …then read what the server received
curl -s https://stateless.mcpjam.com/runs/$RUN/calls
# {"total":1,"byTool":{"dotted.tool.name":1}}
```

## Running locally

    npm install
    npm run dev          # wrangler dev on http://127.0.0.1:8787
    npm test             # vitest: the default /mcp catalog, fixtures, and run counter
    npm run typecheck

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
| Call `run-task` / `tasks/*` / listen with `taskIds` without declaring the tasks extension | `-32003` naming the extension        |
| `tasks/get` with a tampered or made-up `taskId`                           | `-32602 Task not found`                              |
| `tasks/*` without `Mcp-Name: <taskId>`, or with a mismatching one         | `400 -32020`                                         |
| `tasks/cancel` a `stubborn` task                                          | ack, then it completes anyway (cooperative cancel)   |

The `MCP-Protocol-Version` header is a **cross-check only**: omitting it is fine (the body's `_meta` envelope is authoritative), but sending one that contradicts the body is rejected.

## Deliberately not included

- **Apps extension** (`io.modelcontextprotocol/ui`) — needs the `ext-apps` package and a host bridge; advertising an extension without its complete behavior would make this server a bad conformance target.
- **Legacy (2025-era) serving** — the endpoint is `legacy: "reject"` on purpose, so it doubles as the "modern-only strict server" fixture. Flip to the SDK default (`legacy: "stateless"`) if you ever want one handler serving both eras.

The `requestState` HMAC key in `src/index.ts` and the task-ID signing key in `src/tasks.ts` are deliberately public — this server holds no secrets; the point is exercising the mint/verify round-trips including tamper rejection.
