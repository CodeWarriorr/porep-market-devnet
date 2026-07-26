export function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

export function assertPresent<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined || value === "") {
    throw new Error(`${label}: missing`);
  }
  return value;
}
