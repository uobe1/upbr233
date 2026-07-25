import type {
  IProvider,
  ProviderConfig,
  LLMRequest,
  LLMResponse,
  StreamEvent,
  Message,
  ModelConfig,
  MessageContent,
} from "../types";

export class AnthropicProvider implements IProvider {
  readonly name: string;
  readonly protocol = "anthropic-compatible" as const;
  private baseUrl: string;
  private apiKeys: string[];
  private currentKeyIndex = 0;
  private keyLockedUntil = new Map<number, number>();

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKeys = [...new Set(config.apiKeys)];
    if (this.apiKeys.length === 0) {
      throw new Error(`Provider "${config.name}" has no API keys configured`);
    }
  }

  private getActiveKey(): string {
    const now = Date.now();
    const startIdx = this.currentKeyIndex;
    for (let i = 0; i < this.apiKeys.length; i++) {
      const idx = (startIdx + i) % this.apiKeys.length;
      const lockedUntil = this.keyLockedUntil.get(idx);
      if (!lockedUntil || now >= lockedUntil) {
        this.currentKeyIndex = (idx + 1) % this.apiKeys.length;
        return this.apiKeys[idx]!;
      }
    }
    let earliestUnlock = Infinity;
    for (const [, until] of this.keyLockedUntil) {
      if (until < earliestUnlock) earliestUnlock = until;
    }
    const waitMs = earliestUnlock - now;
    throw new Error(
      `All API keys are temporarily unavailable. ` +
      `Next key available in ${Math.ceil(waitMs / 1000 / 60)} minutes.`
    );
  }

  private lockKey(index: number): void {
    this.keyLockedUntil.set(index, Date.now() + 5 * 60 * 60 * 1000);
  }

  async listModels(): Promise<ModelConfig[]> {
    // Anthropic doesn't have a standard /models endpoint
    // Return known Claude models
    return [
      {
        name: "claude-sonnet-4-20250514",
        maxContextLength: 200000,
        maxOutput: 64000,
        thinking: {
          canThink: true,
          canToggle: true,
          levels: ["no_thinking", "low", "high", "max"],
        },
        capabilities: {
          textInput: true,
          textOutput: true,
          toolCall: true,
          imageInput: true,
        },
      },
      {
        name: "claude-opus-4-20250514",
        maxContextLength: 200000,
        maxOutput: 32000,
        thinking: {
          canThink: true,
          canToggle: true,
          levels: ["no_thinking", "low", "high", "max"],
        },
        capabilities: {
          textInput: true,
          textOutput: true,
          toolCall: true,
          imageInput: true,
        },
      },
      {
        name: "claude-haiku-3-5-20241022",
        maxContextLength: 200000,
        maxOutput: 8192,
        thinking: { canThink: false, canToggle: false, levels: [] },
        capabilities: {
          textInput: true,
          textOutput: true,
          toolCall: true,
          imageInput: true,
        },
      },
    ];
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const key = this.getActiveKey();
    const body = this.buildRequestBody(request);

    try {
      const resp = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(
          parseInt(process.env.UPBR_REQUEST_TIMEOUT || "120000")
        ),
      });

      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        if (resp.status === 401 || resp.status === 403) {
          this.lockKey(this.currentKeyIndex);
          return this.chat(request);
        }
        throw new Error(`Provider error (${resp.status}): ${err}`);
      }

      const data = await resp.json();
      return this.parseResponse(data);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Provider error")) throw e;
      if (e instanceof Error && e.message.startsWith("All API keys")) throw e;
      this.lockKey(this.currentKeyIndex);
      return this.chat(request);
    }
  }

  async *chatStream(request: LLMRequest): AsyncGenerator<StreamEvent> {
    const key = this.getActiveKey();
    const body = { ...this.buildRequestBody(request), stream: true };

    try {
      const resp = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(
          parseInt(process.env.UPBR_REQUEST_TIMEOUT || "120000")
        ),
      });

      if (!resp.ok || !resp.body) {
        if (resp.status === 401 || resp.status === 403) {
          this.lockKey(this.currentKeyIndex);
          yield* this.chatStream(request);
          return;
        }
        const err = await resp.text().catch(() => "");
        yield { type: "error", error: `Provider error (${resp.status}): ${err}` };
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentToolBlock: { id: string; name: string; input: string } | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;

            const jsonStr = trimmed.slice(6);
            try {
              const event = JSON.parse(jsonStr);

              switch (event.type) {
                case "content_block_start": {
                  const block = event.content_block;
                  if (block?.type === "tool_use") {
                    currentToolBlock = {
                      id: block.id,
                      name: block.name,
                      input: "",
                    };
                  }
                  break;
                }
                case "content_block_delta": {
                  const delta = event.delta;
                  if (delta?.type === "text_delta") {
                    yield { type: "text_delta", text: delta.text };
                  } else if (delta?.type === "input_json_delta" && currentToolBlock) {
                    currentToolBlock.input += delta.partial_json;
                  }
                  break;
                }
                case "content_block_stop": {
                  if (currentToolBlock) {
                    try {
                      const input = JSON.parse(currentToolBlock.input);
                      yield {
                        type: "tool_use",
                        toolUse: {
                          type: "tool_use",
                          id: currentToolBlock.id,
                          name: currentToolBlock.name,
                          input,
                        },
                      };
                    } catch {
                      // skip malformed input
                    }
                    currentToolBlock = null;
                  }
                  break;
                }
                case "message_stop": {
                  yield { type: "message_stop" };
                  return;
                }
              }
            } catch {
              // Skip malformed events
            }
          }
        }
        yield { type: "message_stop" };
      } finally {
        reader.releaseLock();
      }
    } catch {
      this.lockKey(this.currentKeyIndex);
      yield* this.chatStream(request);
    }
  }

  async countTokens(messages: Message[], _model: string): Promise<number> {
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
      total += Math.ceil(content.length / 4);
    }
    total += messages.length * 3;
    return total;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  private buildRequestBody(request: LLMRequest): Record<string, unknown> {
    const { systemMessages, otherMessages } = this.separateMessages(request);

    const body: Record<string, unknown> = {
      model: request.model,
      messages: otherMessages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string"
          ? [{ type: "text", text: m.content }]
          : m.content,
      })),
      max_tokens: request.maxTokens ?? 4096,
    };

    if (systemMessages.length > 0) {
      body.system = systemMessages
        .map((m) =>
          typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        )
        .join("\n\n");
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

    if (request.thinking) {
      body.thinking = request.thinking;
    }

    return body;
  }

  private separateMessages(request: LLMRequest): {
    systemMessages: Message[];
    otherMessages: Message[];
  } {
    const systemMessages: Message[] = [];
    const otherMessages: Message[] = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemMessages.push(msg);
      } else {
        otherMessages.push(msg);
      }
    }

    if (request.system) {
      systemMessages.unshift({ role: "system", content: request.system });
    }

    return { systemMessages, otherMessages };
  }

  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const content: MessageContent[] = [];

    const contentBlocks = data.content as Array<Record<string, unknown>>;
    if (contentBlocks) {
      for (const block of contentBlocks) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text as string });
        } else if (block.type === "tool_use") {
          content.push({
            type: "tool_use",
            id: block.id as string,
            name: block.name as string,
            input: block.input as Record<string, unknown>,
          });
        }
      }
    }

    const usage = data.usage as Record<string, number>;
    const stopReasonStr = (data.stop_reason as string) || "end_turn";

    return {
      id: (data.id as string) || crypto.randomUUID(),
      model: (data.model as string) || "unknown",
      content,
      stopReason: stopReasonStr === "tool_use"
        ? "tool_use"
        : stopReasonStr === "end_turn"
          ? "end_turn"
          : stopReasonStr === "max_tokens"
            ? "max_tokens"
            : "stop_sequence",
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheCreationInputTokens: usage?.cache_creation_input_tokens,
        cacheReadInputTokens: usage?.cache_read_input_tokens,
      },
    };
  }
}
