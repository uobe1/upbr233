import type { ToolConfig } from "../types";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { readdirSync } from "fs";
import { resolve, relative, dirname, join } from "path";

const cwd = process.cwd();

export const readFileTool: ToolConfig = {
  name: "read_file",
  description: "Read the contents of a file. Returns file content with line numbers.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file (absolute or relative to project root)" },
      offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
      limit: { type: "number", description: "Maximum number of lines to read" },
    },
    required: ["path"],
  },
  requiresApproval: false,
  handler: async (input) => {
    try {
      const filePath = resolve(cwd, input.path as string);
      const content = readFileSync(filePath, "utf-8");
      let lines = content.split("\n");

      const offset = (input.offset as number) || 1;
      const limit = (input.limit as number) || lines.length;

      lines = lines.slice(offset - 1, offset - 1 + limit);

      const numbered = lines.map((line, i) => `${String(offset + i).padStart(4)} | ${line}`).join("\n");

      return {
        id: "",
        toolName: "read_file",
        output: `File: ${input.path}\nLines: ${offset}-${offset + lines.length - 1} of ${lines.length + offset - 1}\n\n${numbered}`,
        isError: false,
      };
    } catch (e) {
      return {
        id: "",
        toolName: "read_file",
        output: `Error reading file: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};

export const writeFileTool: ToolConfig = {
  name: "write_file",
  description: "Write or overwrite a file with given content. Use for creating new files or replacing entire file contents.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file" },
      content: { type: "string", description: "Full content to write to the file" },
    },
    required: ["path", "content"],
  },
  requiresApproval: true,
  handler: async (input) => {
    try {
      const filePath = resolve(cwd, input.path as string);
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(filePath, input.content as string, "utf-8");
      const size = statSync(filePath).size;
      return {
        id: "",
        toolName: "write_file",
        output: `Successfully wrote ${size} bytes to ${input.path}`,
        isError: false,
      };
    } catch (e) {
      return {
        id: "",
        toolName: "write_file",
        output: `Error writing file: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};

export const editFileTool: ToolConfig = {
  name: "edit_file",
  description: "Edit a file by replacing old string with new string. Performs exact string replacement.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit" },
      oldString: { type: "string", description: "Exact string to replace" },
      newString: { type: "string", description: "Replacement string" },
      replaceAll: { type: "boolean", description: "Replace all occurrences (default: false)" },
    },
    required: ["path", "oldString", "newString"],
  },
  requiresApproval: true,
  handler: async (input) => {
    try {
      const filePath = resolve(cwd, input.path as string);
      const content = readFileSync(filePath, "utf-8");
      const oldStr = input.oldString as string;
      const newStr = input.newString as string;

      let newContent: string;
      if (input.replaceAll || input.replaceall) {
        newContent = content.split(oldStr).join(newStr);
      } else {
        const idx = content.indexOf(oldStr);
        if (idx === -1) {
          return {
            id: "",
            toolName: "edit_file",
            output: `Error: Could not find the exact string to replace in ${input.path}. Make sure the oldString matches exactly, including whitespace.`,
            isError: true,
          };
        }
        newContent = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
      }

      writeFileSync(filePath, newContent, "utf-8");
      return {
        id: "",
        toolName: "edit_file",
        output: `Successfully edited ${input.path}`,
        isError: false,
      };
    } catch (e) {
      return {
        id: "",
        toolName: "edit_file",
        output: `Error editing file: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};

export const globFileTool: ToolConfig = {
  name: "glob_file",
  description: "Find files matching a glob pattern (e.g., **/*.ts, src/**/*.test.ts)",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match files" },
      path: { type: "string", description: "Directory to search in (default: project root)" },
    },
    required: ["pattern"],
  },
  requiresApproval: false,
  handler: async (input) => {
    try {
      // Using Bun's built-in Glob
      const pattern = input.pattern as string;
      const basePath = input.path as string || ".";
      const searchPath = resolve(cwd, basePath);

      const glob = new Bun.Glob(pattern);
      const matches: string[] = [];

      for await (const file of glob.scan({ cwd: searchPath, absolute: false })) {
        matches.push(file);
      }

      const result = matches.slice(0, 100);
      return {
        id: "",
        toolName: "glob_file",
        output: `Found ${matches.length} files matching "${pattern}":\n${result.map((f) => `  ${f}`).join("\n")}${matches.length > 100 ? `\n  ...and ${matches.length - 100} more` : ""}`,
        isError: false,
      };
    } catch (e) {
      return {
        id: "",
        toolName: "glob_file",
        output: `Error globbing: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};

export const searchFileTool: ToolConfig = {
  name: "search_file",
  description: "Search file contents using regex pattern. Returns matching lines with context.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "File path or directory to search in" },
      fileGlob: { type: "string", description: "Optional file glob to filter (e.g., *.ts)" },
      caseSensitive: { type: "boolean", description: "Case-sensitive search (default: false)" },
    },
    required: ["pattern"],
  },
  requiresApproval: false,
  handler: async (input) => {
    try {
      const pattern = input.pattern as string;
      const searchDir = resolve(cwd, (input.path as string) || ".");

      // Use ripgrep if available, otherwise use basic search
      const proc = Bun.spawn([
        "rg",
        "--line-number",
        "--no-heading",
        "--color=never",
        input.fileGlob ? `--glob=${input.fileGlob}` : "",
        input.caseSensitive ? "" : "-i",
        pattern,
        searchDir,
      ].filter(Boolean));

      const output = await new Response(proc.stdout).text();
      const lines = output.split("\n").filter(Boolean).slice(0, 100);

      return {
        id: "",
        toolName: "search_file",
        output: lines.length > 0
          ? `Found ${lines.length} matches:\n${lines.join("\n")}`
          : `No matches found for "${pattern}"`,
        isError: false,
      };
    } catch {
      return {
        id: "",
        toolName: "search_file",
        output: "Search completed (ripgrep not available, try installing it for better results)",
        isError: false,
      };
    }
  },
};

