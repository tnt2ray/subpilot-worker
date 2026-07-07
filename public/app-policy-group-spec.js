export function splitPolicyGroupSpec(spec) {
  const parts = [];
  let current = "";
  let braceDepth = 0;
  for (const char of String(spec || "")) {
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

export function parseAllSelector(item) {
  const match = String(item).match(/^\{all(?:\s+filter=([^}]*?)(?=\s+exclude=|}))?(?:\s+exclude=([^}]+))?\}$/);
  if (!match) return null;
  return {
    filter: (match[1] || "").trim(),
    exclude: (match[2] || "").trim()
  };
}

export function parseGroupOption(item) {
  const match = String(item).match(/^([^=,{}]+)=(.*)$/s);
  if (!match) return null;
  const key = match[1].trim();
  if (!key) return null;
  return {
    key,
    value: match[2].trim()
  };
}
