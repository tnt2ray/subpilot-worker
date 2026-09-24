declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*.wasm.sha256" {
  const checksum: string;
  export default checksum;
}
