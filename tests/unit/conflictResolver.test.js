/**
 * Phase 9 - Conflict Resolver tests.
 *
 * design.md section 10 promises three behaviours: a version mismatch aborts,
 * disjoint edits merge with the later one shifted, and overlapping edits
 * refuse to merge. Each is asserted here, including the offset arithmetic
 * that is easy to get wrong by one character.
 */

'use strict';

const {
  ConflictResolver,
  ConflictError,
  operationRange
} = require('../../src/engine/conflict/ConflictResolver');

describe('operationRange', () => {
  test('an insert is a zero-width point with a positive delta', () => {
    expect(operationRange({ type: 'insert', position: 5, content: 'abc' }))
      .toEqual({ start: 5, end: 5, delta: 3 });
  });

  test('a delete spans the characters it removes', () => {
    expect(operationRange({ type: 'delete', position: 2, length: 4 }))
      .toEqual({ start: 2, end: 6, delta: -4 });
  });
});

describe('version checking', () => {
  let resolver;

  beforeEach(() => {
    resolver = new ConflictResolver();
  });

  test('accepts a matching version', () => {
    expect(() => resolver.assertNoConflict({
      txId: 1, pageId: 4, expectedVersion: 7, actualVersion: 7
    })).not.toThrow();
    expect(resolver.getStats()).toMatchObject({ checks: 1, conflicts: 0 });
  });

  test('rejects a stale version and reports both numbers', () => {
    try {
      resolver.assertNoConflict({ txId: 1, pageId: 4, expectedVersion: 7, actualVersion: 9 });
      throw new Error('expected a ConflictError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect(error.code).toBe('VERSION_CONFLICT');
      expect(error.expectedVersion).toBe(7);
      expect(error.actualVersion).toBe(9);
    }
    expect(resolver.getStats().conflicts).toBe(1);
  });
});

describe('applyOperation', () => {
  test('inserts at a position', () => {
    expect(ConflictResolver.applyOperation('hello world', { type: 'insert', position: 5, content: ' brave' }))
      .toBe('hello brave world');
  });

  test('deletes a span', () => {
    expect(ConflictResolver.applyOperation('hello brave world', { type: 'delete', position: 5, length: 6 }))
      .toBe('hello world');
  });

  test('clamps a position beyond the end of the text', () => {
    expect(ConflictResolver.applyOperation('abc', { type: 'insert', position: 99, content: 'd' })).toBe('abcd');
    expect(ConflictResolver.applyOperation('abc', { type: 'delete', position: 1, length: 99 })).toBe('a');
  });

  test('leaves the text untouched for an unknown operation', () => {
    expect(ConflictResolver.applyOperation('abc', { type: 'format', position: 0 })).toBe('abc');
  });
});

describe('overlap detection', () => {
  let resolver;

  beforeEach(() => {
    resolver = new ConflictResolver();
  });

  test('two inserts at the same offset overlap', () => {
    expect(resolver.overlaps(
      { type: 'insert', position: 3, content: 'a' },
      { type: 'insert', position: 3, content: 'b' }
    )).toBe(true);
  });

  test('two inserts at different offsets do not', () => {
    expect(resolver.overlaps(
      { type: 'insert', position: 3, content: 'a' },
      { type: 'insert', position: 8, content: 'b' }
    )).toBe(false);
  });

  test('an insert strictly inside a deleted span overlaps', () => {
    expect(resolver.overlaps(
      { type: 'insert', position: 5, content: 'x' },
      { type: 'delete', position: 3, length: 6 }
    )).toBe(true);
  });

  test('an insert at the boundary of a deleted span does not', () => {
    expect(resolver.overlaps(
      { type: 'insert', position: 3, content: 'x' },
      { type: 'delete', position: 3, length: 4 }
    )).toBe(false);
  });

  test('two deletes that share a character overlap', () => {
    expect(resolver.overlaps(
      { type: 'delete', position: 2, length: 4 },
      { type: 'delete', position: 5, length: 3 }
    )).toBe(true);
  });

  test('two adjacent deletes do not', () => {
    expect(resolver.overlaps(
      { type: 'delete', position: 2, length: 3 },
      { type: 'delete', position: 5, length: 3 }
    )).toBe(false);
  });
});

describe('merging', () => {
  let resolver;

  beforeEach(() => {
    resolver = new ConflictResolver();
  });

  test('shifts a later insert by the length an earlier one added', () => {
    const result = resolver.merge(
      'hello world',
      { type: 'insert', position: 0, content: '>> ' },
      { type: 'insert', position: 6, content: 'brave ' }
    );

    expect(result.merged).toBe(true);
    expect(result.shiftedOp.position).toBe(9);
    expect(result.text).toBe('>> hello brave world');
  });

  test('leaves an earlier edit alone when the committed one is after it', () => {
    const result = resolver.merge(
      'hello world',
      { type: 'insert', position: 11, content: '!' },
      { type: 'insert', position: 0, content: '>' }
    );

    expect(result.merged).toBe(true);
    expect(result.shiftedOp.position).toBe(0);
    expect(result.text).toBe('>hello world!');
  });

  test('shifts a later insert back by the length an earlier delete removed', () => {
    const result = resolver.merge(
      'hello brave world',
      { type: 'delete', position: 5, length: 6 },
      { type: 'insert', position: 17, content: '!' }
    );

    expect(result.merged).toBe(true);
    expect(result.shiftedOp.position).toBe(11);
    expect(result.text).toBe('hello world!');
  });

  test('refuses to merge overlapping edits', () => {
    const result = resolver.merge(
      'hello world',
      { type: 'delete', position: 0, length: 5 },
      { type: 'delete', position: 2, length: 5 }
    );

    expect(result.merged).toBe(false);
    expect(result.reason).toMatch(/overlapping/);
    expect(resolver.getStats().merges).toBe(0);
  });

  test('a merged result is independent of which edit is replayed first', () => {
    const base = 'one two three';
    const a = { type: 'insert', position: 0, content: 'A' };
    const b = { type: 'insert', position: 8, content: 'B' };

    expect(resolver.merge(base, a, b).text).toBe(resolver.merge(base, b, a).text);
  });
});
