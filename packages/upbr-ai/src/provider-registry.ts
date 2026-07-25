import type { IProvider, ProviderConfig, ProviderProtocol } from "./types";
import { OpenAIProvider } from "./providers/openai";
import { AnthropicProvider } from "./providers/anthropic";

const providerRegistry = new Map<string, (config: ProviderConfig) => IProvider>();

export function registerProvider(
  protocol: ProviderProtocol,
  factory: (config: ProviderConfig) => IProvider
): void {
  providerRegistry.set(protocol, factory);
}

// Register built-in providers
registerProvider("openai-compatible", (c) => new OpenAIProvider(c));
registerProvider("anthropic-compatible", (c) => new AnthropicProvider(c));

export function createProvider(config: ProviderConfig): IProvider {
  const factory = providerRegistry.get(config.protocol);
  if (!factory) {
    throw new Error(
      `Unknown provider protocol: ${config.protocol}. ` +
      `Available: ${[...providerRegistry.keys()].join(", ")}`
    );
  }
  return factory(config);
}

export function getAvailableProtocols(): ProviderProtocol[] {
  return [...providerRegistry.keys()] as ProviderProtocol[];
}
