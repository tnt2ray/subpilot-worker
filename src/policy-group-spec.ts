export interface PolicyGroupOption {
  key: string;
  value: string;
}

export interface AllPolicySelector {
  filter: string;
  exclude: string;
}

export function splitGroupSpec(spec: string): string[] {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  for (const char of spec) {
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (char === "," && braceDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseGroupOption(item: string, options: { requireValue?: boolean } = {}): PolicyGroupOption | null {
  const match = item.match(/^([^=,{}]+)=(.*)$/s);
  if (!match) return null;
  const key = (match[1] ?? "").trim();
  const value = (match[2] ?? "").trim();
  if (!key || (options.requireValue && !value)) return null;
  return { key, value };
}

export function parseAllPolicySelector(item: string): AllPolicySelector | null {
  const match = item.match(/^\{all(?:\s+filter=([^}]*?)(?=\s+exclude=|}))?(?:\s+exclude=([^}]+))?\}$/);
  if (!match) return null;
  return {
    filter: (match[1] ?? "").trim(),
    exclude: (match[2] ?? "").trim()
  };
}

export function isAllPolicySelector(item: string): boolean {
  return parseAllPolicySelector(item) !== null;
}
