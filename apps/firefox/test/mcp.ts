import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Calls a tool of the kernel's MCP server like the container's agent would, with the main token (`.webaios/mcp.json`) or a session's `config`. */
export async function callMcpTool(
  root: string,
  name: string,
  args: Record<string, unknown> = {},
  config = join(root, ".webaios", "mcp.json"),
): Promise<{ texte: string; image?: string; erreur: boolean }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const server = JSON.parse(readFileSync(config, "utf8")).mcpServers.webaios;
  const transport = new StreamableHTTPClientTransport(new URL(server.url.replace("host.docker.internal", "127.0.0.1")), {
    requestInit: { headers: server.headers },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string; data?: string }[];
      isError?: boolean;
    };
    return {
      texte: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      ...(r.content.some((c) => c.type === "image") ? { image: r.content.find((c) => c.type === "image")!.data } : {}),
      erreur: r.isError === true,
    };
  } finally {
    await client.close();
  }
}
