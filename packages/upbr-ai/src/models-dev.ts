import type { ModelConfig } from "./types";

/**
 * Models.dev client - fetches model metadata from the models.dev registry.
 * models.dev is an open-source, community-maintained database of AI model
 * specifications, pricing, and capabilities.
 */
export class ModelsDevClient {
  private baseUrl: string;
  private cache: Map<string, { data: unknown; expires: number }> = new Map();
  private cacheTtlMs: number;

  constructor(options?: { baseUrl?: string; cacheTtlMs?: number }) {
    this.baseUrl = options?.baseUrl || "https://models.dev/api";
    this.cacheTtlMs = options?.cacheTtlMs || 5 * 60 * 1000; // 5 min default
  }

  /**
   * Search for models matching a query.
   */
  async searchModels(query: string): Promise<ModelConfig[]> {
    const cached = this.cache.get(`search:${query}`);
    if (cached && Date.now() < cached.expires) {
      return cached.data as ModelConfig[];
    }

    try {
      const resp = await fetch(
        `${this.baseUrl}/models?q=${encodeURIComponent(query)}`,
        { signal: AbortSignal.timeout(5000) }
      );

      if (!resp.ok) return [];
      const data = await resp.json() as Record<string, unknown>;
      const models = ((data.models || data.data || []) as Array<Record<string, unknown>>).map(this.parseModelEntry);

      this.cache.set(`search:${query}`, {
        data: models,
        expires: Date.now() + this.cacheTtlMs,
      });

      return models;
    } catch {
      return [];
    }
  }

  /**
   * List all available providers from models.dev.
   */
  async listProviders(): Promise<ProviderInfo[]> {
    const cached = this.cache.get("providers");
    if (cached && Date.now() < cached.expires) {
      return cached.data as ProviderInfo[];
    }

    try {
      const resp = await fetch(`${this.baseUrl}/providers`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) return [];
      const data = await resp.json() as Record<string, unknown>;
      const providers = ((data.providers || data.data || []) as Array<Record<string, unknown>>).map(
        (p: Record<string, unknown>) => ({
          name: p.name as string,
          id: p.id as string,
          models: (p.models as Array<Record<string, unknown>> || []).map(
            this.parseModelEntry
          ),
        })
      );

      this.cache.set("providers", {
        data: providers,
        expires: Date.now() + this.cacheTtlMs,
      });

      return providers;
    } catch {
      return [];
    }
  }

  /**
   * Get models for a specific provider.
   */
  async getProviderModels(providerId: string): Promise<ModelConfig[]> {
    const cached = this.cache.get(`provider:${providerId}`);
    if (cached && Date.now() < cached.expires) {
      return cached.data as ModelConfig[];
    }

    try {
      const resp = await fetch(
        `${this.baseUrl}/providers/${providerId}/models`,
        { signal: AbortSignal.timeout(5000) }
      );

      if (!resp.ok) return [];
      const data = await resp.json() as Record<string, unknown>;
      const models = ((data.models || data.data || []) as Array<Record<string, unknown>>).map(this.parseModelEntry);

      this.cache.set(`provider:${providerId}`, {
        data: models,
        expires: Date.now() + this.cacheTtlMs,
      });

      return models;
    } catch {
      return [];
    }
  }

  private parseModelEntry(entry: Record<string, unknown>): ModelConfig {
    return {
      name: (entry.name || entry.model || entry.id) as string,
      maxContextLength: (entry.maxContextLength ||
        entry.context_window ||
        entry.context_length ||
        128000) as number,
      maxOutput: (entry.maxOutput ||
        entry.max_tokens ||
        entry.max_output_tokens ||
        4096) as number | undefined,
      maxInput: entry.maxInput as number | undefined,
      thinking: {
        canThink: Boolean(entry.supports_thinking || entry.thinking),
        canToggle: entry.canToggleThinking !== false,
        levels: (entry.thinking_levels as string[]) || [],
      },
      pricing: entry.pricing
        ? {
            input: (entry.pricing as Record<string, number>).input || 0,
            output: (entry.pricing as Record<string, number>).output || 0,
            cacheHitInput: (entry.pricing as Record<string, number>)
              .cacheHitInput,
          }
        : undefined,
      capabilities: {
        textInput: true,
        textOutput: true,
        toolCall: Boolean(entry.supports_tools || entry.toolCall !== false),
        imageInput: Boolean(entry.supports_vision || entry.imageInput),
        imageOutput: Boolean(entry.imageOutput),
        audioInput: Boolean(entry.audioInput),
        audioOutput: Boolean(entry.audioOutput),
        videoInput: Boolean(entry.videoInput),
        videoOutput: Boolean(entry.videoOutput),
      },
    };
  }
}

export interface ProviderInfo {
  name: string;
  id: string;
  models: ModelConfig[];
}
