export const TEST_ADMIN_TOKEN_HASH = "10a4c7c9fc5206d6f36dc6944a81bb6f4a3cb0e25014ae3b12e6c3e52712292a";

export type TestKvValue = string | ArrayBuffer;
export type TestKv = Map<string, TestKvValue>;
export type TestKvInput = Map<string, TestKvValue> | Map<string, string>;

export interface TestKvCalls {
  gets: number;
  puts: number;
  deletes: number;
  lists: number;
}

export interface TestEnvOptions {
  adminTokenHash?: string | undefined;
  configEncryptionKey?: string | undefined;
  assets?: Map<string, string> | undefined;
}

export interface TestEnvResult {
  env: Env;
  kv: TestKv;
  calls: TestKvCalls;
}

export function makeTestEnv(kv: TestKvInput = new Map<string, TestKvValue>(), options: TestEnvOptions = {}): TestEnvResult {
  const testKv = kv as TestKv;
  const calls: TestKvCalls = { gets: 0, puts: 0, deletes: 0, lists: 0 };
  const assets = options.assets ?? new Map<string, string>();
  const env = {
    ADMIN_TOKEN_HASH: options.adminTokenHash ?? TEST_ADMIN_TOKEN_HASH,
    CONFIG_ENCRYPTION_KEY: options.configEncryptionKey ?? "config-secret",
    SUBPILOT_CONFIG: {
      get: async (key: string, type?: string) => {
        calls.gets += 1;
        const value = testKv.get(key) ?? null;
        if (value === null) return null;
        if (type === "json") return JSON.parse(stringFromKvValue(value));
        if (type === "arrayBuffer") return arrayBufferFromKvValue(value);
        return stringFromKvValue(value);
      },
      put: async (key: string, value: TestKvValue) => {
        calls.puts += 1;
        testKv.set(key, value);
      },
      delete: async (key: string) => {
        calls.deletes += 1;
        testKv.delete(key);
      },
      list: async (listOptions?: { prefix?: string }) => {
        calls.lists += 1;
        return {
          keys: [...testKv.keys()]
            .filter((key) => !listOptions?.prefix || key.startsWith(listOptions.prefix))
            .map((name) => ({ name })),
          list_complete: true,
          cursor: undefined
        };
      },
      getWithMetadata: async () => ({ value: null, metadata: null })
    },
    ASSETS: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        const body = assets.get(path === "/" ? "/index.html" : path);
        return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
      }
    }
  } as unknown as Env;
  return { env, kv: testKv, calls };
}

export function makeEnv(kv?: TestKvInput): Env {
  return makeTestEnv(kv).env;
}

function stringFromKvValue(value: TestKvValue): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function arrayBufferFromKvValue(value: TestKvValue): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  const bytes = new TextEncoder().encode(value);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
