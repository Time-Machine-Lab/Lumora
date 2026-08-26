export class ProviderRuntime {
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  deactivate(): void {
    this.controller.abort();
  }
}
