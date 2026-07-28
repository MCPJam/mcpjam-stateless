// Stateless "everything" MCP server (2026-07-28) on Cloudflare Workers.
//
// One server exercising every 2026-07-28 feature the SDK serves, so a client
// (the MCPJam inspector, CLI, conformance runner, …) can point at a single
// endpoint and test the whole modern surface:
//
//   * server/discover, per-request `_meta` envelopes, standard headers
//     (SEP-2243), cacheable results (SEP-2549) — all SDK-enforced.
//   * Tools: happy path, `x-mcp-header` param mirroring, outputSchema +
//     structuredContent, deliberate failures, progress + log notifications
//     on the request's SSE stream, and a bus-publish trigger.
//   * MRTR (SEP-2322) from all three entry methods (tools/call, prompts/get,
//     resources/read): form + URL elicitation, sampling, roots, multi-round
//     flows with HMAC-signed `requestState`, and an infinite loop to test
//     client max-round limits.
//   * Resources: static text, binary blob, a template with list + argument
//     completion, per-resource cache hints, resource-not-found behavior.
//   * Prompts: completable arguments (completion/complete), icons.
//   * subscriptions/listen: ack-first filtered notification streams fed by
//     the `trigger-notifications` tool.
//   * Tasks extension (io.modelcontextprotocol/tasks, SEP-2663): the
//     `run-task` tool returns CreateTaskResult; tasks/get|update|cancel and
//     task-aware listen streams are served by src/tasks.ts via the
//     interception layer below.
//
// Run locally:  npm run dev    (Wrangler binds to http://127.0.0.1:8787/mcp)

import {
  acceptedContent,
  createMcpHandler,
  createRequestStateCodec,
  hostHeaderValidationResponse,
  inputRequired,
  inputResponse,
  McpServer,
  preloadSchemas,
  ResourceNotFoundError,
  ResourceTemplate,
  completable,
  type Icon,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  handleTaskListen,
  handleTasksMethod,
  registerRunTaskTool,
  tasksCapabilityDeclared,
  TASKS_EXTENSION_ID,
  type TasksEnv,
} from "./tasks";

// The per-task overlay Durable Object must be exported from the entry module.
export { TaskOverlays } from "./tasks";

// Workers bill per-request CPU but not module evaluation — build the wire
// schemas once at isolate warm-up instead of inside the first request.
preloadSchemas();

const LIST_RESULT_TTL_MS = 300_000;

// ── requestState integrity (SEP-2322 server requirement) ────
// `requestState` round-trips through the client and comes back as
// attacker-controlled input; the spec requires integrity protection when it
// influences behavior. The codec HMAC-signs (not encrypts) the payload.
// The key is deliberately public: this is a test server with no secrets to
// protect — the point is exercising the mint/verify round-trip, including
// the `-32602 Invalid or expired requestState` rejection on tampered state.
const stateCodec = createRequestStateCodec<StatePayload>({
  key: "mcpjam-stateless-demo-key-not-a-secret-0123456789",
  ttlSeconds: 600,
});

