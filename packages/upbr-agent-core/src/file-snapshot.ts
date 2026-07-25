/**
 * File Snapshot System - enables file revert on timeline withdraw.
 *
 * Uses git stash to create lightweight snapshots before each
 * file-modifying tool call. On withdraw, reverts via git stash pop.
 * No git commits are created, so the user's git history stays clean.
 */

import { spawn } from "node:child_process";

interface Snapshot {
  id: string;
  toolCallId: string;
  stashIndex: number; // index in `git stash list`
  timestamp: number;
}

export class FileSnapshotManager {
  private snapshots: Snapshot[] = [];
  private enabled: boolean;
  private repoPath: string;

  constructor(options?: { enabled?: boolean; repoPath?: string }) {
    this.enabled = options?.enabled ?? true;
    this.repoPath = options?.repoPath ?? process.cwd();
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a snapshot using git stash before a file-modifying tool call.
   * Uses: git stash push --include-untracked -m "upbr233:<toolCallId>"
   */
  async createSnapshot(toolCallId: string): Promise<Snapshot | null> {
    if (!this.enabled) return null;

    try {
      const status = await this.git(["status", "--porcelain"]);
      if (!status.trim()) return null;

      const msg = `upbr233:snapshot:${toolCallId}`;
      await this.git(["stash", "push", "--include-untracked", "-m", msg]);

      // Find the stash index just created (most recent = 0)
      const stashList = await this.git(["stash", "list"]);
      const stashIndex = stashList.split("\n").filter(Boolean).length - 1;

      const snapshot: Snapshot = {
        id: `snap_${Date.now()}`,
        toolCallId,
        stashIndex,
        timestamp: Date.now(),
      };

      this.snapshots.push(snapshot);
      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Revert to a snapshot by applying the stash and dropping it.
   */
  async revertToSnapshot(snapshotId: string): Promise<boolean> {
    const idx = this.snapshots.findIndex((s) => s.id === snapshotId);
    if (idx === -1) return false;

    const snapshot = this.snapshots[idx]!;

    try {
      // Apply and drop the stash
      await this.git(["stash", "apply", `stash@{${snapshot.stashIndex}}`]);
      await this.git(["stash", "drop", `stash@{${snapshot.stashIndex}}`]);
      this.snapshots = this.snapshots.slice(0, idx);
      return true;
    } catch {
      return false;
    }
  }

  async revertAfter(toolCallId: string): Promise<boolean> {
    const idx = this.snapshots.findIndex((s) => s.toolCallId === toolCallId);
    if (idx === -1) return this.revertAll();

    const prevSnapshot = idx > 0 ? this.snapshots[idx - 1] : null;
    if (prevSnapshot) {
      return this.revertToSnapshot(prevSnapshot.id);
    }
    return this.revertAll();
  }

  async revertAll(): Promise<boolean> {
    if (this.snapshots.length === 0) return false;

    try {
      // Drop all snapshots we created and restore working tree
      for (let i = this.snapshots.length - 1; i >= 0; i--) {
        const s = this.snapshots[i]!;
        try {
          await this.git(["stash", "drop", `stash@{0}`]);
        } catch { /* may already be dropped */ }
      }
      await this.git(["checkout", "."]);
      this.snapshots = [];
      return true;
    } catch {
      return false;
    }
  }

  cleanup(): void {
    this.snapshots = [];
  }

  private git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", args, {
        cwd: this.repoPath,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (d) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `Git exited with code ${code}`));
      });
      proc.on("error", (e) => reject(e));
    });
  }
}
