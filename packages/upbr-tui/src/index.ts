/**
 * UPBR233 TUI - Terminal User Interface with differential rendering.
 *
 * Inspired by pi-tui's "retained mode" approach:
 * - Maintains a back buffer of previous state
 * - Calculates exactly which lines changed
 * - Emits minimal ANSI escape codes
 * - Respects native terminal scrollback
 */

import type { AgentStep, AgentState, ToolCallRequest, ToolCallResult } from "@upbr233/agent-core";

// === ANSI Codes ===
const CSI = "\x1b[";
const HOME = `${CSI}H`;
const CLEAR_SCREEN = `${CSI}2J`;
const CLEAR_LINE = `${CSI}2K`;
const CURSOR_UP = (n: number) => `${CSI}${n}A`;
const CURSOR_DOWN = (n: number) => `${CSI}${n}B`;
const CURSOR_TO_COL = (n: number) => `${CSI}${n}G`;
const SAVE_CURSOR = `${CSI}s`;
const RESTORE_CURSOR = `${CSI}u`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

// Colors
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const ITALIC = `${CSI}3m`;
const CYAN = (t: string) => `${CSI}36m${t}${RESET}`;
const GREEN = (t: string) => `${CSI}32m${t}${RESET}`;
const YELLOW = (t: string) => `${CSI}33m${t}${RESET}`;
const RED = (t: string) => `${CSI}31m${t}${RESET}`;
const MAGENTA = (t: string) => `${CSI}35m${t}${RESET}`;
const BLUE = (t: string) => `${CSI}34m${t}${RESET}`;
const GRAY = (t: string) => `${CSI}90m${t}${RESET}`;

export interface TuiConfig {
  theme?: "dark" | "light";
  maxVisibleLines?: number;
  showTimestamps?: boolean;
  locale?: "zh" | "en";
}

class TuiRenderer {
  private backBuffer: string[] = [];
  private config: TuiConfig;
  private editorBuffer: string[] = [];
  private cursorPos = 0;
  private isEditing = false;
  private history: string[] = [];
  private historyIndex = -1;

  constructor(config: TuiConfig = {}) {
    this.config = {
      theme: "dark",
      maxVisibleLines: 100,
      showTimestamps: false,
      locale: "en",
      ...config,
    };
  }

  t(msg: { zh: string; en: string }): string {
    return this.config.locale === "zh" ? msg.zh : msg.en;
  }

  /**
   * Write content to the terminal, performing differential rendering
   * against the back buffer.
   */
  render(lines: string[]): void {
    const output: string[] = [];
    const minLen = Math.min(this.backBuffer.length, lines.length);

    // Find common prefix
    let commonStart = 0;
    for (let i = 0; i < minLen; i++) {
      if (this.backBuffer[i] !== lines[i]) break;
      commonStart++;
    }

    if (commonStart === 0) {
      // Full redraw needed
      output.push(CLEAR_SCREEN, HOME);
      for (const line of lines) {
        output.push(line, "\r\n");
      }
    } else {
      // Differential update: only changed lines
      output.push(CURSOR_TO_COL(1));
      output.push(CURSOR_UP(this.backBuffer.length - commonStart));

      for (let i = commonStart; i < lines.length; i++) {
        output.push(CLEAR_LINE, lines[i]!, "\r\n");
      }

      // Remove extra lines if new content is shorter
      if (lines.length < this.backBuffer.length) {
        for (let i = lines.length; i < this.backBuffer.length; i++) {
          output.push(CLEAR_LINE, "\r\n");
        }
        output.push(CURSOR_UP(this.backBuffer.length - lines.length));
      }
    }

    // Update back buffer
    this.backBuffer = [...lines];

    // Write all output
    process.stdout.write(output.join(""));
  }

