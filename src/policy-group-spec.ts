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
  let quoted = false;
  let escaped = false;
  for (const char of spec) {
    if (quoted) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; current += char; continue; }
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

export function validatePolicyPriority(value: string): string | null {
  if (!value.startsWith('"') || !value.endsWith('"')) return "policy-priority 必须是双引号包围的 regex:factor 列表";
  const entries = value.slice(1, -1).split(";");
  for (const entry of entries) {
    const separator = entry.lastIndexOf(":");
    const pattern = entry.slice(0, separator).trim();
    const factor = entry.slice(separator + 1).trim();
    if (separator < 1 || !pattern || /["\r\n]/.test(pattern)) return "policy-priority 每项必须是 regex:factor";
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(factor) || !Number.isFinite(Number(factor)) || Number(factor) <= 0) return "policy-priority 权重必须是有限正数";
    try { new RegExp(pattern); } catch { return "policy-priority 正则表达式无效"; }
  }
  return null;
}
