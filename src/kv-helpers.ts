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

/** Await every deletion, with bounded concurrency and one same-key KV retry. */
export async function deleteKvKeys(env: Env, keys: string[]): Promise<void> {
  const unique = [...new Set(keys)];
  for (let index = 0; index < unique.length; index += 16) {
    await Promise.all(unique.slice(index, index + 16).map(async (key) => {
      try { await env.SUBPILOT_CONFIG.delete(key); }
      catch (error) {
        if (!/429|too many requests/i.test(error instanceof Error ? error.message : String(error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await env.SUBPILOT_CONFIG.delete(key);
      }
    }));
  }
}
