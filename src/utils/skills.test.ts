import { describe, expect, it } from 'vitest';
import { getInlineSkillContent, readBundledSkill } from './skills.js';

describe('bundled ProofShot skills', () => {
  it.each([
    ['claude', 'claude/SKILL.md'],
    ['codex', 'codex/SKILL.md'],
    ['generic', 'codex/AGENTS.md'],
    ['opencode', 'opencode/SKILL.md'],
    ['cursor', 'cursor/proofshot.mdc'],
    ['generic', 'generic/PROOFSHOT.md'],
  ])('keeps the %s variant synchronized with workflow.md', (agent, relativePath) => {
    expect(readBundledSkill(relativePath)).toBe(getInlineSkillContent(agent));
  });

  it('keeps unsafe lifecycle advice out of every variant', () => {
    for (const agent of ['claude', 'codex', 'opencode', 'cursor', 'generic']) {
      const content = getInlineSkillContent(agent);
      expect(content).not.toContain('kills the existing process');
      expect(content).toContain('--take-port');
      expect(content).toContain('proofshot assert');
      expect(content).toContain('native image viewer');
      expect(content).toMatch(/unavailable evidence/i);
    }
  });
});
