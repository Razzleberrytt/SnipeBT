export interface CounterConfiguration {
  name: string;
  help?: string;
}
export class Counter {
  constructor(configuration: CounterConfiguration);
  inc(value?: number): void;
  get(): { name: string; help: string; value: number };
}
export function collectDefaultMetrics(): void;
export const register: {
  contentType: string;
  metrics(): Promise<string>;
};
declare const _default: {
  Counter: typeof Counter;
  collectDefaultMetrics: typeof collectDefaultMetrics;
  register: typeof register;
};
export default _default;
