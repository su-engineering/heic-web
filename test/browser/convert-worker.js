import { convertHeic } from '/test/.consumer/stdin.js';
import { wasmDecoder } from '/test/.consumer/stdin.js';
self.onmessage = async () => {
  try {
    const source = await (await fetch('/test/fixtures/generated/asym-base.heic')).blob();
    const result = await convertHeic(source, { strategy: 'wasm', wasmLoader: async () => wasmDecoder });
    const image = await createImageBitmap(result.blob);
    self.postMessage({ type: result.blob.type, size: result.blob.size, width: image.width,
      height: image.height, strategy: result.strategy });
    image.close();
  } catch (error) { self.postMessage({ error: String(error) }); }
};
