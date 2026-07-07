export function maybeDecodeBase64(content: string): string {
  const trimmed = content.trim();
  if (!trimmed || /[\s{}:[\],]/.test(trimmed.slice(0, 80))) return content;
  try {
    const padded = trimmed + "=".repeat((4 - (trimmed.length % 4)) % 4);
    const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return text.includes("\n") || text.includes("://") ? text : content;
  } catch {
    return content;
  }
}
