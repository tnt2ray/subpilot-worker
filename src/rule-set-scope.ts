import type { Target } from "./types";

/** R2 is optional; a deployment without the binding still supports Worker mode. */
export function ruleSetArtifactsBucket(env: Env): R2Bucket | undefined {
  return (env as Env & { RULE_SET_ARTIFACTS?: R2Bucket }).RULE_SET_ARTIFACTS;
}

/** Only compiled artifacts are target-scoped. Source bodies keep their shared keys. */
export function ruleSetEnv(env: Env, target: Target): Env {
  return scopedRuleSetEnv(env, `cache:v2:${target}:compiledRuleSet`, `subpilot/rule-sets/v2/clients/${target}/`);
}

/** Fallback artifacts never replace the preferred compiler's heads or cleanup records. */
export function workerFallbackEnv(env: Env, target: Target): Env {
  // This R2 prefix stays outside v2 so an existing ruleSetEnv proxy leaves it intact.
  const fallbackEnv = { ...env, RULE_SET_ARTIFACTS: undefined } as unknown as Env;
  return scopedRuleSetEnv(fallbackEnv, `cache:v2:${target}:workerFallback:compiledRuleSet`, `subpilot/rule-sets/fallback-worker/v1/${target}/`);
}

function scopedRuleSetEnv(env: Env, prefix: string, scopedR2Prefix: string): Env {
  const encode = (key: string) => key.replace(/^cache:compiledRuleSet/, prefix);
  const decode = (key: string) => key.startsWith(prefix) ? key.replace(prefix, "cache:compiledRuleSet") : key;
  const r2Prefix = "subpilot/rule-sets/v2/";
  const encodeR2 = (key: string) => key.startsWith(r2Prefix)
    ? `${scopedR2Prefix}${key.slice(r2Prefix.length)}`
    : key;
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
  const bucket = ruleSetArtifactsBucket(env);
  if (!bucket) return { ...env, SUBPILOT_CONFIG: namespace } as Env;
  const artifacts = new Proxy(bucket, {
    get(bucket, property) {
      const method = Reflect.get(bucket, property);
      if (property === "delete") {
        return (keys: string | string[], ...args: unknown[]) => Reflect.apply(method, bucket, [
          Array.isArray(keys) ? keys.map(encodeR2) : encodeR2(keys), ...args
        ]);
      }
      if (["get", "head", "put"].includes(String(property))) {
        return (key: string, ...args: unknown[]) => Reflect.apply(method, bucket, [encodeR2(key), ...args]);
      }
      return typeof method === "function" ? method.bind(bucket) : method;
    }
  });
  return { ...env, SUBPILOT_CONFIG: namespace, RULE_SET_ARTIFACTS: artifacts } as Env;
}
