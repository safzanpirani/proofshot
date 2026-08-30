import { describe, expect, it } from 'vitest';
import { getAppendMarkerStatus, parseToolFilter } from './install.js';

describe('parseToolFilter', () => {
  it('accepts canonical comma-separated tool names', () => {
    expect([...parseToolFilter('Claude, codex', '--only')]).toEqual(['claude', 'codex']);
  });

  it('rejects unknown and empty tool names', () => {
    expect(() => parseToolFilter('claude,unknown', '--only')).toThrow('unknown');
    expect(() => parseToolFilter('claude,', '--skip')).toThrow('<empty>');
  });
});

describe('getAppendMarkerStatus', () => {
  it('recognizes one complete marker block', () => {
    expect(getAppendMarkerStatus([
      '# Existing rules',
      '<!-- proofshot:start -->',
      'ProofShot workflow',
      '<!-- proofshot:end -->',
    ].join('\n'))).toBe('valid');
  });

  it.each([
    '<!-- proofshot:start -->\ntruncated',
    'orphan\n<!-- proofshot:end -->',
    '<!-- proofshot:end -->\n<!-- proofshot:start -->',
    '<!-- proofshot:start -->\na\n<!-- proofshot:end -->\n<!-- proofshot:start -->\nb\n<!-- proofshot:end -->',
  ])('rejects malformed marker layout', (contents) => {
    expect(getAppendMarkerStatus(contents)).toBe('malformed');
  });
});
