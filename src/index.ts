// Stateless MCP server (2026-07-28 RC) on Cloudflare Workers.
//
// What "stateless" means here, per the new spec:
//   * No `initialize` handshake. Each request carries its own
//     `_meta.io.modelcontextprotocol/protocolVersion`, `clientInfo`,
//     and `clientCapabilities` — the server treats every request as
//     standalone, even when delivered over the same TCP connection.
//   * `handleHttp(server)` returns a plain `(Request) => Promise<Response>`
//     handler. One server instance is shared across all requests; there is
//     no Durable Object, no per-session state.
//   * `server/discover` replaces `initialize` for version negotiation.
//     Removed methods (`initialize`, `ping`, `logging/setLevel`,
//     `resources/subscribe`) return -32601.
//   * Server→client interactions (sampling/elicitation/listRoots) are not
//     pushed as separate requests. Handlers call `ctx.mcpReq.elicitInput`
//     / `requestSampling` / `listRoots`; the SDK turns those into an
//     `InputRequiredResult` for the client to satisfy (SEP-2322 MRTR).
//   * Long-lived notifications are obtained by the client POSTing
//     `subscriptions/listen`; the response itself is an SSE stream
//     (handled inside `handleHttp`).
//
// Run locally:  pnpm dev    (Wrangler binds to http://127.0.0.1:8787/mcp)

import { handleHttp, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const server = new McpServer(
  { name: "mcpjam-stateless", version: "0.1.0" },
  {
    capabilities: {
      tools: { listChanged: true },
      logging: {},
    },
    // Advertise only the 2026 RC. Written as the SDK's placeholder
    // literal because that's what this SDK build still pins; the
    // version-bridge below rewrites it to "2026-07-28" outbound.
    supportedProtocolVersions: ["DRAFT-2026-v1"],
  },
);

// ── echo ────────────────────────────────────────────────────
// Minimal happy path: validates inputSchema, emits a log notification
// (only delivered if the request's `_meta.logLevel` opted in to `info`
// or finer — stateless logging is per-request, not connection-wide).
const echoTool = server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo back the provided message.",
    inputSchema: z.object({ message: z.string() }),
    annotations: { readOnlyHint: true },
  },
  async ({ message }, ctx) => {
    await ctx.mcpReq.log("info", `echoing: ${message}`);
    return {
      content: [{ type: "text" as const, text: `echo: ${message}` }],
      structuredContent: { echoed: message },
    };
  },
);

// ── execute-sql ─────────────────────────────────────────────
// Demonstrates `x-mcp-header`: the `region` parameter is mirrored
// into an `Mcp-Param-Region` header by conforming clients, so a load
// balancer can route to the right region without parsing the body.
// The SDK validates header↔body agreement and rejects mismatches with
// HeaderMismatch (-32001).
// `x-mcp-header` lives on the JSON Schema, not the Zod object, so we
// attach it via `.meta()` — the SDK serializes that into the published
// tool's inputSchema for clients to honor.
server.registerTool(
  "execute-sql",
  {
    title: "Execute SQL",
    description: "Run a SQL query against a regional database.",
    inputSchema: z.object({
      region: z
        .string()
        .meta({
          description: "Target region (mirrored to Mcp-Param-Region).",
          "x-mcp-header": "Region",
        }),
      query: z.string().meta({ description: "SQL to execute." }),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ region, query }, ctx) => {
    await ctx.mcpReq.log("debug", `[${region}] ${query}`);
    return {
      content: [
        {
          type: "text" as const,
          text: `(stub) executed in ${region}: ${query}`,
        },
      ],
      structuredContent: { region, rowCount: 0 },
    };
  },
);

// ── ask-name ────────────────────────────────────────────────
// Server→client interaction under stateless transport. The handler
// calls `elicitInput`; the SDK rethrows InputRequiredError which the
// dispatcher turns into an InputRequiredResult on the wire. The client
// satisfies it and replays the request with the response embedded.
//
// If the client did not declare `capabilities.elicitation`, the call
// fails with MissingRequiredClientCapability (-32003) — verifiable by
// omitting that capability from `_meta.clientCapabilities`.
server.registerTool(
  "ask-name",
  {
    title: "Ask the user's name",
    description: "Elicits a name from the user, then greets them.",
    inputSchema: z.object({}),
  },
  async (_args, ctx) => {
    const result = await ctx.mcpReq.elicitInput({
      message: "What's your name?",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string", title: "Your name" } },
        required: ["name"],
      },
    });
    if (result.action !== "accept" || !result.content) {
      return {
        content: [
          { type: "text" as const, text: `Elicitation ${result.action}.` },
        ],
      };
    }
    const name = (result.content as { name?: string }).name ?? "stranger";
    return {
      content: [{ type: "text" as const, text: `Hello, ${name}!` }],
      structuredContent: { name },
    };
  },
);

