import type { LlmProvider } from "../types/provider";

/** Registry of LLM providers keyed by their unique id. */
export class ProviderRegistry {
  private readonly providers = new Map<string, LlmProvider>();

  register(p: LlmProvider): void {
    if (this.providers.has(p.id)) {
      throw new Error(`provider with id '${p.id}' already registered`);
    }
    this.providers.set(p.id, p);
  }

  get(id: string): LlmProvider | undefined {
    return this.providers.get(id);
  }

  list(): LlmProvider[] {
    return [...this.providers.values()];
  }
}
