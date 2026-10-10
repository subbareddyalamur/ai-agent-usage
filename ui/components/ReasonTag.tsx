import type { MissReason } from '../../src/core/api-types';
import { REASON_HINT, REASON_LABEL } from '../lib/cache';

export function ReasonTag({ reason, avoidable }: { reason: MissReason; avoidable: boolean }) {
  return (
    <span className={`reason ${avoidable ? 'avoidable' : 'unavoidable'}`} title={`${REASON_HINT[reason]} ${avoidable ? 'Avoidable.' : 'Normally unavoidable.'}`}>
      {REASON_LABEL[reason]}
    </span>
  );
}
