import { describe, expect, it } from 'vitest';
import { isPipeCommand, parsePipeCommand, validatePipeAssigneeCount, isBrainstormCommand, parseBrainstormCommand } from './pipe-parser.js';

describe('pipe-parser', () => {
  it('recognizes /explain as a pipe command', () => {
    expect(isPipeCommand('/explain teach me this')).toBe(true);
  });

  it('recognizes /summarize as a pipe command', () => {
    expect(isPipeCommand('/summarize boil this down')).toBe(true);
  });

  it('parses /explain with explicit assignees without a colon', () => {
    expect(parsePipeCommand('/explain @alice @bob explain the bug')).toEqual({
      mode: 'explain',
      assignees: ['alice', 'bob'],
      prompt: 'explain the bug',
    });
  });

  it('still accepts a legacy colon separator', () => {
    expect(parsePipeCommand('/explain @alice @bob: explain the bug')).toEqual({
      mode: 'explain',
      assignees: ['alice', 'bob'],
      prompt: 'explain the bug',
    });
  });

  it('parses /summarize with explicit assignees', () => {
    expect(parsePipeCommand('/summarize @alice @bob summarize this topic')).toEqual({
      mode: 'summarize',
      assignees: ['alice', 'bob'],
      prompt: 'summarize this topic',
    });
  });

  it('allows prompt-only commands so defaults can be resolved later', () => {
    expect(parsePipeCommand('/merge-pipe compare these options')).toEqual({
      mode: 'merge',
      assignees: [],
      prompt: 'compare these options',
    });
  });

  it('stops assignee parsing when a leading @token is not a known participant', () => {
    expect(
      parsePipeCommand(
        '/merge-all-pipe @alice @bob @user mentioned this bug',
        (name) => name === 'alice' || name === 'bob',
      ),
    ).toEqual({
      mode: 'merge-all',
      assignees: ['alice', 'bob'],
      prompt: '@user mentioned this bug',
    });
  });

  it('rejects duplicate assignees', () => {
    expect(parsePipeCommand('/explain @alice @alice duplicate')).toEqual({
      error: 'Duplicate assignees not allowed.',
    });
  });

  it('validates minimum assignee counts after resolution', () => {
    expect(validatePipeAssigneeCount('linear', 1)).toBe('/linear-pipe requires at least 2 assignees.');
    expect(validatePipeAssigneeCount('merge', 2)).toBe('/merge-pipe requires at least 3 assignees (last one synthesizes).');
    expect(validatePipeAssigneeCount('explain', 1)).toBe('/explain requires at least 2 assignees.');
    expect(validatePipeAssigneeCount('explain', 2)).toBeNull();
    expect(validatePipeAssigneeCount('summarize', 1)).toBe('/summarize requires at least 2 assignees.');
    expect(validatePipeAssigneeCount('summarize', 2)).toBeNull();
  });
});

describe('brainstorm-parser', () => {
  it('recognizes /brainstorm as a brainstorm command', () => {
    expect(isBrainstormCommand('/brainstorm design a cache')).toBe(true);
  });

  it('does not recognize /brainstorming or other variants', () => {
    expect(isBrainstormCommand('/brainstorming ideas')).toBe(false);
    expect(isBrainstormCommand('/linear-pipe @a @b do work')).toBe(false);
    expect(isBrainstormCommand('brainstorm something')).toBe(false);
  });

  it('parses /brainstorm with explicit assignees and colon', () => {
    expect(parseBrainstormCommand('/brainstorm @alice @bob : design a cache')).toEqual({
      assignees: ['alice', 'bob'],
      prompt: 'design a cache',
    });
  });

  it('parses /brainstorm with explicit assignees without colon', () => {
    expect(parseBrainstormCommand('/brainstorm @alice @bob design a cache')).toEqual({
      assignees: ['alice', 'bob'],
      prompt: 'design a cache',
    });
  });

  it('parses /brainstorm with no assignees (prompt only)', () => {
    expect(parseBrainstormCommand('/brainstorm design a cache')).toEqual({
      assignees: [],
      prompt: 'design a cache',
    });
  });

  it('parses /brainstorm with colon and no assignees', () => {
    expect(parseBrainstormCommand('/brainstorm : design a cache')).toEqual({
      assignees: [],
      prompt: 'design a cache',
    });
  });

  it('returns error for empty prompt', () => {
    expect(parseBrainstormCommand('/brainstorm @alice @bob')).toEqual({
      error: 'Brainstorm prompt cannot be empty.',
    });
  });

  it('returns error for duplicate assignees', () => {
    expect(parseBrainstormCommand('/brainstorm @alice @alice design a cache')).toEqual({
      error: 'Duplicate assignees not allowed.',
    });
  });

  it('returns error when first leading @name is unknown (no valid assignees)', () => {
    const known = new Set(['alice']);
    const result = parseBrainstormCommand(
      '/brainstorm @ghost design a cache',
      (name) => known.has(name),
    );
    expect(result).toEqual({
      error: 'Unknown assignee @ghost. All assignees must be connected LLM participants.',
    });
  });

  it('treats unknown @name as prompt text when valid assignees precede it', () => {
    const known = new Set(['alice', 'bob']);
    const result = parseBrainstormCommand(
      '/brainstorm @alice @bob @user wants a cache layer',
      (name) => known.has(name),
    );
    expect(result).toEqual({
      assignees: ['alice', 'bob'],
      prompt: '@user wants a cache layer',
    });
  });

  it('accepts all assignees when validator confirms them', () => {
    const known = new Set(['alice', 'bob']);
    const result = parseBrainstormCommand(
      '/brainstorm @alice @bob : design a cache',
      (name) => known.has(name),
    );
    expect(result).toEqual({
      assignees: ['alice', 'bob'],
      prompt: 'design a cache',
    });
  });
});
