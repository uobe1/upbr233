import type {
  IProvider,
  LLMRequest,
  LLMResponse,
  StreamEvent,
  Message,
  ModelConfig,
  ProviderConfig,
} from "./types";
import { createProvider } from "./provider-registry";

/**
 * Unified Provider - presents a single interface across all LLM providers.
 * Manages provider selection, fallback, and model routing.
 */
export class UnifiedProvider {
  private providers = new Map<string, IProvider>();
  private modelProviderMap = new Map<string, string>(); // model -> provider name
  private defaultProvider: string | null = null;

  /**
   * Add a provider from a config object.
   */
  addProvider(config: ProviderConfig): IProvider {
    const provider = createProvider(config);
    this.providers.set(provider.name, provider);

    if (!this.defaultProvider) {
      this.defaultProvider = provider.name;
    }

    return provider;
  }

  /**
   * Remove a provider by name.
   */
  removeProvider(name: string): void {
    this.providers.delete(name);
    // Clean model mappings for removed provider
    for (const [model, provider] of this.modelProviderMap) {
      if (provider === name) {
        this.modelProviderMap.delete(model);
      }
    }
    if (this.defaultProvider === name) {
      this.defaultProvider = this.providers.keys().next().value ?? null;
    }
  }

  /**
   * Register a model to use a specific provider.
   */
  registerModel(modelName: string, providerName: string): void {
    if (!this.providers.has(providerName)) {
      throw new Error(`Provider "${providerName}" not found`);
    }
    this.modelProviderMap.set(modelName, providerName);
  }

  /**
   * Set the default provider name.
   */
  setDefaultProvider(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider "${name}" not found`);
    }
    this.defaultProvider = name;
  }

  /**
   * Get a provider by name.
   */
  getProvider(name: string): IProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Resolve the provider for a given model.
   */
  private resolveProvider(model: string): IProvider {
    const providerName = this.modelProviderMap.get(model) || this.defaultProvider;
    if (!providerName) {
      throw new Error("No provider configured. Add a provider first.");
    }

    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(
        `Provider "${providerName}" for model "${model}" not found`
      );
    }

    return provider;
  }

  /**
   * List all available models across all providers.
   */
  async listAllModels(): Promise<Map<string, ModelConfig[]>> {
    const result = new Map<string, ModelConfig[]>();
    for (const [name, provider] of this.providers) {
      try {
        const models = await provider.listModels();
        result.set(name, models);
      } catch {
        result.set(name, []);
      }
    }
    return result;
  }

  /**
   * Send a chat request using the appropriate provider.
   */
  async chat(request: LLMRequest): Promise<LLMResponse> {
    const provider = this.resolveProvider(request.model);
    return provider.chat(request);
  }

  /**
   * Stream a chat response using the appropriate provider.
   */
  async *chatStream(request: LLMRequest): AsyncGenerator<StreamEvent> {
    const provider = this.resolveProvider(request.model);
    yield* provider.chatStream(request);
  }

  /**
   * Count tokens for a message set using the appropriate provider.
   */
  async countTokens(
    messages: Message[],
    model: string
  ): Promise<number> {
    const provider = this.resolveProvider(model);
    return provider.countTokens(messages, model);
  }

  /**
   * Check health of all providers.
   */
  async healthCheck(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    const checks = [...this.providers.entries()].map(
      async ([name, provider]) => {
        try {
          const ok = await provider.healthCheck();
          results.set(name, ok);
        } catch {
          results.set(name, false);
        }
      }
    );
    await Promise.all(checks);
    return results;
  }

  /**
   * Get the list of registered provider names.
   */
  get providerNames(): string[] {
    return [...this.providers.keys()];
  }
}
