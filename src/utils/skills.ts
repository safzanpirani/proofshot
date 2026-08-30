import * as fs from 'fs';
import * as path from 'path';

const SKILL_DESCRIPTION = 'Records and inspects browser proof for visible UI changes. Use after modifying UI, when a user asks for screenshots, demos, recordings, or before-and-after proof, and before claiming that a visual change works.';

const FALLBACK_WORKFLOW = `# ProofShot visual verification workflow

1. Run \`proofshot doctor\`. Stop if required runtime tooling is unavailable.
2. Start with \`proofshot start --run "<dev command>" --port <port> --description "<scope>"\`. Use \`--take-port\` only after confirming ownership. Use \`--force\` only for state proven stale.
3. Drive the browser through ProofShot commands. Add required \`proofshot assert\` commands and capture key screenshots.
4. Open every key screenshot with the runtime's native image viewer.
5. Run \`proofshot stop\` after successful and failed actions. Treat failed actions, errors, malformed logs, and unavailable evidence as failures.
6. Run \`proofshot pr\` only after complete evidence exists.

Report visible observations, assertions, errors, unavailable evidence, and human checks as separate facts.`;

/** Resolve the directory where bundled skill files are shipped. */
export function getSkillsDir(): string {
  return path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '..', '..', 'skills',
  );
}

/** Read a bundled skill file. Returns null when the file is unavailable. */
export function readBundledSkill(relativePath: string): string | null {
  try {
    return fs.readFileSync(path.join(getSkillsDir(), relativePath), 'utf-8');
  } catch {
    return null;
  }
}

export function renderSkillContent(agent: string, workflow: string): string {
  if (agent === 'cursor') {
    return `---\ndescription: Visual verification of UI changes using ProofShot\nglobs: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.html"]\n---\n\n${workflow}`;
  }
  if (agent === 'opencode') {
    return `---\nname: proofshot\ndescription: ${SKILL_DESCRIPTION}\ncompatibility: opencode\n---\n\n${workflow}`;
  }
  if (agent === 'claude' || agent === 'codex') {
    return `---\nname: proofshot\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${workflow}`;
  }
  return workflow;
}

/** Generate installable skill content from the canonical workflow. */
export function getInlineSkillContent(agent: string): string {
  return renderSkillContent(agent, readBundledSkill('workflow.md') ?? FALLBACK_WORKFLOW);
}

export function getCanonicalSkillContent(agent: string): string {
  return getInlineSkillContent(agent);
}
