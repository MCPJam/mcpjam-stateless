// Odd tool names fixture, served at /fixtures/odd-names/mcp.
//
// Tool names that stress how a host lists, sanitizes, truncates, and routes
// them. Several hosts cap names at 64 characters or only accept
// [A-Za-z0-9_-], so this fixture has names on each side of those lines. Every
// tool answers with its own exact name, so a call that reaches the wrong
// tool (two names collapsed into one by a host) shows in the result.
//
// Unlike /mcp, this endpoint serves both eras (the SDK's default
// `legacy: "stateless"`): the hosts worth testing here include 2025-era
// clients. `slashed/tool/name` is outside SEP-986's charset on purpose, so
// the SDK logs a tool-name warning each time it registers that tool.

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const LIST_RESULT_TTL_MS = 300_000;

/** `prefix`, then a digit ruler: the character at 1-based position p is
 *  p % 10, so the last digit of a name is its length mod 10. */
export function rulerName(prefix: string, length: number): string {
  let name = prefix;
  while (name.length < length) name += String((name.length + 1) % 10);
  return name;
}

const AT_64 = rulerName("long_name_", 64);

export const ODD_NAME_TOOLS: { name: string; why: string }[] = [
  {
    name: "control",
    why: "A conforming name. If a host lists only this tool, it dropped every odd name.",
  },
  { name: "dotted.tool.name", why: "Contains dots." },
  { name: "slashed/tool/name", why: "Contains slashes, which are outside SEP-986's allowed characters." },
  {
    name: "collide.pair",
    why: "Collides with collide_pair when a host replaces characters outside [A-Za-z0-9_-] with '_'.",
  },
  {
    name: "collide_pair",
    why: "Collides with collide.pair when a host replaces characters outside [A-Za-z0-9_-] with '_'.",
  },
  { name: AT_64, why: "Exactly 64 characters, the cap several hosts enforce." },
  {
    name: `${AT_64}5`,
    why: "65 characters: the 64-character name plus one, so a host that truncates names to 64 makes the two identical.",
  },
  {
    name: rulerName("longest_allowed_name_", 128),
    why: "128 characters, the longest name SEP-986 allows.",
  },
];

function buildOddNamesServer(): McpServer {
  const server = new McpServer(
    { name: "mcpjam-stateless-odd-names", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Fixture for testing how a host handles unusual MCP tool names: dots, slashes, a pair that " +
        "collides after sanitizing, and names at 64, 65 and 128 characters. Each tool replies with its " +
        "own exact name and length.",
      cacheHints: {
        "server/discover": { ttlMs: LIST_RESULT_TTL_MS, cacheScope: "public" },
        "tools/list": { ttlMs: LIST_RESULT_TTL_MS, cacheScope: "public" },
      },
    },
  );

  for (const { name, why } of ODD_NAME_TOOLS) {
    server.registerTool(
      name,
      {
        description: `${why} (${name.length} characters.) Replies with the exact name that was called.`,
        inputSchema: z.object({
          message: z.string().optional().meta({ description: "Optional text to echo back." }),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ message }) => ({
        content: [
          {
            type: "text" as const,
            text: `called ${name} (${name.length} chars)${message === undefined ? "" : `: ${message}`}`,
          },
        ],
        structuredContent: { tool: name, length: name.length, ...(message === undefined ? {} : { message }) },
      }),
    );
  }
  return server;
}

// Nothing here publishes change events, so one handler (and its bus) can be
// shared by the plain fixture path and every /runs/<run-id>/ path.
export const oddNamesHandler = createMcpHandler(() => buildOddNamesServer());