type StatePayload =
  | { tool: "confirm-launch"; step: "confirm" | "code" }
  | { tool: "open-dashboard"; nonce: string }
  | { tool: "never-satisfied"; round: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Emoji-in-SVG data URIs so list results carry `icons` without external hosts.
const emojiIcon = (emoji: string): Icon[] => [
  {
    src: `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text x="16" y="24" font-size="24" text-anchor="middle">${emoji}</text></svg>`,
    )}`,
    mimeType: "image/svg+xml",
  },
];

// 1x1 orange PNG — a real binary blob for `resources/read` blob contents.
const LOGO_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

// Files behind the demo://files/{name} resource template.
const TEMPLATE_FILES: Record<string, { text: string; mimeType: string }> = {
  "readme.md": { text: "# Demo files\n\nServed from a resource template.", mimeType: "text/markdown" },
  "spec.md": { text: "# 2026-07-28\n\nThe stateless revision.", mimeType: "text/markdown" },
  "notes.txt": { text: "Plain text file for mimeType variety.", mimeType: "text/plain" },
};

const PROMPT_LANGUAGES = ["typescript", "python", "rust", "go", "swift", "kotlin"];

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "mcpjam-stateless", version: "0.3.1" },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        completions: {},
        logging: {}, // deprecated (SEP-2577) but functional — kept on purpose so clients can test the deprecation path
        // Tasks extension (SEP-2663) — served by the interception layer in
        // src/tasks.ts, advertised here so server/discover reflects it.
        extensions: { [TASKS_EXTENSION_ID]: {} },
      },
      instructions:
        "Reference 'everything' server for the 2026-07-28 stateless revision. " +
        "Every tool/prompt/resource demonstrates one protocol feature; call " +
        "them in any order — nothing here has real side effects.",
      // SEP-2549 CacheableResult: "public" is safe while this server returns
      // the same catalog to every caller; switch to "private" the moment any
      // listed item depends on the request's authorization — otherwise a
      // shared cache could serve user A's view to user B.
      cacheHints: {
        "server/discover": { ttlMs: LIST_RESULT_TTL_MS, cacheScope: "public" },
        "tools/list": { ttlMs: LIST_RESULT_TTL_MS, cacheScope: "public" },
        "prompts/list": { ttlMs: LIST_RESULT_TTL_MS, cacheScope: "public" },
        "resources/list": { ttlMs: LIST_RESULT_TTL_MS, cacheScope: "public" },
        "resources/templates/list": { ttlMs: LIST_RESULT_TTL_MS, cacheScope: "public" },
        // Per-resource cacheHint on individual resources overrides this,
        // field by field (see demo://counter).
        "resources/read": { ttlMs: 60_000, cacheScope: "private" },
      },
      requestState: { verify: (state, ctx) => stateCodec.verify(state, ctx) },
    },
  );

  registerTools(server);
  registerRunTaskTool(server);
  registerResources(server);
  registerPrompts(server);
  return server;
}

// ════════════════════════════════════════════════════════════
// Tools
// ════════════════════════════════════════════════════════════

function registerTools(server: McpServer): void {
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
  // Demonstrates `x-mcp-header` (SEP-2243): the `region` parameter is
  // mirrored into an `Mcp-Param-Region` header by conforming clients, so a
  // load balancer can route without parsing the body. The SDK validates
  // header↔body agreement and rejects mismatches with HeaderMismatch.
  server.registerTool(
    "execute-sql",
    {
      title: "Execute SQL",
      description: "Run a SQL query against a regional database.",
      inputSchema: z.object({
        region: z.string().meta({
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
        content: [{ type: "text" as const, text: `(stub) executed in ${region}: ${query}` }],
        structuredContent: { region, rowCount: 0 },
      };
    },
  );

  // ── get-weather ─────────────────────────────────────────────
  // Declares an `outputSchema`, so clients can test structured-output
  // validation of `structuredContent` against the advertised schema.
  server.registerTool(
    "get-weather",
    {
      title: "Get weather",
      description: "Deterministic fake weather — exercises outputSchema validation.",
      icons: emojiIcon("⛅"),
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({
        city: z.string(),
        temperatureC: z.number(),
        conditions: z.enum(["sunny", "cloudy", "rainy"]),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ city }) => {
      // Deterministic per city so tests are repeatable.
      const hash = [...city].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 97, 7);
      const output = {
        city,
        temperatureC: (hash % 35) - 5,
        conditions: (["sunny", "cloudy", "rainy"] as const)[hash % 3],
      };
      return {
        content: [{ type: "text" as const, text: `${output.temperatureC}°C and ${output.conditions} in ${city}` }],
        structuredContent: output,
      };
    },
  );

  // ── long-task ───────────────────────────────────────────────
  // Streams `notifications/progress` (when the request carries a
  // `_meta.progressToken`) and log messages on the request's SSE stream
  // while it runs — the request-scoped notification path. Honors
  // cancellation via the request's abort signal.
  server.registerTool(
    "long-task",
    {
      title: "Long-running task",
      description:
        "Runs N steps with a delay, emitting progress + log notifications on the response stream. Send `_meta.progressToken` to receive progress.",
      inputSchema: z.object({
        steps: z.number().int().min(1).max(10).default(5),
        delayMs: z.number().int().min(0).max(2000).default(300),
      }),
    },
    async ({ steps, delayMs }, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      for (let i = 1; i <= steps; i++) {
        if (ctx.mcpReq.signal.aborted) {
          return { content: [{ type: "text" as const, text: `cancelled at step ${i}/${steps}` }] };
        }
        await sleep(delayMs);
        await ctx.mcpReq.log("info", `step ${i}/${steps} done`);
        if (progressToken !== undefined) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken, progress: i, total: steps, message: `step ${i}/${steps}` },
          });
        }
      }
      return {
        content: [{ type: "text" as const, text: `completed ${steps} steps` }],
        structuredContent: { steps, delayMs },
      };
    },
  );

  // ── fail ────────────────────────────────────────────────────
  // Distinguishes the two tool-failure shapes: a well-formed result with
  // `isError: true` versus a handler throw (which the SDK converts into an
  // isError result carrying the message).
  server.registerTool(
    "fail",
    {
      title: "Fail on purpose",
      description: "mode=result returns isError:true; mode=throw throws from the handler.",
      inputSchema: z.object({ mode: z.enum(["result", "throw"]) }),
    },
    async ({ mode }) => {
      if (mode === "throw") throw new Error("deliberate handler throw");
      return {
        content: [{ type: "text" as const, text: "deliberate tool error result" }],
        isError: true,
      };
    },
  );

  // ── ask-name ────────────────────────────────────────────────
  // Single-round form elicitation via MRTR (SEP-2322). Round 1 returns
  // `inputRequired(...)`; round 2 re-enters the handler with the answer in
  // `inputResponses`. Requires `clientCapabilities.elicitation.form` —
  // omit it to test `-32021 MissingRequiredClientCapability`.
  server.registerTool(
    "ask-name",
    {
      title: "Ask the user's name",
      description: "Elicits a name from the user (form mode), then greets them.",
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
        return { content: [{ type: "text" as const, text: `Elicitation ${action}.` }] };
      }
      const answer = acceptedContent<{ name?: string }>(ctx.mcpReq.inputResponses, "name");
      const name = answer?.name ?? "stranger";
      return {
        content: [{ type: "text" as const, text: `Hello, ${name}!` }],
        structuredContent: { name },
      };
    },
  );

  // ── confirm-launch ──────────────────────────────────────────
  // Multi-round MRTR: two sequential elicitation rounds correlated by
  // HMAC-signed `requestState`. Verifies per-round response REPLACEMENT
  // (round 3 carries only the round-2 answer) and lets clients test the
  // `-32602 Invalid or expired requestState` rejection by tampering with
  // the echoed state.
  server.registerTool(
    "confirm-launch",
    {
      title: "Confirm launch (two rounds)",
      description:
        "Round 1 asks for confirmation, round 2 for a launch code — a two-round MRTR flow with signed requestState.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const state = ctx.mcpReq.requestState<StatePayload>();

      if (!state) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: "Launch the rocket?",
              requestedSchema: {
                type: "object",
                properties: { confirm: { type: "boolean", title: "Confirm launch" } },
                required: ["confirm"],
              },
            }),
          },
          requestState: await stateCodec.mint({ tool: "confirm-launch", step: "confirm" }, ctx),
        });
      }
      if (state.tool !== "confirm-launch") {
        return { content: [{ type: "text" as const, text: "requestState from another flow." }], isError: true };
      }

      if (state.step === "confirm") {
        const view = inputResponse(ctx.mcpReq.inputResponses, "confirm");
        if (view.kind !== "elicit" || view.action !== "accept") {
          return { content: [{ type: "text" as const, text: "Launch aborted (no confirmation)." }] };
        }
        const answer = acceptedContent<{ confirm?: boolean }>(ctx.mcpReq.inputResponses, "confirm");
        if (!answer?.confirm) {
          return { content: [{ type: "text" as const, text: "Launch declined." }] };
        }
        return inputRequired({
          inputRequests: {
            code: inputRequired.elicit({
              message: "Enter the launch code (hint: 0000).",
              requestedSchema: {
                type: "object",
                properties: { code: { type: "string", title: "Launch code" } },
                required: ["code"],
              },
            }),
          },
          requestState: await stateCodec.mint({ tool: "confirm-launch", step: "code" }, ctx),
        });
      }

      // step === "code" — final round; the confirm answer from round 2 must
      // NOT still be present (responses are replaced per round, not merged).
      const staleConfirm = inputResponse(ctx.mcpReq.inputResponses, "confirm");
      const view = inputResponse(ctx.mcpReq.inputResponses, "code");
      if (view.kind !== "elicit" || view.action !== "accept") {
        return { content: [{ type: "text" as const, text: "Launch aborted (no code)." }] };
      }
      const code = acceptedContent<{ code?: string }>(ctx.mcpReq.inputResponses, "code")?.code;
      const launched = code === "0000";
      return {
        content: [
          {
            type: "text" as const,
            text: launched ? "🚀 Launched!" : `Wrong code (${code ?? "none"}). Launch scrubbed.`,
          },
        ],
        structuredContent: {
          launched,
          // Surfaced so clients can assert per-round replacement happened.
          roundTwoResponseLeakedIntoRoundThree: staleConfirm.kind !== "missing",
        },
      };
    },
  );

  // ── open-dashboard ──────────────────────────────────────────
  // URL-mode elicitation via MRTR. On 2026-07-28 URL elicitation rides the
  // input_required flow (no elicitationId, no -32042); correlation across
  // rounds is the server's own identifier inside requestState.
  server.registerTool(
    "open-dashboard",
    {
      title: "Open dashboard (URL elicitation)",
      description: "Asks the client to send the user to a URL, then reports the outcome.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const state = ctx.mcpReq.requestState<StatePayload>();
      if (!state) {
        const nonce = crypto.randomUUID();
        return inputRequired({
          inputRequests: {
            visit: inputRequired.elicitUrl({
              message: "Please open the MCPJam dashboard to continue.",
              url: `https://stateless.mcpjam.com/?session=${nonce}`,
            }),
          },
          requestState: await stateCodec.mint({ tool: "open-dashboard", nonce }, ctx),
        });
      }
      if (state.tool !== "open-dashboard") {
        return { content: [{ type: "text" as const, text: "requestState from another flow." }], isError: true };
      }
      const view = inputResponse(ctx.mcpReq.inputResponses, "visit");
      const action = view.kind === "elicit" ? view.action : "invalid";
      return {
        content: [{ type: "text" as const, text: `URL elicitation outcome: ${action} (session ${state.nonce})` }],
        structuredContent: { action, nonce: state.nonce },
      };
    },
  );

  // ── summarize ───────────────────────────────────────────────
  // Sampling via MRTR: the embedded request is `sampling/createMessage`, so
  // the client answers with its LLM's completion. Requires
  // `_meta.clientCapabilities.sampling`.
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
                { role: "user", content: { type: "text", text: `Summarize in one sentence:\n\n${text}` } },
              ],
            }),
          },
        });
      }
      if (view.kind !== "sampling") {
        return { content: [{ type: "text" as const, text: "Invalid sampling response." }], isError: true };
      }
      const block = Array.isArray(view.result.content) ? view.result.content[0] : view.result.content;
      const out = block?.type === "text" ? block.text : "(non-text result)";
      return {
        content: [{ type: "text" as const, text: out }],
        structuredContent: { summary: out },
      };
    },
  );

  // ── list-client-roots ───────────────────────────────────────
  // Roots via MRTR (`roots/list` embedded request). Roots is deprecated on
  // 2026-07-28 and many clients (MCPJam included, by decision) do not
  // support it — this tool exists precisely so clients can test their
  // "server asked for an input kind we don't do" rejection path.
  server.registerTool(
    "list-client-roots",
    {
      title: "List client roots",
      description:
        "Embeds a roots/list request via MRTR. Clients that don't support roots should surface a precise capability error — that's the test.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const view = inputResponse(ctx.mcpReq.inputResponses, "roots");
      if (view.kind === "missing") {
        return inputRequired({ inputRequests: { roots: inputRequired.listRoots() } });
      }
      if (view.kind !== "roots") {
        return { content: [{ type: "text" as const, text: "Invalid roots response." }], isError: true };
      }
      const uris = view.roots.map((r) => r.uri);
      return {
        content: [{ type: "text" as const, text: uris.length ? uris.join("\n") : "(no roots)" }],
        structuredContent: { roots: uris },
      };
    },
  );

  // ── never-satisfied ─────────────────────────────────────────
  // Returns input_required forever — the fixture for the client-side
  // max-rounds limit (the official client fails the flow with
  // `SdkError(InputRequiredRoundsExceeded)`, default 10 rounds).
  server.registerTool(
    "never-satisfied",
    {
      title: "Never satisfied (infinite MRTR loop)",
      description: "Always asks again. Tests the client's input_required round limit.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const state = ctx.mcpReq.requestState<StatePayload>();
      const round = state?.tool === "never-satisfied" ? state.round + 1 : 1;
      return inputRequired({
        inputRequests: {
          more: inputRequired.elicit({
            message: `Round ${round}: still not satisfied. Try again?`,
            requestedSchema: {
              type: "object",
              properties: { anything: { type: "string", title: "Anything at all" } },
            },
          }),
        },
        requestState: await stateCodec.mint({ tool: "never-satisfied", round }, ctx),
      });
    },
  );

  // ── trigger-notifications ───────────────────────────────────
  // Publishes a change event on the handler's subscription bus, delivered
  // to every open `subscriptions/listen` stream whose filter opted in.
  // NOTE: the bus is per-isolate — the listen stream and the trigger call
  // must land on the same Workers isolate to observe delivery (they
  // normally do for a single client; guaranteed under `wrangler dev`).
  server.registerTool(
    "trigger-notifications",
    {
      title: "Trigger subscription notifications",
      description:
        "Publishes tools/prompts/resources list_changed or a resources/updated event to open subscriptions/listen streams.",
      inputSchema: z.object({
        event: z.enum(["tools", "prompts", "resources", "resource-updated"]),
        uri: z.string().optional().meta({
          description: "URI for resource-updated (default demo://counter).",
        }),
      }),
    },
    async ({ event, uri }) => {
      const target = uri ?? "demo://counter";
      switch (event) {
        case "tools":
          mcp.notify.toolsChanged();
          break;
        case "prompts":
          mcp.notify.promptsChanged();
          break;
        case "resources":
          mcp.notify.resourcesChanged();
          break;
        case "resource-updated":
          mcp.notify.resourceUpdated(target);
          break;
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `published ${event}${event === "resource-updated" ? ` for ${target}` : ""}`,
          },
        ],
      };
    },
  );
}

