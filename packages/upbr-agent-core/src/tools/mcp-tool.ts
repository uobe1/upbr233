/**
 * MCP Tools - Agent tools for Model Context Protocol integration.
 *
 * mcp_connect: Connect to an MCP server via stdio (spawn as subprocess)
 * mcp_list_tools: List available tools from a connected MCP server
 * mcp_call_tool: Call a tool on a connected MCP server
 *
 * MCP servers are identified by a user-provided name (connection alias).
 * Multiple servers can be connected simultaneously.
 */

import type { ToolConfig } from "../types";
import { McpClient, type McpTool } from "../mcp/mcp-client";

// === Active MCP Connections ===

const mcpConnections = new Map<string, McpClient>();

export function getMcpConnections(): Map<string, McpClient> {
  return mcpConnections;
}

export function disconnectAllMcp(): void {
  for (const [name, client] of mcpConnections) {
    try { client.disconnect(); } catch { /* ignore */ }
  }
  mcpConnections.clear();
}

// === Tools ===

export const mcpConnectTool: ToolConfig = {
  name: "mcp_connect",
  description: "Connect to an MCP (Model Context Protocol) server. The server is spawned as a subprocess and communicates via stdio (JSON-RPC 2.0). Use this to access external tools provided by MCP servers.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Alias name for this MCP server connection (used with mcp_call_tool and mcp_list_tools)",
      },
      command: {
        type: "string",
        description: "Shell command to start the MCP server (e.g., 'npx', 'node', 'python')",
      },
      args: {
        type: "string",
        description: "Arguments for the command, space-separated (e.g., '-y @modelcontextprotocol/server-filesystem /tmp')",
      },
    },
    required: ["name", "command"],
  },
  requiresApproval: true, // MCP connections execute external commands
  handler: async (input) => {
    const name = input.name as string;
    const command = input.command as string;
    const argsStr = input.args as string | undefined;
    const args = argsStr ? argsStr.split(/\s+/).filter(Boolean) : [];

    // Check for duplicate connections
    if (mcpConnections.has(name)) {
      const existing = mcpConnections.get(name)!;
      if (existing.isConnected) {
        return {
          id: "",
          toolName: "mcp_connect",
          output: `MCP server "${name}" is already connected (${existing.info?.name || "unknown"} v${existing.info?.version || "?"}).`,
          isError: false,
          metadata: { name, connected: true, serverInfo: existing.info },
        };
      }
      // If disconnected, clean up
      mcpConnections.delete(name);
    }

    const client = new McpClient({ command, args });
    try {
      const info = await client.connect();
      mcpConnections.set(name, client);

      const tools = await client.listTools();

      return {
        id: "",
        toolName: "mcp_connect",
        output: [
          `Connected to MCP server "${name}":`,
          `  Server: ${info.name} v${info.version}`,
          `  Protocol: ${info.protocolVersion}`,
          `  Capabilities: ${JSON.stringify(Object.keys(info.capabilities))}`,
          `  Available tools: ${tools.length}`,
          tools.length > 0 ? `\nTools:\n${tools.map((t: McpTool) => `  - ${t.name}: ${t.description || "no description"}`).join("\n")}` : "",
        ].filter(Boolean).join("\n"),
        isError: false,
        metadata: { name, serverInfo: info, toolCount: tools.length },
      };
    } catch (e) {
      client.disconnect(); // kill orphaned process
      mcpConnections.delete(name);
      return {
        id: "",
        toolName: "mcp_connect",
        output: `Failed to connect to MCP server "${name}": ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};

export const mcpListToolsTool: ToolConfig = {
  name: "mcp_list_tools",
  description: "List available tools from one or all connected MCP servers.",
  inputSchema: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "MCP server alias name (omit to list tools from all connected servers)",
      },
    },
    required: [],
  },
  requiresApproval: false,
  handler: async (input) => {
    const serverName = input.server as string | undefined;

    if (serverName) {
      const client = mcpConnections.get(serverName);
      if (!client) {
        return {
          id: "",
          toolName: "mcp_list_tools",
          output: `MCP server "${serverName}" not found. Connected servers: ${[...mcpConnections.keys()].join(", ") || "none"}`,
          isError: true,
        };
      }

      if (!client.isConnected) {
        return {
          id: "",
          toolName: "mcp_list_tools",
          output: `MCP server "${serverName}" is disconnected.`,
          isError: true,
        };
      }

      try {
        const tools = await client.listTools();
        return {
          id: "",
          toolName: "mcp_list_tools",
          output: tools.length > 0
            ? `Tools from "${serverName}" (${client.info?.name}):\n${tools.map((t: McpTool) => `  - ${t.name}: ${t.description || "n/a"}`).join("\n")}`
            : `No tools available from "${serverName}".`,
          isError: false,
          metadata: { server: serverName, tools },
        };
      } catch (e) {
        return {
          id: "",
          toolName: "mcp_list_tools",
          output: `Error listing tools: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        };
      }
    }

    // List all servers
    if (mcpConnections.size === 0) {
      return {
        id: "",
        toolName: "mcp_list_tools",
        output: "No MCP servers connected. Use mcp_connect to connect to a server.",
        isError: false,
        metadata: { serverCount: 0 },
      };
    }

    const results: string[] = [];
    for (const [name, client] of mcpConnections) {
      if (!client.isConnected) continue;
      try {
        const tools = await client.listTools();
        results.push(`\n## ${name} (${client.info?.name})`);
        results.push(...tools.map((t: McpTool) => `  - ${t.name}: ${t.description || "n/a"}`));
      } catch {
        results.push(`\n## ${name} - Error fetching tools`);
      }
    }

    return {
      id: "",
      toolName: "mcp_list_tools",
      output: `MCP Tools (${mcpConnections.size} servers):\n${results.join("\n")}`,
      isError: false,
      metadata: { serverCount: mcpConnections.size },
    };
  },
};

