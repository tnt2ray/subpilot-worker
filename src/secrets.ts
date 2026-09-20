type SecretName = "ADMIN_TOKEN_HASH" | "CONFIG_ENCRYPTION_KEY" | "SINGBOX_SRS_GITHUB_TOKEN" | "SINGBOX_SRS_SECRET";

export function getSecret(env: Env, name: SecretName): string | undefined {
  // Optional integrations must not become required deployment bindings.
  const value = Reflect.get(env, name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requireSecret(env: Env, name: SecretName): string {
  const value = getSecret(env, name);
  if (!value) throw new Error(`${name} secret is required`);
  return value;
}
