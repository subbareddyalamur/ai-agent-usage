import type { CostSourceShare } from '../../src/core/api-types';
import { dominantSource, SOURCE_INFO, sourceKey, sourceTooltip, type SourceKey } from '../lib/priceSource';

export function SourceTag({ source, extra, title }: { source: SourceKey; extra?: number; title?: string }) {
  const info = SOURCE_INFO[source];
  return (
    <span className={`tag source ${info.tone}`} title={title ?? info.explain} aria-label={`Price source: ${info.label}${extra ? `, plus ${extra} more` : ''}`}>
      <span aria-hidden="true">{info.glyph}</span> {info.label}
      {extra ? <span className="muted"> +{extra}</span> : null}
    </span>
  );
}

/** Dominant source of a model with "+N" when other sources contributed; tooltip lists all of them. */
export function ModelSourceBadge({ shares }: { shares: readonly CostSourceShare[] }) {
  const { main, others } = dominantSource(shares);
  if (!main) return <span className="muted">–</span>;
  return <SourceTag source={sourceKey(main.source)} extra={others.length} title={others.length > 0 ? sourceTooltip(shares) : undefined} />;
}
