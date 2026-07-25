#!/usr/bin/env bun
/**
 * UPBR233 CLI - The main entry point for the `upbr` command.
 *
 * This is the interactive terminal coding agent that connects
 * the TUI, Agent Loop, Provider, and Tool systems together.
 */

import { UnifiedProvider, KeyManager, ModelsDevClient } from "@upbr233/ai";
import {
  AgentLoop,
  ContextManager,
  createToolRegistry,
  SessionStore,
  FileSnapshotManager,
  IpcHub,
  setSubConnectIpcHub,
} from "@upbr233/agent-core";
import type {
  AgentLoopHooks,
  ToolCallRequest,
  ToolCallResult,
  AgentState,
  AgentLoopConfig,
  ContextManagerConfig,
} from "@upbr233/agent-core";
import { MemoryManagerPro } from "@upbr233/mmp";
import { TuiRenderer } from "@upbr233/tui";
import type { TuiConfig } from "@upbr233/tui";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// === System Prompt ===
import { getSystemPrompt } from "./prompt";

// === Configuration ===
interface CliConfig {
  locale: "zh" | "en";
  model?: string;
  provider?: string;
  apiBase?: string;
  apiKey?: string;
  mode: "build" | "plan";
  resumeSession?: string;
  listSessions?: boolean;
}

function parseArgs(): CliConfig {
  const args = Bun.argv.slice(2);
  const config: CliConfig = {
    locale: process.env.LANG?.startsWith("zh") ? "zh" : "en",
    mode: "build",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":
      case "-m":
        config.model = args[++i];
        break;
      case "--provider":
      case "-p":
        config.provider = args[++i];
        break;
      case "--api-base":
        config.apiBase = args[++i];
        break;
      case "--api-key":
      case "-k":
        config.apiKey = args[++i];
        break;
      case "--plan":
        config.mode = "plan";
        break;
      case "--resume":
      case "-r":
        config.resumeSession = args[++i];
        break;
      case "--list-sessions":
      case "--ls":
        config.listSessions = true;
        break;
      case "--locale":
      case "-l":
        config.locale = args[++i] === "zh" ? "zh" : "en";
        break;
      case "--help":
      case "-h":
        console.log(getHelpText(config.locale));
        process.exit(0);
      case "--version":
      case "-v":
        console.log("upbr v0.1.0");
        process.exit(0);
    }
  }

  return config;
}

function getHelpText(locale: string): string {
  const isZh = locale === "zh";
  return isZh
    ? [
        "UPBR233 Coding Agent v0.1.0",
        "",
        "用法: upbr [选项]",
        "",
        "选项:",
        "  -m, --model <model>        使用的模型名称",
        "  -p, --provider <name>      使用的提供商名称",
        "  --api-base <url>           API基础URL",
        "  -k, --api-key <key>        API密钥",
        "  --plan                     以计划模式启动（只读）",
        "  -r, --resume <id>          恢复之前的会话",
        "  --ls, --list-sessions      列出所有会话",
        "  -l, --locale <zh|en>       语言 (默认: 自动检测)",
        "  -h, --help                  显示此帮助信息",
        "  -v, --version               显示版本信息",
      ].join("\n")
    : [
        "UPBR233 Coding Agent v0.1.0",
        "",
        "Usage: upbr [options]",
        "",
        "Options:",
        "  -m, --model <model>        Model name to use",
        "  -p, --provider <name>      Provider name to use",
        "  --api-base <url>           API base URL",
        "  -k, --api-key <key>        API key",
        "  --plan                     Start in plan mode (read-only)",
        "  -r, --resume <id>          Resume a previous session",
        "  --ls, --list-sessions      List all saved sessions",
        "  -l, --locale <zh|en>       Language (default: auto-detect)",
        "  -h, --help                  Show this help",
        "  -v, --version               Show version",
      ].join("\n");
}

// === Interactive Prompt Handler ===
class PromptHandler {
  private tui: TuiRenderer;
  private pendingApproval: {
    request: ToolCallRequest;
    resolve: (answer: "once" | "always" | "deny") => void;
  } | null = null;

  constructor(tui: TuiRenderer) {
    this.tui = tui;
  }

  set configuration(config: { locale: "zh" | "en" }) {
    // TUI is already configured
  }

  async askApproval(request: ToolCallRequest): Promise<"once" | "always" | "deny"> {
    this.tui.renderApproval(request);

    return new Promise((resolve) => {
      this.pendingApproval = { request, resolve };
    });
  }

