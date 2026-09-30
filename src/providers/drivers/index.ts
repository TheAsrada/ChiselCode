import type { ProviderDriver } from "../contracts.js";
export class DriverRegistry {
  private entries = new Map<string, ProviderDriver>();
  constructor(drivers: ProviderDriver[] = []) {
    for (const driver of drivers) this.register(driver);
  }
  register(driver: ProviderDriver): void {
    if (this.has(driver.id))
      throw new Error(`Duplicate driver "${driver.id}".`);
    this.entries.set(driver.id, driver);
  }
  get(id: string): ProviderDriver | undefined {
    return this.entries.get(id);
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }
  require(id: string): ProviderDriver {
    const d = this.get(id);
    if (!d) throw new Error(`Unknown driver "${id}".`);
    return d;
  }
}