// ── summarize ───────────────────────────────────────────────
// Sampling via MRTR. Requires `_meta.clientCapabilities.sampling`.
server.registerTool(
  "summarize",
  {
    title: "Summarize text",
    description: "Asks the client's LLM to summarize the given text.",
    inputSchema: z.object({ text: z.string() }),
  },
  async ({ text }, ctx) => {
    const sample = await ctx.mcpReq.requestSampling({
      maxTokens: 256,
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Summarize in one sentence:\n\n${text}` },
        },
      ],
    });
    const out =
      sample.content.type === "text" ? sample.content.text : "(non-text result)";
    return {
      content: [{ type: "text" as const, text: out }],
      structuredContent: { summary: out },
    };
  },
);

// ── retoggle-echo ───────────────────────────────────────────
// Demonstrates `notifications/tools/list_changed`. Each call flips the
// echo tool's disabled state; subscribers to `subscriptions/listen` with
// `toolsListChanged: true` will receive a notification on their stream.
server.registerTool(
  "retoggle-echo",
  {
    title: "Toggle echo availability",
    description:
      "Enable/disable the echo tool and emit notifications/tools/list_changed. " +
      "Subscribers via subscriptions/listen will see the change.",
    inputSchema: z.object({}),
  },
  async () => {
    // RegisteredTool exposes enable()/disable() and triggers listChanged.
    if (echoTool.enabled) echoTool.disable();
    else echoTool.enable();
    return {
      content: [
        {
          type: "text" as const,
          text: `echo is now ${echoTool.enabled ? "enabled" : "disabled"}`,
        },
      ],
      structuredContent: { echoEnabled: echoTool.enabled },
    };
  },
);

// ── Worker entry ────────────────────────────────────────────
// `handleHttp` is the 2026-06 stateless Fetch entry. It enforces:
//   * POST-only (GET/DELETE → 405)
//   * Content-Type: application/json (CSRF barrier → 415 otherwise)
//   * Per-request _meta validation
//   * MCP-Protocol-Version header ↔ body parity (HeaderMismatch -32001)
//   * `subscriptions/listen` → SSE response stream
//   * Status code mapping (404 for unknown method, 400 for invalid params,
//     500 for internal errors, 200 for normal results).
const mcp = handleHttp(server.server, {
  // DNS-rebinding guard. Accepts local dev hosts plus the deployed worker
  // hostname. Tighten if you bind a custom domain.
  allowedHosts: [
    "127.0.0.1",
    "localhost",
    "[::1]",
    "mcpjam-stateless.marcelo-1cb.workers.dev",
  ],
  maxBodyBytes: 1 * 1024 * 1024,
});

// ── version bridge ────────────────────────────────────────
// The symlinked SDK still pins the placeholder literal "DRAFT-2026-v1".
// The spec has since pinned the same wire protocol as "2026-07-28"
// (modelcontextprotocol/main @ a11b1550), and mcpjam-backend +
// inspector PR #2303 have fully swapped to the new literal. Until the
// SDK ships a build that pins 2026-07-28 too, we translate the version
// string at the HTTP edge so this example interops with the bumped
// clients without forking the SDK.
//
// Delete this whole block (and call `mcp` directly from `fetch`) once
// the SDK exports 2026-07-28.
const WIRE_VERSION = "2026-07-28"; // what bumped clients speak
const SDK_VERSION = "DRAFT-2026-v1"; // what this SDK build speaks

// Outbound JSON keys that ever carry a protocol-version string:
//   * `supportedVersions` in DiscoverResult
//   * `supported` / `requested` in UnsupportedProtocolVersionErrorData
// Tool content (`content`, `structuredContent`) is never rewritten, so
// an `echo` of the literal `"DRAFT-2026-v1"` round-trips unchanged.
const VERSION_KEYS = new Set(["supportedVersions", "supported", "requested"]);

// Walks `value` and rewrites string leaves equal to `from` → `to`, but
// only when the enclosing key (anywhere up the path) is in VERSION_KEYS.
// `inside` propagates that gate through nested arrays/objects so that
// e.g. `supportedVersions: ["DRAFT-2026-v1"]` rewrites, while
// `structuredContent: { echoed: "DRAFT-2026-v1" }` does not.
function swapVersion(value: unknown, from: string, to: string, inside = false): unknown {
  if (Array.isArray(value)) return value.map((v) => swapVersion(v, from, to, inside));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = swapVersion(v, from, to, inside || VERSION_KEYS.has(k));
    }
    return out;
  }
  if (inside && typeof value === "string" && value === from) return to;
  return value;
}

function rewriteSseLine(line: string): string {
  // SSE: each event has one or more `data:` lines whose payload is JSON.
  if (!line.startsWith("data:")) return line;
  const payload = line.slice("data:".length).replace(/^\s/, "");
  const trailing = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
  try {
    const json = JSON.parse(payload);
    return `data: ${JSON.stringify(swapVersion(json, SDK_VERSION, WIRE_VERSION))}${trailing}`;
  } catch {
    return line;
  }
}

async function bridgedMcp(request: Request): Promise<Response> {
  // ── inbound: WIRE → SDK ───────────────────────────────────
  const headers = new Headers(request.headers);
  if (headers.get("mcp-protocol-version") === WIRE_VERSION) {
    headers.set("mcp-protocol-version", SDK_VERSION);
  }
  // Body may be empty for malformed requests; let the SDK reject those.
  const rawBody = await request.text();
  let body = rawBody;
  if (rawBody.length > 0) {
    try {
      const json = JSON.parse(rawBody);
      const meta = json?.params?._meta;
      const key = "io.modelcontextprotocol/protocolVersion";
      if (meta && typeof meta === "object" && meta[key] === WIRE_VERSION) {
        meta[key] = SDK_VERSION;
        body = JSON.stringify(json);
      }
    } catch {
      /* not JSON — pass through, SDK will reject */
    }
  }
  // Drop content-length; the runtime recomputes it from the new body.
  headers.delete("content-length");
  const inner = new Request(request.url, {
    method: request.method,
    headers,
    body: body.length > 0 ? body : undefined,
  });

  const response = await mcp(inner);

  // ── outbound: SDK → WIRE ──────────────────────────────────
  const ctype = response.headers.get("content-type") ?? "";

  if (ctype.startsWith("application/json")) {
    const text = await response.text();
    const outHeaders = new Headers(response.headers);
    outHeaders.delete("content-length");
    try {
      const rewritten = JSON.stringify(swapVersion(JSON.parse(text), SDK_VERSION, WIRE_VERSION));
      return new Response(rewritten, {
        status: response.status,
        statusText: response.statusText,
        headers: outHeaders,
      });
    } catch {
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: outHeaders,
      });
    }
  }

  if (ctype.startsWith("text/event-stream") && response.body) {
    let buffer = "";
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl + 1);
          buffer = buffer.slice(nl + 1);
          controller.enqueue(encoder.encode(rewriteSseLine(line)));
        }
      },
      flush(controller) {
        if (buffer.length > 0) controller.enqueue(encoder.encode(rewriteSseLine(buffer)));
      },
    });
    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return response;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return bridgedMcp(request);
    return new Response(landingHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

function landingHtml(): string {
  return `<!doctype html>
<html><body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
  <div style="text-align:center;max-width:560px">
    <h1>mcpjam-stateless</h1>
    <p>Stateless MCP server (2026-07-28 RC). POST JSON-RPC to <code>/mcp</code>.</p>
    <p>Try: <code>server/discover</code>, <code>tools/list</code>, <code>tools/call</code>.</p>
  </div>
</body></html>`;
}
