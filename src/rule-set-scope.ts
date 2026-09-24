import type { Target } from "./types";

/** Only compiled artifacts are target-scoped. Source bodies keep their shared keys. */
export function ruleSetEnv(env: Env, target: Target): Env {
  const prefix = `cache:v2:${target}:compiledRuleSet`;
  const encode = (key: string) => key.replace(/^cache:compiledRuleSet/, prefix);
  const decode = (key: string) => key.startsWith(prefix) ? key.replace(prefix, "cache:compiledRuleSet") : key;
  const namespace = new Proxy(env.SUBPILOT_CONFIG, {
    get(kv, property) {
      const method = Reflect.get(kv, property);
      if (property === "list") return async (options: KVNamespaceListOptions = {}) => {
        const result = await kv.list({ ...options, ...(options.prefix ? { prefix: encode(options.prefix) } : {}) });
        return { ...result, keys: result.keys.map((key) => ({ ...key, name: decode(key.name) })) };
      };
      if (["get", "getWithMetadata", "put", "delete"].includes(String(property))) {
        return (key: string, ...args: unknown[]) => Reflect.apply(method, kv, [encode(key), ...args]);
      }
      return typeof method === "function" ? method.bind(kv) : method;
    }
  });
  return { ...env, SUBPILOT_CONFIG: namespace };
}
