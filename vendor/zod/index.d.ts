export class ZodError extends Error {
  constructor(issues: readonly ZodIssue[]);
  issues: readonly ZodIssue[];
  format(): Record<string, { _errors: string[] }>;
}
export interface ZodIssue {
  path: (string | number)[];
  message: string;
}
export interface SafeParseSuccess<T> {
  success: true;
  data: T;
}
export interface SafeParseFailure {
  success: false;
  error: ZodError;
}
export type SafeParseReturnType<T> = SafeParseSuccess<T> | SafeParseFailure;

export interface ZodType<T> {
  optional(): this;
  default(value: T): this;
  parse(value: unknown): T;
  safeParse(value: unknown): SafeParseReturnType<T>;
}

export interface StringSchema extends ZodType<string | undefined> {
  url(): this;
}

export interface NumberSchema extends ZodType<number | undefined> {
  int(): this;
  min(value: number): this;
  max(value: number): this;
}

export interface BooleanSchema extends ZodType<boolean | undefined> {}

export interface EnumSchema<T extends readonly [string, ...string[]]> extends ZodType<T[number]> {}

export interface ObjectSchema<T extends Record<string, any>> extends ZodType<{ [K in keyof T]: Infer<T[K]> }> {}

export type Infer<T> = T extends { parse(value: unknown): infer R } ? R : never;
export type infer<T> = Infer<T>;

export interface ZodNamespace {
  object<T extends Record<string, any>>(shape: T): ObjectSchema<T>;
  string(): StringSchema;
  enum<T extends readonly [string, ...string[]]>(values: T): EnumSchema<T>;
  number(): NumberSchema;
  boolean(): BooleanSchema;
  coerce: {
    number(): NumberSchema;
    boolean(): BooleanSchema;
  };
  infer: typeof infer;
}

declare const z: ZodNamespace;
declare namespace z {
  type infer<T> = Infer<T>;
}
export { z };
export default z;
export type { SafeParseSuccess, SafeParseFailure };