// ════════════════════════════════════════════════════════════
// Resources
// ════════════════════════════════════════════════════════════

function registerResources(server: McpServer): void {
  // Static text resource with a per-resource cache hint (overrides the
  // per-operation resources/read hint, field by field).
  server.registerResource(
    "server-card",
    "demo://server-card",
    {
      title: "Server card",
      description: "Static text resource with a public per-resource cache hint.",
      mimeType: "text/markdown",
      icons: emojiIcon("🪪"),
      cacheHint: { ttlMs: LIST_RESULT_TTL_MS, cacheScope: "public" },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: "# mcpjam-stateless\n\nEverything server for the 2026-07-28 revision.",
        },
      ],
    }),
  );

  // Binary blob resource.
  server.registerResource(
    "logo",
    "demo://logo",
    {
      title: "Logo",
      description: "A 1x1 PNG — exercises blob resource contents.",
      mimeType: "image/png",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "image/png", blob: LOGO_PNG_BASE64 }],
    }),
  );

  // Time-varying resource: pairs with `trigger-notifications
  // event=resource-updated` for testing resourceSubscriptions delivery, and
  // its per-resource cacheHint forces ttlMs 0 so clients never cache it.
  server.registerResource(
    "counter",
    "demo://counter",
    {
      title: "Counter",
      description: "Time-varying value; never cacheable (per-resource ttlMs 0 overrides the operation hint).",
      mimeType: "application/json",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ epochMinute: Math.floor(Date.now() / 60_000) }),
        },
      ],
    }),
  );

  // Resource template: enumerable (list callback) and completable (the
  // {name} variable answers completion/complete with prefix matches).
  server.registerResource(
    "files",
    new ResourceTemplate("demo://files/{name}", {
      list: () => ({
        resources: Object.entries(TEMPLATE_FILES).map(([name, f]) => ({
          name,
          uri: `demo://files/${name}`,
          mimeType: f.mimeType,
        })),
      }),
      complete: {
        name: (value) => Object.keys(TEMPLATE_FILES).filter((n) => n.startsWith(value)),
      },
    }),
    {
      title: "Demo files",
      description: "Resource template with list + argument completion. Unknown names test resource-not-found (-32602).",
    },
    async (uri, variables) => {
      const name = String(variables.name);
      const file = TEMPLATE_FILES[name];
      if (!file) throw new ResourceNotFoundError(`No such file: ${name}`);
      return {
        contents: [{ uri: uri.href, mimeType: file.mimeType, text: file.text }],
      };
    },
  );

  // MRTR from resources/read: the read is gated on a form elicitation.
  server.registerResource(
    "vault",
    "demo://vault",
    {
      title: "Vault",
      description: "resources/read that answers input_required — MRTR from the resources entry method. Passphrase: mcp",
      mimeType: "text/plain",
    },
    async (uri, ctx: ServerContext) => {
      const view = inputResponse(ctx.mcpReq.inputResponses, "passphrase");
      if (view.kind === "missing") {
        return inputRequired({
          inputRequests: {
            passphrase: inputRequired.elicit({
              message: "This resource is locked. Enter the passphrase (hint: mcp).",
              requestedSchema: {
                type: "object",
                properties: { passphrase: { type: "string", title: "Passphrase" } },
                required: ["passphrase"],
              },
            }),
          },
        });
      }
      const answer = acceptedContent<{ passphrase?: string }>(ctx.mcpReq.inputResponses, "passphrase");
      if (view.kind !== "elicit" || view.action !== "accept" || answer?.passphrase !== "mcp") {
        throw new Error("Vault access denied.");
      }
      return {
        contents: [{ uri: uri.href, mimeType: "text/plain", text: "The vault contains: nothing but this sentence." }],
      };
    },
  );
}