export const listDirTool: ToolConfig = {
  name: "list_dir",
  description: "List contents of a directory. Returns files and subdirectories.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (default: current working directory)" },
    },
    required: [],
  },
  requiresApproval: false,
  handler: async (input) => {
    try {
      const dirPath = resolve(cwd, (input.path as string) || ".");
      const entries = readdirSync(dirPath, { withFileTypes: true });

      const files = entries.filter((e) => e.isFile()).map((e) => `  📄 ${e.name}`).sort();
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => `  📁 ${e.name}/`).sort();
      const symlinks = entries.filter((e) => e.isSymbolicLink()).map((e) => `  🔗 ${e.name}`).sort();

      return {
        id: "",
        toolName: "list_dir",
        output: `Directory: ${input.path || "."}\n\n${dirs.join("\n")}${(files.length > 0 && dirs.length > 0) ? "\n" : ""}${files.join("\n")}${symlinks.length > 0 ? "\n" + symlinks.join("\n") : ""}`,
        isError: false,
      };
    } catch (e) {
      return {
        id: "",
        toolName: "list_dir",
        output: `Error listing directory: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};

function treeDirRecursive(dirPath: string, prefix: string, maxDepth: number, depth: number): string[] {
  if (depth > maxDepth) return [];
  const result: string[] = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = prefix + (isLast ? "    " : "│   ");

      if (entry.isDirectory()) {
        result.push(`${prefix}${connector}📁 ${entry.name}/`);
        if (depth < maxDepth) {
          result.push(...treeDirRecursive(
            join(dirPath, entry.name),
            childPrefix,
            maxDepth,
            depth + 1
          ));
        }
      } else {
        result.push(`${prefix}${connector}📄 ${entry.name}`);
      }
    }
  } catch {}
  return result;
}

export const treeDirTool: ToolConfig = {
  name: "tree_dir",
  description: "Display a directory tree structure.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path" },
      maxDepth: { type: "number", description: "Maximum depth (default: 3)" },
    },
    required: [],
  },
  requiresApproval: false,
  handler: async (input) => {
    try {
      const dirPath = resolve(cwd, (input.path as string) || ".");
      const maxDepth = (input.maxDepth as number) || 3;
      const tree = treeDirRecursive(dirPath, "", maxDepth, 0);
      return {
        id: "",
        toolName: "tree_dir",
        output: `${input.path || "."}\n${tree.join("\n")}`,
        isError: false,
      };
    } catch (e) {
      return {
        id: "",
        toolName: "tree_dir",
        output: `Error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};

export const makeDirTool: ToolConfig = {
  name: "make_dir",
  description: "Create a directory (and parent directories if needed).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path to create" },
    },
    required: ["path"],
  },
  requiresApproval: true,
  handler: async (input) => {
    try {
      const dirPath = resolve(cwd, input.path as string);
      mkdirSync(dirPath, { recursive: true });
      return {
        id: "",
        toolName: "make_dir",
        output: `Created directory: ${input.path}`,
        isError: false,
      };
    } catch (e) {
      return {
        id: "",
        toolName: "make_dir",
        output: `Error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
