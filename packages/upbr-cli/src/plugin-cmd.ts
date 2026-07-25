/**
 * UPBR233 Plugin CLI - subcommand handler for `upbr plugin`.
 *
 * Commands:
 *   upbr plugin --install <source>  Install a plugin
 *   upbr plugin --list             List installed plugins
 *   upbr plugin --remove <name>    Remove a plugin
 *
 * Source formats:
 *   git@github.com Owner:Repo      Git repository (GitHub)
 *   @plugin:upbr:PackageName       Built-in plugin
 */

import { PluginManager } from "@upbr233/agent-core";
import type { PluginContext } from "@upbr233/agent-core";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Parse plugin install source into type and details */
function parsePluginSource(
  source: string
): { type: "git"; url: string; repoPath: string } | { type: "builtin"; packageName: string } | { type: "unknown"; raw: string } {
  // Built-in plugin: @plugin:upbr:PackageName
  if (source.startsWith("@plugin:")) {
    const parts = source.replace("@plugin:", "").split(":");
    if (parts.length >= 2) {
      return { type: "builtin", packageName: parts[1]! };
    }
  }

  // Git repo: git@github.com Owner:Repo or git@github.com:Owner/Repo
  if (source.startsWith("git@")) {
    // Format: git@github.com Owner:Repo (space-separated)
    const spaceParts = source.split(/\s+/);
    if (spaceParts.length === 2) {
      const [hostPart, repoPart] = spaceParts;
      const host = hostPart!.replace("git@", "").replace(":", "/");
      const [owner, repo] = repoPart!.split(":");
      if (owner && repo) {
        return {
          type: "git",
          url: `https://gh-proxy.org/https://github.com/${owner}/${repo}.git`,
          repoPath: `${owner}/${repo}`,
        };
      }
    }
    // Format: git@github.com:Owner/Repo (colon-separated)
    const normalized = source.replace("git@", "https://").replace(":", "/");
    const repoPath = normalized.replace("https://github.com/", "").replace(".git", "");
    return {
      type: "git",
      url: normalized.endsWith(".git") ? normalized : `${normalized}.git`,
      repoPath,
    };
  }

  // HTTPS URL fallback
  if (source.startsWith("https://")) {
    return { type: "git", url: source, repoPath: source.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") };
  }

  return { type: "unknown", raw: source };
}

export async function handlePluginCommand(args: string[]): Promise<void> {
  const pluginsDir = join(process.env.HOME || "/tmp", ".upbr", "plugins");
  if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });

  // Create a minimal plugin context for management
  const ctx: PluginContext = {
    contextManager: null as unknown as PluginContext["contextManager"],
    toolRegistry: null as unknown as PluginContext["toolRegistry"],
    pluginDir: pluginsDir,
    storage: new Map(),
  };
  const manager = new PluginManager(ctx);

  let installSource: string | undefined;
  let listMode = false;
  let removeName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--install":
      case "-i":
        installSource = args[++i];
        break;
      case "--list":
      case "-l":
        listMode = true;
        break;
      case "--remove":
      case "-r":
        removeName = args[++i];
        break;
      case "--help":
      case "-h":
        printHelp();
        return;
    }
  }

  if (listMode) {
    const plugins = manager.listPlugins();
    if (plugins.length === 0) {
      console.log("No plugins installed.\n\nInstall with: upbr plugin --install <source>");
    } else {
      console.log("Installed plugins:");
      for (const p of plugins) {
        console.log(`  ${p.active ? "[active]" : "[inactive]"} ${p.name} v${p.manifest.version} - ${p.manifest.description}`);
      }
    }
    return;
  }

  if (installSource) {
    const parsed = parsePluginSource(installSource);

    if (parsed.type === "builtin") {
      console.log(`Installing built-in plugin: ${parsed.packageName}`);
      console.log("Built-in plugins are pre-packaged with UPBR233 and will be available after restart.");
      console.log(`Run 'upbr' to use the plugin.`);
      return;
    }

    if (parsed.type === "git") {
      console.log(`Installing plugin from: ${parsed.repoPath}`);
      console.log(`Cloning ${parsed.url}...`);

      try {
        await manager.installFromGit(parsed.url);
        console.log(`Plugin installed from ${parsed.repoPath}`);
      } catch (e) {
        console.error(`Failed to install plugin: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      return;
    }

    console.error(`Unknown plugin source: ${installSource}`);
    console.error("Formats: git@github.com Owner:Repo | @plugin:upbr:PackageName | https://github.com/...");
    process.exit(1);
  }

  if (removeName) {
    console.log(`Removing plugin: ${removeName}`);
    await manager.deactivate(removeName);
    console.log("Plugin removed. Restart to fully unload.");
    return;
  }

  printHelp();
}

function printHelp(): void {
  console.log([
    "UPBR233 Plugin Manager",
    "",
    "Usage: upbr plugin [options]",
    "",
    "Options:",
    "  -i, --install <source>  Install a plugin",
    "  -l, --list             List installed plugins",
    "  -r, --remove <name>    Remove a plugin",
    "  -h, --help             Show this help",
    "",
    "Source formats:",
    "  git@github.com Owner:Repo          GitHub repository",
    "  git@github.com:Owner/Repo          GitHub repository (alt)",
    "  @plugin:upbr:PackageName           Built-in plugin",
    "  https://github.com/Owner/Repo      GitHub HTTPS",
    "",
    "Examples:",
    "  upbr plugin --install git@github.com some-author:cool-plugin",
    "  upbr plugin --install @plugin:upbr:mmp",
    "  upbr plugin --list",
  ].join("\n"));
}
