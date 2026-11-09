import { join } from "node:path";
import { callMcpTool } from "../test/mcp";

/** Calls a tool of the kernel's MCP server of a launched WebAiOs (config at `<dataDir>/workspace/.webaios/mcp.json`). */
export const callTool = (dataDir: string, name: string, args: Record<string, unknown> = {}) => callMcpTool(join(dataDir, "workspace"), name, args);
