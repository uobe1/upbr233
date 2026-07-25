import type {
  IProvider,
  ProviderConfig,
  ProviderMetadata,
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
  private lastUsedKeyIndex = -1;
  private keyLockedUntil = new Map<number, number>(); // index -> timestamp
  private metadata: ProviderMetadata;
  private retryCount = 0;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKeys = [...new Set(config.apiKeys)]; // dedup
    this.metadata = config.metadata || {};
    if (this.apiKeys.length === 0) {
      throw new Error(`Provider "${config.name}" has no API keys configured`);
    }
  }

  private get timeoutMs(): number {
    return this.metadata.requestTimeoutMs ?? parseInt(process.env.UPBR_REQUEST_TIMEOUT || "120000");
  }

  private get maxRetries(): number {
    return this.metadata.maxRetries ?? 3;
  }

  private get retryDelay(): number {
    if (this.metadata.retryBackoff) {
      return (this.metadata.retryIntervalMs || 1000) * Math.pow(2, this.retryCount);
    }
    return this.metadata.retryIntervalMs || 1000;
  }

  private getActiveKey(): string {
    const now = Date.now();
    const startIdx = this.currentKeyIndex;

    for (let i = 0; i < this.apiKeys.length; i++) {
      const idx = (startIdx + i) % this.apiKeys.length;
      const lockedUntil = this.keyLockedUntil.get(idx);
      if (!lockedUntil || now >= lockedUntil) {
        this.lastUsedKeyIndex = idx;
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

  private lockLastUsedKey(): void {
    if (this.lastUsedKeyIndex >= 0) {
      this.lockKey(this.lastUsedKeyIndex);
    }
  }

  async listModels(): Promise<ModelConfig[]> {
    const key = this.getActiveKey();
    try {
      const resp = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          this.lockLastUsedKey();
          return this.listModels();
        }
        return [];
      }
      const data = await resp.json() as Record<string, unknown>;
      return ((data.data || []) as Array<{ id: string }>).map((m) => ({
        name: m.id,
        maxContextLength: 128000,
        thinking: { canThink: false, canToggle: false, levels: [] },
        capabilities: { textInput: true, textOutput: true, toolCall: true },
      }));
    } catch {
      this.lockLastUsedKey();
      return this.listModels();
    }
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    this.retryCount = 0;
    return this._chat(request);
  }

  private async _chat(request: LLMRequest): Promise<LLMResponse> {
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
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        if (resp.status === 401 || resp.status === 403) {
          this.lockLastUsedKey();
          return this._chat(request);
        }
        if (resp.status === 429 || resp.status >= 500) {
          if (this.retryCount < this.maxRetries) {
            this.retryCount++;
            await this.sleep(this.retryDelay);
            return this._chat(request);
          }
        }
        throw new Error(`Provider error (${resp.status}): ${err}`);
      }

      this.retryCount = 0;
      const data = await resp.json() as Record<string, unknown>;
      return this.parseResponse(data);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Provider error")) throw e;
      if (e instanceof Error && e.message.startsWith("All API keys")) throw e;
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        await this.sleep(this.retryDelay);
        this.lockLastUsedKey();
        return this._chat(request);
      }
      this.lockLastUsedKey();
      return this._chat(request);
    }
  }

  async *chatStream(request: LLMRequest): AsyncGenerator<StreamEvent> {
    this.retryCount = 0;
    yield* this._chatStream(request);
  }

  private async *_chatStream(request: LLMRequest): AsyncGenerator<StreamEvent> {
    const key = this.getActiveKey();
    const body = { ...this.buildRequestBody(request), stream: true };

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!resp.ok || !resp.body) {
      const err = await resp.text().catch(() => "");
      if (resp.status === 401 || resp.status === 403) {
        this.lockLastUsedKey();
        yield* this._chatStream(request);
        return;
      }
      if ((resp.status === 429 || resp.status >= 500) && this.retryCount < this.maxRetries) {
        this.retryCount++;
        await this.sleep(this.retryDelay);
        yield* this._chatStream(request);
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

            if (delta.content) {
              yield { type: "text_delta", text: delta.content };
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolUseBuffers.has(idx)) {
                  toolUseBuffers.set(idx, { name: tc.function?.name || "", input: "" });
                }
                const buf = toolUseBuffers.get(idx)!;
                if (tc.function?.name) buf.name = tc.function.name;
                if (tc.function?.arguments) buf.input += tc.function.arguments;
              }
            }

            if (chunk.choices?.[0]?.finish_reason === "tool_calls") {
              for (const [, buf] of toolUseBuffers) {
                try {
                  const input = JSON.parse(buf.input);
                  yield {
                    type: "tool_use",
                    toolUse: {
                      type: "tool_use",
                      id: `tool_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
                      name: buf.name,
                      input,
                    },
                  };
                } catch { /* skip malformed */ }
              }
            }
          } catch { /* skip malformed chunks */ }
        }
      }
      yield { type: "message_stop" };
    } finally {
      reader.releaseLock();
    }
  }

  async countTokens(messages: Message[], _model: string): Promise<number> {
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === "string"
        ? msg.content : JSON.stringify(msg.content);
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
    const body: Record<string, unknown> = {
      model: request.model,
      messages: this.formatMessages(request),
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
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
      msgs.push({ role: msg.role, content: msg.content });
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
          input: typeof fn?.arguments === "string" ? JSON.parse(fn.arguments) : (fn?.arguments || {}),
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
