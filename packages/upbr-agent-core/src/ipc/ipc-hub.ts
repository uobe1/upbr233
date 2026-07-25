/**
 * IPC Hub - NNG-style central message router.
 *
 * The Hub acts as a message broker following NNG patterns:
 * - REQ/REP: Command-response between Agent and Subagents
 * - PUB/SUB: Status broadcasts (started new IPC process, async task progress)
 * - PUSH/PULL: Async task work distribution
 *
 * Implementation:
 * - Uses Unix domain sockets (IPC transport) when available
 * - Falls back to in-process message channels (INPROC transport) for testing
 * - Each peer connects via a unique socket address
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { IpcEnvelope, IpcMessageHandler, IpcPeerId } from "./types";

const IPC_DIR = join(process.env.HOME || "/tmp", ".upbr", "ipc");
const IPC_SOCKET = join(IPC_DIR, "hub.sock");
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 100;

export class IpcHub {
  private server: Server | null = null;
  private clients = new Map<string, Socket>();
  private handlers = new Map<string, IpcMessageHandler[]>();
  private messageQueue = new Map<string, IpcEnvelope[]>();
  private peerId: IpcPeerId;

  constructor(peerId: IpcPeerId = "agent") {
    this.peerId = peerId;
    if (!existsSync(IPC_DIR)) {
      mkdirSync(IPC_DIR, { recursive: true });
    }
  }

  // === Lifecycle ===

  /** Start the hub as a server (main Agent process) */
  async start(): Promise<void> {
    // Clean up stale socket
    if (existsSync(IPC_SOCKET)) {
      try { unlinkSync(IPC_SOCKET); } catch { /* ignore */ }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.clients.set(clientId, socket);
        this.emit("__hub:connect", this.createEnvelope("NOTIFY", clientId, { event: "connected" }));

        let buffer = "";

        socket.on("data", (data: Buffer) => {
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const envelope: IpcEnvelope = JSON.parse(line);
              this.routeMessage(envelope);
            } catch { /* skip malformed */ }
          }
        });

        socket.on("close", () => {
          this.clients.delete(clientId);
          this.emit("__hub:disconnect", this.createEnvelope("NOTIFY", clientId, { event: "disconnected" }));
        });

        socket.on("error", () => {
          this.clients.delete(clientId);
        });
      });

      this.server.on("error", reject);
      this.server.listen(IPC_SOCKET, () => resolve());
    });
  }

  /** Connect to a hub as a client (Subagent/AsyncTask process) */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const clientId = this.peerId;
      this.clients.set(clientId, socket);

      socket.connect(IPC_SOCKET, () => {
        // Register our peer
        const envelope = this.createEnvelope("NOTIFY", "agent", {
          type: "register",
          peerId: this.peerId,
        });
        socket.write(JSON.stringify(envelope) + "\n");
        resolve();
      });

      let buffer = "";
      socket.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const envelope: IpcEnvelope = JSON.parse(line);
            this.routeMessage(envelope);
          } catch { /* skip */ }
        }
      });

      socket.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("IPC Hub not running. Start the main agent first."));
        } else {
          reject(err);
        }
      });
    });
  }

  /** Stop the hub */
  async stop(): Promise<void> {
    for (const [, socket] of this.clients) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.clients.clear();

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null;
          if (existsSync(IPC_SOCKET)) {
            try { unlinkSync(IPC_SOCKET); } catch { /* ignore */ }
          }
          resolve();
        });
      });
    }
  }

  // === Message Routing ===

  /** Register a handler for a specific peer */
  on(peerId: IpcPeerId, handler: IpcMessageHandler): void {
    const handlers = this.handlers.get(peerId) || [];
    handlers.push(handler);
    this.handlers.set(peerId, handlers);
  }

  /** Send a message to a peer */
  async send(envelope: IpcEnvelope): Promise<void> {
    const data = JSON.stringify(envelope) + "\n";

    // Check if the recipient is a directly connected client
    for (const [id, socket] of this.clients) {
      if (id === envelope.to || envelope.to === "agent") {
        if (!socket.destroyed) {
          socket.write(data);
          return;
        }
      }
    }

    // If no direct client, queue the message
    const queue = this.messageQueue.get(envelope.to) || [];
    queue.push(envelope);
    this.messageQueue.set(envelope.to, queue);
  }

  /** Flush queued messages for a peer that just connected */
  flushQueue(peerId: IpcPeerId): void {
    const queue = this.messageQueue.get(peerId);
    if (!queue) return;

    for (const envelope of queue) {
      const data = JSON.stringify(envelope) + "\n";
      for (const [, socket] of this.clients) {
        if (!socket.destroyed) {
          socket.write(data);
          break;
        }
      }
    }
    this.messageQueue.delete(peerId);
  }

  // === Helpers ===

  private routeMessage(envelope: IpcEnvelope): void {
    // Route to specific peer handlers
    const peerHandlers = this.handlers.get(envelope.to) || [];
    const wildcardHandlers = this.handlers.get("*") || [];

    for (const handler of [...peerHandlers, ...wildcardHandlers]) {
      handler(envelope).catch(() => { /* handler errors are non-fatal */ });
    }
  }

  private createEnvelope(
    type: IpcEnvelope["type"],
    to: IpcPeerId,
    payload: unknown
  ): IpcEnvelope {
    return {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      from: this.peerId,
      to,
      payload: JSON.stringify(payload),
      timestamp: Date.now(),
    };
  }

  private emit(event: string, envelope: IpcEnvelope): void {
    this.routeMessage({
      ...envelope,
      payload: JSON.stringify({ ...JSON.parse(envelope.payload), event }),
    });
  }
}
