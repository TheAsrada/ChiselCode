import { getModelCapabilities, listProviderModels } from "../commands/run.js";
import type { OpenTuiModelsActions } from "./opentui-models.js";
import type { TuiPresentationController as TuiController } from "./tui-controller.js";

/** Application-owned discovery cache. It holds no conversation or execution resources. */
export class ModelCatalogController {
  constructor(private readonly configPath?: string) {}
  private readonly modelCache = new Map<
    string,
    { expires: number; result: Awaited<ReturnType<typeof listProviderModels>> }
  >();
  private modelCacheGeneration = 0;
  private readonly capabilityRequests = new Map<
    string,
    { expires: number; request: ReturnType<typeof getModelCapabilities> }
  >();
  warm(controller: TuiController) {
    const selection = controller.snapshot.modelSelection;
    if (!selection) return;
    const generation = controller.currentGeneration;
    const catalogGeneration = this.modelCacheGeneration;
    void this.capabilities(selection).then((capabilities) => {
      if (
        catalogGeneration === this.modelCacheGeneration &&
        controller.isCurrent(generation)
      )
        controller.setModelCapabilities(selection, capabilities);
    });
  }
  capabilities(
    selection: Parameters<TuiController["setModelCapabilities"]>[0],
  ) {
    const key = JSON.stringify(selection);
    const cached = this.capabilityRequests.get(key);
    if (cached && cached.expires > Date.now()) return cached.request;
    const request = getModelCapabilities(selection, {
      configPath: this.configPath,
    });
    this.capabilityRequests.set(key, { expires: Date.now() + 60_000, request });
    return request;
  }
  private readonly modelRequests = new Map<string, number>();
  async models(
    selection: Parameters<OpenTuiModelsActions["models"]>[0],
    refresh?: boolean,
  ): ReturnType<OpenTuiModelsActions["models"]> {
    const key = JSON.stringify([
      selection.provider,
      selection.profileId,
      selection.baseUrl,
    ]);
    const cached = this.modelCache.get(key);
    const cacheHit = !refresh && cached && cached.expires > Date.now();
    const generation = this.modelCacheGeneration;
    const request = cacheHit
      ? this.modelRequests.get(key)
      : (this.modelRequests.get(key) ?? 0) + 1;
    if (!cacheHit && request !== undefined)
      this.modelRequests.set(key, request);
    const result = cacheHit
      ? cached.result
      : await listProviderModels(selection, {
          configPath: this.configPath,
        });
    if (result.ok) {
      if (
        !cacheHit &&
        generation === this.modelCacheGeneration &&
        request === this.modelRequests.get(key)
      )
        this.modelCache.set(key, { expires: Date.now() + 300_000, result });
      return {
        ok: true,
        models: result.models.map(
          ({ id, displayName, contextWindow, maxOutputTokens }) => ({
            id,
            hint: displayName,
            contextWindow,
            maxOutputTokens,
          }),
        ),
      };
    }
    return { ok: false, error: result.error };
  }
  invalidate() {
    this.modelCache.clear();
    this.capabilityRequests.clear();
    this.modelCacheGeneration++;
  }
}
