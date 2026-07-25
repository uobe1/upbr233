// === LLM Message Types ===

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<TextContent | ImageContent>;
  is_error?: boolean;
}

export type MessageContent =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent;

export type ContentBlock = TextContent | ImageContent;

export interface Message {
  role: "system" | "user" | "assistant";
  content: string | Array<TextContent | ImageContent | ToolUseContent | ToolResultContent>;
}

// === Tool Types ===

export interface ToolPropertySchema {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolPropertySchema;
  properties?: Record<string, ToolPropertySchema>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, ToolPropertySchema>;
    required?: string[];
  };
}

// === Model Capabilities ===

export interface ModelCapabilities {
  textInput: boolean;
  textOutput: boolean;
  imageInput?: boolean;
  imageOutput?: boolean;
  audioInput?: boolean;
  audioOutput?: boolean;
  videoInput?: boolean;
  videoOutput?: boolean;
  toolCall: boolean;
}

export interface ModelPricing {
  input: number;       // per 1M tokens
  output: number;      // per 1M tokens
  cacheHitInput?: number; // per 1M tokens
}

export interface ThinkingConfig {
  canThink: boolean;
  canToggle: boolean;       // true=can switch on/off, false=always think
  levels: string[];         // e.g. ["no_thinking", "low", "high", "max"]
}

// === Provider Types ===

export type ProviderProtocol = "openai-compatible" | "anthropic-compatible";

export interface ProviderConfig {
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKeys: string[];
  models: ModelConfig[];
  metadata?: ProviderMetadata;
}

export interface ProviderMetadata {
  requestTimeoutMs?: number;
  retryIntervalMs?: number;
  retryBackoff?: boolean;     // exponential backoff
  maxRetries?: number;
}

export interface ModelConfig {
  name: string;
  maxContextLength: number;
  maxOutput?: number;
  maxInput?: number;
  includeThinkingInInput?: boolean;
  thinkingMaxLength?: number;
  thinking: ThinkingConfig;
  pricing?: ModelPricing;
  capabilities: ModelCapabilities;
}

// === Stream Types ===

export interface StreamEvent {
  type: "text_delta" | "tool_use" | "tool_result" | "message_stop" | "error";
  text?: string;
  toolUse?: ToolUseContent;
  error?: string;
}

// === Provider Interface ===

export interface LLMRequest {
  model: string;
  messages: Message[];
  system?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  thinking?: { type: string; budget_tokens?: number };
}

export interface LLMResponse {
  id: string;
  model: string;
  content: MessageContent[];
  stopReason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence";
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
}

export interface IProvider {
  readonly name: string;
  readonly protocol: ProviderProtocol;
  listModels(): Promise<ModelConfig[]>;
  chat(request: LLMRequest): Promise<LLMResponse>;
  chatStream(request: LLMRequest): AsyncGenerator<StreamEvent>;
  countTokens(messages: Message[], model: string): Promise<number>;
  healthCheck(): Promise<boolean>;
}
