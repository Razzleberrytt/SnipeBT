import { loadConfig } from "../../config";
import { fetchInput as fetch } from "../../vendor/fetch";
import { AiGenerateRequest, AiProvider, AiProviderResult } from "../types";

interface CouncilProviderConfig {
  baseUrl: string;
  route: string;
  playbookId?: string;
  apiKey?: string;
  timeoutMs: number;
}

function buildTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

function serializeMessages(messages: AiGenerateRequest["messages"]): string {
  return messages
    .map((msg) => `[${msg.role.toUpperCase()}]\n${msg.content}`)
    .join("\n\n");
}

function compact<T extends Record<string, unknown>>(payload: T): T {
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
      delete payload[key as keyof T];
    } else if (typeof value === "object" && !Array.isArray(value)) {
      compact(value as Record<string, unknown>);
      if (Object.keys(value as Record<string, unknown>).length === 0) {
        delete payload[key as keyof T];
      }
    }
  }
  return payload;
}

function extractOutput(data: any): string {
  if (data == null) return "";
  if (typeof data === "string") return data;

  const choices = data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (first?.message?.content) return first.message.content;
    if (typeof first?.text === "string") return first.text;
  }

  const output = data.output ?? data.result ?? data.response;
  if (typeof output === "string") return output;

  if (Array.isArray(output?.messages)) {
    const assistant = output.messages.find((m: any) => (m.role ?? "").includes("assistant"));
    if (assistant?.content) return assistant.content;
  }

  if (Array.isArray(data.messages)) {
    const assistant = data.messages.find((m: any) => (m.role ?? "").includes("assistant"));
    if (assistant?.content) return assistant.content;
  }

  if (typeof output?.result === "string") return output.result;

  return JSON.stringify(data);
}

export class CouncilProvider implements AiProvider {
  public readonly name = "council";

  constructor(private readonly cfg: CouncilProviderConfig) {}

  static fromEnv(): CouncilProvider {
    const cfg = loadConfig();
    return new CouncilProvider({
      baseUrl: cfg.COUNCIL_BASE_URL,
      route: cfg.COUNCIL_ROUTE,
      playbookId: cfg.COUNCIL_PLAYBOOK_ID,
      apiKey: cfg.COUNCIL_API_KEY,
      timeoutMs: Number(cfg.AI_REQUEST_TIMEOUT_MS ?? 15000),
    });
  }

  isAvailable(): boolean {
    return Boolean(this.cfg.apiKey);
  }

  private buildPayload(request: AiGenerateRequest) {
    const prompt = serializeMessages(request.messages);
    const input: Record<string, unknown> = {
      messages: request.messages,
      prompt,
      context: request.context,
      metadata: request.metadata,
    };

    const params: Record<string, unknown> = {
      temperature: request.temperature,
      top_p: request.topP,
      max_output_tokens: request.maxOutputTokens,
      stop: request.stopSequences,
    };

    if (this.cfg.playbookId) {
      return compact({
        playbook: this.cfg.playbookId,
        input,
        params,
      });
    }

    return compact({
      ...input,
      ...params,
    });
  }

  async generate(request: AiGenerateRequest): Promise<AiProviderResult> {
    const started = Date.now();

    if (!this.isAvailable()) {
      return {
        provider: this.name,
        output: "",
        latencyMs: 0,
        error: "Council API key is not configured",
      };
    }

    const payload = this.buildPayload(request);
    const { signal, cancel } = buildTimeoutSignal(this.cfg.timeoutMs);

    try {
      const response = await fetch(new URL(this.cfg.route, this.cfg.baseUrl).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
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
      const output = extractOutput(data);

      return {
        provider: this.name,
        output,
        latencyMs: Date.now() - started,
        metadata: {
          playbookId: this.cfg.playbookId,
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

export function createCouncilProvider(): CouncilProvider {
  return CouncilProvider.fromEnv();
}
