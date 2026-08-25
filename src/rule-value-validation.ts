const DOMAIN_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX"]);
const IPV4_CIDR_RULE_TYPES = new Set(["IP-CIDR", "SRC-IP-CIDR"]);
const IPV6_CIDR_RULE_TYPES = new Set(["IP-CIDR6"]);
const IP_ASN_RULE_TYPES = new Set(["IP-ASN", "SRC-IP-ASN"]);
const MAX_ASN = 4_294_967_295;

export function validateRuleMatchValue(type: string, value: string): string | null {
  const normalizedType = type.trim().toUpperCase();
  if (DOMAIN_RULE_TYPES.has(normalizedType) && !isValidDomainRuleValue(value)) {
    return `${normalizedType} 包含无效的域名`;
  }
  if ((IPV4_CIDR_RULE_TYPES.has(normalizedType) || IPV6_CIDR_RULE_TYPES.has(normalizedType))
    && !isValidCidrForRuleType(value, normalizedType)) {
    return `${normalizedType} 包含无效的 CIDR`;
  }
  if (IP_ASN_RULE_TYPES.has(normalizedType) && !isValidIpAsn(value)) {
    return `${normalizedType} 包含无效的 ASN`;
  }
  return null;
}

export function isValidCidrForRuleType(value: string, type: string): boolean {
  if (!looksLikeCidr(value)) return false;
  const address = value.trim().slice(0, value.trim().lastIndexOf("/"));
  return IPV6_CIDR_RULE_TYPES.has(type.trim().toUpperCase()) ? address.includes(":") : !address.includes(":");
}

function isValidDomainRuleValue(value: string): boolean {
  const normalized = value.trim().replace(/\.$/, "");
  if (!normalized || normalized.length > 253 || normalized.includes("://") || /[\s,\[\]{}]/u.test(normalized)) return false;
  return normalized.split(".").every((label) => (
    label.length >= 1
    && label.length <= 63
    && !label.startsWith("-")
    && !label.endsWith("-")
    && /^[\p{L}\p{N}_-]+$/u.test(label)
  ));
}

function isValidIpAsn(value: string): boolean {
  const match = value.trim().match(/^(?:AS)?(\d+)$/i);
  if (!match) return false;
  const asn = Number(match[1]);
  return Number.isSafeInteger(asn) && asn >= 1 && asn <= MAX_ASN;
}

export function looksLikeCidr(value: string): boolean {
  const normalized = value.trim();
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex <= 0 || slashIndex !== normalized.indexOf("/")) return false;
  const address = normalized.slice(0, slashIndex);
  const prefix = normalized.slice(slashIndex + 1);
  if (!/^\d+$/.test(prefix)) return false;
  const prefixLength = Number(prefix);
  return address.includes(":")
    ? prefixLength <= 128 && isValidIpv6Address(address)
    : prefixLength <= 32 && isValidIpv4Address(address);
}

function isValidIpv4Address(address: string): boolean {
  const octets = address.split(".");
  return octets.length === 4 && octets.every((octet) => (
    /^\d{1,3}$/.test(octet) && Number(octet) <= 255
  ));
}

function isValidIpv6Address(address: string): boolean {
  if (!address || address.includes("%")) return false;
  const compressionIndex = address.indexOf("::");
  const hasCompression = compressionIndex >= 0;
  if (hasCompression && compressionIndex !== address.lastIndexOf("::")) return false;

  const halves = hasCompression ? address.split("::") : [address];
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = hasCompression && halves[1] ? halves[1].split(":") : [];
  const segments = [...left, ...right];
  if (segments.some((segment) => !segment)) return false;

  const ipv4Segments = segments.filter((segment) => segment.includes("."));
  if (ipv4Segments.length > 1) return false;
  if (ipv4Segments.length === 1) {
    const ipv4 = ipv4Segments[0]!;
    if (segments.at(-1) !== ipv4 || !address.endsWith(ipv4) || !isValidIpv4Address(ipv4)) return false;
  }
  if (segments.some((segment) => !segment.includes(".") && !/^[0-9a-f]{1,4}$/i.test(segment))) return false;

  const segmentCount = segments.reduce((count, segment) => count + (segment.includes(".") ? 2 : 1), 0);
  return hasCompression ? segmentCount < 8 : segmentCount === 8;
}
