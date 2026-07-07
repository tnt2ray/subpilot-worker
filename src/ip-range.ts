export interface IpRange {
  family: 4 | 6;
  start: bigint;
  end: bigint;
}

export function parseIpRange(type: string, value: string): IpRange | null {
  const family = type === "IP-CIDR6" ? 6 : 4;
  const totalBits = family === 6 ? 128 : 32;
  const [addressPart = "", prefixPart] = value.trim().split("/", 2);
  const address = family === 6 ? parseIPv6Address(addressPart) : parseIPv4Address(addressPart);
  if (address === null) return null;
  const prefix = prefixPart === undefined || prefixPart === "" ? totalBits : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > totalBits) return null;
  const blockSize = 1n << BigInt(totalBits - prefix);
  const start = (address / blockSize) * blockSize;
  return { family, start, end: start + blockSize - 1n };
}

function parseIPv4Address(value: string): bigint | null {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return null;
  let output = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (number < 0 || number > 255) return null;
    output = (output << 8n) + BigInt(number);
  }
  return output;
}

function parseIPv6Address(value: string): bigint | null {
  const address = value.trim().toLowerCase();
  if (!address || address.includes(".")) return null;
  const compressedParts = address.split("::");
  if (compressedParts.length > 2) return null;
  const head = compressedParts[0] ? compressedParts[0].split(":") : [];
  const tail = compressedParts.length === 2 && compressedParts[1] ? compressedParts[1].split(":") : [];
  const missing = compressedParts.length === 2 ? 8 - head.length - tail.length : 0;
  if (missing < 0) return null;
  const parts = compressedParts.length === 2 ? [...head, ...Array.from({ length: missing }, () => "0"), ...tail] : head;
  if (parts.length !== 8) return null;
  let output = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    output = (output << 16n) + BigInt(Number.parseInt(part, 16));
  }
  return output;
}
