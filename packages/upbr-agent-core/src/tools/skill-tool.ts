import { readFileSync, existsSync } from "fs";
import type { ToolConfig } from "../types";

// Skill loading and management
const loadedSkills = new Map<string, string>(); // name -> full SKILL.md content

export const loadSkillTool: ToolConfig = {
  name: "load_skill",
  description: "Load a skill's full SKILL.md content. Skills are indexed in the context; use this to load the complete instructions for a specific skill.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the skill to load" },
    },
    required: ["name"],
  },
  requiresApproval: false,
  handler: async (input) => {
    const name = input.name as string;

    // Check if already loaded
    if (loadedSkills.has(name)) {
      return {
        id: "",
        toolName: "load_skill",
        output: `Skill "${name}" loaded:\n\n${loadedSkills.get(name)}`,
        isError: false,
      };
    }

    // Try to find SKILL.md in known locations
    const paths = [
      `.agents/skills/${name}/SKILL.md`,
      `.agent/skills/${name}/SKILL.md`,
      `skills/${name}/SKILL.md`,
      `${process.env.HOME}/.upbr/skills/${name}/SKILL.md`,
    ];

    for (const p of paths) {
      try {
        if (existsSync(p)) {
          const content = readFileSync(p, "utf-8");
          loadedSkills.set(name, content);
          return {
            id: "",
            toolName: "load_skill",
            output: `Skill "${name}" loaded from ${p}:\n\n${content}`,
            isError: false,
            metadata: { path: p },
          };
        }
      } catch {}
    }

    // Try using community skill discovery (npx skills)
    return {
      id: "",
      toolName: "load_skill",
      output: `Skill "${name}" not found locally. Try installing it with:\n\n  npx skills add <owner/repo> --skill ${name} --yes\n\nOr search for skills:\n  npx skills find ${name}`,
      isError: true,
    };
  },
};
