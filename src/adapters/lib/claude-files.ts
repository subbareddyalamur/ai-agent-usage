import { getCursor, readNewJsonl, relKey } from '../kit';
import type { Json } from '../kit';
import type { IngestContext, IngestItem } from '../../core/types';
import { parseClaudeRecords } from './claude-format';

export interface ClaudeFilesConfig {
  agent: string;
  root: string;
  files: readonly string[];
  isSubagent: (rec: Json, file: string) => boolean;
  awsProfileHint?: string;
}

/** Incrementally ingests a set of Claude-format transcript files, resuming from saved byte offsets. */
export async function* ingestClaudeFiles(ctx: IngestContext, cfg: ClaudeFilesConfig): AsyncGenerator<IngestItem> {
  for (const file of cfg.files) {
    const key = `f:${relKey(cfg.root, file)}`;
    const prev = getCursor(ctx.state, key);
    let read;
    try {
      read = readNewJsonl(file, prev);
    } catch (error: unknown) {
      ctx.log(`skip ${key}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (read.unchanged) continue;

    const carry = !read.fromStart && prev ? prev : undefined;
    const result = parseClaudeRecords(read.records, {
      agent: cfg.agent,
      isSubagent: (rec) => cfg.isSubagent(rec, file),
      cwd: typeof carry?.cwd === 'string' ? carry.cwd : undefined,
      sessionId: typeof carry?.sessionId === 'string' ? carry.sessionId : undefined,
      awsProfileHint: cfg.awsProfileHint,
    });
    yield* result.items;
    ctx.state.set(key, { ...read.cursor, cwd: result.cwd, sessionId: result.sessionId });
  }
}
