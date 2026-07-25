# UPBR233 Coding Agent

<p align="center">
  <strong>🚀 AI-powered terminal coding assistant</strong><br>
  自由 · 高效 · 智能
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-installation">Installation</a> •
  <a href="#-usage">Usage</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-contributing">Contributing</a>
</p>

---

## 📖 Overview

**UPBR233** is an open-source, terminal-centric AI coding agent. It runs in your terminal and can read/edit code, execute shell commands, search the web, manage subagents, and more. Built from the ground up with performance, transparency, and extensibility in mind.

### Inspired By

- [OpenCode](https://github.com/anomalyco/opencode) - Agent modes, tool authorization, plugin hooks
- [Pi Coding Agent](https://github.com/earendil-works/pi) - Minimalist architecture, differential TUI rendering, unified provider API
- [Kimi Code](https://github.com/MoonshotAI/kimi-code) - models.dev integration, ACP protocol, lifecycle hooks
- [Memory Lancedb Pro](https://github.com/CortexReach/memory-lancedb-pro) - Vector memory with LanceDB
- [Lossless Claw Enhanced](https://github.com/win4r/lossless-claw-enhanced) - DAG-based context management

---

## ✨ Features

### Core
- **Agent Loop** - Iterative reasoning loop: think → act → observe → repeat
- **Multi-Provider** - Unified API for OpenAI, Anthropic, and custom providers
- **API Key Rotation** - Automatic key fallback with 5-hour lockout on failures
- **models.dev Integration** - Dynamic model discovery and configuration
- **Streaming** - Real-time text and tool call streaming

### Tool System
| Tool | Description |
|------|-------------|
| `read_file` | Read files with line numbers |
| `write_file` | Create or overwrite files |
| `edit_file` | Edit files by exact string replacement |
| `glob_file` | Find files by glob pattern |
| `search_file` | Search file contents with regex |
| `list_dir` | List directory contents |
| `tree_dir` | Display directory as a tree |
| `make_dir` | Create directories |
| `run_cmd` | Execute shell commands (dangerous commands require approval) |
| `web_search` | Search the web |
| `web_fetch` | Fetch and extract URL content |
| `ask_user` | Ask the user questions interactively |
| `write_todos` / `read_todos` | Manage task tracking |
| `load_skill` | Load agent skills from agentskills.io |
| `task` | Spawn isolated subagents |
| `async_task` / `async_view` | Async task execution |
| `finish_task` | Report subagent completion |

### Interaction
- **Differential TUI Rendering** - Flicker-free terminal updates
- **Multi-line Input** - Enter for newline, Ctrl+J to send
- **Keyboard Shortcuts** - Ctrl+C×2 clear, Ctrl+D×2 exit, arrow key history
- **Bilingual** - Chinese (中文) and English support
- **Tool Approval** - Allow once, always allow, or deny (with reason)

### Memory & Context
- **Context Manager Plus** - Three-layer architecture: System → Rule → Changeable
- **DAG Memory (MMP)** - Hierarchical conversation summarization with SQLite persistence
- **Subagent Isolation** - Prevent context pollution with isolated task execution

### Extensibility
- **Plugin System** - Git-based plugin installation with hook architecture
- **Skill Support** - agentskills.io compatible skill loading
- **Context API** - Plugin-accessible context management

---

## 🚀 Quick Start

```bash
# Install (requires Bun)
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/your-org/upbr233.git
cd upbr233
bun install
bun run dev
```

### Configure API Provider

```bash
# Set API key via environment variable
export UPBR_DEFAULT_API_KEY="sk-your-key-here"
export UPBR_DEFAULT_BASE_URL="https://api.openai.com/v1"

# Or use CLI arguments
bun run dev -- --api-key sk-xxx --api-base https://api.openai.com/v1

# Multiple keys (with rotation)
export UPBR_DEFAULT_API_KEY_LISTS="key1 : key2 : key3"
```

---

## 📦 Installation

### From Source

```bash
git clone https://github.com/your-org/upbr233.git
cd upbr233
bun install
bun run build
```

### Global Install (after build)

```bash
cd packages/upbr-cli
bun link
upbr --version
```

### Using gh-proxy (Mainland China)

```bash
UPBR_USE_GH_PROXY=true git clone https://gh-proxy.org/https://github.com/your-org/upbr233.git
```

---

## 🎮 Usage

```bash
# Start interactive session
upbr

# Plan mode (read-only, no file modifications)
upbr --plan

# Specify model and provider
upbr --model gpt-4o --provider openai

# Chinese locale
upbr --locale zh
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Insert newline |
| `Ctrl+J` | Send message |
| `Ctrl+C` ×2 | Clear current input |
| `Ctrl+D` ×2 | Exit (on empty input) |
| `↑` / `↓` | Navigate message history |
| `←` / `→` | Move cursor |

### Interaction Flow

1. Type your message (Enter for newlines)
2. Press `Ctrl+J` to send
3. Agent processes and may call tools
4. For dangerous operations, approve/deny when prompted
5. Agent continues until task is complete

---

## 🏗️ Architecture

```
upbr233/
├── packages/
│   ├── upbr-ai/           # Unified LLM provider API
│   │   ├── providers/     # OpenAI, Anthropic implementations
│   │   ├── unified.ts     # Multi-provider abstraction
│   │   ├── key-manager.ts # API key rotation & lockout
│   │   └── models-dev.ts  # models.dev integration
│   ├── upbr-agent-core/   # Agent runtime
│   │   ├── agent-loop.ts  # Core reasoning loop
│   │   ├── tool-system.ts # Tool registry & execution
│   │   ├── context-manager.ts # 3-layer context
│   │   ├── subagent.ts    # Subagent manager
│   │   ├── plugin-system.ts # Plugin hooks & management
│   │   └── tools/         # Built-in tools (file, shell, web, etc.)
│   ├── upbr-tui/          # Terminal UI library
│   │   └── index.ts       # Differential rendering TUI
│   ├── upbr-cli/          # CLI entry point
│   │   ├── index.ts       # Main interactive loop
│   │   └── prompt.ts      # System prompt (i18n)
│   └── upbr-mmp/          # Memory Manager Pro plugin
│       └── index.ts       # DAG memory with SQLite
├── plugins/               # Plugin directory
├── docs/                  # Documentation
└── package.json           # Monorepo root
```

### Agent Loop

```
User Input → Build Context → LLM Call → Parse Response
                                          ↓
                              ┌─ Tool Calls? ───── Yes ─→ Execute Tools
                              │                              ↓
                              └─ No ──→ Done ←── Feed Results Back
```

---

## 🔧 Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `UPBR_{NAME}_API_KEY` | Single API key for provider |
| `UPBR_{NAME}_API_KEY_LISTS` | Multiple keys, ` : ` separated |
| `UPBR_{NAME}_BASE_URL` | Custom base URL |
| `UPBR_DEFAULT_PROVIDER` | Default provider name |
| `UPBR_MODEL` | Default model |
| `UPBR_REQUEST_TIMEOUT` | Request timeout in ms (default: 120000) |
| `UPBR_USE_GH_PROXY` | Use gh-proxy for git clone |
| `UPBR_IN_CHINA` | Enable China-specific optimizations |

### Config File (coming soon)

UPBR233 will support configuration via `.upbrrc`, `.upbr/config.json`, or `upbr.config.json`.

---

## 🧪 Development

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Type check
bun run typecheck

# Run in dev mode
bun run dev

# Run with custom options
bun run dev -- --plan --model gpt-4o
```

### Adding a Plugin

```bash
# From Git repository
upbr plugin --install git@github.com Owner:Repo

# Built-in plugin
upbr plugin --install @plugin:upbr:mmp
```

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules for both humans and AI agents.

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

<p align="center">
  Made with ❤️ by the UPBR233 community
</p>
