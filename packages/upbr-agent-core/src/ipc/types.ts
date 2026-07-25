/**
 * IPC Message Types - follows NNG (nanomsg-next-generation) patterns.
 *
 * Transport layers:
 *   IPC  - Unix domain socket (inter-process, default)
 *   INPROC - In-process channel (fallback for testing)
 *
 * Protocol patterns (from NNG scalability protocols):
 *   REQ/REP  - Request/Reply (sub_connect commands)
 *   PUB/SUB  - Publish/Subscribe (status broadcasts, async task progress)
 *   PUSH/PULL - Pipeline (async task distribution)
 */

// === Envelope ===

export interface IpcEnvelope {
  /** Unique message ID */
  id: string;
  /** Message type - determines how the message is handled */
  type: IpcMessageType;
  /** Sender ID (agent, subagent_xxx, async_xxx) */
  from: IpcPeerId;
  /** Recipient ID (agent, subagent_xxx, async_xxx) */
  to: IpcPeerId;
  /** Payload data */
  payload: string;
  /** Unix timestamp in ms */
  timestamp: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export type IpcPeerId = string;
export type IpcMessageType = "REQUEST" | "RESPONSE" | "NOTIFY" | "ERROR" | "HEARTBEAT";

// === NNG-style Socket Abstraction ===

export type IpcSocketType = "REQ" | "REP" | "PUB" | "SUB" | "PUSH" | "PULL";

export interface IpcSocketConfig {
  /** Socket type (NNG protocol pattern) */
  socketType: IpcSocketType;
  /** The peer ID this socket represents */
  peerId: IpcPeerId;
  /** Transport: 'ipc' for unix sockets, 'inproc' for in-process */
  transport: "ipc" | "inproc";
  /** Address to dial or listen on (ipc:///path/to/socket, inproc://name) */
  address?: string;
}

export interface IpcSocket {
  readonly config: IpcSocketConfig;
  /** Start listening (server mode) */
  listen(address: string): Promise<void>;
  /** Connect to a listener (client mode) */
  dial(address: string): Promise<void>;
  /** Send a message */
  send(envelope: IpcEnvelope): Promise<void>;
  /** Receive a message (returns null if no message available) */
  recv(timeoutMs?: number): Promise<IpcEnvelope | null>;
  /** Close the socket */
  close(): Promise<void>;
}

// === IPC Hub (Message Router) ===

export interface IpcHubConfig {
  /** Directory for IPC socket files */
  socketDir?: string;
  /** Hub peer ID (defaults to 'agent') */
  peerId?: IpcPeerId;
}

export type IpcMessageHandler = (envelope: IpcEnvelope) => Promise<void>;

// === Subagent IPC ===

export interface SubagentIpcMessage {
  /** Subagent ID */
  subagentId: string;
  /** Action type */
  action: "spawn" | "message" | "terminate" | "status";
  /** Content for message action */
  content?: string;
  /** Spawn configuration */
  config?: {
    name: string;
    prompt: string;
    tools: string[];
  };
}

// === Async Task IPC ===

export interface AsyncTaskIpcMessage {
  /** Task ID */
  taskId: string;
  /** Tool to execute */
  toolName: string;
  /** Tool input */
  input: Record<string, unknown>;
  /** Task status */
  status?: "running" | "completed" | "failed";
  /** Result output */
  result?: string;
  /** Error message */
  error?: string;
  /** Progress percentage (0-100) */
  progress?: number;
}