// ════════════════════════════════════════════════════════════
// Prompts
// ════════════════════════════════════════════════════════════

function registerPrompts(server: McpServer): void {
  // Completable prompt argument: `language` answers completion/complete.
  server.registerPrompt(
    "code-review",
    {
      title: "Code review",
      description: "Review code — the language argument supports completion.",
      icons: emojiIcon("🔍"),
      argsSchema: z.object({
        language: completable(z.string(), (value) =>
          PROMPT_LANGUAGES.filter((l) => l.startsWith(value.toLowerCase())),
        ),
        code: z.string(),
      }),
    },
    ({ language, code }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Review this ${language} code for bugs and style:\n\n\`\`\`${language}\n${code}\n\`\`\``,
          },
        },
      ],
    }),
  );

  // MRTR from prompts/get: the prompt asks for a tone before rendering.
  server.registerPrompt(
    "personalized-greeting",
    {
      title: "Personalized greeting",
      description: "prompts/get that answers input_required — MRTR from the prompts entry method.",
      // `.default({})` keeps absent `arguments` valid (this prompt takes none).
      argsSchema: z.object({}).default({}),
    },
    (_args, ctx: ServerContext) => {
      const view = inputResponse(ctx.mcpReq.inputResponses, "tone");
      if (view.kind === "missing") {
        return inputRequired({
          inputRequests: {
            tone: inputRequired.elicit({
              message: "What tone should the greeting have?",
              requestedSchema: {
                type: "object",
                properties: {
                  tone: {
                    type: "string",
                    title: "Tone",
                    enum: ["formal", "friendly", "pirate"],
                  },
                },
                required: ["tone"],
              },
            }),
          },
        });
      }
      const tone = acceptedContent<{ tone?: string }>(ctx.mcpReq.inputResponses, "tone")?.tone ?? "friendly";
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: `Write a short ${tone} greeting for a new MCPJam user.` },
          },
        ],
      };
    },
  );
}

