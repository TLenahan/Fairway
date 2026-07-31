import BetterSqlite3 from 'better-sqlite3';

import { SqlDatabase, SqlValue } from './database';

/**
 * Node-only better-sqlite3 adapter for the SqlDatabase seam. Consumed by the
 * Mac hub (via the `@golf/data/node` path alias) and by jest through
 * testing/better-sqlite3-adapter. Deliberately NOT exported from the lib
 * index — the app bundle must never pull in better-sqlite3.
 *
 * `readonly` opens the file for reading only, and the driver rejects every
 * write. It is what the MCP server runs on: a read-only surface enforced by
 * a flag beats one enforced by everybody remembering not to write. Note that
 * a read-only connection cannot run migrations, so it requires a database the
 * hub has already created.
 */
export function openNodeDatabase(
  filename = ':memory:',
  opts: { readonly?: boolean } = {},
): SqlDatabase & {
  close(): void;
} {
  const db = new BetterSqlite3(filename, { readonly: opts.readonly ?? false });
  // Foreign keys constrain writes, and this connection cannot make any.
  if (!opts.readonly) db.pragma('foreign_keys = ON');
  return {
    async execAsync(sql: string): Promise<void> {
      db.exec(sql);
    },
    async runAsync(sql: string, params: SqlValue[] = []): Promise<void> {
      db.prepare(sql).run(...params);
    },
    async getFirstAsync<T>(
      sql: string,
      params: SqlValue[] = [],
    ): Promise<T | null> {
      if (sql.trim().toUpperCase().startsWith('PRAGMA')) {
        const pragma = sql.trim().slice('PRAGMA'.length).trim();
        const result = db.pragma(pragma, { simple: false }) as T[];
        return result[0] ?? null;
      }
      const row = db.prepare(sql).get(...params) as T | undefined;
      return row ?? null;
    },
    async getAllAsync<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },
    close() {
      db.close();
    },
  };
}
