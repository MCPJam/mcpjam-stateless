// Shared helpers: drive the Worker's fetch handler directly, the way the
// Workers runtime would. Node's Request leaves out the Host header that
// workerd always sets, so `request()` adds it for the DNS-rebinding guard.

import worker from "../src/index";

export const ORIGIN = "https://stateless.mcpjam.com";
export const PROTOCOL_VERSION = "2026-07-28";

export const modernMeta = (clientCapabilities: Record<string, unknown> = {}) => ({
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
});

export function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("Host")) headers.set("Host", new URL(ORIGIN).host);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

let nextId = 1;

/** POST one 2026-07-28 JSON-RPC request with the standard routing headers. */
export function modernRequest(
  path: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: { name?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Mcp-Method": method,
    ...opts.headers,
  };
  if (opts.name !== undefined) headers["Mcp-Name"] = opts.name;
  return request(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: { ...params, _meta: modernMeta() } }),
  });
}

/** POST one 2025-era JSON-RPC message (no envelope, no routing headers). */
export function legacyRequest(path: string, method: string, params: Record<string, unknown> = {}): Request {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

/** Read a JSON-RPC response body, whether it came back as JSON or SSE. */
export async function rpcBody(response: Response): Promise<any> {
  const text = await response.text();
  if (!(response.headers.get("Content-Type") ?? "").includes("text/event-stream")) return JSON.parse(text);
  const messages = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
  const final = messages.find((m) => "result" in m || "error" in m);
  if (!final) throw new Error(`no JSON-RPC response in SSE body: ${text}`);
  return final;
}

export function send(req: Request, env?: unknown): Promise<Response> {
  return worker.fetch(req, env as never);
}

export async function call(req: Request, env?: unknown): Promise<{ status: number; body: any }> {
  const response = await send(req, env);
  return { status: response.status, body: await rpcBody(response) };
}

export async function listToolNames(path: string, env?: unknown): Promise<string[]> {
  const { body } = await call(modernRequest(path, "tools/list"), env);
  return body.result.tools.map((t: { name: string }) => t.name);
}

/** Open a subscriptions/listen stream for tools/list_changed and read its frames. */
export async function listen(path: string, env: unknown) {
  const response = await send(
    modernRequest(path, "subscriptions/listen", { notifications: { toolsListChanged: true } }),
    env,
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

  async function next(timeoutMs: number): Promise<any | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) return JSON.parse(data.slice("data: ".length));
        continue; // keepalive comment
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      pending ??= reader.read();
      const result = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), remaining))]);
      if (result === null) return undefined;
      pending = undefined;
      if (result.done) return undefined;
      buffer += decoder.decode(result.value, { stream: true });
    }
  }

  return { next, close: () => reader.cancel() };
}
