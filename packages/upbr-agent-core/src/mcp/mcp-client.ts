/**
 * MCP Client - Minimal Model Context Protocol implementation.
 *
 * Implements the core MCP spec (JSON-RPC 2.0 over stdio) for:
 * - initialize: Capability negotiation
 * - tools/list: Discover MCP server tools
 * - tools/call: Call MCP server tools
 * - resources/list: Discover resources
 * - prompts/list: Discover prompt templates
 *
 * Architecture:
 *   Client spawns MCP server as a subprocess via stdio.
 *   Messages are newline-delimited JSON-RPC 2.0 over stdin/stdout.
 *   Supports multiple concurrent MCP server connections.
 */

import { spawn, type ChildProcess } from "node:child_process";

// === JSON-RPC 2.0 Types ===

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id: number | string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// === MCP Types ===

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
}

// === MCP Client ===

export class McpClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number | string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private serverInfo: McpServerInfo | null = null;
  private buffer = "";
  private connected = false;
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;

  constructor(options: {
    command: string;
    args?: string[];
    timeoutMs?: number;
  }) {
    this.command = options.command;
    this.args = options.args || [];
    this.timeoutMs = options.timeoutMs || 30000;
  }

  /** Connect to the MCP server by spawning it as a subprocess */
  async connect(): Promise<McpServerInfo> {
    if (this.connected) return this.serverInfo!;

    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let initDone = false;

      this.process.stdout?.on("data", (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.handleMessage(msg);
          } catch { /* skip malformed */ }
        }
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        // MCP servers may log to stderr; we ignore it for now
      });

      this.process.on("error", (err) => {
        if (!initDone) reject(err);
      });

      this.process.on("close", (code) => {
        this.connected = false;
        this.process = null;
        // Reject all pending requests
        for (const [, p] of this.pending) {
          p.reject(new Error(`MCP server closed with code ${code}`));
          clearTimeout(p.timer);
        }
        this.pending.clear();
      });

      // Send initialize
      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        clientInfo: {
          name: "upbr233",
          version: "0.1.0",
        },
      }).then((res) => {
        this.serverInfo = res as McpServerInfo;
        this.connected = true;
        initDone = true;
        // Send initialized notification
        this.sendNotification("notifications/initialized");
        resolve(this.serverInfo);
      }).catch(reject);
    });
  }

  /** List available tools from the MCP server */
  async listTools(): Promise<McpTool[]> {
    const result = await this.sendRequest("tools/list");
    return ((result as Record<string, unknown>)?.tools as McpTool[]) || [];
  }

  /** Call a tool on the MCP server */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.sendRequest("tools/call", { name, arguments: args });
  }

  /** List available resources */
  async listResources(): Promise<McpResource[]> {
    const result = await this.sendRequest("resources/list");
    return ((result as Record<string, unknown>)?.resources as McpResource[]) || [];
  }

  /** List available prompts */
  async listPrompts(): Promise<McpPrompt[]> {
    const result = await this.sendRequest("prompts/list");
    return ((result as Record<string, unknown>)?.prompts as McpPrompt[]) || [];
  }

  /** Disconnect and kill the server process */
  disconnect(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connected = false;
    this.serverInfo = null;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get info(): McpServerInfo | null {
    return this.serverInfo;
  }

  // === Private ===

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.process) throw new Error("Not connected");

    const id = ++this.requestId;
    const request: JsonRpcRequest = { jsonrpc: "2.0", method, params, id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method} (${this.timeoutMs}ms)`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage(request);
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.writeMessage(notification);
  }

  private writeMessage(msg: unknown): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(JSON.stringify(msg) + "\n");
    }
  }

  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    // Check if it's a response (has id)
    if ("id" in msg && msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      if (msg.error) {
        pending.reject(new Error(`MCP Error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
    // Notifications are handled by event listeners (future)
  }
}
