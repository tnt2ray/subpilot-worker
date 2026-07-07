import { makeTestEnv } from "./env";

export function makeEnv(kv = new Map<string, string>()): Env {
  const assets = new Map<string, string>([
    ["/index.html", "<!doctype html><title>SubPilot 控制台</title><a>配置链接</a><script type=\"module\" src=\"/app.js\"></script>"],
    ["/login.html", "<!doctype html><title>SubPilot 登录</title><main>管理员登录</main><script>fetch('/api/login')</script>"],
    ["/app-constants.js", "export const PAGES = []"],
    ["/app-i18n.js", "export const I18N = {}"],
    ["/app-policy-group-spec.js", "export function splitPolicyGroupSpec() { return [] }"],
    ["/app-preview-warnings.js", "export function groupPreviewWarnings() { return [] }"],
    ["/app-validation.js", "export function validateStashScriptLines() { return { errors: [], warnings: [] } }"],
    ["/app-proxy-node-drafts.js", "export function parseProxyNodeConfigDraft() { return { valid: false, name: '' } }"],
    ["/app-yaml.js", "export function parseYamlPair() { return null }"],
    ["/app.js", "console.log('admin app')"],
    ["/styles.css", ".admin{}"]
  ]);
  return makeTestEnv(kv, { assets }).env;
}

export const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

export function makeExecutionContext(): { ctx: ExecutionContext; waitUntil: Promise<unknown>[] } {
  const waitUntil: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => { waitUntil.push(promise); },
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext,
    waitUntil
  };
}
