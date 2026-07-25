import type {
  IProvider,
  ProviderConfig,
  LLMRequest,
  LLMResponse,
  StreamEvent,
  Message,
  ToolDefinition,
  ModelConfig,
} from "../types";

export class OpenAIProvider implements IProvider {
  readonly name: string;
  readonly protocol = "openai-compatible" as const;
  private baseUrl: string;
  private apiKeys: string[];
  private currentKeyIndex = 0;
  private keyLockedUntil = new Map<number, number>(); // index -> timestamp

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKeys = [...new Set(config.apiKeys)]; // dedup
    if (this.apiKeys.length === 0) {
      throw new Error(`Provider "${config.name}" has no API keys configured`);
    }
  }

  private getActiveKey(): string {
    const now = Date.now();
    const startIdx = this.currentKeyIndex;

    // Try all keys, respecting lockout periods
    for (let i = 0; i < this.apiKeys.length; i++) {
      const idx = (startIdx + i) % this.apiKeys.length;
      const lockedUntil = this.keyLockedUntil.get(idx);
      if (!lockedUntil || now >= lockedUntil) {
        this.currentKeyIndex = (idx + 1) % this.apiKeys.length;
        return this.apiKeys[idx]!;
      }
    }

    // All keys locked - find earliest unlock time
    let earliestUnlock = Infinity;
    for (const [idx, until] of this.keyLockedUntil) {
      if (until < earliestUnlock) earliestUnlock = until;
    }
    const waitMs = earliestUnlock - now;
    throw new Error(
      `All API keys are temporarily unavailable. ` +
      `Next key available in ${Math.ceil(waitMs / 1000 / 60)} minutes.`
    );
  }

  private lockKey(index: number): void {
    // Lock for 5 hours as per spec
    this.keyLockedUntil.set(index, Date.now() + 5 * 60 * 60 * 1000);
  }

  async listModels(): Promise<ModelConfig[]> {
    const key = this.getActiveKey();
    try {
      const resp = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          this.lockKey(this.currentKeyIndex);
          return this.listModels();
        }
        return [];
      }
      const data = await resp.json();
      return (data.data || []).map((m: { id: string }) => ({
        name: m.id,
        maxContextLength: 128000,
        thinking: { canThink: false, canToggle: false, levels: [] },
        capabilities: { textInput: true, textOutput: true, toolCall: true },
      }));
    } catch {
      // Network error - try next key
      this.lockKey(this.currentKeyIndex);
      return this.listModels();
    }
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const key = this.getActiveKey();
    const body = this.buildRequestBody(request);

    try {
      const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
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

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        parseInt(process.env.UPBR_REQUEST_TIMEOUT || "120000")
      ),
    });

    if (!resp.ok || !resp.body) {
      const err = await resp.text().catch(() => "");
      if (resp.status === 401 || resp.status === 403) {
        this.lockKey(this.currentKeyIndex);
        yield* this.chatStream(request);
        return;
      }
      yield { type: "error", error: `Provider error (${resp.status}): ${err}` };
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolUseBuffers = new Map<string, { name: string; input: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const jsonStr = trimmed.slice(6);
          if (jsonStr === "[DONE]") {
            yield { type: "message_stop" };
            return;
          }

          try {
            const chunk = JSON.parse(jsonStr);
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Text delta
            if (delta.content) {
              yield { type: "text_delta", text: delta.content };
            }

            // Tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolUseBuffers.has(idx)) {
                  toolUseBuffers.set(idx, {
                    name: tc.function?.name || "",
                    input: "",
                  });
                }
                const buf = toolUseBuffers.get(idx)!;
                if (tc.function?.name) buf.name = tc.function.name;
                if (tc.function?.arguments) buf.input += tc.function.arguments;
              }
            }

            // Finish reason
            if (chunk.choices?.[0]?.finish_reason === "tool_calls") {
              for (const [idx, buf] of toolUseBuffers) {
                try {
                  const input = JSON.parse(buf.input);
                  yield {
                    type: "tool_use",
                    toolUse: {
                      type: "tool_use",
                      id: `tool_${idx}_${Date.now()}`,
                      name: buf.name,
                      input,
                    },
                  };
                } catch {
                  // Skip malformed tool calls
                }
              }
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
      yield { type: "message_stop" };
    } finally {
      reader.releaseLock();
    }
  }

  async countTokens(messages: Message[], model: string): Promise<number> {
    // Rough estimate: ~4 chars per token for English, ~2 for CJK
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
      // Rough estimate: 4 chars per token
      total += Math.ceil(content.length / 4);
    }
    // Add 3 tokens per message for formatting
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
    const body: Record<string, unknown> = {
      model: request.model,
      messages: this.formatMessages(request),
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    if (request.thinking) {
      body.thinking = request.thinking;
    }

    return body;
  }

  private formatMessages(request: LLMRequest): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [];

    if (request.system) {
      msgs.push({ role: "system", content: request.system });
    }

    for (const msg of request.messages) {
      msgs.push({
        role: msg.role,
        content: msg.content,
      });
    }

    return msgs;
  }

  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
    const message = choice?.message as Record<string, unknown>;
    const usage = data.usage as Record<string, number>;

    const content: LLMResponse["content"] = [];

    if (typeof message?.content === "string" && message.content) {
      content.push({ type: "text", text: message.content });
    }

    const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown>;
        content.push({
          type: "tool_use",
          id: (tc.id as string) || `tool_${Date.now()}`,
          name: (fn?.name as string) || "",
          input: typeof fn?.arguments === "string"
            ? JSON.parse(fn.arguments)
            : (fn?.arguments || {}),
        });
      }
    }

    const stopReason =
      choice?.finish_reason === "tool_calls" ? "tool_use" :
      choice?.finish_reason === "stop" ? "end_turn" :
      choice?.finish_reason === "length" ? "max_tokens" :
      "stop_sequence";

    return {
      id: (data.id as string) || crypto.randomUUID(),
      model: (data.model as string) || "unknown",
      content,
      stopReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
    };
  }
}
