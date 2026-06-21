type SecretName = "ADMIN_TOKEN_HASH" | "CONFIG_ENCRYPTION_KEY";
type EnvWithSecrets = Env & Partial<Record<SecretName, string>>;

export function getSecret(env: Env, name: SecretName): string | undefined {
  const value = (env as EnvWithSecrets)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requireSecret(env: Env, name: SecretName): string {
  const value = getSecret(env, name);
  if (!value) throw new Error(`${name} secret is required`);
  return value;
}
