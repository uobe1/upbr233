/**
 * Session Store - persistence layer for agent sessions.
 *
 * Stores:
 * - Conversation timeline entries
 * - Agent state and configuration
 * - Tool approval history
 * - MMP memory state
 *
 * Uses SQLite for durable storage so sessions survive CLI restarts.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TimelineEntry } from "./types";

interface StoredSession {
  id: string;
  name: string;
  mode: string;
  model: string;
  provider: string;
  created_at: number;
  updated_at: number;
  metadata: string;
}

export class SessionStore {
  private db: Database;

  constructor(storageDir?: string) {
    const dir = storageDir || join(process.env.HOME || "/tmp", ".upbr", "sessions");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(join(dir, "sessions.db"));
    this.initDb();
  }

  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT DEFAULT 'build',
        model TEXT DEFAULT '',
        provider TEXT DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS timeline_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        timestamp INTEGER NOT NULL,
        parent_id TEXT,
        branch_id TEXT,
        entry_order INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS tool_approvals (
        tool_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tool_name, session_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline_entries(session_id, entry_order);
      CREATE INDEX IF NOT EXISTS idx_timeline_type ON timeline_entries(session_id, type);
    `);
  }

  // === Session Management ===

  createSession(options: {
    id?: string;
    name?: string;
    mode?: string;
    model?: string;
    provider?: string;
  }): StoredSession {
    const id = options.id || `session_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO sessions (id, name, mode, model, provider, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
    `).run(
      id,
      options.name || "Untitled Session",
      options.mode || "build",
      options.model || "",
      options.provider || "",
      now,
      now
    );

    return this.getSession(id)!;
  }

  getSession(id: string): StoredSession | null {
    return this.db
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(id) as StoredSession | null;
  }

  listSessions(limit = 20): StoredSession[] {
    return this.db
      .query("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as StoredSession[];
  }

  updateSession(id: string, updates: Partial<StoredSession>): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push("name = ?"); values.push(updates.name); }
    if (updates.mode !== undefined) { setClauses.push("mode = ?"); values.push(updates.mode); }
    if (updates.model !== undefined) { setClauses.push("model = ?"); values.push(updates.model); }
    if (updates.provider !== undefined) { setClauses.push("provider = ?"); values.push(updates.provider); }

    setClauses.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    this.db.prepare(`UPDATE sessions SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM timeline_entries WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM tool_approvals WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // === Timeline Entry Persistence ===

  saveEntry(sessionId: string, entry: TimelineEntry, order: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO timeline_entries (id, session_id, type, content, metadata, timestamp, parent_id, branch_id, entry_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      sessionId,
      entry.type,
      entry.content,
      JSON.stringify(entry.metadata),
      entry.timestamp,
      entry.parentId,
      entry.branchId || null,
      order
    );

    // Update session timestamp
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(Date.now(), sessionId);
  }

  loadEntries(sessionId: string): TimelineEntry[] {
    const rows = this.db
      .query(
        "SELECT * FROM timeline_entries WHERE session_id = ? ORDER BY entry_order ASC"
      )
      .all(sessionId) as Array<{
        id: string;
        type: string;
        content: string;
        metadata: string;
        timestamp: number;
        parent_id: string | null;
        branch_id: string | null;
      }>;

    return rows.map((r) => ({
      id: r.id,
      type: r.type as TimelineEntry["type"],
      content: r.content,
      metadata: JSON.parse(r.metadata || "{}"),
      timestamp: r.timestamp,
      parentId: r.parent_id,
      branchId: r.branch_id || undefined,
    }));
  }

  deleteEntriesAfter(sessionId: string, entryId: string): number {
    // Find the order of the specified entry
    const entry = this.db
      .query(
        "SELECT entry_order FROM timeline_entries WHERE id = ? AND session_id = ?"
      )
      .get(entryId, sessionId) as { entry_order: number } | null;

    if (!entry) return 0;

    const result = this.db
      .prepare(
        "DELETE FROM timeline_entries WHERE session_id = ? AND entry_order >= ?"
      )
      .run(sessionId, entry.entry_order);

    return result.changes;
  }

  // === Tool Approval Persistence ===

  saveApproval(sessionId: string, toolName: string, approved: boolean): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tool_approvals (tool_name, session_id, approved)
      VALUES (?, ?, ?)
    `).run(toolName, sessionId, approved ? 1 : 0);
  }

  loadApprovals(sessionId: string): Set<string> {
    const rows = this.db
      .query(
        "SELECT tool_name FROM tool_approvals WHERE session_id = ? AND approved = 1"
      )
      .all(sessionId) as Array<{ tool_name: string }>;

    return new Set(rows.map((r) => r.tool_name));
  }

  // === Utilities ===

  close(): void {
    this.db.close();
  }
}
