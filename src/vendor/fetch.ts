export async function fetchInput(input: RequestInfo | URL, init?: RequestInit) {
  const f = (globalThis as any).fetch as typeof fetch | undefined;
  if (!f) throw new Error("fetch is not available in this runtime");
  return f(input, init);
}
