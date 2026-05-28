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
//   * Request-scoped notifications are delivered on the request's response
//     stream when the client asks for SSE.
//
// Run locally:  pnpm dev    (Wrangler binds to http://127.0.0.1:8787/mcp)

import { handleHttp, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const server = new McpServer(
  { name: "mcpjam-stateless", version: "0.1.0" },
  {
    capabilities: {
      tools: { listChanged: false },
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

// ── Worker entry ────────────────────────────────────────────
// `handleHttp` is the 2026-06 stateless Fetch entry. It enforces:
//   * POST-only (GET/DELETE → 405)
//   * Content-Type: application/json (CSRF barrier → 415 otherwise)
//   * Per-request _meta validation
//   * MCP-Protocol-Version header ↔ body parity (HeaderMismatch -32001)
//   * Status code mapping (404 for unknown method, 400 for invalid params,
//     500 for internal errors, 200 for normal results).
const MAX_BODY_BYTES = 1 * 1024 * 1024;

const mcp = handleHttp(server.server, {
  // DNS-rebinding guard. Accepts local dev hosts plus the deployed worker
  // hostname. Tighten if you bind a custom domain.
  allowedHosts: [
    "127.0.0.1",
    "localhost",
    "[::1]",
    "mcpjam-stateless.marcelo-1cb.workers.dev",
    "stateless.mcpjam.com",
  ],
  maxBodyBytes: MAX_BODY_BYTES,
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
const VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const JSONRPC_VERSION = "2.0";
const HEADER_MISMATCH = -32001;
const UNSUPPORTED_PROTOCOL_VERSION = -32004;
const LIST_RESULT_TTL_MS = 300_000;
// SEP-2549 CacheableResult fields the SDK doesn't emit yet. ttlMs/cacheScope
// are REQUIRED on every result that extends CacheableResult; we detect those
// results by the array field they carry.
const CACHEABLE_RESULT_ARRAY_FIELDS = [
  "tools", // ListToolsResult
  "prompts", // ListPromptsResult
  "resources", // ListResourcesResult
  "resourceTemplates", // ListResourceTemplatesResult
  "contents", // ReadResourceResult
] as const;
// "public" matches the spec's tools-list example and is safe while this server
// returns the same tool set to every caller. Switch to "private" the moment any
// listed item depends on the request's authorization — otherwise a shared cache
// (proxy, CDN, multi-tenant gateway) could serve user A's view to user B.
const DEFAULT_CACHE_SCOPE = "public";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestId(message: unknown): unknown {
  return isObject(message) && "id" in message ? message.id : null;
}

function errorResponse(status: number, id: unknown, code: number, message: string, data?: unknown): Response {
  return Response.json(
    {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    },
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function unsupportedVersionResponse(id: unknown, requested: string): Response {
  return errorResponse(400, id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
    supported: [WIRE_VERSION],
    requested,
  });
}

function metaVersion(message: unknown): string | undefined {
  if (!isObject(message)) return undefined;
  const params = message.params;
  if (!isObject(params)) return undefined;
  const meta = params._meta;
  if (!isObject(meta)) return undefined;
  const version = meta[VERSION_META_KEY];
  return typeof version === "string" ? version : undefined;
}

function setMetaVersion(message: unknown, version: string): void {
  if (!isObject(message)) return;
  const params = message.params;
  if (!isObject(params)) return;
  const meta = params._meta;
  if (!isObject(meta)) return;
  if (meta[VERSION_META_KEY] === WIRE_VERSION) meta[VERSION_META_KEY] = version;
}

function messagesFromBody(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [body];
}

function validateWireVersions(body: unknown, headerVersion: string | null): Response | undefined {
  for (const message of messagesFromBody(body)) {
    const id = requestId(message);
    const bodyVersion = metaVersion(message);

    if (headerVersion !== null && bodyVersion !== undefined && headerVersion !== bodyVersion) {
      return errorResponse(
        400,
        id,
        HEADER_MISMATCH,
        `MCP-Protocol-Version header does not match _meta.${VERSION_META_KEY}`,
      );
    }

    const requested = bodyVersion ?? headerVersion;
    if (requested !== undefined && requested !== null && requested !== WIRE_VERSION) {
      return unsupportedVersionResponse(id, requested);
    }
  }

  return undefined;
}

function patchWireResult(result: JsonObject): JsonObject {
  const patched: JsonObject = { ...result };

  if (Array.isArray(patched.supportedVersions)) {
    patched.supportedVersions = patched.supportedVersions.map((v) => (v === SDK_VERSION ? WIRE_VERSION : v));
    patched.resultType ??= "complete";
  }

  if (isObject(patched.capabilities) && isObject(patched.capabilities.tools)) {
    const tools = { ...patched.capabilities.tools };
    if (tools.listChanged === false) delete tools.listChanged;
    patched.capabilities = { ...patched.capabilities, tools };
  }

  if (CACHEABLE_RESULT_ARRAY_FIELDS.some((field) => Array.isArray(patched[field]))) {
    patched.ttlMs ??= LIST_RESULT_TTL_MS;
    patched.cacheScope ??= DEFAULT_CACHE_SCOPE;
  }

  return patched;
}

function patchWireError(error: JsonObject): JsonObject {
  const patched: JsonObject = { ...error };

  if (patched.message === "Unsupported protocol version" && isObject(patched.data)) {
    patched.code = UNSUPPORTED_PROTOCOL_VERSION;
    patched.data = {
      ...patched.data,
      supported: Array.isArray(patched.data.supported)
        ? patched.data.supported.map((v) => (v === SDK_VERSION ? WIRE_VERSION : v))
        : [WIRE_VERSION],
      requested: patched.data.requested === SDK_VERSION ? WIRE_VERSION : patched.data.requested,
    };
  }

  return patched;
}

function patchWireMessage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => patchWireMessage(entry));
  if (!isObject(value)) return value;

  const patched: JsonObject = { ...value };
  if (isObject(patched.result)) patched.result = patchWireResult(patched.result);
  if (isObject(patched.error)) patched.error = patchWireError(patched.error);
  return patched;
}

function stripLineEnd(line: string): string {
  return line.endsWith("\r\n") ? line.slice(0, -2) : line.endsWith("\n") ? line.slice(0, -1) : line;
}

function lineEnd(line: string): string {
  return line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "\n";
}

function rewriteSseEvent(lines: string[]): string {
  const dataLines = lines.filter((line) => stripLineEnd(line).startsWith("data:"));
  if (dataLines.length === 0) return lines.join("");

  const payload = dataLines
    .map((line) => stripLineEnd(line).slice("data:".length).replace(/^\s/, ""))
    .join("\n");
  const newline = lineEnd(dataLines[0]);

  try {
    const json = JSON.parse(payload);
    let wroteData = false;
    return lines
      .map((line) => {
        if (!stripLineEnd(line).startsWith("data:")) return line;
        if (wroteData) return "";
        wroteData = true;
        return `data: ${JSON.stringify(patchWireMessage(json))}${newline}`;
      })
      .join("");
  } catch {
    return lines.join("");
  }
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string | undefined> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

async function bridgedMcp(request: Request): Promise<Response> {
  // ── inbound: WIRE → SDK ───────────────────────────────────
  const headers = new Headers(request.headers);
  const headerVersion = headers.get("mcp-protocol-version");
  const rawBody = await readBoundedText(request, MAX_BODY_BYTES);
  if (rawBody === undefined) {
    return errorResponse(413, null, -32600, "Request body too large");
  }

  // Body may be empty for malformed requests; let the SDK reject those.
  let body = rawBody;
  if (rawBody.length > 0) {
    try {
      const json = JSON.parse(rawBody);
      const validationError = validateWireVersions(json, headerVersion);
      if (validationError) return validationError;

      for (const message of messagesFromBody(json)) setMetaVersion(message, SDK_VERSION);
      body = JSON.stringify(json);
    } catch {
      /* not JSON — pass through, SDK will reject */
    }
  }
  if (headerVersion === WIRE_VERSION) headers.set("mcp-protocol-version", SDK_VERSION);

  // Drop content-length; the runtime recomputes it from the new body.
  headers.delete("content-length");
  const inner = new Request(request.url, {
    method: request.method,
    headers,
    body: body.length > 0 ? body : undefined,
    signal: request.signal,
  });

  const response = await mcp(inner);

  // ── outbound: SDK → WIRE ──────────────────────────────────
  const ctype = response.headers.get("content-type") ?? "";

  if (ctype.startsWith("application/json")) {
    const text = await response.text();
    const outHeaders = new Headers(response.headers);
    outHeaders.delete("content-length");
    try {
      const rewritten = JSON.stringify(patchWireMessage(JSON.parse(text)));
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
    const eventLines: string[] = [];

    function drainLines(controller: TransformStreamDefaultController<Uint8Array>) {
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl + 1);
        buffer = buffer.slice(nl + 1);
        eventLines.push(line);
        if (/^\r?\n$/.test(line)) {
          controller.enqueue(encoder.encode(rewriteSseEvent(eventLines)));
          eventLines.length = 0;
        }
      }
    }

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        drainLines(controller);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.length > 0) {
          eventLines.push(buffer);
          buffer = "";
        }
        if (eventLines.length > 0) controller.enqueue(encoder.encode(rewriteSseEvent(eventLines)));
      },
    });
    // Per spec (transports.mdx, "Receiving Messages"): servers SHOULD set
    // X-Accel-Buffering: no on SSE responses to stop reverse proxies (nginx
    // et al.) from buffering events. The SDK doesn't set it, so the bridge
    // does.
    const sseHeaders = new Headers(response.headers);
    sseHeaders.set("X-Accel-Buffering", "no");
    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers: sseHeaders,
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