  /**
   * Render the chat view with conversation history and input area.
   */
  renderChat(
    messages: Array<{ role: string; content: string }>,
    agentState: AgentState,
    currentStreaming: string,
    inputBuffer: string,
    cursorPos: number,
    statusLine: string
  ): void {
    const termHeight = process.stdout.rows || 24;
    const termWidth = process.stdout.columns || 80;
    const dividerChar = "─".repeat(termWidth);

    const lines: string[] = [];

    // Header
    lines.push(
      `${BOLD}${CYAN("▛▔▔▔ UPBR233 ▔▔▔▜")}${RESET}  ${DIM}v0.1.0${RESET}  ${this.statusBadge(agentState)}`
    );

    // Divider
    lines.push(DIM + dividerChar + RESET);

    // Messages area
    const msgAreaHeight = termHeight - 6; // Reserve for header, divider, input, status
    const recentMsgs = messages.slice(-msgAreaHeight);

    for (const msg of recentMsgs) {
      const prefix = this.rolePrefix(msg.role);
      const wrappedLines = this.wrapText(prefix + msg.content, termWidth - 2);

      for (const line of wrappedLines) {
        lines.push(`  ${line}`);
      }
    }

    // Streaming text
    if (currentStreaming) {
      for (const line of this.wrapText(
        `  ${YELLOW("⟳")} ${currentStreaming}`,
        termWidth - 2
      )) {
        lines.push(line);
      }
    }

    // Fill remaining with empty lines
    while (lines.length < termHeight - 3) {
      lines.push("");
    }

    // Divider
    lines.push(DIM + dividerChar + RESET);

    // Input area
    if (agentState === "waiting_approval") {
      lines.push(`  ${YELLOW("⚠")}  ${this.t({ zh: "等待批准...", en: "Waiting for approval..." })}`);
    } else {
      lines.push(`  ${GREEN("❯")} ${inputBuffer}`);
    }

    // Status line
    lines.push(`  ${GRAY(statusLine)}`);

    this.render(lines.slice(0, termHeight));
  }

  /**
   * Render a tool approval prompt.
   */
  renderApproval(request: ToolCallRequest): void {
    const termWidth = process.stdout.columns || 80;
    const dividerChar = "─".repeat(termWidth);

    const lines = [
      `${BOLD}${YELLOW("⚠ TOOL APPROVAL REQUIRED")}${RESET}`,
      DIM + dividerChar + RESET,
      `${BOLD}Tool:${RESET} ${CYAN(request.name)}`,
      `${BOLD}Input:${RESET} ${JSON.stringify(request.input, null, 2)}`,
      "",
      `${GREEN("[Y]")} ${this.t({ zh: "允许一次", en: "Allow once" })}`,
      `${GREEN("[A]")} ${this.t({ zh: "始终允许", en: "Always allow" })}`,
      `${RED("[N]")} ${this.t({ zh: "拒绝 (可附带原因)", en: "Deny (optional reason)" })}`,
    ];

    this.render(lines);
  }

  private statusBadge(state: AgentState): string {
    switch (state) {
      case "idle":
        return DIM + `[${this.t({ zh: "空闲", en: "idle" })}]` + RESET;
      case "thinking":
        return `${CYAN("●")} ${this.t({ zh: "思考中...", en: "thinking..." })}${RESET}`;
      case "executing_tools":
        return `${YELLOW("⚙")} ${this.t({ zh: "执行工具...", en: "executing tools..." })}${RESET}`;
      case "waiting_approval":
        return `${YELLOW("⚠")} ${this.t({ zh: "等待批准", en: "awaiting approval" })}${RESET}`;
      case "done":
        return `${GREEN("✓")} ${this.t({ zh: "完成", en: "done" })}${RESET}`;
      case "error":
        return `${RED("✗")} ${this.t({ zh: "错误", en: "error" })}${RESET}`;
    }
  }

  private rolePrefix(role: string): string {
    switch (role) {
      case "user":
        return `${GREEN("▶")} `;
      case "assistant":
        return `${CYAN("■")} `;
      case "system":
        return `${DIM}◆ `;
      case "tool":
        return `${YELLOW("⚙")} `;
      case "subagent":
        return `${MAGENTA("◇")} `;
      default:
        return "  ";
    }
  }

  private wrapText(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let current = "";

    for (const char of text) {
      if (char === "\n") {
        lines.push(current);
        current = "";
        continue;
      }

      const w = this.charWidth(char);
      const currentWidth = this.stringWidth(current);

      if (currentWidth + w > maxWidth) {
        lines.push(current);
        current = char;
      } else {
        current += char;
      }
    }

    if (current) lines.push(current);
    return lines.length > 0 ? lines : [""];
  }

  private charWidth(char: string): number {
    const code = char.codePointAt(0) || 0;
    // CJK and other wide characters
    if (
      (code >= 0x1100 && code <= 0x115f) || // Hangul
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compatibility Forms
      (code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms
      (code >= 0x1f300 && code <= 0x1f64f)   // Emoticons
    ) {
      return 2;
    }
    return 1;
  }

  private stringWidth(str: string): number {
    let width = 0;
    for (const char of str) {
      width += this.charWidth(char);
    }
    return width;
  }
}

export { TuiRenderer };
export default TuiRenderer;
