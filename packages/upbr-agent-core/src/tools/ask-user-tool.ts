import type { ToolConfig } from "../types";

/**
 * Ask User tool - allows the agent to pause execution and ask the user
 * a question. The user can provide an answer which is fed back as the
 * tool result. Supports single-select and multi-select modes.
 *
 * Reference: OpenCode's ask_user mechanism.
 */
export const askUserTool: ToolConfig = {
  name: "ask_user",
  description: "Ask the user one or more questions and wait for answers. Use when you need clarification, need the user to choose between options, or need important decisions confirmed before proceeding.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "Array of questions to ask the user. Each question has a question text, optional header, and options.",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question to ask the user",
            },
            header: {
              type: "string",
              description: "Short label for the question (max 18 chars)",
            },
            options: {
              type: "array",
              description: "Array of answer options with label and optional description",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "The display text for this option",
                  },
                  description: {
                    type: "string",
                    description: "Explanation shown when option is focused",
                  },
                },
                required: ["label"],
              },
            },
            multiSelect: {
              type: "boolean",
              description: "If true, allows selecting multiple options (default: false)",
            },
          },
          required: ["question", "options"],
        },
      },
      title: {
        type: "string",
        description: "Optional title for the question dialog",
      },
    },
    required: ["questions"],
  },
  requiresApproval: false,
  handler: async (input) => {
    const questions = input.questions as Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;

    // Format the questions for display
    // The TUI/CLI layer handles the actual interactive input capture
    // The agent should wait for the user to answer before proceeding
    let output = "=== QUESTIONS FROM AGENT ===\n";
    output += "Please answer ALL questions before continuing.\n\n";

    if (input.title) {
      output += `## ${input.title}\n\n`;
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      output += `Q${i + 1}. ${q.question}\n`;
      if (q.multiSelect) {
        output += "   (multi-select)\n";
      }
      output += q.options
        .map((o, j) => `   [${j + 1}] ${o.label}${o.description ? ` - ${o.description}` : ""}`)
        .join("\n");
      output += "\n";
    }

    output += "\nPlease answer each question. Format: Q<number>=<option number> or Q<number>=<custom answer>";

    return {
      id: "",
      toolName: "ask_user",
      output,
      isError: false,
      metadata: {
        needsUserInput: true,
        questions,
      },
    };
  },
};
