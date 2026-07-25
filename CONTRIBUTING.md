# Contributing to UPBR233

Thank you for your interest in contributing! UPBR233 is an open-source AI coding agent.

## Development Setup

```bash
# Prerequisites: Bun >= 1.1.0
curl -fsSL https://bun.sh/install | bash

# Clone and install
git clone https://github.com/your-org/upbr233.git
cd upbr233
bun install

# Build
bun run build

# Run in dev mode
bun run dev
```

## Development Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes following [AGENTS.md](AGENTS.md) conventions
4. Build and typecheck: `bun run build && bun run typecheck`
5. Run tests: `bun test`
6. Commit with a descriptive message
7. Push and create a Pull Request

## Code Review

All submissions require code review. We aim to:
- Review within 48 hours
- Provide constructive feedback
- Help contributors succeed

## Reporting Issues

Use GitHub Issues. Include:
- Steps to reproduce
- Expected vs actual behavior
- Environment info (Bun version, OS, terminal)
- Relevant logs or screenshots

## Security

For security vulnerabilities, please do NOT open a public issue. Instead, email the maintainers directly or use GitHub's private vulnerability reporting.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
