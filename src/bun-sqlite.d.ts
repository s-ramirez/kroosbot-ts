declare module "bun:sqlite" {
  export type SQLQueryBindings = string | number | bigint | boolean | Uint8Array | null;

  export class Statement<Params extends Record<string, SQLQueryBindings> | SQLQueryBindings[] | undefined = undefined> {
    run(params?: Params | Record<string, SQLQueryBindings> | SQLQueryBindings[] | SQLQueryBindings): { changes: number; lastInsertRowid: number | bigint };
    get<Row = unknown>(params?: Params | Record<string, SQLQueryBindings> | SQLQueryBindings[] | SQLQueryBindings): Row | null;
    all<Row = unknown>(params?: Params | Record<string, SQLQueryBindings> | SQLQueryBindings[] | SQLQueryBindings): Row[];
  }

  export class Database {
    constructor(filename?: string, options?: { create?: boolean; strict?: boolean });
    exec(query: string): this;
    prepare<Params extends Record<string, SQLQueryBindings> | SQLQueryBindings[] | undefined = undefined>(
      query: string
    ): Statement<Params>;
    query<Params extends Record<string, SQLQueryBindings> | SQLQueryBindings[] | undefined = undefined>(
      query: string
    ): Statement<Params>;
    transaction<T extends (...args: never[]) => unknown>(fn: T): T;
    close(): void;
  }
}
