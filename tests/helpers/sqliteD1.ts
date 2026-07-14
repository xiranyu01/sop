import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import type {
  D1AllResultLike,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from '../../server/repositories/d1ResourceRepository';

export type ExecutedSql = { sql: string; values: unknown[]; operation: 'first' | 'all' | 'run' };

class SqliteD1Statement implements D1PreparedStatementLike {
  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqliteD1Statement(this.owner, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    this.owner.executed.push({ sql: this.sql, values: this.values, operation: 'first' });
    return (this.statement().get(...this.sqlValues()) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1AllResultLike<T>> {
    this.owner.executed.push({ sql: this.sql, values: this.values, operation: 'all' });
    return { results: this.statement().all(...this.sqlValues()) as T[], success: true };
  }

  async run(): Promise<D1RunResultLike> {
    return this.runSync();
  }

  runSync(): D1RunResultLike {
    this.owner.executed.push({ sql: this.sql, values: this.values, operation: 'run' });
    const result = this.statement().run(...this.sqlValues());
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  private statement(): StatementSync {
    return this.owner.database.prepare(this.sql);
  }

  private sqlValues(): SQLInputValue[] {
    return this.values as SQLInputValue[];
  }
}

export class SqliteD1 implements D1DatabaseLike {
  readonly database = new DatabaseSync(':memory:');
  readonly executed: ExecutedSql[] = [];

  constructor(migrationSql: string) {
    this.database.exec(migrationSql);
  }

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteD1Statement(this, sql);
  }

  async batch<T extends D1RunResultLike = D1RunResultLike>(
    statements: D1PreparedStatementLike[],
  ): Promise<T[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteD1Statement)) throw new TypeError('Unexpected statement implementation');
        return statement.runSync() as T;
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  close(): void {
    this.database.close();
  }
}
