// Tasks extension (io.modelcontextprotocol/tasks) for the stateless server.
//
// The v2 server SDK serves core 2026-07-28 only — it has no routing for the
// extension's `tasks/get` / `tasks/update` / `tasks/cancel` methods, its
// subscription filter schema strips the extension's `taskIds` member, and a
// tool callback cannot emit a JSON-RPC error (the -32003 capability gate).
// So the extension lives in a thin layer IN FRONT of `createMcpHandler`:
// the Worker fetch routes `tasks/*` (and task-aware `subscriptions/listen`)
// here and delegates everything else to the SDK untouched. The one thing the
// SDK does carry is the `CreateTaskResult` itself: its 2026 encode contract
// deliberately passes a handler-provided `resultType` through verbatim on
// `tools/call`, so the `run-task` tool returns the create-task envelope
// straight from an ordinary registered tool.
//
// Statelessness: taskIds are HMAC-signed tokens carrying the task's plan
// (scenario, delay, creation time), so the happy path — create, poll to
// terminal, survive a reconnect — is computed from the ID alone and works
// across Workers isolates with zero storage. Mutations (input answers,
// cancellation) live in a tiny per-task Durable Object so tasks/update and
// tasks/cancel are visible from every isolate — a per-isolate map is only
// the fallback when the binding is absent (plain tests) — while status
// stays a pure function of (seed, overlay, now). The signing key is
// deliberately public, like the
// requestState key: this server holds no secrets; unguessability of the
// embedded UUID still satisfies the spec's entropy requirement.

import {
  inputRequired,
  inputResponse,
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  type McpServer,
  type ServerEvent,
  type ServerEventBus,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
const PROTOCOL_VERSION = "2026-07-28";
const SERVER_INFO = { name: "mcpjam-stateless", version: "0.3.1" };

const TASK_TTL_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const NOTIFY_EVAL_MS = 500;
const KEEPALIVE_MS = 15_000;

// Deliberately public — see module comment.
const TASK_ID_KEY = "mcpjam-stateless-task-key-not-a-secret-0123456789";

// ── Task identity: HMAC-signed self-describing IDs ──────────

export type TaskScenario =
  | "complete" // working → completed (CallToolResult)
  | "tool-error" // working → completed with isError: true (NOT `failed` — spec)
  | "protocol-error" // working → failed with a JSON-RPC error object
  | "needs-input" // working → input_required → (tasks/update) → working → completed
  | "stubborn"; // like complete, but ignores tasks/cancel

interface TaskSeed {
  u: string; // uuid — entropy so IDs stay unguessable
  s: TaskScenario;
  d: number; // per-phase delay ms
  c: number; // createdAt epoch ms
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

let hmacKey: CryptoKey | undefined;
async function getKey(): Promise<CryptoKey> {
  hmacKey ??= await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TASK_ID_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return hmacKey;
}

export async function mintTaskId(scenario: TaskScenario, delayMs: number): Promise<string> {
  const seed: TaskSeed = { u: crypto.randomUUID(), s: scenario, d: delayMs, c: Date.now() };
  const payload = new TextEncoder().encode(JSON.stringify(seed));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await getKey(), payload));
  return `${b64url(payload)}.${b64url(sig)}`;
}

async function decodeTaskId(taskId: string): Promise<TaskSeed | undefined> {
  const dot = taskId.indexOf(".");
  if (dot < 0) return undefined;
  try {
    const payload = b64urlDecode(taskId.slice(0, dot));
    const sig = b64urlDecode(taskId.slice(dot + 1));
    const bufOf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
    if (!(await crypto.subtle.verify("HMAC", await getKey(), bufOf(sig), bufOf(payload)))) return undefined;
    const seed = JSON.parse(new TextDecoder().decode(payload)) as TaskSeed;
    if (typeof seed.u !== "string" || typeof seed.c !== "number") return undefined;
    return seed;
  } catch {
    return undefined;
  }
}

