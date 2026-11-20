// The default /mcp endpoint is seeded into every Jamroom QA workspace and
// used by Inspector tests: its catalog and behavior must not drift. The
// snapshot was recorded from main before the fixture endpoints existed.

import { describe, expect, it } from "vitest";
import { call, legacyRequest, listen, listToolNames, modernRequest, request, send } from "./helpers";

const DEFAULT_TOOLS = [
  "echo",
  "execute-sql",
  "get-weather",
  "long-task",
  "fail",
  "ask-name",
  "confirm-launch",
  "open-dashboard",
  "summarize",
  "list-client-roots",
  "never-satisfied",
  "trigger-notifications",
  "run-task",
];

describe("default /mcp endpoint", () => {
  it("keeps exactly its tool names", async () => {
    expect(await listToolNames("/mcp")).toEqual(DEFAULT_TOOLS);
  });

  it("keeps its full tools/list result", async () => {
    const { status, body } = await call(modernRequest("/mcp", "tools/list"));
    expect(status).toBe(200);
    expect(body.result).toMatchSnapshot();
  });

  it("keeps its full server/discover result", async () => {
    const { body } = await call(modernRequest("/mcp", "server/discover"));
    expect(body.result).toMatchSnapshot();
  });

  it("echo still answers 'echo: <message>'", async () => {
    const { status, body } = await call(
      modernRequest("/mcp", "tools/call", { name: "echo", arguments: { message: "hi" } }, { name: "echo" }),
    );
    expect(status).toBe(200);
    expect(body.result.content).toEqual([{ type: "text", text: "echo: hi" }]);
  });

  it("still delivers trigger-notifications to its own listen streams", async () => {
    const stream = await listen("/mcp", undefined);
    try {
      expect((await stream.next(1000))?.method).toBe("notifications/subscriptions/acknowledged");
      await call(
        modernRequest(
          "/mcp",
          "tools/call",
          { name: "trigger-notifications", arguments: { event: "tools" } },
          { name: "trigger-notifications" },
        ),
      );
      expect((await stream.next(1000))?.method).toBe("notifications/tools/list_changed");
    } finally {
      await stream.close();
    }
  });

  it("still ignores the query string", async () => {
    expect(await listToolNames("/mcp?session=anything")).toEqual(DEFAULT_TOOLS);
  });

  it("still rejects 2025-era initialize", async () => {
    const { status, body } = await call(
      legacyRequest("/mcp", "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1" },
      }),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32022);
  });

  it("still answers run-task without the tasks extension with -32003", async () => {
    const { body } = await call(
      modernRequest("/mcp", "tools/call", { name: "run-task", arguments: {} }, { name: "run-task" }),
    );
    expect(body.error.code).toBe(-32003);
  });

  it("still rejects foreign Host headers", async () => {
    const response = await send(
      request("/mcp", { method: "POST", headers: { Host: "evil.example", "Content-Type": "application/json" }, body: "{}" }),
    );
    expect(response.status).toBe(403);
  });

  it("still serves the landing page on other paths", async () => {
    for (const path of ["/", "/anything", "/mcp/"]) {
      const response = await send(request(path));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
    }
  });
});
