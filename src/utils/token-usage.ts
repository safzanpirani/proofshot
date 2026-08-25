import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  model: string;
  source: 'claude-logs';
}

/**
 * Report token usage for a ProofShot session, when a real source says so.
 *
 * Returns null rather than guessing. There used to be a fallback that derived
 * "usage" from the action count (500 in / 300 out per action, priced at Sonnet
 * rates) and printed it as a cost. Those numbers tracked nothing, and a proof
 * artifact is the last place invented figures belong -- the whole point of the
 * report is that a human can trust what it says.
 */
export function estimateTokenUsage(
  _sessionDir: string,
  startTimeMs: number,
  endTimeMs: number,
): TokenUsage | null {
  return tryClaudeCodeLogs(startTimeMs, endTimeMs);
}

function tryClaudeCodeLogs(startTimeMs: number, endTimeMs: number): TokenUsage | null {
  const claudeDir = path.join(os.homedir(), '.claude', 'sessions');
  if (!fs.existsSync(claudeDir)) return null;

  try {
    const files = fs.readdirSync(claudeDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(claudeDir, file), 'utf-8'));
      const sessionStart = new Date(data.startedAt).getTime();
      if (sessionStart >= startTimeMs - 60000 && sessionStart <= endTimeMs + 60000) {
        if (data.totalInputTokens != null || data.totalOutputTokens != null || data.usage) {
          const inputTokens = data.totalInputTokens ?? data.usage?.inputTokens ?? 0;
          const outputTokens = data.totalOutputTokens ?? data.usage?.outputTokens ?? 0;
          return {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            estimatedCost: 0,
            model: data.model || 'claude',
            source: 'claude-logs',
          };
        }
      }
    }
  } catch {
    // Silent fallback
  }

  return null;
}

export function formatTokenUsage(usage: TokenUsage): string {
  const fmt = (n: number) => n.toLocaleString();
  let result = '';
  result += `- Input tokens: ~${fmt(usage.inputTokens)}\n`;
  result += `- Output tokens: ~${fmt(usage.outputTokens)}\n`;
  result += `- Total tokens: ~${fmt(usage.totalTokens)}\n`;
  if (usage.estimatedCost > 0) {
    result += `- Estimated cost: ~$${usage.estimatedCost.toFixed(4)}\n`;
  }
  return result;
}
