import { createCouncilProvider } from "./providers/council";
import { createOllamaProvider } from "./providers/ollama";
import {
  AiGenerateRequest,
  AiHealthReport,
  AiOrchestratorResult,
  AiProvider,
  AiProviderError,
  AiProviderResult,
} from "./types";

export class AiOrchestrator {
  constructor(private readonly providers: AiProvider[]) {}

  private availableProviders(): AiProvider[] {
    return this.providers.filter((provider) => {
      try {
        return provider.isAvailable();
      } catch (error) {
        return false;
      }
    });
  }

  listProviders(): string[] {
    return this.providers.map((provider) => provider.name);
  }

  async health(): Promise<AiHealthReport[]> {
    const available = this.availableProviders();
    const reports = await Promise.all(
      available.map(async (provider) => {
        if (typeof provider.healthCheck === "function") {
          try {
            return await provider.healthCheck();
          } catch (error) {
            return {
              provider: provider.name,
              ok: false,
              message: error instanceof Error ? error.message : "unknown error",
            } satisfies AiHealthReport;
          }
        }
        return {
          provider: provider.name,
          ok: provider.isAvailable(),
        } satisfies AiHealthReport;
      })
    );

    const unavailable = this.providers
      .filter((provider) => !available.includes(provider))
      .map<AiHealthReport>((provider) => ({
        provider: provider.name,
        ok: false,
        message: "Provider configuration incomplete",
      }));

    return [...reports, ...unavailable];
  }

  async generate(request: AiGenerateRequest): Promise<AiOrchestratorResult> {
    const providers = this.availableProviders();

    if (providers.length === 0) {
      const error: AiProviderError = {
        provider: "ensemble",
        message: "No AI providers are configured. Set up Ollama or Council credentials to enable AI decisions.",
      };
      return { primary: null, responses: [], errors: [error] };
    }

    const responses: AiProviderResult[] = [];
    const errors: AiProviderError[] = [];

    await Promise.all(
      providers.map(async (provider) => {
        try {
          const result = await provider.generate(request);
          responses.push(result);
          if (result.error) {
            errors.push({
              provider: provider.name,
              message: result.error,
            });
          }
        } catch (error) {
          errors.push({
            provider: provider.name,
            message: error instanceof Error ? error.message : "unknown error",
            cause: error,
          });
        }
      })
    );

    const successful = responses.filter((response) => !response.error);
    const primary = successful.length > 0 ? successful[0] : null;

    return {
      primary,
      responses,
      errors,
    };
  }
}

export function createAiOrchestrator(): AiOrchestrator {
  return new AiOrchestrator([createOllamaProvider(), createCouncilProvider()]);
}
