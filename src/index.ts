// Stateless MCP server (DRAFT-2026-v1) on Cloudflare Workers.
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
  // DNS-rebinding guard — comment out or expand for production.
  allowedHosts: ["127.0.0.1", "localhost", "[::1]"],
  maxBodyBytes: 1 * 1024 * 1024,
});

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return mcp(request);
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
    <p>Stateless MCP server (DRAFT-2026-v1). POST JSON-RPC to <code>/mcp</code>.</p>
    <p>Try: <code>server/discover</code>, <code>tools/list</code>, <code>tools/call</code>.</p>
  </div>
</body></html>`;
}
