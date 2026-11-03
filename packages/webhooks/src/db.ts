/** The part of a D1 binding this package uses (D1Database satisfies it). */
export interface Db {
  prepare(query: string): Stmt;
}

export interface Stmt {
  bind(...values: unknown[]): Stmt;
  run(): Promise<{ meta: { changes: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
