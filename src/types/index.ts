export type Json = Record<string, unknown>;

export interface Timestamped {
  createdAt: Date;
  updatedAt?: Date;
}
