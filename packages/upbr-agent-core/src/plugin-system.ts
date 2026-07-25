/**
 * UPBR233 Plugin System
 *
 * Supports:
 * - Git repo plugin installation: upbr plugin --install git@github.com:Owner:Repo
 * - Built-in plugins: upbr plugin --install @plugin:upbr:PackageName
 * - Future: Plugin market
 *
 * Plugin interface is based on hooks and context API.
 * Inspired by OpenCode's hook-based plugin system.
 */

import type { ContextManager } from "./context-manager";
import type { ToolRegistry } from "./tool-system";
import type { ToolConfig } from "./types";

// === Plugin Types ===

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  hooks?: string[];          // Hook names this plugin uses
  tools?: string[];          // Tool names this plugin provides
}

export interface PluginHooks {
  // Session lifecycle
  onSessionStart?: (context: ContextManager) => void | Promise<void>;
  onSessionEnd?: () => void | Promise<void>;

  // Context hooks
  onBeforeContextBuild?: (context: ContextManager) => void | Promise<void>;
  onAfterContextBuild?: (prompt: string) => string | Promise<string>;

  // Tool hooks
  onBeforeToolExecute?: (toolName: string, input: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  onAfterToolExecute?: (toolName: string, result: string) => string | Promise<string>;

  // Message hooks
  onUserMessage?: (message: string) => string | Promise<string>;
  onAgentMessage?: (message: string) => string | Promise<string>;
}

export interface Plugin {
  manifest: PluginManifest;
  tools?: ToolConfig[];
  hooks?: PluginHooks;
  activate?: (ctx: PluginContext) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}

export interface PluginContext {
  contextManager: ContextManager;
  toolRegistry: ToolRegistry;
  pluginDir: string;
  storage: Map<string, unknown>;
}

// === Plugin Manager ===

export class PluginManager {
  private plugins = new Map<string, Plugin>();
  private activePlugins = new Set<string>();
  private context: PluginContext;

  constructor(context: PluginContext) {
    this.context = context;
  }

  /**
   * Register a plugin (from code).
   */
  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.manifest.name)) {
      throw new Error(`Plugin "${plugin.manifest.name}" is already registered`);
    }
    this.plugins.set(plugin.manifest.name, plugin);
  }

  /**
   * Activate a plugin by name.
   */
  async activate(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin "${name}" not found`);
    }

    if (this.activePlugins.has(name)) {
      return; // Already active
    }

    // Register plugin tools
    if (plugin.tools) {
      for (const tool of plugin.tools) {
        try {
          this.context.toolRegistry.register(tool);
        } catch {
          // Tool may already be registered
        }
      }
    }

    // Register hooks
    if (plugin.hooks) {
      const ctx = this.context.contextManager;

      if (plugin.hooks.onBeforeContextBuild) {
        ctx.onPreBuild(async (cm) => {
          await plugin.hooks!.onBeforeContextBuild!(cm);
        });
      }

      if (plugin.hooks.onAfterContextBuild) {
        ctx.onPostBuild((prompt) => {
          const result = plugin.hooks!.onAfterContextBuild!(prompt);
          // Normalize: return string (may be Promise<string> or string)
          return result instanceof Promise ? result : Promise.resolve(result);
        });
      }
    }

    // Call activate
    if (plugin.activate) {
      await plugin.activate(this.context);
    }

    this.activePlugins.add(name);
  }

  /**
   * Deactivate a plugin by name.
   */
  async deactivate(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    if (plugin.tools) {
      for (const tool of plugin.tools) {
        this.context.toolRegistry.unregister(tool.name);
      }
    }

    if (plugin.deactivate) {
      await plugin.deactivate();
    }

    this.activePlugins.delete(name);
  }

  /**
   * Install a plugin from a git repository.
   *
   * Usage: upbr plugin --install git@github.com:Owner:Repo
   *
   * Clone the repo into the plugins directory and load it.
   */
  async installFromGit(gitUrl: string): Promise<void> {
    // Normalize the git URL
    let url = gitUrl;
    if (url.endsWith(".git")) {
      url = url.slice(0, -4);
    }

    // Use gh-proxy if in China
    if (process.env.UPBR_USE_GH_PROXY === "true" || process.env.UPBR_IN_CHINA === "true") {
      url = `https://gh-proxy.org/${url}.git`;
    } else {
      url = `${url}.git`;
    }

    const pluginName = url.split("/").pop()?.replace(".git", "") || "unknown";
    const pluginDir = `${this.context.pluginDir}/${pluginName}`;

    // Clone the repo
    const proc = Bun.spawn(["git", "clone", url, pluginDir], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`Failed to clone plugin: ${err}`);
    }

    // Try to load the plugin
    try {
      const pluginModule = await import(`${pluginDir}/index.ts`);
      if (pluginModule.default) {
        this.register(pluginModule.default);
      }
    } catch (e) {
      throw new Error(
        `Failed to load plugin from ${pluginDir}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /**
   * Get a list of all registered plugins.
   */
  listPlugins(): Array<{ name: string; active: boolean; manifest: PluginManifest }> {
    return [...this.plugins.entries()].map(([name, plugin]) => ({
      name,
      active: this.activePlugins.has(name),
      manifest: plugin.manifest,
    }));
  }

  /**
   * Execute a hook across all active plugins.
   */
  async executeHook(
    hookName: keyof PluginHooks,
    ...args: unknown[]
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const name of this.activePlugins) {
      const plugin = this.plugins.get(name);
      if (!plugin?.hooks) continue;

      const hook = plugin.hooks[hookName];
      if (typeof hook === "function") {
        try {
          const result = await (hook as Function)(...args);
          results.push(result);
        } catch (e) {
          console.error(`Plugin "${name}" hook "${hookName}" error:`, e);
        }
      }
    }
    return results;
  }
}
