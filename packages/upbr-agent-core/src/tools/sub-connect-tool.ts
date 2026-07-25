/**
 * sub_connect - Async communication tool between Agent and Subagent.
 *
 * Based on the spec: communication via NNG (nanomsg-next-generation).
 * For now, uses an in-process message queue as a fallback until
 * NNG bindings are available.
 *
 * The tool allows:
 * - Agent to send messages to a running Subagent
 * - Subagent to send messages back to the parent Agent
 */

import type { ToolConfig } from "../types";

// In-process message queues for subagent communication
const subagentMessageQueues = new Map<string, Array<{
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
  return subagentMessageQueues.get(subagentId) || [];
}

/**
 * Send a message to a subagent's queue.
 */
export function sendToSubagent(
  subagentId: string,
  content: string,
  from: "agent" | "subagent" = "agent"
): void {
  const queue = subagentMessageQueues.get(subagentId) || [];
  queue.push({ from, content, timestamp: Date.now() });
  subagentMessageQueues.set(subagentId, queue);
}

/**
 * Clear a subagent's message queue.
 */
export function clearSubagentMessages(subagentId: string): void {
  subagentMessageQueues.delete(subagentId);
}

export const subConnectTool: ToolConfig = {
  name: "sub_connect",
  description: "Send a message to a running subagent or receive messages from subagents. For async communication between Agent and Subagent.",
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
        description: "Action: 'send' to send a message, 'receive' to check for messages (default: 'send' if message is provided, otherwise 'receive')",
        enum: ["send", "receive"],
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
        output: `Message sent to subagent "${subagentId}"`,
        isError: false,
        metadata: { sent: true, subagentId },
      };
    }

    // Receive mode
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