// ── Mutation overlay (Durable Object–backed) ────────────────
// Status stays derivable from the signed ID alone; only the two mutating
// verbs need shared state. Each taskId maps to its own DO, which holds one
// tiny record and deletes itself via alarm after the task's TTL.

interface TaskOverlay {
  answeredName?: string; // needs-input: accepted elicitation answer
  declined?: boolean; // needs-input: user declined/cancelled the elicitation
  resumedAtMs?: number; // needs-input: when the answer arrived (phase-2 clock)
  cancelRequestedAtMs?: number;
}

export interface TasksEnv {
  TASK_OVERLAYS?: DurableObjectNamespace;
}

// First answer wins, first cancel wins — later patches to the same field
// are ignored, so racing updates cannot rewind an already-resumed task.
function mergeOverlay(current: TaskOverlay, patch: TaskOverlay): TaskOverlay {
  if (patch.resumedAtMs !== undefined && current.resumedAtMs === undefined) {
    current.answeredName = patch.answeredName;
    current.declined = patch.declined;
    current.resumedAtMs = patch.resumedAtMs;
  }
  if (patch.cancelRequestedAtMs !== undefined && current.cancelRequestedAtMs === undefined) {
    current.cancelRequestedAtMs = patch.cancelRequestedAtMs;
  }
  return current;
}

