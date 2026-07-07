export function yamlIndent(line) {
  return String(line || "").match(/^\s*/)?.[0].length || 0;
}

export function stripYamlComment(value) {
  const text = String(value || "");
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ((char === "\"" || char === "'") && text[index - 1] !== "\\") {
      quote = quote === char ? "" : quote || char;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trim();
    }
  }
  return text.trim();
}

export function unquoteYamlScalar(value) {
  const text = stripYamlComment(value);
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

export function quoteYamlScalar(value) {
  const text = String(value || "").trim();
  if (!text) return "\"\"";
  return /^[A-Za-z0-9_./:@%+?=&~-]+$/.test(text)
    ? text
    : JSON.stringify(text);
}

export function quoteYamlKey(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_.-]+$/.test(text)
    ? text
    : JSON.stringify(text);
}

export function quoteYamlListItem(value) {
  const text = String(value || "").trim();
  if (!text) return "\"\"";
  return /^[A-Za-z0-9_./:@%+?=&~,*()| -]+$/.test(text) && !/^[-?:]/.test(text)
    ? text
    : JSON.stringify(text);
}

export function parseYamlPair(line) {
  const index = String(line || "").indexOf(":");
  if (index < 0) return null;
  return {
    key: unquoteYamlScalar(line.slice(0, index)),
    value: line.slice(index + 1)
  };
}
