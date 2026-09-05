import { describe, expect, it } from 'vitest';
import { SCHEMA, schemaStatements } from '../src/worker/db';

describe('schemaStatements', () => {
  it('splits on semicolons and drops comments', () => {
    const statements = schemaStatements(`
      -- a comment; with a semicolon
      CREATE TABLE IF NOT EXISTS a (id TEXT PRIMARY KEY);

      -- another comment
      CREATE INDEX IF NOT EXISTS idx_a ON a (id);
    `);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS a/);
    expect(statements[1]).toMatch(/^CREATE INDEX IF NOT EXISTS idx_a/);
  });

  it('returns no empty statements for trailing semicolons and whitespace', () => {
    expect(schemaStatements('SELECT 1; \n ; ;')).toEqual(['SELECT 1']);
  });
});

describe('SCHEMA', () => {
  const statements = schemaStatements(SCHEMA);

  /* The splitter treats every semicolon as a statement boundary, so a semicolon
     inside a table body would silently create half a table. This is that guard. */
  it('splits into whole CREATE statements only', () => {
    for (const statement of statements) {
      expect(statement).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS/);
    }
    for (const statement of statements) {
      if (statement.startsWith('CREATE TABLE')) {
        // A truncated body would be missing its closing paren.
        expect(statement.split('(').length).toBe(statement.split(')').length);
      }
    }
  });

  it('creates every table the app reads', () => {
    const tables = statements
      .map((statement) => /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement)?.[1])
      .filter(Boolean);
    expect(tables).toEqual(
      expect.arrayContaining([
        'settings', 'connect_sessions', 'agents', 'conversations', 'messages',
        'people', 'panel_agents', 'memory_entries', 'reviews', 'review_people',
        'review_memory', 'documents', 'passes', 'issues', 'feedback_batches', 'feedback_links',
      ]),
    );
    expect(new Set(tables).size).toBe(tables.length);
  });
});
