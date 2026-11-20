// Per-run tool-call counter.
//
// Every endpoint can also be reached under `/runs/<run-id>/…`, where each
// `tools/call` request it receives is counted under the tool name the client
// sent — before any validation, so calls to names the server doesn't have
// (a host that mangled `dotted.tool.name` into `dotted_tool_name`, say) and
// calls the server then rejects are counted too. `GET /runs/<run-id>/calls`
// returns `{ total, byTool }`, which is what lets a QA run prove a host sent
// the server zero calls.
//
// Isolation: each run id is its own Durable Object, reached only by its
// exact name. Nothing lists runs, nothing aggregates across them, and a run
// nobody has called reads as zeros without writing anything, so a reader
// learns nothing about whether some other id exists. Run ids are chosen by
// the caller; the length floor keeps random ones unguessable.
//
// Expiry: a run's counts delete themselves RUN_TTL_MS after its most recent
// counted call (a Durable Object alarm, the same mechanism as the task
// overlays in src/tasks.ts).

export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
export const RUN_TTL_MS = 24 * 60 * 60_000;

// Bounds on what a caller can make one run store. `total` always counts;
// `byTool` itemizes only names within these limits, so `total` can exceed
// the sum of `byTool` only when a client floods a run with odd names.
export const MAX_TRACKED_TOOLS = 256;
export const MAX_TRACKED_NAME_LENGTH = 256;

/** The `GET /runs/<run-id>/calls` body. */
export interface RunCounts {
  total: number;
  byTool: Record<string, number>;
}

// Stored with a Map so any tool name a client sends, `__proto__` included,
// is an ordinary key.
interface StoredCounts {
  total: number;
  byTool: Map<string, number>;
}

export interface RunsEnv {
  RUN_CALLS?: DurableObjectNamespace;
}

export function isValidRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

export const INVALID_RUN_ID_MESSAGE =
  "Invalid run id. Use 16-64 characters from A-Z, a-z, 0-9, '-' and '_', for example a random UUID.";

/** Merge one batch of received tool names into a run's counts. */
function addCalls(counts: StoredCounts, names: (string | undefined)[]): void {
  for (const name of names) {
    counts.total += 1;
    if (name === undefined || name.length > MAX_TRACKED_NAME_LENGTH) continue;
    const seen = counts.byTool.get(name);
    if (seen !== undefined) counts.byTool.set(name, seen + 1);
    else if (counts.byTool.size < MAX_TRACKED_TOOLS) counts.byTool.set(name, 1);
  }
}

/**
 * The `tools/call` requests in a JSON-RPC body (a single message, or a
 * 2025-03-26 batch), as the tool names they name. A call without a string
 * `params.name` still counts toward `total`, so it yields `undefined`.
 */
export function toolCallNames(body: unknown): (string | undefined)[] {
  const messages = Array.isArray(body) ? body : [body];
  const names: (string | undefined)[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { method, params } = message as { method?: unknown; params?: unknown };
    if (method !== "tools/call") continue;
    const name = typeof params === "object" && params !== null ? (params as { name?: unknown }).name : undefined;
    names.push(typeof name === "string" ? name : undefined);
  }
  return names;
}

/** The tool calls in a request, read from a clone so the body stays
 *  consumable. A body that is not JSON holds none; the server rejects it. */
export async function receivedToolCalls(request: Request): Promise<(string | undefined)[]> {
  if (request.method !== "POST") return [];
  try {
    return toolCallNames(JSON.parse(await request.clone().text()));
  } catch {
    return [];
  }
}

// One instance per run id (idFromName). Stores a single record; a GET on a
// run that was never counted touches no storage and sets no alarm.
export class RunCallCounter {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const counts = ((await this.state.storage.get("counts")) as StoredCounts | undefined) ?? {
      total: 0,
      byTool: new Map<string, number>(),
    };
    if (request.method === "POST") {
      const { names } = (await request.json()) as { names: (string | null)[] };
      addCalls(counts, names.map((n) => n ?? undefined));
      await this.state.storage.put("counts", counts);
      // Sliding expiry: the run lives until it has been idle for the TTL.
      await this.state.storage.setAlarm(Date.now() + RUN_TTL_MS);
    }
    const body: RunCounts = { total: counts.total, byTool: Object.fromEntries(counts.byTool) };
    return Response.json(body);
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

function counterFor(env: RunsEnv | undefined, runId: string): DurableObjectStub | undefined {
  const ns = env?.RUN_CALLS;
  return ns?.get(ns.idFromName(runId));
}

/** Record received calls. Throws when the counter cannot be reached. */
export async function recordCalls(env: RunsEnv | undefined, runId: string, names: (string | undefined)[]): Promise<void> {
  const stub = counterFor(env, runId);
  if (!stub) throw new Error("RUN_CALLS binding is not configured");
  const response = await stub.fetch("https://run-calls/", {
    method: "POST",
    // JSON has no undefined; null marks a call without a string name.
    body: JSON.stringify({ names: names.map((n) => n ?? null) }),
  });
  if (!response.ok) throw new Error(`run counter answered ${response.status}`);
}

/** `GET /runs/<run-id>/calls` */
export async function readCalls(env: RunsEnv | undefined, runId: string): Promise<Response> {
  const stub = counterFor(env, runId);
  if (!stub) return jsonError(503, "The call counter is not available on this deployment. Try again later.");
  try {
    const counts = (await (await stub.fetch("https://run-calls/")).json()) as RunCounts;
    return Response.json(counts, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return jsonError(503, "Couldn't read the run's call counts. Try again.");
  }
}

export function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
