// Stateless MCP server (2026-07-28) on Cloudflare Workers.
//
// What "stateless" means here, per the spec:
//   * No `initialize` handshake. Each request carries its own
//     `_meta.io.modelcontextprotocol/protocolVersion`, `clientInfo`,
//     and `clientCapabilities` — the server treats every request as
//     standalone, even when delivered over the same TCP connection.
//   * `createMcpHandler(factory)` builds a fresh server instance per
//     request; there is no Durable Object, no per-session state.
//   * `server/discover` replaces `initialize` for version negotiation.
//   * Server→client interactions (sampling/elicitation/listRoots) are not
//     pushed as separate requests. Handlers return `inputRequired(...)`;
//     the client satisfies the embedded requests and replays the call with
//     the responses attached (SEP-2322 MRTR), readable via
//     `ctx.mcpReq.inputResponses`.
//   * Request-scoped notifications are delivered on the request's response
//     stream when the client asks for SSE.
//
// Run locally:  npm run dev    (Wrangler binds to http://127.0.0.1:8787/mcp)

import {
  acceptedContent,
  createMcpHandler,
  hostHeaderValidationResponse,
  inputRequired,
  inputResponse,
  McpServer,
  preloadSchemas,
} from "@modelcontextprotocol/server";
import { z } from "zod";

// Workers bill per-request CPU but not module evaluation — build the wire
// schemas once at isolate warm-up instead of inside the first request.
preloadSchemas();

const LIST_RESULT_TTL_MS = 300_000;

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "mcpjam-stateless", version: "0.1.0" },
    {
      capabilities: {
        tools: { listChanged: false },
        logging: {},
      },
      // SEP-2549 CacheableResult: the SDK emits the conservative
      // `ttlMs: 0` / `cacheScope: "private"` unless hinted. "public" is safe
      // while this server returns the same tool set to every caller; switch
      // to "private" the moment any listed item depends on the request's
      // authorization — otherwise a shared cache (proxy, CDN, multi-tenant
      // gateway) could serve user A's view to user B.
      cacheHints: {
        "tools/list": { ttlMs: LIST_RESULT_TTL_MS, cacheScope: "public" },
        "server/discover": { ttlMs: LIST_RESULT_TTL_MS, cacheScope: "public" },
      },
    },
  );

  // ── echo ────────────────────────────────────────────────────
  // Minimal happy path: validates inputSchema, emits a log notification
  // (only delivered if the request's `_meta.logLevel` opted in to `info`
  // or finer — stateless logging is per-request, not connection-wide).
  server.registerTool(
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
  // HeaderMismatch.
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
  // Server→client elicitation under stateless transport (MRTR). Round 1:
  // the handler returns `inputRequired(...)`, which the dispatcher puts on
  // the wire as an InputRequiredResult. Round 2: the client replays the
  // call with the user's answer in `inputResponses`, and the handler runs
  // again from the top with the response available.
  //
  // If the client did not declare `clientCapabilities.elicitation.form`,
  // the SDK rejects the inputRequired return with
  // MissingRequiredClientCapability — verifiable by omitting that
  // capability from `_meta.clientCapabilities`.
  server.registerTool(
    "ask-name",
    {
      title: "Ask the user's name",
      description: "Elicits a name from the user, then greets them.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const view = inputResponse(ctx.mcpReq.inputResponses, "name");
      if (view.kind === "missing") {
        return inputRequired({
          inputRequests: {
            name: inputRequired.elicit({
              message: "What's your name?",
              requestedSchema: {
                type: "object",
                properties: { name: { type: "string", title: "Your name" } },
                required: ["name"],
              },
            }),
          },
        });
      }
      if (view.kind !== "elicit" || view.action !== "accept") {
        const action = view.kind === "elicit" ? view.action : "invalid";
        return {
          content: [{ type: "text" as const, text: `Elicitation ${action}.` }],
        };
      }
      const answer = acceptedContent<{ name?: string }>(
        ctx.mcpReq.inputResponses,
        "name",
      );
      const name = answer?.name ?? "stranger";
      return {
        content: [{ type: "text" as const, text: `Hello, ${name}!` }],
        structuredContent: { name },
      };
    },
  );

  // ── summarize ───────────────────────────────────────────────
  // Sampling via MRTR: same two-round shape as ask-name, but the embedded
  // request is `sampling/createMessage`, so the client answers with its
  // LLM's completion. Requires `_meta.clientCapabilities.sampling`.
  server.registerTool(
    "summarize",
    {
      title: "Summarize text",
      description: "Asks the client's LLM to summarize the given text.",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }, ctx) => {
      const view = inputResponse(ctx.mcpReq.inputResponses, "summary");
      if (view.kind === "missing") {
        return inputRequired({
          inputRequests: {
            summary: inputRequired.createMessage({
              maxTokens: 256,
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: `Summarize in one sentence:\n\n${text}`,
                  },
                },
              ],
            }),
          },
        });
      }
      if (view.kind !== "sampling") {
        return {
          content: [
            { type: "text" as const, text: "Invalid sampling response." },
          ],
          isError: true,
        };
      }
      const block = Array.isArray(view.result.content)
        ? view.result.content[0]
        : view.result.content;
      const out =
        block?.type === "text" ? block.text : "(non-text result)";
      return {
        content: [{ type: "text" as const, text: out }],
        structuredContent: { summary: out },
      };
    },
  );

  return server;
}

// ── Worker entry ────────────────────────────────────────────
// `createMcpHandler` is the 2026-07-28 stateless HTTP entry. It enforces:
//   * POST-only for modern traffic (GET/DELETE → 405)
//   * Content-Type: application/json (CSRF barrier)
//   * Per-request _meta envelope validation
//   * Standard request headers (SEP-2243): MCP-Protocol-Version, Mcp-Method,
//     Mcp-Name and Mcp-Param-* presence + header↔body parity (HeaderMismatch)
//   * SEP-2549 cache fields (ttlMs/cacheScope) on cacheable results
//   * Status code mapping (404 unknown method, 400 invalid params, …)
//
// `legacy: "reject"` makes the endpoint modern-only: 2025-era requests
// (including `initialize`) get the unsupported-protocol-version error
// instead of the legacy stateless fallback.
const mcp = createMcpHandler(() => buildServer(), { legacy: "reject" });

// DNS-rebinding guard. Accepts local dev hosts plus the deployed worker
// hostname. Tighten if you bind a custom domain.
const ALLOWED_HOSTS = [
  "127.0.0.1",
  "localhost",
  "[::1]",
  "mcpjam-stateless.marcelo-1cb.workers.dev",
  "stateless.mcpjam.com",
];

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") {
      return new Response(landingHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const rejected = hostHeaderValidationResponse(request, ALLOWED_HOSTS);
    if (rejected) return rejected;
    return mcp.fetch(request);
  },
};

function landingHtml(): string {
  return `<!doctype html>
<html><body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
  <div style="text-align:center;max-width:560px">
    <h1>mcpjam-stateless</h1>
    <p>Stateless MCP server (2026-07-28). POST JSON-RPC to <code>/mcp</code>.</p>
    <p>Try: <code>server/discover</code>, <code>tools/list</code>, <code>tools/call</code>.</p>
  </div>
</body></html>`;
}
