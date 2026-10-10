import type { ReactNode } from 'react';
import type { CacheReport, MissReason } from '../../src/core/api-types';
import { formatDuration, REASON_LABEL } from '../lib/cache';
import { formatUsd } from '../lib/format';

const Live = ({ children }: { children: ReactNode }) => <strong title="Calculated from your current data">{children}</strong>;

const ADVICE: ReadonlyArray<{ reason: MissReason; what: ReactNode; fix: ReactNode }> = [
  {
    reason: 'caching-off',
    what: 'The agent never asked the provider to cache this model\'s prompts, so every step pays full input price for the whole conversation. A common cause is an unusual model id (for example an application inference profile ARN) that the agent does not recognise as cache-capable.',
    fix: 'Use the plain model id or a system inference profile (such as us.anthropic.…) in that agent, then check the "By model" table: "caching never observed" should disappear.',
  },
  {
    reason: 'expired',
    what: 'You paused longer than the cache lifetime, so the saved prompt was gone and had to be written again.',
    fix: 'Keep pauses short, use the 1-hour cache where your agent supports it, or after a long break start a fresh session with a short summary instead of resuming a huge one.',
  },
  {
    reason: 'prefix-change',
    what: 'Same model, no long pause, still a miss. A cache only matches if the beginning of the prompt is byte-for-byte identical, so something near the start changed. Typical causes: the tool list or an MCP server changed, a skill or memory file was reloaded, earlier messages were edited, or two requests raced each other. This is a pattern, not a proof: the logs do not record the prompt itself.',
    fix: 'Keep static things (system prompt, tool definitions) first and stable, avoid toggling MCP servers or modes mid-session, and avoid editing earlier history.',
  },
  {
    reason: 'model-switch',
    what: 'Caches belong to one model. Switching the main model mid-session throws the cached conversation away and writes it again for the new model.',
    fix: 'Pick the model before a long task, and send small side jobs to a subagent on the cheaper model, which starts its own conversation anyway.',
  },
  {
    reason: 'context-reset',
    what: 'The prompt shrank sharply: a compaction replaced the history with a summary, or a new conversation began. The new beginning has never been cached.',
    fix: 'Normal and mostly unavoidable. Starting a fresh session per task keeps contexts small, which is cheaper than relying on compaction.',
  },
  {
    reason: 'cold-start',
    what: 'The first call of a conversation: nothing exists to read yet, so the prompt is written once.',
    fix: 'Unavoidable. It is amortised over every later step, which is why very short sessions have a poor hit ratio.',
  },
];

export function CacheMissSection({ report }: { report: CacheReport | null }) {
  const byReason = new Map((report?.reasons ?? []).map((r) => [r.reason, r]));
  return (
    <section id="cache-misses" tabIndex={-1}>
      <h2>Cache misses: the six reasons</h2>
      <p>
        A <em>miss</em> is a step that re-sent prompt tokens a cache hit could have served. Only the part beyond genuinely new content counts: each step adds new messages and tool results, and those are
        always processed fresh. The Cache page sorts every miss into one of six reasons
        {report && <> and judges "expired" against your cache lifetime of <Live>{formatDuration(report.totals.ttlMs)}</Live></>}
        .
      </p>
      <ul>
        {ADVICE.map((a) => {
          const row = byReason.get(a.reason);
          return (
            <li key={a.reason}>
              <strong>{REASON_LABEL[a.reason]}</strong>
              {row && row.steps > 0 && <> (across all your data: <Live>{row.steps.toLocaleString()}</Live> steps{row.avoidable ? <>, about <Live>{formatUsd(row.extraCostUsd)}</Live> extra</> : null})</>}
              . {a.what} <em>What to do:</em> {a.fix}
            </li>
          );
        })}
      </ul>
      <p className="muted">Extra cost is an estimate: missed tokens priced at what they cost (full input or cache write) minus what a cache read would have cost, using the current price list.</p>
    </section>
  );
}