export class TaskOverlays {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const current = ((await this.state.storage.get("overlay")) as TaskOverlay | undefined) ?? {};
    if (request.method === "POST") {
      mergeOverlay(current, (await request.json()) as TaskOverlay);
      await this.state.storage.put("overlay", current);
      // Self-destruct once the task's TTL has certainly elapsed.
      await this.state.storage.setAlarm(Date.now() + TASK_TTL_MS);
    }
    return Response.json(current);
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

// Fallback for environments without the binding (plain unit tests).
const localOverlays = new Map<string, TaskOverlay>();

async function getOverlay(env: TasksEnv | undefined, taskId: string): Promise<TaskOverlay> {
  const ns = env?.TASK_OVERLAYS;
  if (!ns) return localOverlays.get(taskId) ?? {};
  const stub = ns.get(ns.idFromName(taskId));
  return (await (await stub.fetch("https://task-overlays/")).json()) as TaskOverlay;
}

async function patchOverlay(env: TasksEnv | undefined, taskId: string, patch: TaskOverlay): Promise<void> {
  const ns = env?.TASK_OVERLAYS;
  if (!ns) {
    const current = localOverlays.get(taskId) ?? {};
    localOverlays.set(taskId, mergeOverlay(current, patch));
    if (localOverlays.size > 10_000) localOverlays.clear();
    return;
  }
  const stub = ns.get(ns.idFromName(taskId));
  await stub.fetch("https://task-overlays/", { method: "POST", body: JSON.stringify(patch) });
}

// ── Lazy task evaluation ────────────────────────────────────
// Status is a pure function of (seed, overlay, now) — no timers, so a poll
// landing on a cold isolate still resolves the whole non-interactive flow.

export interface DetailedTask {
  taskId: string;
  status: "working" | "input_required" | "completed" | "cancelled" | "failed";
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  inputRequests?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

type Evaluation = { ok: true; task: DetailedTask } | { ok: false; reason: "not-found" | "expired" };

const iso = (ms: number) => new Date(ms).toISOString();

const NAME_ELICITATION = {
  method: "elicitation/create",
  params: {
    mode: "form",
    message: "The task needs your name to finish.",
    requestedSchema: {
      type: "object",
      properties: { name: { type: "string", title: "Your name" } },
      required: ["name"],
    },
  },
};

export async function evaluateTask(taskId: string, o: TaskOverlay, now = Date.now()): Promise<Evaluation> {
  const seed = await decodeTaskId(taskId);
  if (!seed) return { ok: false, reason: "not-found" };
  if (now > seed.c + TASK_TTL_MS) return { ok: false, reason: "expired" };

  const base = {
    taskId,
    createdAt: iso(seed.c),
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
  const at = (ms: number, rest: Omit<DetailedTask, keyof typeof base | "lastUpdatedAt">): DetailedTask => ({
    ...base,
    lastUpdatedAt: iso(ms),
    ...rest,
  });

  // When does (or did) the underlying work finish, ignoring cancellation?
  // needs-input never finishes until the elicitation is answered.
  let finishAt: number | undefined;
  if (seed.s === "needs-input") {
    if (o.declined) finishAt = o.resumedAtMs;
    else if (o.resumedAtMs !== undefined) finishAt = o.resumedAtMs + seed.d;
  } else {
    finishAt = seed.c + seed.d;
  }

  // Cooperative cancellation: honored unless the work already finished (the
  // spec's "MAY reach a terminal status other than cancelled") or the
  // scenario is `stubborn` (a server is never obligated to stop the work).
  const cancelled =
    o.cancelRequestedAtMs !== undefined &&
    seed.s !== "stubborn" &&
    (finishAt === undefined || o.cancelRequestedAtMs < finishAt);
  if (cancelled) {
    return {
      ok: true,
      task: at(o.cancelRequestedAtMs!, {
        status: "cancelled",
        statusMessage: "Cancelled on request before the work finished.",
      }),
    };
  }

  if (finishAt === undefined || now < finishAt) {
    if (seed.s === "needs-input" && o.resumedAtMs === undefined && now >= seed.c + seed.d) {
      return {
        ok: true,
        task: at(seed.c + seed.d, {
          status: "input_required",
          statusMessage: "Blocked on the client answering the elicitation.",
          inputRequests: { name: NAME_ELICITATION },
        }),
      };
    }
    const ignored = seed.s === "stubborn" && o.cancelRequestedAtMs !== undefined;
    return {
      ok: true,
      task: at(o.resumedAtMs ?? seed.c, {
        status: "working",
        statusMessage: ignored
          ? "Cancellation acknowledged and deliberately ignored (stubborn scenario)."
          : o.resumedAtMs !== undefined
            ? "Input received; finishing up."
            : `Simulated work in progress (${seed.d}ms per phase).`,
      }),
    };
  }

  // Terminal.
  switch (seed.s) {
    case "protocol-error":
      return {
        ok: true,
        task: at(finishAt, {
          status: "failed",
          statusMessage: "The underlying tools/call hit a JSON-RPC error.",
          error: { code: -32603, message: "Deliberate task execution failure (protocol-error scenario)" },
        }),
      };
    case "tool-error":
      // Tool-level errors are COMPLETED tasks whose result has isError: true.
      return {
        ok: true,
        task: at(finishAt, {
          status: "completed",
          statusMessage: "Tool finished with isError: true (still `completed` per spec).",
          result: {
            content: [{ type: "text", text: "Deliberate tool error from a task (tool-error scenario)" }],
            isError: true,
          },
        }),
      };
    case "needs-input":
      if (o.declined) {
        return {
          ok: true,
          task: at(finishAt, {
            status: "completed",
            statusMessage: "Elicitation was declined; the tool reported it as a tool error.",
            result: {
              content: [{ type: "text", text: "Task input was declined — nothing to do." }],
              isError: true,
            },
          }),
        };
      }
      return {
        ok: true,
        task: at(finishAt, {
          status: "completed",
          result: {
            content: [{ type: "text", text: `Hello, ${o.answeredName ?? "stranger"} — your task is done!` }],
            isError: false,
          },
        }),
      };
    default:
      return {
        ok: true,
        task: at(finishAt, {
          status: "completed",
          result: {
            content: [{ type: "text", text: `Task finished after ${seed.d}ms of simulated work.` }],
            isError: false,
          },
        }),
      };
  }
}

// ── JSON-RPC plumbing for the intercepted methods ───────────

type Json = Record<string, unknown>;

const rpcResult = (id: unknown, result: Json, status = 200): Response =>
  Response.json(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      result: { resultType: "complete", ...result, _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO, ...(result._meta as Json | undefined) } },
    },
    { status },
  );

const rpcError = (id: unknown, code: number, message: string, status = 200, data?: Json): Response =>
  Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } },
    { status },
  );

