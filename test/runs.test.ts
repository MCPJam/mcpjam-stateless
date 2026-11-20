import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_TRACKED_NAME_LENGTH,
  MAX_TRACKED_TOOLS,
  RUN_TTL_MS,
  RunCallCounter,
  toolCallNames,
} from "../src/runs";
import { fakeNamespace } from "./fakeDurableObjects";
import { call, legacyRequest, listen, listToolNames, modernRequest, request, send } from "./helpers";

function setup() {
  const counters = fakeNamespace((state) => new RunCallCounter(state));
  return { env: { RUN_CALLS: counters.namespace }, counters };
}

const newRunId = () => crypto.randomUUID();

async function readCounts(runId: string, env: unknown) {
  const response = await send(request(`/runs/${runId}/calls`), env);
  return { status: response.status, cacheControl: response.headers.get("Cache-Control"), body: await response.json() };
}

const callTool = (path: string, name: string, args: Record<string, unknown> = {}) =>
  modernRequest(path, "tools/call", { name, arguments: args }, { name });

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); // SDK tool-name warnings (odd-names)
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("/runs/<run-id>/calls", () => {
  it("reads zeros for a run nobody called, without storing anything", async () => {
    const { env, counters } = setup();
    const runId = newRunId();
    const counts = await readCounts(runId, env);
    expect(counts).toEqual({ status: 200, cacheControl: "no-store", body: { total: 0, byTool: {} } });
    const object = counters.objects.get(runId)!;
    expect(object.storage.size).toBe(0);
    expect(object.storage.alarm).toBeNull();
  });

  it("only answers GET", async () => {
    const { env } = setup();
    const response = await send(request(`/runs/${newRunId()}/calls`, { method: "POST", body: "{}" }), env);
    expect(response.status).toBe(405);
  });
});

describe("/runs/<run-id>/mcp", () => {
  it("serves exactly the /mcp catalog", async () => {
    const { env } = setup();
    const runPath = `/runs/${newRunId()}/mcp`;
    expect(await listToolNames(runPath, env)).toEqual(await listToolNames("/mcp"));
    const plain = await call(modernRequest("/mcp", "tools/list"));
    const counted = await call(modernRequest(runPath, "tools/list"), env);
    expect(counted.body.result).toEqual(plain.body.result);
  });

  it("counts tool calls per tool and still answers them", async () => {
    const { env } = setup();
    const runId = newRunId();
    const path = `/runs/${runId}/mcp`;

    const echo = await call(callTool(path, "echo", { message: "hi" }), env);
    expect(echo.body.result.content).toEqual([{ type: "text", text: "echo: hi" }]);
    await call(callTool(path, "echo", { message: "again" }), env);
    await call(callTool(path, "get-weather", { city: "Lima" }), env);
    await call(modernRequest(path, "tools/list"), env); // not a call

    expect((await readCounts(runId, env)).body).toEqual({ total: 3, byTool: { echo: 2, "get-weather": 1 } });
  });

  it("counts calls the server rejects", async () => {
    const { env } = setup();
    const runId = newRunId();
    const path = `/runs/${runId}/mcp`;
    const rejected = await call(callTool(path, "run-task"), env); // no tasks extension declared
    expect(rejected.body.error.code).toBe(-32003);
    const unknown = await call(callTool(path, "no-such-tool"), env);
    expect(unknown.body.error).toBeDefined();
    expect((await readCounts(runId, env)).body).toEqual({ total: 2, byTool: { "run-task": 1, "no-such-tool": 1 } });
  });

  it("keeps runs apart", async () => {
    const { env } = setup();
    const [a, b] = [newRunId(), newRunId()];
    await call(callTool(`/runs/${a}/mcp`, "echo", { message: "a" }), env);
    await call(callTool("/mcp", "echo", { message: "uncounted" }), env);
    expect((await readCounts(a, env)).body).toEqual({ total: 1, byTool: { echo: 1 } });
    expect((await readCounts(b, env)).body).toEqual({ total: 0, byTool: {} });
  });

  it("keeps subscription notifications inside the run that triggered them", async () => {
    const { env } = setup();
    const [a, b] = [newRunId(), newRunId()];
    const listenA = await listen(`/runs/${a}/mcp`, env);
    try {
      expect((await listenA.next(1000))?.method).toBe("notifications/subscriptions/acknowledged");

      await call(callTool(`/runs/${b}/mcp`, "trigger-notifications", { event: "tools" }), env);
      await call(callTool("/mcp", "trigger-notifications", { event: "tools" }), env);
      expect(await listenA.next(200)).toBeUndefined();

      await call(callTool(`/runs/${a}/mcp`, "trigger-notifications", { event: "tools" }), env);
      expect((await listenA.next(1000))?.method).toBe("notifications/tools/list_changed");
    } finally {
      await listenA.close();
    }
  });
});

describe("/runs/<run-id>/fixtures/odd-names/mcp", () => {
  it("counts each name exactly as the client sent it", async () => {
    const { env } = setup();
    const runId = newRunId();
    const path = `/runs/${runId}/fixtures/odd-names/mcp`;
    const ok = await call(callTool(path, "dotted.tool.name"), env);
    expect(ok.body.result.content[0].text).toBe("called dotted.tool.name (16 chars)");
    await call(callTool(path, "dotted_tool_name"), env); // a host's sanitized spelling
    await call(legacyRequest(path, "tools/call", { name: "collide.pair", arguments: {} }), env); // 2025-era client
    expect((await readCounts(runId, env)).body).toEqual({
      total: 3,
      byTool: { "dotted.tool.name": 1, dotted_tool_name: 1, "collide.pair": 1 },
    });
  });
});

