import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class StateStore {
  private values: Record<string, string>;

  constructor(private readonly path: string) {
    this.values = this.load();
  }

  set(key: string, value: string | number | bigint): void {
    this.values[key] = value.toString();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.values, null, 2)}\n`);
  }

  get(key: string): string | undefined {
    return this.values[key];
  }

  require(key: string): string {
    const value = this.get(key);
    if (!value) throw new Error(`missing state key: ${key}`);
    return value;
  }

  all(): Record<string, string> {
    return { ...this.values };
  }

  private load(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
  }
}
