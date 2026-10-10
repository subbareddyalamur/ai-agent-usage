import { useEffect, useMemo, type ReactNode } from 'react';
import type { CacheReport, ModelRow, SummaryResult } from '../../src/core/api-types';
import { useApi } from '../lib/api';
import { formatPct, formatRate } from '../lib/format';
import { useRoute } from '../lib/router';
import { CacheMissSection } from './CacheMissConcepts';

const SECTIONS: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'tokens', title: 'Tokens and their four kinds' },
  { id: 'prompt-caching', title: 'Prompt caching' },
  { id: 'cache-misses', title: 'Cache misses: the six reasons' },
  { id: 'context-growth', title: 'Context growth and compaction' },
  { id: 'pricing-tiers', title: 'Pricing tiers and unpriced models' },
  { id: 'tools', title: 'Tools and MCP' },
  { id: 'model-mix', title: 'Choosing the right model' },
];

function Live({ children }: { children: ReactNode }) {
  return <strong title="Calculated from your current data">{children}</strong>;
}

export function Concepts({ section, refreshKey }: { section: string | null; refreshKey: number }) {
  const route = useRoute();
  const models = useApi<ModelRow[]>('/api/models', refreshKey);
  const summary = useApi<SummaryResult>('/api/summary', refreshKey);
  const cache = useApi<CacheReport>('/api/cache', refreshKey);

  useEffect(() => {
    if (!section) return;
    const el = document.getElementById(section);
    if (el) el.scrollIntoView({ block: 'start' });
  }, [section, models.data]);

  // A priced model that has cache rates; used only to phrase real ratios from the live price list.
  const ref = useMemo(() => (models.data ?? []).find((m) => m.rates && m.rates.cacheRead > 0 && m.rates.input > 0) ?? null, [models.data]);
  const rates = ref?.rates ?? null;
  const priced = (models.data ?? []).filter((m) => m.rates);
  const inputs = priced.map((m) => (m.rates as NonNullable<ModelRow['rates']>).input);
  const spread = inputs.length > 1 ? Math.max(...inputs) / Math.min(...inputs) : null;
  const hit = summary.data?.totals.cacheHitRatio ?? null;

  return (
    <div className="prose">
      <h1>Concepts</h1>
      <p className="muted">Plain-language notes on what the numbers mean. Figures in <strong>bold</strong> come from your own data and the latest saved price list.</p>
      <nav aria-label="On this page">
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.id}><a href={route.hrefFor(['concepts'], { section: s.id })}>{s.title}</a></li>
          ))}
        </ul>
      </nav>

      <section id="tokens" tabIndex={-1}>
        <h2>Tokens and their four kinds</h2>
        <p>A token is a small chunk of text (roughly four characters). Models read and write tokens, and providers bill per million of them. Your usage splits into four kinds:</p>
        <ul>
          <li><strong>Fresh input</strong>: prompt tokens processed at full price.</li>
          <li><strong>Output</strong>: tokens the model writes. Reasoning ("thinking") tokens are billed as output. Output is the most expensive kind{rates ? <> (<Live>{(rates.output / rates.input).toFixed(1)}×</Live> the input rate for {ref?.model})</> : null}.</li>
          <li><strong>Cache read</strong>: prompt tokens served from the cache at a steep discount.</li>
          <li><strong>Cache write</strong>: prompt tokens saved into the cache so later steps can read them.</li>
        </ul>
        <p>An agent does not send just your last message. <em>Every step re-sends the whole conversation so far</em> plus tool definitions, which is why input dwarfs output.</p>
      </section>

      <section id="prompt-caching" tabIndex={-1}>
        <h2>Prompt caching</h2>
        <p>
          The provider can remember the already-processed beginning of a prompt for a short time. If the next call starts with the same text, it pays the cache-read price for that part instead of full price.
          {rates && (
            <> On the current price list, a cache read for {ref?.model} costs <Live>{formatPct(rates.cacheRead / rates.input)}</Live> of normal input ({formatRate(rates.cacheRead)} vs {formatRate(rates.input)} per 1M tokens).</>
          )}
        </p>
        <p>
          <strong>Why cache writes cost more.</strong> Storing the prompt is extra work, so a write is priced above normal input
          {rates && <> (<Live>{(rates.cacheWrite5m / rates.input).toFixed(2)}×</Live> for the 5-minute option, <Live>{(rates.cacheWrite1h / rates.input).toFixed(2)}×</Live> for the 1-hour option)</>}
          . It pays off because later steps read the same text cheaply.
        </p>
        <p id="cache-expiry" tabIndex={-1}>
          <strong>Expiry (TTL).</strong> A cached prefix lives for 5 minutes by default, and the clock restarts each time it is used. A 1-hour option exists at a higher write price. If you pause longer than the TTL, the next call
          cannot read the cache and re-writes the whole prompt. That shows up as a step with zero cache read and a big cache write.
        </p>
        <p>
          <strong>When caching silently fails.</strong> Some agents only turn caching on if they recognise the model id. A model reached through an unusual id (for example an application inference profile ARN) may get no cache
          markers at all: cache read and cache write stay at zero while fresh input grows with the conversation. That is the pattern the Insights page looks for.
        </p>
        {hit !== null && <div className="callout">In the data you have loaded, <Live>{formatPct(hit)}</Live> of prompt tokens came from the cache. Healthy agent sessions are usually mostly cache reads.</div>}
      </section>

      <CacheMissSection report={cache.data} />

      <section id="context-growth" tabIndex={-1}>
        <h2>Context growth and compaction</h2>
        <p>The context is everything re-sent on a step: instructions, tool definitions, your messages, the model's replies and every tool result so far. It only grows, and each step costs roughly in proportion to it. Without caching, a long session's cost grows much faster than its length.</p>
        <p id="compaction" tabIndex={-1}>
          <strong>Compaction</strong> replaces the history with a short summary when the context gets too large. You see it as a sudden drop on the session timeline. It keeps the session going but costs an extra call, and details can be lost.
        </p>
        <ul>
          <li>Start a fresh session for a new task instead of continuing a long one.</li>
          <li>Prefer targeted reads and searches over dumping whole files or logs into the conversation.</li>
          <li>Check the session timeline: a rising red area (fresh input) means you are paying full price for the same text again and again.</li>
        </ul>
      </section>

      <section id="pricing-tiers" tabIndex={-1}>
        <h2>Pricing tiers and unpriced models</h2>
        <p>The cost shown everywhere is an <strong>estimate</strong>: tokens × the public AWS Bedrock price list, not your invoice.</p>
        <ul>
          <li><strong>Regional vs global.</strong> The price list has two rates per model. Model ids starting with <code>global.</code> use the global rate; <code>us.</code> ids and others use the regional rate. The Models page shows which tier each model used.</li>
          <li><strong>Price history.</strong> Every price list the app fetches is kept. Each call is costed with the list that was current when it happened, so old usage is not re-priced by later changes. Usage older than the first saved list is marked approximate.</li>
          <li id="unpriced" tabIndex={-1}><strong>Unpriced models.</strong> If a model id cannot be matched to the price list (a local model, a brand-new model, an unresolved ARN), its tokens are still counted but its cost is left out and labelled unpriced, never shown as $0. It is resolved automatically once the price list or ARN lookup can match it.</li>
        </ul>
      </section>

      <section id="tools" tabIndex={-1}>
        <h2>Tools and MCP</h2>
        <p>Tools are actions an agent can take: reading files, running shell commands, searching, fetching web pages. <strong>MCP servers</strong> add more tools, named <code>mcp__server__tool</code>; the Tools page groups them by server.</p>
        <p>What a tool returns is added to the conversation and re-sent on every later step until compaction. A single 200 KB command output (roughly 50k tokens) is therefore paid for again and again, which is why the Tools page tracks result sizes rather than call counts alone.</p>
      </section>

      <section id="model-mix" tabIndex={-1}>
        <h2>Choosing the right model</h2>
        <p>
          Larger models cost several times more per token than smaller ones
          {spread && <> (across your priced models, input rates differ by up to <Live>{spread.toFixed(1)}×</Live>)</>}
          . Exploration, search and simple edits rarely need the biggest model; keep it for hard design or debugging work. Subagents that do narrow jobs are good candidates for the smallest model.
        </p>
        <p>The Models page puts calls, average context, cache hit rate and cost side by side so you can see which model your spend actually goes to.</p>
      </section>
    </div>
  );
}