const MISSING_TASKS_CAPABILITY = {
  requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } },
};

export function tasksCapabilityDeclared(meta: unknown): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  const caps = (meta as Json)[CLIENT_CAPABILITIES_META_KEY];
  if (typeof caps !== "object" || caps === null) return false;
  const ext = (caps as Json).extensions;
  return typeof ext === "object" && ext !== null && TASKS_EXTENSION_ID in (ext as Json);
}

/** Envelope + SEP-2243 header checks shared by the intercepted methods.
 *  Returns an error Response, or undefined when the request is well-formed. */
function checkEnvelopeAndHeaders(
  request: Request,
  body: Json,
  expectedName: string | undefined,
): Response | undefined {
  const id = body.id;
  const params = (body.params ?? {}) as Json;
  const meta = params._meta as Json | undefined;

  const headerMethod = request.headers.get("Mcp-Method");
  if (headerMethod !== body.method) {
    return rpcError(id, -32020, `Mcp-Method header ${headerMethod === null ? "is absent" : `'${headerMethod}' disagrees with body method '${body.method}'`}`, 400);
  }
  // The extension's routing-header rule: Mcp-Name MUST carry params.taskId.
  if (expectedName !== undefined) {
    const headerName = request.headers.get("Mcp-Name");
    if (headerName !== expectedName) {
      return rpcError(id, -32020, `Mcp-Name header ${headerName === null ? "is absent" : "disagrees with params"} — it must carry '${expectedName}'`, 400);
    }
  }
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  const bodyVersion = meta?.[PROTOCOL_VERSION_META_KEY];
  if (headerVersion !== null && headerVersion !== bodyVersion) {
    return rpcError(id, -32020, "MCP-Protocol-Version header disagrees with the _meta envelope", 400);
  }
  if (bodyVersion === undefined) {
    return rpcError(id, -32602, `Invalid params: _meta['${PROTOCOL_VERSION_META_KEY}'] is required on every request`);
  }
  if (bodyVersion !== PROTOCOL_VERSION) {
    return rpcError(id, -32022, `Unsupported protocol version: ${String(bodyVersion)}`, 400);
  }
  if (!tasksCapabilityDeclared(meta)) {
    return rpcError(id, -32003, "Missing required client capability: the tasks extension must be declared per request", 200, MISSING_TASKS_CAPABILITY);
  }
  return undefined;
}

