import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { MessageContent, ToolUseContent, ToolResultContent } from "@upbr233/ai";
import {
  type ContextManagerConfig,
  type SkillIndexEntry,
  type TimelineEntry,
  type ContextLayer,
} from "./types";

/**
 * Context Manager Plus (Pre-editing)
 *
 * Three-layer context architecture:
 *   System layer (Unchangeable) - system prompt, persona
 *   Rule layer (Unchangeable)   - skill index, MCP tools, AGENTS.md
 *   Changeable layer (Changeable) - conversation history, tool calls
 *
 * Exposes Plugin API for external context management.
 */
export class ContextManager {
  private systemLayer: string = "";
  private persona: string = "";
  private ruleFiles: Map<string, string> = new Map();
  private skillIndex: SkillIndexEntry[] = [];
  private mcpToolDefs: unknown[] = [];
  private changeableLayer: TimelineEntry[] = [];
  private maxHistoryTokens: number;
  private compactionThreshold: number;

  // Plugin hooks
  private preBuildHooks: Array<(ctx: ContextManager) => void | Promise<void>> = [];
  private postBuildHooks: Array<(prompt: string) => string | Promise<string>> = [];

  constructor(config: ContextManagerConfig) {
    this.systemLayer = config.systemPrompt;
    this.persona = config.persona || "";
    this.skillIndex = config.skillIndex || [];
    this.mcpToolDefs = config.mcpTools || [];
    this.maxHistoryTokens = config.maxHistoryTokens;
    this.compactionThreshold = config.compactionThreshold;

    // Load rules files
    if (config.rulesFiles) {
      for (const path of config.rulesFiles) {
        try {
          if (existsSync(path)) {
            const content = readFileSync(path, "utf-8");
            this.ruleFiles.set(path, content);
          }
        } catch {
          // File not found or unreadable, skip
        }
      }
    }
  }

  /**
   * Load AGENTS.md and other project rule files from the project root.
   * Searches: AGENTS.md, .agents.md, CLAUDE.md, .cursorrules, .windsurfrules
   */
  loadProjectRules(projectRoot?: string): void {
    const root = projectRoot || process.cwd();
    const ruleFiles = [
      "AGENTS.md",
      ".agents.md", 
      "CLAUDE.md",
      ".cursorrules",
      ".windsurfrules",
      "CONTRIBUTING.md",
    ];

    for (const filename of ruleFiles) {
      const path = join(root, filename);
      try {
        if (existsSync(path)) {
          const content = readFileSync(path, "utf-8");
          this.ruleFiles.set(filename, content);
        }
      } catch {
        // File not found or unreadable, skip
      }
    }
  }

  // === Layer Management ===

  setSystemPrompt(prompt: string): void {
    this.systemLayer = prompt;
  }

  setPersona(persona: string): void {
    this.persona = persona;
  }

  addRuleFile(path: string, content: string): void {
    this.ruleFiles.set(path, content);
  }

  removeRuleFile(path: string): void {
    this.ruleFiles.delete(path);
  }

  setSkillIndex(index: SkillIndexEntry[]): void {
    this.skillIndex = index;
  }

  addMcpTool(toolDef: unknown): void {
    this.mcpToolDefs.push(toolDef);
  }

  // === Changeable Layer (Timeline) ===

  addEntry(entry: TimelineEntry): void {
    this.changeableLayer.push(entry);
  }

  getEntries(): TimelineEntry[] {
    return [...this.changeableLayer];
  }

  deleteEntry(id: string): { deleted: TimelineEntry; newBranch: string } | null {
    const idx = this.changeableLayer.findIndex((e) => e.id === id);
    if (idx === -1) return null;

    const deleted = this.changeableLayer[idx]!;
    const branchId = `branch_${Date.now()}`;

    // Keep entries before this one, create a branch
    this.changeableLayer = this.changeableLayer.slice(0, idx);
    for (const entry of this.changeableLayer) {
      entry.branchId = branchId;
    }

    return { deleted, newBranch: branchId };
  }

  withdrawEntry(id: string): TimelineEntry | null {
    const idx = this.changeableLayer.findIndex((e) => e.id === id);
    if (idx === -1) return null;

    // Remove this entry and all after it
    const removed = this.changeableLayer.splice(idx);
    return removed[0] || null;
  }

