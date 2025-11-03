declare const fetchImpl: typeof globalThis.fetch;
export default fetchImpl;
export type RequestInfo = Parameters<typeof fetchImpl>[0];
export type RequestInit = Parameters<typeof fetchImpl>[1];
