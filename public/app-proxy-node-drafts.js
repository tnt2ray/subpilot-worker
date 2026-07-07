import { PROXY_NODE_URI_PATTERN } from "./app-constants.js";

export function splitProxyNodeSurgeConfig(value) {
  const parts = [];
  for (const rawPart of String(value || "").split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    if (parts.length >= 3 && !/^[A-Za-z][\w-]*=/.test(part)) {
      parts[parts.length - 1] = `${parts[parts.length - 1]},${rawPart}`;
      continue;
    }
    parts.push(part);
  }
  return parts;
}

export function parseProxyNodeConfigDraft(value) {
  const surge = parseSurgeProxyNodeDraft(value);
  if (surge.valid) return surge;
  return parseClashProxyNodeDraft(value);
}

export function parseSurgeProxyNodeDraft(value) {
  const line = String(value || "").split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#") && !item.startsWith(";") && !/^\[[^\]]+\]$/.test(item));
  const [rawName, rawDetail] = line?.split(/=(.*)/s) || [];
  const name = String(rawName || "").trim();
  const detail = String(rawDetail || "").trim();
  if (name && PROXY_NODE_URI_PATTERN.test(detail)) {
    return { valid: true, name };
  }
  const parts = splitProxyNodeSurgeConfig(rawDetail || "");
  const protocol = String(parts[0] || "").trim();
  const server = String(parts[1] || "").trim();
  const port = Number(parts[2]);
  return {
    valid: Boolean(name && protocol && server && Number.isFinite(port) && port >= 1 && port <= 65535),
    name
  };
}

export function readProxyNodeYamlScalar(text, key) {
  const pattern = new RegExp(`(?:^|[\\n{,])\\s*-?\\s*${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([^"',}\\n#]+))`, "i");
  const match = String(text || "").match(pattern);
  return String(match?.[1] || match?.[2] || match?.[3] || "").trim();
}

export function parseClashProxyNodeDraft(value) {
  const text = String(value || "");
  const name = readProxyNodeYamlScalar(text, "name");
  const type = readProxyNodeYamlScalar(text, "type");
  const server = readProxyNodeYamlScalar(text, "server");
  const port = Number(readProxyNodeYamlScalar(text, "port"));
  return {
    valid: Boolean(name && type && server && Number.isFinite(port) && port >= 1 && port <= 65535),
    name
  };
}
