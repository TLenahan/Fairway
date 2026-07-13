/**
 * Minimal async SQL interface the DAO is written against.
 *
 * In the app it's satisfied by expo-sqlite's SQLiteDatabase; in Node tests by
 * the better-sqlite3 adapter in test-support. Keeping the DAO off the concrete
 * driver is what makes @golf/data unit-testable without a device.
 */
export interface SqlDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: SqlValue[]): Promise<void>;
  getFirstAsync<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
}

export type SqlValue = string | number | null;
