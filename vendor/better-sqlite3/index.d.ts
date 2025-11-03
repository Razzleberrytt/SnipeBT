declare class BetterSqlite3 {
  constructor(file: string);
  pragma(setting: string): void;
  exec(sql: string): void;
  prepare(sql: string): BetterSqlite3.Statement;
}
declare namespace BetterSqlite3 {
  interface Statement {
    run(params: Record<string, unknown>): void;
  }
  type Database = BetterSqlite3;
}
export = BetterSqlite3;
