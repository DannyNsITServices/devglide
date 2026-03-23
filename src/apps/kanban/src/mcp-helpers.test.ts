import { describe, it, expect } from 'vitest';
import { normalizeEscapes, truncateDescription, DEFAULT_COLUMNS, mapColumnRow, mapIssueRow, sanitizeFtsQuery } from './mcp-helpers.js';
import type { ColumnRow, IssueRow } from './db.js';

describe('normalizeEscapes', () => {
  it('converts literal \\n to newline', () => {
    expect(normalizeEscapes('line1\\nline2')).toBe('line1\nline2');
  });

  it('converts literal \\t to tab', () => {
    expect(normalizeEscapes('col1\\tcol2')).toBe('col1\tcol2');
  });

  it('handles multiple escapes', () => {
    expect(normalizeEscapes('a\\nb\\nc\\td')).toBe('a\nb\nc\td');
  });

  it('returns unchanged string when no escapes', () => {
    expect(normalizeEscapes('no escapes here')).toBe('no escapes here');
  });
});

describe('truncateDescription', () => {
  it('returns null for null/undefined input', () => {
    expect(truncateDescription(null)).toBeNull();
    expect(truncateDescription(undefined)).toBeNull();
  });

  it('returns short descriptions unchanged', () => {
    expect(truncateDescription('short desc')).toBe('short desc');
  });

  it('truncates descriptions over 200 chars', () => {
    const long = 'a'.repeat(250);
    const result = truncateDescription(long)!;
    expect(result.length).toBeLessThan(250);
    expect(result).toContain('…(truncated)');
  });

  it('returns exactly 200 chars unchanged', () => {
    const exact = 'x'.repeat(200);
    expect(truncateDescription(exact)).toBe(exact);
  });
});

describe('DEFAULT_COLUMNS', () => {
  it('has 6 columns in correct order', () => {
    expect(DEFAULT_COLUMNS).toHaveLength(6);
    expect(DEFAULT_COLUMNS.map((c) => c.name)).toEqual([
      'Backlog', 'Todo', 'In Progress', 'In Review', 'Testing', 'Done',
    ]);
  });

  it('has sequential order values', () => {
    expect(DEFAULT_COLUMNS.map((c) => c.order)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('mapColumnRow', () => {
  it('remaps projectId to featureId', () => {
    const row: ColumnRow = {
      id: 'c1', name: 'Todo', order: 1, color: '#blue',
      projectId: 'proj1', createdAt: '2025-01-01', updatedAt: '2025-01-01',
    };
    const mapped = mapColumnRow(row);
    expect(mapped.featureId).toBe('proj1');
    expect('projectId' in mapped).toBe(false);
  });

  it('returns undefined for undefined input', () => {
    expect(mapColumnRow(undefined)).toBeUndefined();
  });
});

describe('mapIssueRow', () => {
  it('remaps projectId to featureId', () => {
    const row: IssueRow = {
      id: 'i1', title: 'Bug', description: null, type: 'BUG',
      priority: 'HIGH', order: 0, labels: '[]', dueDate: null,
      reviewFeedback: null, projectId: 'proj1', columnId: 'c1',
      createdAt: '2025-01-01', updatedAt: '2025-01-01',
    };
    const mapped = mapIssueRow(row);
    expect(mapped.featureId).toBe('proj1');
    expect(mapped.title).toBe('Bug');
    expect('projectId' in mapped).toBe(false);
  });
});

describe('sanitizeFtsQuery', () => {
  it('passes simple words through quoted', () => {
    expect(sanitizeFtsQuery('bug fix')).toBe('"bug" "fix"');
  });

  it('strips parentheses', () => {
    expect(sanitizeFtsQuery('foo(')).toBe('"foo"');
  });

  it('strips quotes', () => {
    expect(sanitizeFtsQuery('"hello"')).toBe('"hello"');
  });

  it('strips curly braces and asterisks', () => {
    expect(sanitizeFtsQuery('test{} *wild')).toBe('"test" "wild"');
  });

  it('drops bare FTS operators', () => {
    expect(sanitizeFtsQuery('a OR')).toBe('"a"');
    expect(sanitizeFtsQuery('AND NOT OR')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(sanitizeFtsQuery('')).toBeNull();
    expect(sanitizeFtsQuery('   ')).toBeNull();
  });

  it('returns null for only special characters', () => {
    expect(sanitizeFtsQuery('"()*{}')).toBeNull();
  });

  it('handles mixed valid and invalid tokens', () => {
    expect(sanitizeFtsQuery('chat OR rules')).toBe('"chat" "rules"');
  });
});
