# AGENTS.md

## Project: UPBR233 Coding Agent

This file provides instructions for both human contributors and AI agents working on this project.

## Project Structure

UPBR233 is a TypeScript monorepo using Bun workspaces:

- `packages/upbr-ai/` - Unified multi-provider LLM API
- `packages/upbr-agent-core/` - Agent runtime, tool system, context manager
- `packages/upbr-tui/` - Terminal UI with differential rendering
- `packages/upbr-cli/` - CLI entry point (`upbr` command)
- `packages/upbr-mmp/` - Memory Manager Pro (DAG memory plugin)
- `plugins/` - External plugin directory
- `docs/` - Documentation

## Conventions

### Code Style
- TypeScript strict mode enabled
- ESM modules only (`import`/`export`, no `require`)
- Use `node:` prefix for Node.js built-in imports (e.g., `node:fs`, `node:path`)
- Prefer `Bun` APIs over Node.js where applicable
- Single-file modules when possible, split when exceeding ~500 lines

### Naming
- **Files**: kebab-case (`agent-loop.ts`, `key-manager.ts`)
- **Classes**: PascalCase (`AgentLoop`, `ToolRegistry`)
- **Functions**: camelCase (`createToolRegistry`, `buildContext`)
- **Types/Interfaces**: PascalCase with `I` prefix for interfaces (`IProvider`, `IToolRegistry`)
- **Constants**: UPPER_SNAKE_CASE for top-level constants
- **Exports**: Prefer named exports over default exports

### Architecture Patterns
- **Provider Pattern**: All providers implement `IProvider` interface
- **Tool Pattern**: All tools follow `ToolConfig` shape with `name`, `description`, `inputSchema`, `requiresApproval`, `handler`
- **Context Layers**: Unchangeable (System + Rule) vs Changeable (History)
- **Event-Driven**: Agent loop emits events; TUI subscribes

### Important Rules
1. NEVER use `require()` - always use ESM `import`
2. Always read surrounding code before making changes
3. Reuse existing helpers, components, and classes
4. Make minimal changes to achieve the goal
5. When modifying exports, find and update ALL references
6. Use `@upbr233/*` workspace references for internal imports

## Testing

```bash
bun test                    # Run all tests
bun test packages/upbr-ai   # Test specific package
```

## Build

```bash
bun run build      # Build all packages
bun run typecheck  # Type check all packages
```

## Performance Targets

- Memory: < 80 MiB
- Package size: < 400 MiB
- Cold start: < 800 ms
- Shutdown: < 600 ms
