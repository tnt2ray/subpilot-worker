import { splitRuleLine } from "./rule-line";

const LOGICAL_RULE_TYPES = new Set(["AND", "OR", "NOT"]);
const MAX_LOGICAL_RULE_DEPTH = 32;

export type LogicalRuleLeafValidator = (parts: string[]) => string | null;

/**
 * Validates the value field of an AND/OR/NOT rule. Logical child rules never
 * contain a policy target; target-specific leaf syntax is checked by the
 * caller through validateLeaf.
 */
export function validateLogicalRuleExpression(
  type: string,
  expression: string,
  validateLeaf: LogicalRuleLeafValidator
): string | null {
  const normalizedType = type.trim().toUpperCase();
  if (!LOGICAL_RULE_TYPES.has(normalizedType)) return "逻辑规则类型无效";
  return validateLogicalNode(normalizedType, expression, validateLeaf, 0);
}

function validateLogicalNode(
  type: string,
  expression: string,
  validateLeaf: LogicalRuleLeafValidator,
  depth: number
): string | null {
  if (depth >= MAX_LOGICAL_RULE_DEPTH) return `逻辑规则嵌套不能超过 ${MAX_LOGICAL_RULE_DEPTH} 层`;

  const content = unwrapParenthesized(expression);
  if (content === null) return "逻辑表达式必须使用完整且平衡的括号包裹";
  const children = splitRuleLine(content);
  if (children.some((child) => !child.trim())) return "逻辑表达式存在空子规则";

  if ((type === "AND" || type === "OR") && children.length < 2) {
    return `${type} 逻辑规则至少需要两个子规则`;
  }
  if (type === "NOT" && children.length !== 1) return "NOT 逻辑规则必须且只能包含一个子规则";

  for (const child of children) {
    const childContent = unwrapParenthesized(child);
    if (childContent === null) return "每个逻辑子规则都必须使用完整且平衡的括号包裹";
    const parts = splitRuleLine(childContent);
    if (parts.length < 2 || parts.some((part) => !part.trim())) return "逻辑子规则缺少规则类型或匹配值";

    const childType = parts[0]!.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9-]*$/.test(childType)) return "逻辑子规则类型格式无效";
    if (LOGICAL_RULE_TYPES.has(childType)) {
      if (parts.length !== 2) return `${childType} 逻辑子规则不能包含策略出口或尾随参数`;
      const error = validateLogicalNode(childType, parts[1]!, validateLeaf, depth + 1);
      if (error) return error;
      continue;
    }

    const error = validateLeaf(parts);
    if (error) return error;
  }
  return null;
}

function unwrapParenthesized(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("(")) return null;

  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== null) {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        if (trimmed[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char !== ")") continue;
    depth -= 1;
    if (depth < 0) return null;
    if (depth === 0 && index !== trimmed.length - 1) return null;
  }

  if (quote !== null || escaped || depth !== 0 || !trimmed.endsWith(")")) return null;
  return trimmed.slice(1, -1);
}