  replaceEntry(id: string, newEntry: TimelineEntry): boolean {
    const idx = this.changeableLayer.findIndex((e) => e.id === id);
    if (idx === -1) return false;

    // Create branch, overwrite entry
    const branchId = `branch_${Date.now()}`;
    for (let i = 0; i <= idx; i++) {
      this.changeableLayer[i]!.branchId = branchId;
    }
    newEntry.branchId = branchId;

    this.changeableLayer = [
      ...this.changeableLayer.slice(0, idx + 1),
      newEntry,
    ];
    return true;
  }

  // === Context Building ===

  /**
   * Build the complete context for an LLM request.
   * Merges all three layers.
   */
  async buildContext(): Promise<string> {
    // Allow plugins to pre-process
    for (const hook of this.preBuildHooks) {
      await hook(this);
    }

    const parts: string[] = [];

    // System layer
    parts.push(this.systemLayer);
    if (this.persona) {
      parts.push(`\n## Persona\n${this.persona}`);
    }

    // Rule layer
    if (this.ruleFiles.size > 0) {
      parts.push("\n## Project Rules");
      for (const [path, content] of this.ruleFiles) {
        parts.push(`\n### ${path}\n${content}`);
      }
    }

    if (this.skillIndex.length > 0) {
      parts.push("\n## Available Skills");
      for (const skill of this.skillIndex) {
        parts.push(`- **${skill.name}**: ${skill.description}`);
        if (skill.magicWords.length > 0) {
          parts.push(`  Magic words: ${skill.magicWords.join(", ")}`);
        }
      }
    }

    // Changeable layer (history)
    if (this.changeableLayer.length > 0) {
      parts.push("\n## Conversation History");
      let currentBranch = "";
      for (const entry of this.changeableLayer) {
        if (entry.branchId && entry.branchId !== currentBranch) {
          currentBranch = entry.branchId;
          parts.push(`\n[Branch: ${currentBranch}]`);
        }
        parts.push(this.formatTimelineEntry(entry));
      }
    }

    let combined = parts.join("\n");

    // Allow plugins to post-process
    for (const hook of this.postBuildHooks) {
      combined = await hook(combined);
    }

    return combined;
  }

  /**
   * Estimate token count of the current context.
   */
  async estimateTokens(): Promise<number> {
    const context = await this.buildContext();
    // Rough estimate: ~4 chars per token for English, ~2 for CJK
    const cjkChars = (context.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
    const otherChars = context.length - cjkChars;
    return Math.ceil(cjkChars / 2 + otherChars / 4);
  }

  /**
   * Check if compaction is needed.
   */
  async needsCompaction(): Promise<boolean> {
    const tokens = await this.estimateTokens();
    return tokens > this.maxHistoryTokens * this.compactionThreshold;
  }

  // === Plugin API ===

  /**
   * Register a pre-build hook (plugin API).
   */
  onPreBuild(hook: (ctx: ContextManager) => void | Promise<void>): void {
    this.preBuildHooks.push(hook);
  }

  /**
   * Register a post-build hook (plugin API).
   */
  onPostBuild(hook: (prompt: string) => string | Promise<string>): void {
    this.postBuildHooks.push(hook);
  }

  /**
   * Get a specific layer's content.
   */
  getLayer(layer: ContextLayer): string {
    switch (layer) {
      case "system":
        return `${this.systemLayer}\n${this.persona ? `\n## Persona\n${this.persona}` : ""}`;
      case "rule": {
        const parts: string[] = [];
        if (this.ruleFiles.size > 0) {
          for (const [path, content] of this.ruleFiles) {
            parts.push(`### ${path}\n${content}`);
          }
        }
        if (this.skillIndex.length > 0) {
          parts.push("## Skills\n" + this.skillIndex.map(
            (s) => `- ${s.name}: ${s.description}`
          ).join("\n"));
        }
        return parts.join("\n\n");
      }
      case "changeable":
        return this.changeableLayer.map((e) => this.formatTimelineEntry(e)).join("\n");
    }
  }

  private formatTimelineEntry(entry: TimelineEntry): string {
    const role = entry.type === "user" ? "User" :
      entry.type === "agent" ? "Agent" :
      entry.type === "tool_call" ? "Tool Call" :
      entry.type === "tool_result" ? "Tool Result" : "Subagent";
    return `\n[${role}] ${new Date(entry.timestamp).toISOString()}\n${entry.content}`;
  }
}
