import { beforeAll, describe, expect, it, vi } from "vitest";
import { rulerName } from "../src/fixtures/oddNames";
import { call, legacyRequest, listToolNames, modernRequest, request, send } from "./helpers";

const PATH = "/fixtures/odd-names/mcp";

const AT_64 = "long_name_" + "1234567890".repeat(5) + "1234";
const AT_65 = `${AT_64}5`;
const AT_128 = rulerName("longest_allowed_name_", 128);

const EXPECTED_NAMES = [
  "control",
  "dotted.tool.name",
  "slashed/tool/name",
  "collide.pair",
  "collide_pair",
  AT_64,
  AT_65,
  AT_128,
];

beforeAll(() => {
  // The SDK warns on every registration of `slashed/tool/name` (outside
  // SEP-986's charset on purpose); keep the test output readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("odd-names fixture", () => {
  it("lists every odd name, in order", async () => {
    expect(await listToolNames(PATH)).toEqual(EXPECTED_NAMES);
  });

  it("has names at exactly 64, 65 and 128 characters", () => {
    expect(AT_64).toHaveLength(64);
    expect(AT_65).toHaveLength(65);
    expect(AT_128).toHaveLength(128);
    // A host that truncates to 64 turns the 65-character name into the 64 one.
    expect(AT_65.slice(0, 64)).toBe(AT_64);
    // ...but not the 128-character one.
    expect(AT_128.slice(0, 64)).not.toBe(AT_64);
  });

  it("has a pair that collides once non-[A-Za-z0-9_-] characters become '_'", () => {
    const sanitize = (n: string) => n.replace(/[^A-Za-z0-9_-]/g, "_");
    expect(sanitize("collide.pair")).toBe(sanitize("collide_pair"));
  });

  it("ends each ruler name with its length mod 10", () => {
    for (const length of [64, 65, 128]) {
      const name = rulerName("x_", length);
      expect(name).toHaveLength(length);
      expect(name.at(-1)).toBe(String(length % 10));
    }
  });

  it.each(EXPECTED_NAMES)("answers a call to %s with its exact name", async (name) => {
    const { status, body } = await call(
      modernRequest(PATH, "tools/call", { name, arguments: { message: "ping" } }, { name }),
    );
    expect(status).toBe(200);
    expect(body.result.content).toEqual([{ type: "text", text: `called ${name} (${name.length} chars): ping` }]);
    expect(body.result.structuredContent).toEqual({ tool: name, length: name.length, message: "ping" });
  });

  it("accepts calls without arguments", async () => {
    const { body } = await call(modernRequest(PATH, "tools/call", { name: "control" }, { name: "control" }));
    expect(body.result.content).toEqual([{ type: "text", text: "called control (7 chars)" }]);
  });

  it("does not answer a sanitized name it does not have", async () => {
    const name = "dotted_tool_name";
    const { body } = await call(modernRequest(PATH, "tools/call", { name, arguments: {} }, { name }));
    expect(body.result).toBeUndefined();
    expect(body.error.message).toContain(name);
  });

  describe("2025-era clients", () => {
    it("can initialize", async () => {
      const { status, body } = await call(
        legacyRequest(PATH, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "vitest", version: "1" },
        }),
      );
      expect(status).toBe(200);
      expect(body.result.serverInfo.name).toBe("mcpjam-stateless-odd-names");
    });

    it("list and call the same tools", async () => {
      const list = await call(legacyRequest(PATH, "tools/list"));
      expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(EXPECTED_NAMES);

      const name = "slashed/tool/name";
      const result = await call(legacyRequest(PATH, "tools/call", { name, arguments: {} }));
      expect(result.body.result.content).toEqual([{ type: "text", text: `called ${name} (17 chars)` }]);
    });
  });

  it("rejects foreign Host headers", async () => {
    const response = await send(
      request(PATH, { method: "POST", headers: { Host: "evil.example", "Content-Type": "application/json" }, body: "{}" }),
    );
    expect(response.status).toBe(403);
  });

  it("answers 404 for an unknown fixture", async () => {
    const response = await send(request("/fixtures/nope/mcp", { method: "POST", body: "{}" }));
    expect(response.status).toBe(404);
  });
});
