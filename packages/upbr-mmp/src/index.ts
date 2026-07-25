/**
 * Memory Manager Pro (MMP) - Built-in Plugin for UPBR233
 *
 * PackageName: mmp
 *
 * Implements DAG (Directed Acyclic Graph) based memory management
 * for long-term conversation memory.
 *
 * Architecture (inspired by lossless-claw-enhanced):
 * - DAG of memory nodes (raw messages → summaries → meta-summaries)
 * - SQLite-based persistence
 * - Hierarchical summarization cascade
 * - On-demand expansion of compressed nodes
 *
 * Triggers:
 * - Auto-compaction when context reaches 75% of max tokens
 * - Manual compaction via tool call
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// === Types ===

interface MemoryNode {
  id: string;
  parent_id: string | null;
  content: string;
  summary: string | null;
  token_count: number;
  level: number;           // 0 = raw, 1 = summary, 2 = meta-summary
  created_at: number;
  updated_at: number;
  session_id: string;
  metadata: string;        // JSON metadata
}

interface DAGEdge {
  parent_id: string;
  child_id: string;
  weight: number;
}

// === MMP Core ===

export class MemoryManagerPro {
  private db: Database;
  private sessionId: string;
  private maxTokens: number;
  private compactionThreshold: number;

  constructor(options: {
    storageDir?: string;
    maxTokens?: number;
    compactionThreshold?: number;
    sessionId?: string;
  }) {
    this.maxTokens = options.maxTokens || 100000;
    this.compactionThreshold = options.compactionThreshold || 0.75;
    this.sessionId = options.sessionId || `session_${Date.now()}`;

    const dir = options.storageDir || join(process.env.HOME || "/tmp", ".upbr", "memory");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const dbPath = join(dir, "mmp.db");
    this.db = new Database(dbPath);
    this.initDb();
  }

  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        content TEXT NOT NULL,
        summary TEXT,
        token_count INTEGER DEFAULT 0,
        level INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        FOREIGN KEY (parent_id) REFERENCES memory_nodes(id)
      );

      CREATE TABLE IF NOT EXISTS memory_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        FOREIGN KEY (parent_id) REFERENCES memory_nodes(id),
        FOREIGN KEY (child_id) REFERENCES memory_nodes(id),
        UNIQUE(parent_id, child_id)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_session ON memory_nodes(session_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_level ON memory_nodes(session_id, level);
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON memory_nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_edges_parent ON memory_edges(parent_id);
      CREATE INDEX IF NOT EXISTS idx_edges_child ON memory_edges(child_id);
    `);
  }

  /**
   * Add a raw message node (level 0).
   */
  addMessage(
    content: string,
    metadata: Record<string, unknown> = {}
  ): MemoryNode {
    const stmt = this.db.prepare(`
      INSERT INTO memory_nodes (id, parent_id, content, token_count, level, created_at, updated_at, session_id, metadata)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
    `);

    const id = `mem_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const tokenCount = this.estimateTokens(content);

    stmt.run(
      id, null, content, tokenCount, now, now,
      this.sessionId, JSON.stringify(metadata)
    );

    const node = this.getNode(id);
    if (!node) throw new Error("Failed to create node");
    return node;
  }

  /**
   * Get a memory node by ID.
   */
  getNode(id: string): MemoryNode | null {
    return this.db
      .query("SELECT * FROM memory_nodes WHERE id = ?")
      .get(id) as MemoryNode | null;
  }

  /**
   * Get all raw (level 0) nodes in the current session.
   */
  getRawNodes(limit: number = 50): MemoryNode[] {
    return this.db
      .query(
        "SELECT * FROM memory_nodes WHERE session_id = ? AND level = 0 ORDER BY created_at DESC LIMIT ?"
      )
      .all(this.sessionId, limit) as MemoryNode[];
  }

  /**
   * Get the total token count for raw nodes.
   */
  getRawTokenCount(): number {
    const result = this.db
      .query(
        "SELECT COALESCE(SUM(token_count), 0) as total FROM memory_nodes WHERE session_id = ? AND level = 0"
      )
      .get(this.sessionId) as { total: number };
    return result.total;
  }

  /**
   * Check if compaction is needed.
   */
  needsCompaction(): boolean {
    const tokenCount = this.getRawTokenCount();
    return tokenCount > this.maxTokens * this.compactionThreshold;
  }

  /**
   * Compact: summarize the oldest raw nodes and create a summary node (level 1).
   * Uses the provided summarize function (typically an LLM call).
   *
   * Returns the created summary node.
   */
  compact(
    summarize: (text: string) => Promise<string>
  ): Promise<MemoryNode | null> {
    return this.compactLevel(0, 1, summarize);
  }

  /**
   * Build the DAG context: traverse from root summaries down,
   * filling the context budget with the most relevant memory nodes.
   */
  buildContext(maxTokens: number): string {
    const parts: string[] = [];
    let tokenBudget = maxTokens;

    // First, get recent raw nodes (tail)
    const recentRaw = this.db
      .query(
        "SELECT * FROM memory_nodes WHERE session_id = ? AND level = 0 ORDER BY created_at DESC LIMIT 20"
      )
      .all(this.sessionId) as MemoryNode[];

    const tailParts: string[] = [];
    for (const node of recentRaw.reverse()) {
      if (tokenBudget <= 0) break;
      tailParts.push(node.content);
      tokenBudget -= node.token_count;
    }

    // Then, get summaries (level 1) for older context
    const summaries = this.db
      .query(
        "SELECT * FROM memory_nodes WHERE session_id = ? AND level = 1 AND summary IS NOT NULL ORDER BY created_at ASC"
      )
      .all(this.sessionId) as MemoryNode[];

    const summaryParts: string[] = [];
    for (const node of summaries) {
      if (tokenBudget <= 0) break;
      if (node.summary) {
        summaryParts.push(`[Summary] ${node.summary}`);
        tokenBudget -= this.estimateTokens(node.summary);
      }
    }

    // Meta-summaries (level 2)
    const metaSummaries = this.db
      .query(
        "SELECT * FROM memory_nodes WHERE session_id = ? AND level = 2 AND summary IS NOT NULL"
      )
      .all(this.sessionId) as MemoryNode[];

    const metaParts: string[] = [];
    for (const node of metaSummaries) {
      if (tokenBudget <= 0) break;
      if (node.summary) {
        metaParts.push(`[Overview] ${node.summary}`);
        tokenBudget -= this.estimateTokens(node.summary);
      }
    }

    if (metaParts.length > 0) {
      parts.push("## Session Overview\n" + metaParts.join("\n"));
    }
    if (summaryParts.length > 0) {
      parts.push("## Earlier Context\n" + summaryParts.join("\n"));
    }
    if (tailParts.length > 0) {
      parts.push("## Recent Conversation\n" + tailParts.join("\n"));
    }

    return parts.join("\n\n");
  }

  /**
   * Expand a summary node to reveal its children.
   */
  expandNode(nodeId: string): MemoryNode[] {
    return this.db
      .query(
        "SELECT * FROM memory_nodes WHERE parent_id = ? ORDER BY created_at ASC"
      )
      .all(nodeId) as MemoryNode[];
  }

  /**
   * Search memory nodes by content (simple text search via SQLite FTS-like).
   */
  search(query: string, limit: number = 10): MemoryNode[] {
    return this.db
      .query(
        "SELECT * FROM memory_nodes WHERE session_id = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(this.sessionId, `%${query}%`, limit) as MemoryNode[];
  }

  /**
   * Create an edge between two nodes in the DAG.
   */
  addEdge(parentId: string, childId: string, weight: number = 1.0): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO memory_edges (parent_id, child_id, weight) VALUES (?, ?, ?)"
      )
      .run(parentId, childId, weight);
  }

  /**
   * Get all children of a node.
   */
  getChildren(nodeId: string): MemoryNode[] {
    const edges = this.db
      .query("SELECT child_id FROM memory_edges WHERE parent_id = ?")
      .all(nodeId) as Array<{ child_id: string }>;

    if (edges.length === 0) return [];

    const placeholders = edges.map(() => "?").join(",");
    const ids = edges.map((e) => e.child_id);

    return this.db
      .query(`SELECT * FROM memory_nodes WHERE id IN (${placeholders})`)
      .all(...ids) as MemoryNode[];
  }

  /**
   * Get the DAG statistics.
   */
  getStats(): MMPStats {
    const nodeCount = this.db
      .query("SELECT COUNT(*) as count FROM memory_nodes WHERE session_id = ?")
      .get(this.sessionId) as { count: number };

    const edgeCount = this.db
      .query(
        `SELECT COUNT(*) as count FROM memory_edges e
         JOIN memory_nodes n ON e.parent_id = n.id
         WHERE n.session_id = ?`
      )
      .get(this.sessionId) as { count: number };

    const totalTokens = this.getRawTokenCount();

    const levelCounts = this.db
      .query(
        "SELECT level, COUNT(*) as count FROM memory_nodes WHERE session_id = ? GROUP BY level"
      )
      .all(this.sessionId) as Array<{ level: number; count: number }>;

    return {
      sessionId: this.sessionId,
      nodeCount: nodeCount.count,
      edgeCount: edgeCount.count,
      totalTokens,
      levelDistribution: Object.fromEntries(
        levelCounts.map((l) => [l.level, l.count])
      ),
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  // === Private Helpers ===

  private async compactLevel(
    sourceLevel: number,
    targetLevel: number,
    summarize: (text: string) => Promise<string>
  ): Promise<MemoryNode | null> {
    // Get raw nodes, oldest first
    const nodes = this.db
      .query(
        `SELECT * FROM memory_nodes
         WHERE session_id = ? AND level = ?
         ORDER BY created_at ASC
         LIMIT 30`
      )
      .all(this.sessionId, sourceLevel) as MemoryNode[];

    if (nodes.length === 0) return null;

    // Combine content
    const combined = nodes
      .map((n) => n.content)
      .join("\n\n");

    // Generate summary
    const summary = await summarize(combined);

    // Create summary node
    const summaryId = `summary_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO memory_nodes (id, parent_id, content, summary, token_count, level, created_at, updated_at, session_id, metadata)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, '{}')`
      )
      .run(
        summaryId,
        combined,
        summary,
        this.estimateTokens(summary),
        targetLevel,
        now,
        now,
        this.sessionId
      );

    // Link as parent of the source nodes
    for (const node of nodes) {
      this.db
        .prepare("UPDATE memory_nodes SET parent_id = ? WHERE id = ?")
        .run(summaryId, node.id);
      this.addEdge(summaryId, node.id);
    }

    return this.getNode(summaryId);
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token for English, ~2 for CJK
    const cjkChars = (
      text.match(
        /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g
      ) || []
    ).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars / 2 + otherChars / 4) + 1;
  }
}

export interface MMPStats {
  sessionId: string;
  nodeCount: number;
  edgeCount: number;
  totalTokens: number;
  levelDistribution: Record<number, number>;
}

/**
 * Plugin interface for MMP.
 * Can be installed via: upbr plugin --install @plugin:upbr:mmp
 */
export const mmpPlugin = {
  name: "mmp",
  description: "Memory Manager Pro - DAG-based long-term memory",
  version: "0.1.0",
  factory: (options?: Record<string, unknown>) =>
    new MemoryManagerPro((options || {}) as ConstructorParameters<typeof MemoryManagerPro>[0]),
};

export default MemoryManagerPro;
