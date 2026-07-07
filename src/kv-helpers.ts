export async function listKvKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const options: KVNamespaceListOptions = cursor ? { prefix, cursor } : { prefix };
    const page = await env.SUBPILOT_CONFIG.list(options);
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

export async function readKvJson<T>(env: Env, key: string): Promise<T | null> {
  const value = await env.SUBPILOT_CONFIG.get(key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