describe("run ids and paths", () => {
  it.each([
    ["too short", "abc123"],
    ["too long", "a".repeat(65)],
    ["a dot", "run.0123456789abcdef"],
    ["an encoded slash", "run%2F0123456789abcdef"],
  ])("rejects a run id with %s", async (_label, runId) => {
    const { env } = setup();
    for (const path of [`/runs/${runId}/calls`, `/runs/${runId}/mcp`]) {
      const response = await send(request(path, { method: path.endsWith("/mcp") ? "POST" : "GET" }), env);
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain(runId);
    }
  });

  it("accepts 16 and 64 characters", async () => {
    const { env } = setup();
    for (const runId of ["A".repeat(16), "z_-9".repeat(16)]) {
      expect((await readCounts(runId, env)).status).toBe(200);
    }
  });

  it("answers 404 for unknown endpoints under a run", async () => {
    const { env } = setup();
    const runId = newRunId();
    for (const path of [`/runs/${runId}`, `/runs/${runId}/`, `/runs/${runId}/nope`, `/runs/${runId}/fixtures/nope/mcp`]) {
      expect((await send(request(path), env)).status).toBe(404);
    }
  });

  it("rejects foreign Host headers", async () => {
    const { env } = setup();
    const response = await send(request(`/runs/${newRunId()}/calls`, { headers: { Host: "evil.example" } }), env);
    expect(response.status).toBe(403);
  });
});

describe("without the counter binding", () => {
  it("refuses tool calls instead of serving them uncounted", async () => {
    const path = `/runs/${newRunId()}/mcp`;
    const refused = await call(callTool(path, "echo", { message: "hi" }), {});
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe(-32603);
    // Requests that are not calls are still served.
    expect(await listToolNames(path, {})).toContain("echo");
    expect((await send(request(`/runs/${newRunId()}/calls`), {})).status).toBe(503);
  });
});

describe("RunCallCounter", () => {
  const post = (counter: RunCallCounter, names: (string | null)[]) =>
    counter.fetch(new Request("https://run-calls/", { method: "POST", body: JSON.stringify({ names }) }));
  const read = async (counter: RunCallCounter) => (await counter.fetch(new Request("https://run-calls/"))).json();

  function counter() {
    const counters = fakeNamespace((state) => new RunCallCounter(state));
    return counters.objectFor("run");
  }

  it("expires RUN_TTL_MS after the most recent call", async () => {
    const { instance, storage } = counter();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await post(instance, ["echo"]);
    expect(storage.alarm).toBe(1_000_000 + RUN_TTL_MS);
    now.mockReturnValue(5_000_000);
    await post(instance, ["echo"]);
    expect(storage.alarm).toBe(5_000_000 + RUN_TTL_MS);
    expect(RUN_TTL_MS).toBe(24 * 60 * 60_000);
  });

  it("deletes its counts when the alarm fires", async () => {
    const { instance, storage } = counter();
    await post(instance, ["echo", "echo"]);
    expect(await read(instance)).toEqual({ total: 2, byTool: { echo: 2 } });
    await instance.alarm();
    expect(storage.size).toBe(0);
    expect(await read(instance)).toEqual({ total: 0, byTool: {} });
  });

  it("counts calls without a name, and over-long names, in total only", async () => {
    const { instance } = counter();
    await post(instance, [null, "x".repeat(MAX_TRACKED_NAME_LENGTH + 1), "x".repeat(MAX_TRACKED_NAME_LENGTH)]);
    expect(await read(instance)).toEqual({ total: 3, byTool: { ["x".repeat(MAX_TRACKED_NAME_LENGTH)]: 1 } });
  });

  it("itemizes at most MAX_TRACKED_TOOLS names but keeps counting the ones it has", async () => {
    const { instance } = counter();
    const names = Array.from({ length: MAX_TRACKED_TOOLS + 10 }, (_, i) => `tool-${i}`);
    await post(instance, names);
    await post(instance, ["tool-0", `tool-${MAX_TRACKED_TOOLS + 5}`]);
    const counts = await read(instance);
    expect(counts.total).toBe(MAX_TRACKED_TOOLS + 12);
    expect(Object.keys(counts.byTool)).toHaveLength(MAX_TRACKED_TOOLS);
    expect(counts.byTool["tool-0"]).toBe(2);
    expect(counts.byTool[`tool-${MAX_TRACKED_TOOLS + 5}`]).toBeUndefined();
  });

  it("treats __proto__ as an ordinary tool name", async () => {
    const { instance } = counter();
    await post(instance, ["__proto__", "__proto__", "constructor"]);
    const counts = await read(instance);
    expect(counts.total).toBe(3);
    expect(Object.entries(counts.byTool)).toEqual([
      ["__proto__", 2],
      ["constructor", 1],
    ]);
  });
});

describe("toolCallNames", () => {
  it("finds tools/call requests in single messages and batches", () => {
    expect(toolCallNames({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } })).toEqual(["echo"]);
    expect(toolCallNames({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toEqual([]);
    expect(
      toolCallNames([
        { method: "tools/call", params: { name: "a" } },
        { method: "notifications/initialized" },
        { method: "tools/call", params: {} },
        { method: "tools/call", params: { name: 7 } },
        null,
      ]),
    ).toEqual(["a", undefined, undefined]);
    expect(toolCallNames("tools/call")).toEqual([]);
  });
});
