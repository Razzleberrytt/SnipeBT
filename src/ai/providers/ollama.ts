import { loadConfig } from "../../config";
import { fetchInput as fetch } from "../../vendor/fetch";
import { AiGenerateRequest, AiHealthReport, AiProvider, AiProviderResult } from "../types";

const CHAT_ENDPOINT = "/api/chat";
const TAGS_ENDPOINT = "/api/tags";

interface OllamaProviderConfig {
  baseUrl: string;
  model: string;
  keepAliveSeconds: number;
  timeoutMs: number;
}

function withContextMessages(request: AiGenerateRequest) {
  if (!request.context || Object.keys(request.context).length === 0) {
    return request.messages;
  }

  const contextBlock = JSON.stringify(request.context, null, 2);
  return [
    { role: "system" as const, content: `Additional context provided by runtime:\n${contextBlock}` },
    ...request.messages,
  ];
}

function buildTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

export class OllamaProvider implements AiProvider {
  public readonly name = "ollama";

  constructor(private readonly cfg: OllamaProviderConfig) {}

  static fromEnv(): OllamaProvider {
    const cfg = loadConfig();
    return new OllamaProvider({
      baseUrl: cfg.OLLAMA_BASE_URL,
      model: cfg.OLLAMA_MODEL,
      keepAliveSeconds: Number(cfg.OLLAMA_KEEP_ALIVE ?? 600),
      timeoutMs: Number(cfg.AI_REQUEST_TIMEOUT_MS ?? 15000),
    });
  }

  isAvailable(): boolean {
    return Boolean(this.cfg.baseUrl && this.cfg.model);
  }

  async healthCheck(): Promise<AiHealthReport> {
    const started = Date.now();
    const { signal, cancel } = buildTimeoutSignal(Math.min(this.cfg.timeoutMs, 5000));
    try {
      const res = await fetch(new URL(TAGS_ENDPOINT, this.cfg.baseUrl).toString(), {
        method: "GET",
        signal,
      });
      const ok = (res as any).ok === true;
      return {
        provider: this.name,
        ok,
        latencyMs: Date.now() - started,
        message: ok ? undefined : `HTTP ${(res as any).status}`,
      };
    } catch (error) {
      return {
        provider: this.name,
        ok: false,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : "unknown error",
      };
    } finally {
      cancel();
    }
  }

  async generate(request: AiGenerateRequest): Promise<AiProviderResult> {
    const started = Date.now();
    const messages = withContextMessages(request);
    const payload: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      stream: false,
      options: {
        temperature: request.temperature,
        top_p: request.topP,
        num_ctx: request.maxOutputTokens,
        keep_alive: this.cfg.keepAliveSeconds,
        stop: request.stopSequences,
      },
    };

    // Remove undefined option fields to avoid confusing the API.
    if (payload.options && typeof payload.options === "object") {
      for (const [key, value] of Object.entries(payload.options)) {
        if (value === undefined || value === null) {
          delete (payload.options as Record<string, unknown>)[key];
        }
      }
      if (Object.keys(payload.options as Record<string, unknown>).length === 0) {
        delete payload.options;
      }
    }

    if (request.metadata && Object.keys(request.metadata).length > 0) {
      payload.metadata = request.metadata;
    }

    const { signal, cancel } = buildTimeoutSignal(this.cfg.timeoutMs);

    try {
      const response = await fetch(new URL(CHAT_ENDPOINT, this.cfg.baseUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });

      if (!(response as any).ok) {
        return {
          provider: this.name,
          output: "",
          latencyMs: Date.now() - started,
          error: `HTTP ${(response as any).status}`,
        };
      }

      const data = await (response as any).json();
      const message = data?.message?.content ?? data?.response ?? "";

      return {
        provider: this.name,
        output: typeof message === "string" ? message : JSON.stringify(message),
        latencyMs: Date.now() - started,
        finishReason: data?.done_reason,
        metadata: {
          model: data?.model,
          totalDurationMs: data?.total_duration ? data.total_duration / 1_000_000 : undefined,
        },
        raw: data,
      };
    } catch (error) {
      return {
        provider: this.name,
        output: "",
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : "unknown error",
      };
    } finally {
      cancel();
    }
  }
}

export function createOllamaProvider(): OllamaProvider {
  return OllamaProvider.fromEnv();
}
