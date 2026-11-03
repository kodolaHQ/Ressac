import { join } from "node:path";
import { appelerOutil } from "../test/mcp";

/** Calls a tool of the noyau's MCP server of a launched WebAiOs (config at `<dataDir>/espace/.webaios/mcp.json`). */
export const callTool = (dataDir: string, name: string, args: Record<string, unknown> = {}) => appelerOutil(join(dataDir, "espace"), name, args);