export const mcpCallToolTool: ToolConfig = {
  name: "mcp_call_tool",
  description: "Call a tool on a connected MCP server. Use mcp_list_tools first to see available tools.",
  inputSchema: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "MCP server alias name",
      },
      tool: {
        type: "string",
        description: "Name of the tool to call (from mcp_list_tools output)",
      },
      arguments: {
        type: "object",
        description: "Arguments to pass to the tool",
      },
    },
    required: ["server", "tool"],
  },
  requiresApproval: true, // MCP tool calls can have side effects
  handler: async (input) => {
    const serverName = input.server as string;
    const toolName = input.tool as string;
    const args = (input.arguments as Record<string, unknown>) || {};

    const client = mcpConnections.get(serverName);
    if (!client) {
      return {
        id: "",
        toolName: "mcp_call_tool",
        output: `MCP server "${serverName}" not found. Connected: ${[...mcpConnections.keys()].join(", ") || "none"}`,
        isError: true,
      };
    }

    if (!client.isConnected) {
      return {
        id: "",
        toolName: "mcp_call_tool",
        output: `MCP server "${serverName}" is disconnected. Reconnect with mcp_connect.`,
        isError: true,
      };
    }

    try {
      const result = await client.callTool(toolName, args);
      const content = extractContent(result as Record<string, unknown>);

      return {
        id: "",
        toolName: "mcp_call_tool",
        output: `Result from "${serverName}"/${toolName}:\n${content}`,
        isError: false,
        metadata: { server: serverName, tool: toolName, raw: result },
      };
    } catch (e) {
      return {
        id: "",
        toolName: "mcp_call_tool",
        output: `Error calling "${toolName}" on "${serverName}": ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};

// === Helpers ===

/** Extract readable text from MCP tool result (supports MCP content types) */
function extractContent(result: Record<string, unknown>): string {
  // MCP results typically have a 'content' array of { type: "text", text: "..." }
  if (Array.isArray(result.content)) {
    const texts = result.content
      .filter((c: Record<string, unknown>) => c.type === "text")
      .map((c: Record<string, unknown>) => c.text as string)
      .filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
  }

  // Also check for direct 'text' field
  if (typeof result.text === "string") return result.text;

  // Fallback: JSON representation (truncated for safety)
  const text = JSON.stringify(result, null, 2);
  return text.length > 3000 ? text.slice(0, 3000) + "\n...[truncated]" : text;
}
