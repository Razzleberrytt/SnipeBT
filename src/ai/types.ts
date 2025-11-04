export type AiRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface AiGenerateRequest {
  /** Conversational messages that make up the prompt. */
  messages: AiMessage[];
  /** Optional structured context that will be stringified for providers that only accept text prompts. */
  context?: Record<string, unknown>;
  /** Temperature (creativity) hint for providers that support it. */
  temperature?: number;
  /** Top-p sampling hint. */
  topP?: number;
  /** Maximum tokens to generate. */
  maxOutputTokens?: number;
  /** Stop sequences that should terminate generation. */
  stopSequences?: string[];
  /** Extra metadata to forward to providers that support arbitrary payloads. */
  metadata?: Record<string, unknown>;
}

export interface AiProviderResult {
  provider: string;
  output: string;
  latencyMs: number;
  finishReason?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
  error?: string;
}

export interface AiProviderError {
  provider: string;
  message: string;
  cause?: unknown;
}

export interface AiHealthReport {
  provider: string;
  ok: boolean;
  latencyMs?: number;
  message?: string;
}

export interface AiProvider {
  readonly name: string;
  isAvailable(): boolean;
  generate(request: AiGenerateRequest): Promise<AiProviderResult>;
  healthCheck?(): Promise<AiHealthReport>;
}

export interface AiOrchestratorResult {
  primary: AiProviderResult | null;
  responses: AiProviderResult[];
  errors: AiProviderError[];
}
