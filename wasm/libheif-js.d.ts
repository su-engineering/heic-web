/**
 * `libheif-js` ships no type declarations, and the core package must build with
 * it absent entirely. This ambient declaration lets the wasm entry point compile
 * either way; the structural interfaces the adapter actually relies on are
 * declared in index.ts next to the code that uses them.
 */
declare module 'libheif-js' {
  const libheif: unknown;
  export default libheif;
}