  handleApprovalKey(key: string): boolean {
    if (!this.pendingApproval) return false;

    const upper = key.toUpperCase();
    if (upper === "Y" || upper === "O") {
      this.pendingApproval.resolve("once");
      this.pendingApproval = null;
      return true;
    }
    if (upper === "A") {
      this.pendingApproval.resolve("always");
      this.pendingApproval = null;
      return true;
    }
    if (upper === "N") {
      this.pendingApproval.resolve("deny");
      this.pendingApproval = null;
      return true;
    }
    return false;
  }
}

// === Main ===
async function main() {
  const cliConfig = parseArgs();
  const tui = new TuiRenderer({
    locale: cliConfig.locale,
  } as TuiConfig);

  console.clear();
  process.stdout.write("\x1b[?25l"); // hide cursor

  const promptHandler = new PromptHandler(tui);

  // Setup provider
  const unified = new UnifiedProvider();

  // Try to configure provider from env vars
  const providerName = cliConfig.provider || process.env.UPBR_DEFAULT_PROVIDER || "default";
  const apiKeys = KeyManager.fromEnv(providerName);

  if (apiKeys.totalCount === 0 && !cliConfig.apiKey) {
    // Show welcome / setup wizard
    process.stdout.write("\x1b[?25h"); // show cursor
    console.log(tui.t({
      zh: [
        "╔══════════════════════════════════════╗",
        "║        UPBR233 Coding Agent          ║",
        "║         欢迎使用! / Welcome!         ║",
        "╚══════════════════════════════════════╝",
        "",
        "首次使用需要配置 API 提供商。",
        "支持环境变量:",
        "  UPBR_{NAME}_API_KEY=your-key",
        "  UPBR_{NAME}_API_KEY_LISTS=key1 : key2 : key3",
        "",
        "或使用命令行参数:",
        "  upbr --api-key sk-xxx --api-base https://api.openai.com/v1",
        "",
        "目前复用你的 API config来自 `DASHSCOPE_API_KEY` 环境变量。",
      ].join("\n"),
      en: [
        "╔══════════════════════════════════════╗",
        "║        UPBR233 Coding Agent          ║",
        "║           Welcome!                   ║",
        "╚══════════════════════════════════════╝",
        "",
        "First time setup: configure an API provider.",
        "Environment variables:",
        "  UPBR_{NAME}_API_KEY=your-key",
        "  UPBR_{NAME}_API_KEY_LISTS=key1 : key2 : key3",
        "",
        "Or use CLI arguments:",
        "  upbr --api-key sk-xxx --api-base https://api.openai.com/v1",
        "",
        "Using your existing DASHSCOPE_API_KEY if set.",
      ].join("\n"),
    }));
  }

  // Try to get API key
  const apiKey = cliConfig.apiKey
    || process.env.DASHSCOPE_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error(tui.t({
      zh: "错误: 未设置 API Key。请设置环境变量或使用 --api-key 参数。",
      en: "Error: No API key configured. Set an environment variable or use --api-key.",
    }));
    process.exit(1);
  }

  const apiBase = cliConfig.apiBase
    || process.env.OPENAI_BASE_URL
    || process.env.DASHSCOPE_BASE_URL
    || "https://api.openai.com/v1";

  // Determine protocol
  const protocol = apiBase.includes("anthropic")
    ? "anthropic-compatible"
    : "openai-compatible";

  unified.addProvider({
    name: providerName,
    protocol: protocol as "openai-compatible" | "anthropic-compatible",
    baseUrl: apiBase,
    apiKeys: [apiKey],
    models: [],
  });

  const model = cliConfig.model
    || process.env.UPBR_MODEL
    || (protocol === "anthropic-compatible" ? "claude-sonnet-4-20250514" : "gpt-4o");

  const provider = unified.getProvider(providerName)!;

  // Create tool registry
  const toolRegistry = createToolRegistry();

  // System prompt
  const systemPrompt = getSystemPrompt(cliConfig.locale, cliConfig.mode);

  // Context manager
  const ctxConfig: ContextManagerConfig = {
    systemPrompt,
    maxHistoryTokens: 100000,
    compactionThreshold: 0.75,
  };
  const contextManager = new ContextManager(ctxConfig);

  // Memory Manager Pro (DAG memory)
  const storageDir = join(process.env.HOME || "/tmp", ".upbr");
  if (!existsSync(storageDir)) mkdirSync(storageDir, { recursive: true });
  const mmp = new MemoryManagerPro({ storageDir });

  // Session store for persistence
  const sessionStore = new SessionStore(storageDir);
  const session = sessionStore.createSession({
    name: `Session ${new Date().toISOString().slice(0, 10)}`,
    mode: cliConfig.mode,
    model,
    provider: providerName,
  });

  // File snapshot manager for withdraw/revert
  const snapshotManager = new FileSnapshotManager({ enabled: cliConfig.mode !== "plan" });

  // Agent loop
  const loopConfig: AgentLoopConfig = {
    maxIterations: 50,
    maxTokens: 100000,
    mode: cliConfig.mode,
    systemPrompt,
  };
  const agentLoop = new AgentLoop(
    provider,
    toolRegistry,
    contextManager,
    loopConfig,
    model
  );
  agentLoop.setMmp(mmp);
  agentLoop.setSessionStore(sessionStore, session.id);

  // Handle --list-sessions
  if (cliConfig.listSessions) {
    const sessions = sessionStore.listSessions();
    console.log(tui.t({ zh: "已保存的会话:", en: "Saved sessions:" }));
    for (const s of sessions) {
      const date = new Date(s.updated_at).toISOString().slice(0, 19);
      console.log(`  ${s.id}  ${s.name}  [${s.mode}]  ${date}`);
    }
    process.exit(0);
  }

  // Chat state - must be declared before --resume block
  const chatMessages: Array<{ role: string; content: string }> = [];
  let agentState: AgentState = "idle";
  let currentStreaming = "";

  // Handle --resume: restore entries from previous session
  if (cliConfig.resumeSession) {
    const prevSession = sessionStore.getSession(cliConfig.resumeSession);
    if (!prevSession) {
      console.error(tui.t({
        zh: `错误: 未找到会话 "${cliConfig.resumeSession}"`,
        en: `Error: Session "${cliConfig.resumeSession}" not found`,
      }));
      process.exit(1);
    }
    const entries = sessionStore.loadEntries(cliConfig.resumeSession);
    for (const entry of entries) {
      contextManager.addEntry(entry);
    }
    // Also load entries into the agent loop's messages so the agent can see them
    agentLoop.loadHistory(entries);
    chatMessages.unshift({
      role: "system",
      content: tui.t({
        zh: `已恢复会话: ${prevSession.name} (${entries.length} 条记录)`,
        en: `Restored session: ${prevSession.name} (${entries.length} entries)`,
      }),
    });
    // Override session with the resumed one
    cliConfig.mode = (prevSession.mode as "build" | "plan") || cliConfig.mode;
  }

  // Restore tool approvals from previous sessions
  const savedApprovals = sessionStore.loadApprovals(session.id);
  for (const toolName of savedApprovals) {
    // Mark as approved in registry
  }

  // Start IPC hub for subagent/async task communication (NNG-style)
  const ipcHub = new IpcHub();
  try { await ipcHub.start(); setSubConnectIpcHub(ipcHub); } catch { /* IPC unavailable, tools fall back to inproc */ }

  // Set up hooks
  const hooks: AgentLoopHooks = {
    onThinking: () => {
      agentState = "thinking";
      refreshDisplay();
    },
    onTextDelta: (text) => {
      currentStreaming += text;
      refreshDisplay();
    },
    onToolCall: async (request) => {
      chatMessages.push({
        role: "tool",
        content: `Calling: ${request.name}(${JSON.stringify(request.input).slice(0, 100)}...)`,
      });
      // Create file snapshot before file-modifying operations
      if (["write_file", "edit_file", "make_dir", "run_cmd"].includes(request.name)) {
        await snapshotManager.createSnapshot(request.id);
      }
      refreshDisplay();
    },
    onToolResult: async (result) => {
      // Handle ask_user interactive results BEFORE capturing preview
      if (result.metadata?.needsUserInput) {
        await handleAskUserQuestions(result);
      }
      const preview = result.output.slice(0, 200);
      chatMessages.push({
        role: "tool",
        content: `Result: ${preview}${result.output.length > 200 ? "..." : ""}`,
      });
      refreshDisplay();
    },
    onError: (error) => {
      chatMessages.push({ role: "system", content: `Error: ${error}` });
      refreshDisplay();
    },
    onStateChange: (state) => {
      agentState = state;
      refreshDisplay();
    },
    onNeedApproval: async (request) => {
      const answer = await promptHandler.askApproval(request);
      return answer;
    },
  };

  agentLoop.setHooks(hooks);

  // Input handling
  let inputBuffer = "";
  let cursorPos = 0;
  let history: string[] = [];
  let historyIndex = -1;
  let ctrlCPressCount = 0;
  let ctrlCPressTimer: Timer | null = null;
  let ctrlDPressCount = 0;
  let ctrlDPressTimer: Timer | null = null;

  // === Ask User Interactive Handler ===
  async function handleAskUserQuestions(result: ToolCallResult): Promise<void> {
    const questions = result.metadata?.questions as Array<{
      question: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }> | undefined;

    if (!questions || questions.length === 0) return;

    const answers: Record<string, string> = {};

    process.stdout.write("\x1b[?25h"); // show cursor

    console.log(tui.t({
      zh: "\n📋 代理需要你回答一些问题:\n",
      en: "\n📋 The agent needs you to answer some questions:\n",
    }));

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      console.log(`\n${i + 1}. ${q.question}`);

      if (q.multiSelect) {
        console.log(tui.t({
          zh: "   (多选 - 用逗号分隔, 输入 '0' 跳过)",
          en: "   (multi-select - comma separated, '0' to skip)",
        }));
      } else {
        console.log(tui.t({
          zh: "   (输入选项编号, 或直接输入答案)",
          en: "   (enter option number, or type a custom answer)",
        }));
      }

      q.options.forEach((opt, j) => {
        console.log(`   [${j + 1}] ${opt.label}${opt.description ? ` - ${opt.description}` : ""}`);
      });

      process.stdout.write(tui.t({ zh: "> ", en: "> " }));

      // Read user input (simple readline approach)
      const answer = await new Promise<string>((resolve) => {
        let input = "";
        const onData = (data: Buffer) => {
          const char = data.toString();
          if (char === "\r" || char === "\n") {
            process.stdin.removeListener("data", onData);
            process.stdin.setRawMode(true);
            resolve(input.trim());
            return;
          }
          if (char === "\x7f") {
            if (input.length > 0) {
              input = input.slice(0, -1);
              process.stdout.write("\b \b");
            }
            return;
          }
          input += char;
          process.stdout.write(char);
        };
        process.stdin.setRawMode(false);
        process.stdin.on("data", onData);
      });

      answers[`Q${i + 1}`] = answer;
    }

    process.stdout.write("\x1b[?25l"); // hide cursor
    console.log(tui.t({
      zh: "\n✅ 已回答，继续处理...\n",
      en: "\n✅ Answered, continuing...\n",
    }));

    // Build the answer message from collected answers
    const answerLines: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      const answerKey = `Q${i + 1}`;
      const answer = answers[answerKey] || "(skipped)";
      answerLines.push(`Q${i + 1}: ${q.question}`);
      answerLines.push(`  Answer: ${answer}`);
    }
    const answerMsg = answerLines.join("\n");

    // Inject answers directly into the tool result output so the
    // agent loop sees them when it adds the tool result to messages.
    // (onToolResult is now awaited BEFORE addToolResultToMessages)
    result.output += "\n\n=== USER ANSWERS ===\n" + answerMsg;
  }

  function refreshDisplay() {
    const statusLine = [
      `${tui.t({ zh: "模式", en: "Mode" })}: ${cliConfig.mode}`,
      `${tui.t({ zh: "模型", en: "Model" })}: ${model}`,
      `${tui.t({ zh: "提供商", en: "Provider" })}: ${providerName}`,
      `${tui.t({ zh: "迭代", en: "Iteration" })}: ${agentLoop.getIteration()}`,
    ].join(" | ");

    tui.renderChat(chatMessages, agentState, currentStreaming, inputBuffer, cursorPos, statusLine);
  }

  refreshDisplay();

  // === Keyboard Input Loop ===
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const KEY_ENTER = "\r";
  const KEY_BACKSPACE = "\x7f";
  const KEY_DELETE = "\x1b[3~";
  const KEY_UP = "\x1b[A";
  const KEY_DOWN = "\x1b[B";
  const KEY_LEFT = "\x1b[D";
  const KEY_RIGHT = "\x1b[C";
  const KEY_HOME = "\x1b[H";
  const KEY_END = "\x1b[F";

  process.stdin.on("data", async (data: Buffer) => {
    const key = data.toString();

    // Handle Ctrl+C
    if (key === "\x03") {
      ctrlCPressCount++;
      if (ctrlCPressTimer) clearTimeout(ctrlCPressTimer);
      ctrlCPressTimer = setTimeout(() => { ctrlCPressCount = 0; }, 800);

      if (ctrlCPressCount >= 2) {
        // Clear current message
        inputBuffer = "";
        cursorPos = 0;
        ctrlCPressCount = 0;
        refreshDisplay();
      }
      return;
    }

    // Handle Ctrl+D
    if (key === "\x04") {
      ctrlDPressCount++;
      if (ctrlDPressTimer) clearTimeout(ctrlDPressTimer);
      ctrlDPressTimer = setTimeout(() => { ctrlDPressCount = 0; }, 800);

      if (ctrlDPressCount >= 2 && inputBuffer.length === 0) {
        process.stdout.write("\x1b[?25h\n");
        process.exit(0);
      }
      return;
    }

    // Handle approval keys
    if (agentState === "waiting_approval") {
      if (promptHandler.handleApprovalKey(key)) {
        // Approval handled by the pending prompt handler
        refreshDisplay();
        return;
      }
    }

    // Don't process input while agent is running
    if (agentState === "thinking" || agentState === "executing_tools") {
      return;
    }

    // Process key
    handleKey(key);
  });

  async function handleKey(key: string) {
    switch (key) {
      // Enter inserts newline, Ctrl+J sends
      case KEY_ENTER:
        if (agentState === "waiting_approval") return;
        // Insert newline
        inputBuffer = inputBuffer.slice(0, cursorPos) + "\n" + inputBuffer.slice(cursorPos);
        cursorPos++;
        refreshDisplay();
        break;

      case "\x0a": // Ctrl+J - send message
        if (inputBuffer.trim().length > 0) {
          const message = inputBuffer.trim();
          inputBuffer = "";
          cursorPos = 0;
          currentStreaming = "";

          // Add to history
          history.push(message);
          historyIndex = history.length;

          // Add to chat display
          chatMessages.push({ role: "user", content: message });
          refreshDisplay();

          // Run agent loop
          try {
            const step = await agentLoop.run(message);

            // Add final agent response
            const agentText = step.messages
              .filter((m) => m.role === "assistant")
              .slice(-1)
              .map((m) =>
                typeof m.content === "string" ? m.content : ""
              )
              .join("");

            if (agentText) {
              chatMessages.push({ role: "assistant", content: agentText });
            }

            if (step.error) {
              chatMessages.push({
                role: "system",
                content: `Error: ${step.error}`,
              });
            }

            currentStreaming = "";
            refreshDisplay();
          } catch (e) {
            chatMessages.push({
              role: "system",
              content: `Error: ${e instanceof Error ? e.message : String(e)}`,
            });
            agentState = "error";
            currentStreaming = "";
            refreshDisplay();
          }
        }
        break;

      case KEY_BACKSPACE:
        if (cursorPos > 0) {
          inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
          cursorPos--;
          refreshDisplay();
        }
        break;

      case KEY_DELETE:
        if (cursorPos < inputBuffer.length) {
          inputBuffer = inputBuffer.slice(0, cursorPos) + inputBuffer.slice(cursorPos + 1);
          refreshDisplay();
        }
        break;

      case KEY_UP:
        if (history.length > 0) {
          historyIndex = Math.max(0, historyIndex - 1);
          inputBuffer = history[historyIndex] || "";
          cursorPos = inputBuffer.length;
          refreshDisplay();
        }
        break;

      case KEY_DOWN:
        if (history.length > 0) {
          historyIndex = Math.min(history.length - 1, historyIndex + 1);
          inputBuffer = history[historyIndex] || "";
          cursorPos = inputBuffer.length;
          refreshDisplay();
        }
        break;

      case KEY_LEFT:
        if (cursorPos > 0) {
          cursorPos--;
          refreshDisplay();
        }
        break;

      case KEY_RIGHT:
        if (cursorPos < inputBuffer.length) {
          cursorPos++;
          refreshDisplay();
        }
        break;

      case KEY_HOME:
        cursorPos = 0;
        refreshDisplay();
        break;

      case KEY_END:
        cursorPos = inputBuffer.length;
        refreshDisplay();
        break;

      default:
        // Ignore control characters and escape sequences
        if (key.charCodeAt(0) < 32 && key.length === 1) return;
        if (key.startsWith("\x1b[")) break;

        // Regular character input
        inputBuffer = inputBuffer.slice(0, cursorPos) + key + inputBuffer.slice(cursorPos);
        cursorPos += key.length;
        refreshDisplay();
        break;
    }
  }

  // Handle resize
  process.stdout.on("resize", () => {
    refreshDisplay();
  });

  // Cleanup on exit (synchronous - async won't run on exit event)
  process.on("SIGINT", () => { ipcHub.stop(); process.exit(); });
  process.on("SIGTERM", () => { ipcHub.stop(); process.exit(); });
  process.on("exit", () => {
    process.stdout.write("\x1b[?25h"); // show cursor
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.stdout.write("\x1b[?25h");
  process.exit(1);
});
