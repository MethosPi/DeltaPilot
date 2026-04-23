import type { AdapterContext, AdapterResult, AgentAdapter } from "../adapters.js";

export interface MockAdapterOptions {
  result: AdapterResult | ((ctx: AdapterContext) => AdapterResult | Promise<AdapterResult>);
  onExecute?: (ctx: AdapterContext) => void | Promise<void>;
}

export class MockAdapter implements AgentAdapter {
  readonly kind = "mock";
  constructor(private readonly options: MockAdapterOptions) {}

  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    if (this.options.onExecute) await this.options.onExecute(ctx);
    return typeof this.options.result === "function"
      ? await this.options.result(ctx)
      : this.options.result;
  }
}