// ── Worker entry ────────────────────────────────────────────
// `createMcpHandler` is the 2026-07-28 stateless HTTP entry. It enforces
// POST-only modern traffic, Content-Type, per-request envelopes, standard
// headers (SEP-2243), cache fields (SEP-2549), status mapping — and serves
// `subscriptions/listen` streams (ack-first, filtered, keepalives) fed by
// the handler's change-event bus (`mcp.notify.*`).
//
// `legacy: "reject"` makes the endpoint modern-only: 2025-era requests
// (including `initialize`) get the unsupported-protocol-version error.
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

// Methods the SDK cannot serve (tasks extension) are routed on the required
// `Mcp-Method` header — its whole purpose is body-free routing (SEP-2243).
const INTERCEPTED_METHODS = new Set(["tasks/get", "tasks/update", "tasks/cancel"]);

export default {
  async fetch(request: Request, env?: TasksEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") {
      return new Response(landingHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const rejected = hostHeaderValidationResponse(request, ALLOWED_HOSTS);
    if (rejected) return rejected;

    // ── Tasks-extension interception (src/tasks.ts) ─────────
    const headerMethod = request.headers.get("Mcp-Method");
    if (request.method === "POST" && headerMethod !== null) {
      if (INTERCEPTED_METHODS.has(headerMethod)) {
        const body = await readJsonBody(request);
        if (body === undefined) return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          { status: 400 },
        );
        return handleTasksMethod(request, body, env);
      }
      // subscriptions/listen with a `taskIds` filter member: the SDK's filter
      // schema would strip it, so those streams are served by the extension
      // layer (which also bridges the core kinds off the same bus).
      if (headerMethod === "subscriptions/listen") {
        const body = await readJsonBody(request);
        if (body !== undefined) {
          const filter = (body.params as Record<string, unknown> | undefined)?.notifications as
            | Record<string, unknown>
            | undefined;
          if (Array.isArray(filter?.taskIds)) {
            const meta = (body.params as Record<string, unknown>)?._meta;
            if (!tasksCapabilityDeclared(meta)) {
              return Response.json({
                jsonrpc: "2.0",
                id: (body.id as string | number | null) ?? null,
                error: {
                  code: -32003,
                  message: "Missing required client capability: task notifications require the tasks extension",
                  data: { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
                },
              });
            }
            return handleTaskListen(request, body, mcp.bus, env);
          }
        }
        return mcp.fetch(request);
      }
      // run-task requires the extension: a task-only tool MUST answer -32003
      // to non-declaring clients (it cannot be serviced without a task, and
      // the SDK's tool callbacks cannot emit JSON-RPC errors).
      if (headerMethod === "tools/call" && request.headers.get("Mcp-Name") === "run-task") {
        const body = await readJsonBody(request);
        const meta = ((body?.params ?? {}) as Record<string, unknown>)._meta;
        if (body !== undefined && !tasksCapabilityDeclared(meta)) {
          return Response.json({
            jsonrpc: "2.0",
            id: (body.id as string | number | null) ?? null,
            error: {
              code: -32003,
              message: "Missing required client capability: run-task only executes as a task (tasks extension)",
              data: { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
            },
          });
        }
        return mcp.fetch(request);
      }
    }

    return mcp.fetch(request);
  },
};

/** Peek the JSON body via clone() — the original request stays consumable. */
async function readJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await request.clone().text());
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function landingHtml(): string {
  return `<!doctype html>
<html><body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
  <div style="text-align:center;max-width:600px">
    <h1>mcpjam-stateless</h1>
    <p>"Everything" server for stateless MCP (2026-07-28). POST JSON-RPC to <code>/mcp</code>.</p>
    <p>Tools, resources, prompts, completions, MRTR (form/URL/sampling/roots/multi-round),
       progress streams, <code>subscriptions/listen</code>, and the Tasks extension
       (<code>run-task</code> + <code>tasks/get|update|cancel</code> + <code>notifications/tasks</code>).</p>
  </div>
</body></html>`;
}
