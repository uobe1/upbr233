/**
 * IPC Hub - NNG-style central message router.
 *
 * The Hub acts as a message broker following NNG patterns:
 * - REQ/REP: Command-response between Agent and Subagents
 * - PUB/SUB: Status broadcasts (started new IPC process, async task progress)
 * - PUSH/PULL: Async task work distribution
 *
 * Implementation:
 * - Uses Unix domain sockets (IPC transport)
 * - Falls back to in-process message channels (INPROC transport) for testing
 * - Each peer connects via a unique socket address with proper routing by peer ID
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer, Socket, type Server } from "node:net";
import type { IpcEnvelope, IpcMessageHandler, IpcPeerId } from "./types";

const IPC_DIR = join(process.env.HOME || "/tmp", ".upbr", "ipc");
const IPC_SOCKET = join(IPC_DIR, "hub.sock");

interface ClientInfo {
  socket: Socket;
  peerId: IpcPeerId;
}

export class IpcHub {
  private server: Server | null = null;
  /** peerId -> ClientInfo */
  private clients = new Map<IpcPeerId, ClientInfo>();
  /** Fallback: socket reference -> peerId for legacy clients */
  private socketToPeer = new Map<Socket, IpcPeerId>();
  private handlers = new Map<string, IpcMessageHandler[]>();
  private messageQueue = new Map<IpcPeerId, IpcEnvelope[]>();
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
    if (existsSync(IPC_SOCKET)) {
      try { unlinkSync(IPC_SOCKET); } catch { /* ignore */ }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        const connId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        let buffer = "";
        socket.on("data", (data: Buffer) => {
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const envelope: IpcEnvelope = JSON.parse(line);

              // Register the peer on first message from it
              if (envelope.payload) {
                const payload = JSON.parse(envelope.payload);
                if (payload.type === "register" && payload.peerId) {
                  this.registerClient(payload.peerId, socket);
                }
              }

              this.routeMessage(envelope);
            } catch { /* skip malformed */ }
          }
        });

        socket.on("close", () => {
          const peer = this.socketToPeer.get(socket);
          if (peer) {
            this.clients.delete(peer);
            this.socketToPeer.delete(socket);
          }
        });

        socket.on("error", () => {
          const peer = this.socketToPeer.get(socket);
          if (peer) {
            this.clients.delete(peer);
            this.socketToPeer.delete(socket);
          }
        });
      });

      this.server.on("error", (err) => {
        reject(err);
      });

      this.server.listen(IPC_SOCKET, () => resolve());
    });
  }

  /** Register a client peer with its socket */
  private registerClient(peerId: IpcPeerId, socket: Socket): void {
    this.clients.set(peerId, { socket, peerId });
    this.socketToPeer.set(socket, peerId);
    // Flush any queued messages for this peer
    this.flushQueue(peerId);
  }

  /** Connect to a hub as a client (Subagent/AsyncTask process) */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();

      socket.connect(IPC_SOCKET, () => {
        this.registerClient(this.peerId, socket);
        // Send registration
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
    for (const [, info] of this.clients) {
      try { info.socket.destroy(); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.socketToPeer.clear();

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

  /** Register a handler for a specific peer or wildcard "*" */
  on(peerId: IpcPeerId, handler: IpcMessageHandler): void {
    const handlers = this.handlers.get(peerId) || [];
    handlers.push(handler);
    this.handlers.set(peerId, handlers);
  }

  /** Send a message to a specific peer, properly routed */
  async send(envelope: IpcEnvelope): Promise<void> {
    const data = JSON.stringify(envelope) + "\n";

    // Route to the specific peer if connected
    const client = this.clients.get(envelope.to);
    if (client && !client.socket.destroyed) {
      client.socket.write(data);
      return;
    }

    // If peer not connected, queue the message
    const queue = this.messageQueue.get(envelope.to) || [];
    queue.push(envelope);
    this.messageQueue.set(envelope.to, queue);
  }

  /** Flush queued messages for a peer that just connected */
  private flushQueue(peerId: IpcPeerId): void {
    const queue = this.messageQueue.get(peerId);
    if (!queue || queue.length === 0) return;

    const client = this.clients.get(peerId);
    if (!client || client.socket.destroyed) return;

    for (const envelope of queue) {
      client.socket.write(JSON.stringify(envelope) + "\n");
    }
    this.messageQueue.delete(peerId);
  }

  /** Get the agent peer ID */
  getPeerId(): IpcPeerId {
    return this.peerId;
  }

  /** Check if any clients are connected */
  get connectedCount(): number {
    return this.clients.size;
  }

  // === Internal ===

  private routeMessage(envelope: IpcEnvelope): void {
    const peerHandlers = this.handlers.get(envelope.to) || [];
    const wildcardHandlers = this.handlers.get("*") || [];

    for (const handler of [...peerHandlers, ...wildcardHandlers]) {
      handler(envelope).catch(() => { /* handler errors non-fatal */ });
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
}
