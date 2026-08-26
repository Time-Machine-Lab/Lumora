const MAX_PROVIDER_MODELS = 100;

export class ProviderModelCatalogUnavailableError extends Error {
  constructor() {
    super('The AI provider model catalog is unavailable.');
    this.name = 'ProviderModelCatalogUnavailableError';
  }
}

export function resolveProviderModelCatalog<T>(
  catalog: unknown,
  parseEntry: (entry: unknown) => T,
  modelId: (entry: T) => string,
): ReadonlyArray<T> {
  try {
    const value = typeof catalog === 'function' ? (catalog as () => unknown)() : catalog;
    if (!Array.isArray(value)) throw new ProviderModelCatalogUnavailableError();

    const expectedLength = value.length;
    if (expectedLength < 1 || expectedLength > MAX_PROVIDER_MODELS) {
      throw new ProviderModelCatalogUnavailableError();
    }

    const models: T[] = [];
    const modelIds = new Set<string>();
    for (const candidate of value) {
      if (models.length >= MAX_PROVIDER_MODELS) throw new ProviderModelCatalogUnavailableError();
      const model = parseEntry(candidate);
      const id = modelId(model);
      if (modelIds.has(id)) throw new ProviderModelCatalogUnavailableError();
      modelIds.add(id);
      models.push(model);
    }
    if (models.length !== expectedLength) throw new ProviderModelCatalogUnavailableError();
    return models;
  } catch {
    throw new ProviderModelCatalogUnavailableError();
  }
}
