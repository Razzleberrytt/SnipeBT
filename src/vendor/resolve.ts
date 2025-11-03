export function opt<T = any>(name: string): T | undefined {
  try { return require(name) as T; } catch { return undefined; }
}