/** Handle tasks/get, tasks/update, tasks/cancel. */
export async function handleTasksMethod(request: Request, body: Json, env?: TasksEnv): Promise<Response> {
  const id = body.id;
  const method = body.method as string;
  const params = (body.params ?? {}) as Json;
  const taskId = params.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return rpcError(id, -32602, "Invalid params: 'taskId' is required");
  }
  const bad = checkEnvelopeAndHeaders(request, body, taskId);
  if (bad) return bad;

  const evaluation = await evaluateTask(taskId, await getOverlay(env, taskId));
  if (!evaluation.ok) {
    const detail = evaluation.reason === "expired" ? "Task has expired" : "Task not found";
    return rpcError(id, -32602, `Failed to retrieve task: ${detail}`);
  }

  switch (method) {
    case "tasks/get":
      return rpcResult(id, evaluation.task as unknown as Json);

    case "tasks/update": {
      const responses = params.inputResponses;
      if (typeof responses !== "object" || responses === null) {
        return rpcError(id, -32602, "Invalid params: 'inputResponses' is required");
      }
      // Only the `name` key is ever outstanding (needs-input scenario); all
      // other keys are ignored per spec. Only act while it IS outstanding.
      if (evaluation.task.status === "input_required" && "name" in (responses as Json)) {
        const answer = (responses as Json).name as Json;
        const patch: TaskOverlay = { resumedAtMs: Date.now() };
        if (answer?.action === "accept") {
          const content = answer.content as Json | undefined;
          patch.answeredName = typeof content?.name === "string" ? (content.name as string) : undefined;
        } else {
          patch.declined = true;
        }
        await patchOverlay(env, taskId, patch);
      }
      return rpcResult(id, {}); // empty, eventually-consistent ack
    }

    case "tasks/cancel": {
      await patchOverlay(env, taskId, { cancelRequestedAtMs: Date.now() });
      return rpcResult(id, {}); // ack only — cancellation is cooperative
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`, 404);
  }
}

// ── Task-aware subscriptions/listen ─────────────────────────
// Served here only when the filter contains `taskIds` (the SDK's filter
// schema would silently strip it). Mirrors the SDK stream shape: ack-first
// with the honored filter stamped with the subscription id, `event: message`
// SSE frames, keepalive comments. Core change-event kinds are bridged from
// the same bus the SDK's own listen streams use, so mixed filters behave
// identically on either path.

function coreEventNotification(event: ServerEvent): { method: string; params?: Json } | undefined {
  switch (event.kind) {
    case "tools_list_changed":
      return { method: "notifications/tools/list_changed" };
    case "prompts_list_changed":
      return { method: "notifications/prompts/list_changed" };
    case "resources_list_changed":
      return { method: "notifications/resources/list_changed" };
    case "resource_updated":
      return { method: "notifications/resources/updated", params: { uri: event.uri } };
    default:
      return undefined;
  }
}

export async function handleTaskListen(request: Request, body: Json, bus: ServerEventBus, env?: TasksEnv): Promise<Response> {
  const id = body.id;
  const params = (body.params ?? {}) as Json;
  const filter = (params.notifications ?? {}) as Json;

  if (!request.headers.get("accept")?.includes("text/event-stream")) {
    return rpcError(id, -32000, "Not Acceptable: Client must accept text/event-stream", 406);
  }
  const bad = checkEnvelopeAndHeaders(request, body, undefined);
  if (bad) return bad;

  // Honored subset: requested taskIds intersected with tasks that actually
  // resolve (a server only agrees to IDs it can report on), plus the core
  // kinds this server always honors.
  const requestedIds = Array.isArray(filter.taskIds) ? (filter.taskIds as string[]) : [];
  const agreedIds: string[] = [];
  for (const taskId of requestedIds) {
    if (typeof taskId === "string" && (await evaluateTask(taskId, await getOverlay(env, taskId))).ok) {
      agreedIds.push(taskId);
    }
  }
  const honored: Json = {};
  if (filter.toolsListChanged === true) honored.toolsListChanged = true;
  if (filter.promptsListChanged === true) honored.promptsListChanged = true;
  if (filter.resourcesListChanged === true) honored.resourcesListChanged = true;
  if (Array.isArray(filter.resourceSubscriptions) && filter.resourceSubscriptions.length > 0) {
    honored.resourceSubscriptions = [...(filter.resourceSubscriptions as string[])];
  }
  if (agreedIds.length > 0) honored.taskIds = agreedIds;

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  const timers: ReturnType<typeof setInterval>[] = [];

  const stream = new ReadableStream({
    start(controller) {
      const write = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          closed = true;
        }
      };
      const notify = (method: string, extraParams?: Json) =>
        write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            method,
            params: { ...extraParams, _meta: { [SUBSCRIPTION_ID_META_KEY]: id } },
          })}\n\n`,
        );

      // Ack first, before any notification.
      notify("notifications/subscriptions/acknowledged", { notifications: honored });

      // Core kinds, bridged from the shared bus with the same filter rules.
      unsubscribe = bus.subscribe((event) => {
        const note = coreEventNotification(event);
        if (!note) return;
        const accepts =
          (event.kind === "tools_list_changed" && honored.toolsListChanged === true) ||
          (event.kind === "prompts_list_changed" && honored.promptsListChanged === true) ||
          (event.kind === "resources_list_changed" && honored.resourcesListChanged === true) ||
          (event.kind === "resource_updated" &&
            Array.isArray(honored.resourceSubscriptions) &&
            (honored.resourceSubscriptions as string[]).includes(event.uri));
        if (accepts) notify(note.method, note.params);
      });

      // Task transitions: the engine is lazy, so watch for status changes.
      // Only intersection-agreed IDs are ever pushed (never unrequested tasks).
      const lastStatus = new Map<string, string>();
      const watching = new Set(agreedIds);
      if (watching.size > 0) {
        timers.push(
          setInterval(async () => {
            for (const taskId of [...watching]) {
              const evaln = await evaluateTask(taskId, await getOverlay(env, taskId));
              if (!evaln.ok) {
                watching.delete(taskId);
                continue;
              }
              const prev = lastStatus.get(taskId);
              if (prev !== evaln.task.status) {
                lastStatus.set(taskId, evaln.task.status);
                // Push only CHANGES observed while listening (the initial
                // status was already visible to the client via tasks/get).
                if (prev !== undefined) notify("notifications/tasks", evaln.task as unknown as Json);
                if (["completed", "failed", "cancelled"].includes(evaln.task.status)) watching.delete(taskId);
              }
            }
          }, NOTIFY_EVAL_MS),
        );
      }
      timers.push(setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS));
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      for (const t of timers) clearInterval(t);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ── The task-creating tool ──────────────────────────────────
// Registered through the SDK like any other tool; the callback returns a
// CreateTaskResult (resultType: "task"), which the 2026 encode contract
// forwards verbatim on tools/call. The -32003 gate for clients that did NOT
// declare the extension lives in the fetch interception layer (a tool
// callback cannot emit a JSON-RPC error) — by the time this callback runs,
// the capability is known to be declared.
export function registerRunTaskTool(server: McpServer): void {
  server.registerTool(
    "run-task",
    {
      title: "Run an asynchronous task",
      description:
        "Returns a CreateTaskResult (tasks extension) instead of a normal result — poll tasks/get to a terminal status. " +
        "Scenarios: complete, tool-error (completed + isError), protocol-error (failed), " +
        "needs-input (input_required → answer via tasks/update), stubborn (ignores tasks/cancel). " +
        "confirm=true adds a synchronous MRTR elicitation BEFORE the task is created. " +
        "Requires the io.modelcontextprotocol/tasks extension capability (else -32003).",
      inputSchema: z.object({
        scenario: z
          .enum(["complete", "tool-error", "protocol-error", "needs-input", "stubborn"])
          .default("complete"),
        delayMs: z.number().int().min(0).max(60_000).default(5_000).meta({
          description: "Simulated work duration per phase.",
        }),
        confirm: z.boolean().default(false).meta({
          description: "Elicit a confirmation via MRTR before creating the task (spec: MRTR resolves synchronously, then CreateTaskResult).",
        }),
      }),
    },
    async ({ scenario, delayMs, confirm }, ctx) => {
      if (confirm) {
        const view = inputResponse(ctx.mcpReq.inputResponses, "go");
        if (view.kind === "missing") {
          return inputRequired({
            inputRequests: {
              go: inputRequired.elicit({
                message: `Start the '${scenario}' task (${delayMs}ms per phase)?`,
                requestedSchema: {
                  type: "object",
                  properties: { go: { type: "boolean", title: "Start the task" } },
                  required: ["go"],
                },
              }),
            },
          });
        }
        const answer = acceptedContent<{ go?: boolean }>(ctx.mcpReq.inputResponses, "go");
        if (view.kind !== "elicit" || view.action !== "accept" || !answer?.go) {
          return { content: [{ type: "text" as const, text: "Task not started (confirmation declined)." }] };
        }
      }
      const taskId = await mintTaskId(scenario, delayMs);
      // A just-minted task has no overlay yet — no storage read needed.
      const seed = (await evaluateTask(taskId, {})) as { ok: true; task: DetailedTask };
      // The spec requires the task be durably resolvable BEFORE this result
      // is returned — trivially true here: the signed ID is self-describing.
      const createTaskResult = {
        resultType: "task",
        ...seed.task,
      };
      return createTaskResult as never;
    },
  );
}
