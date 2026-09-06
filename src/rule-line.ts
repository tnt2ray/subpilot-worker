/** Compiled rules may omit the policy stored in their separate policy field. */
export function compiledFinalRuleOptions(parts: string[]): string[] {
  const second = parts[1]?.toLowerCase() ?? "";
  const option = ["dns-failed", "no-resolve", "src", "extended-matching"].includes(second) || second.includes("=");
  return parts.slice(option ? 1 : 2);
}

export function splitRuleLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== null) {
      current += char;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += char;
      if (char === quote) {
        if (line[index + 1] === quote) {
          current += line[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() || parts.length > 0) parts.push(current.trim());
  return parts;
}
