/**
 * sub_connect - Async communication tool between Agent and Subagent.
 *
 * Based on NNG (nanomsg-next-generation) REQ/REP pattern.
 * Uses Unix domain socket IPC for cross-process communication.
 *
 * The tool allows:
 * - Agent to send messages to a running Subagent
 * - Subagent to send messages back to the parent Agent
 */

import type { ToolConfig } from "../types";
import { IpcHub } from "../ipc/ipc-hub";
import type { IpcEnvelope } from "../ipc/types";

/** Global IPC hub instance - set by the main Agent process */
let ipcHub: IpcHub | null = null;

/** Set the IPC hub for tool communication */
export function setSubConnectIpcHub(hub: IpcHub): void {
  ipcHub = hub;
}

/** Get the IPC hub instance */
export function getSubConnectIpcHub(): IpcHub | null {
  return ipcHub;
}

// In-process fallback message queues (used when IPC hub is not available)
const fallbackQueues = new Map<string, Array<{
  from: "agent" | "subagent";
  content: string;
  timestamp: number;
}>>();

/**
 * Get the message queue for a subagent.
 */
export function getSubagentMessages(subagentId: string): Array<{
  from: "agent" | "subagent";
  content: string;
  timestamp: number;
}> {
  return fallbackQueues.get(subagentId) || [];
}

/**
 * Send a message to a subagent's queue (via IPC or fallback).
 */
export function sendToSubagent(
  subagentId: string,
  content: string,
  from: "agent" | "subagent" = "agent"
): void {
  // Try IPC first
  if (ipcHub) {
    const envelope: IpcEnvelope = {
      id: `subconn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "REQUEST",
      from,
      to: subagentId,
      payload: JSON.stringify({ action: "message", content }),
      timestamp: Date.now(),
    };
    ipcHub.send(envelope).catch(() => {
      // Fallback on IPC failure
      const queue = fallbackQueues.get(subagentId) || [];
      queue.push({ from, content, timestamp: Date.now() });
      fallbackQueues.set(subagentId, queue);
    });
    return;
  }

  // Fallback to in-process queue
  const queue = fallbackQueues.get(subagentId) || [];
  queue.push({ from, content, timestamp: Date.now() });
  fallbackQueues.set(subagentId, queue);
}

/**
 * Clear a subagent's message queue.
 */
export function clearSubagentMessages(subagentId: string): void {
  fallbackQueues.delete(subagentId);
}

export const subConnectTool: ToolConfig = {
  name: "sub_connect",
  description: "Send a message to a running subagent or receive messages from subagents. Uses NNG-style IPC (Unix domain sockets) for cross-process communication.",
  inputSchema: {
    type: "object",
    properties: {
      subagentId: {
        type: "string",
        description: "ID of the subagent to communicate with",
      },
      message: {
        type: "string",
        description: "Message to send to the subagent. If omitted, retrieves pending messages.",
      },
      action: {
        type: "string",
        description: "Action: 'send' to send a message, 'receive' to check for pending messages (default: 'send' if message is provided, otherwise 'receive')",
      },
    },
    required: ["subagentId"],
  },
  requiresApproval: false,
  handler: async (input) => {
    const subagentId = input.subagentId as string;
    const message = input.message as string | undefined;
    const action = (input.action as string) || (message ? "send" : "receive");

    if (action === "send" && message) {
      sendToSubagent(subagentId, message, "agent");
      return {
        id: "",
        toolName: "sub_connect",
        output: `Message sent to subagent "${subagentId}" via ${ipcHub ? "IPC" : "in-process"}.`,
        isError: false,
        metadata: { sent: true, subagentId, transport: ipcHub ? "ipc" : "inproc" },
      };
    }

    // Receive mode - check both IPC and fallback
    const messages = getSubagentMessages(subagentId);
    clearSubagentMessages(subagentId);

    if (messages.length === 0) {
      return {
        id: "",
        toolName: "sub_connect",
        output: `No pending messages from subagent "${subagentId}".`,
        isError: false,
        metadata: { subagentId, messageCount: 0 },
      };
    }

    const formatted = messages
      .map((m) => `[${m.from}] ${new Date(m.timestamp).toISOString()}\n${m.content}`)
      .join("\n\n");

    return {
      id: "",
      toolName: "sub_connect",
      output: `Messages from subagent "${subagentId}" (${messages.length}):\n\n${formatted}`,
      isError: false,
      metadata: { subagentId, messageCount: messages.length },
    };
  },
};
