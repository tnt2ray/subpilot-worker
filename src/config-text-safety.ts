const UNSAFE_CONFIG_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function isSafeConfigText(value: unknown): boolean {
  return isSafeConfigTextValue(value, new WeakSet<object>());
}

function isSafeConfigTextValue(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value === "string") return !UNSAFE_CONFIG_TEXT_PATTERN.test(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const safe = value.every((item) => isSafeConfigTextValue(item, seen));
    seen.delete(value);
    return safe;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return false;
    seen.add(value);
    const safe = Object.entries(value as Record<string, unknown>)
      .every(([key, item]) => isSafeConfigTextValue(key, seen) && isSafeConfigTextValue(item, seen));
    seen.delete(value);
    return safe;
  }
  return true;
}

export function assertSafeConfigText(value: unknown, label: string): void {
  if (!isSafeConfigText(value)) throw new Error(`${label} contains control characters`);
}
