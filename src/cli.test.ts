import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { parsePort } from './cli.js';

describe('parsePort', () => {
  it.each(['abc', '3000px', '1.5', '0', '-1', '65536', ' 3000', '3000 '])(
    'rejects %j',
    (value) => {
      expect(() => parsePort(value)).toThrow(InvalidArgumentError);
    },
  );

  it.each([
    ['1', 1],
    ['3000', 3000],
    ['65535', 65535],
  ])('parses %s', (value, expected) => {
    expect(parsePort(value)).toBe(expected);
  });
});
