import { WASI } from "@cloudflare/workers-wasi";
import compilerModule from "./vendor/singbox/srs-compiler.wasm";
import { createRuleSetAggregator, RULE_KERNEL_MAX_BYTES } from "./rule-set-kernel";

const MAX_SRS_BYTES = 24 * 1024 * 1024;
const decoder = new TextDecoder();

export async function compileSingboxRuleSet(input: string): Promise<Uint8Array> {
  const inputBytes = new TextEncoder().encode(input);
  const result = await runRuleSetKernel(inputBytes, MAX_SRS_BYTES);
  if (result.byteLength < 8 || decoder.decode(result.subarray(0, 3)) !== "SRS" || result[3]! < 1 || result[3]! > 5) {
    throw new Error("sing-box returned an invalid SRS artifact");
  }
  return result;
}

export const aggregateRuleSet = createRuleSetAggregator((input) => runRuleSetKernel(input, RULE_KERNEL_MAX_BYTES));

async function runRuleSetKernel(inputBytes: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
  const output: Uint8Array[] = [];
  let outputLength = 0;
  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(inputBytes);
      controller.close();
    }
  });
  const stdout = new WritableStream<Uint8Array>({
    write(chunk) {
      outputLength += chunk.byteLength;
      if (outputLength > maxOutputBytes) throw new Error("Rule compiler output exceeds the size limit");
      output.push(chunk.slice());
    }
  });
  const stderr = new WritableStream<Uint8Array>({ write() {} });
  const wasi = new WASI({ stdin, stdout, stderr, returnOnExit: true });
  const instance = new WebAssembly.Instance(compilerModule, { wasi_snapshot_preview1: wasi.wasiImport });
  const exitCode = await wasi.start(instance);
  if (exitCode !== 0) throw new Error("Rule kernel compilation failed");
  const result = new Uint8Array(outputLength);
  let offset = 0;
  for (const chunk of output) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
