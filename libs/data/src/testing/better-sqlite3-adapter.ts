import BetterSqlite3 from 'better-sqlite3';

import { SqlDatabase, SqlValue } from '../database';

/**
 * Node-only adapter so the DAO and migrations run against real SQLite in jest.
 * NOT exported from the lib index — the app must never bundle better-sqlite3.
 */
export function openTestDatabase(filename = ':memory:'): SqlDatabase & {
  close(): void;
} {
  const db = new BetterSqlite3(filename);
  db.pragma('foreign_keys = ON');
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
