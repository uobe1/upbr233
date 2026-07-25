import type { ToolConfig } from "../types";

const DANGEROUS_COMMANDS = [
  /rm\s+-rf\s+(\/|~|\.{1,2}\/)/,
  /rm\s+-rf\s+\/(tmp|root|etc|usr|var|home|opt|sys|proc|dev)(\/|\s|$)/,
  /sudo\s+rm/,
  /mkfs\./,
  /dd\s+if=/,
  />\s*\/dev\//,
  /chmod\s+777/,
  /chown\s+-R/,
  /git\s+push\s+--force/,
  /git\s+push\s+-f/,
  /:\(\)\s*\{\s*:\|\:&\s*\}/,  // fork bomb
];

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMANDS.some((pattern) => pattern.test(command));
}

export const runCmdTool: ToolConfig = {
  name: "run_cmd",
  description: "Run a shell command. Dangerous commands (rm -rf /, sudo rm, etc.) require user approval.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      shell: { type: "string", description: "Shell to use (e.g., bash, zsh, fish). Default: configured default" },
      loadRc: { type: "boolean", description: "Whether to load .bashrc/.zshrc/etc (default: true)" },
      workingDir: { type: "string", description: "Working directory for the command" },
      timeout: { type: "number", description: "Timeout in seconds (default: 30)" },
    },
    required: ["command"],
  },
  requiresApproval: false, // Dynamic - dangerous commands trigger approval
  handler: async (input) => {
    const command = input.command as string;
    const timeout = (input.timeout as number) || 30;
    const shell = (input.shell as string) || process.env.SHELL || "/bin/bash";
    const workingDir = (input.workingDir as string) || process.cwd();

    // Check for dangerous commands
    if (isDangerousCommand(command)) {
      return {
        id: "",
        toolName: "run_cmd",
        output: `DANGEROUS_COMMAND: "${command}" requires explicit user approval. This command matches dangerous patterns (e.g., destructive file operations, force push).`,
        isError: true,
        metadata: { dangerous: true },
      };
    }

    try {
      const proc = Bun.spawn(
        ["bash", "-c", input.loadRc !== false ? `source ~/.bashrc 2>/dev/null; ${command}` : command],
        {
          cwd: workingDir,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, SHELL: shell },
        }
      );

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      const timer = setTimeout(() => {
        proc.kill();
      }, timeout * 1000);

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const result = [
        exitCode !== 0 ? `Exit code: ${exitCode}` : "",
        stdout ? stdout.trim() : "",
        stderr ? `(stderr)\n${stderr.trim()}` : "",
      ].filter(Boolean).join("\n");

      return {
        id: "",
        toolName: "run_cmd",
        output: result || "(no output)",
        isError: exitCode !== 0,
        metadata: { exitCode },
      };
    } catch (e) {
      return {
        id: "",
        toolName: "run_cmd",
        output: `Error executing command: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
