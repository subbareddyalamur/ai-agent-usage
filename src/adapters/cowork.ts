import { join } from 'node:path';
import { asString, hasFile, isObject, listFiles, readJsonSafe } from './kit';
import { ingestClaudeFiles } from './lib/claude-files';
import type { Adapter, DetectResult } from '../core/types';

const isAudit = (p: string): boolean => p.endsWith('/audit.jsonl');
const baseDir = (home: string): string => join(home, 'Library', 'Application Support', 'Claude-3p');
const sessionsDir = (home: string): string => join(baseDir(home), 'local-agent-mode-sessions');

/** The applied config in configLibrary names the AWS profile Cowork uses for Bedrock. */
function awsProfile(home: string): string | undefined {
  const lib = join(baseDir(home), 'configLibrary');
  const meta = readJsonSafe(join(lib, '_meta.json'));
  const id = isObject(meta) ? asString(meta.appliedId) : undefined;
  if (!id) return undefined;
  const cfg = readJsonSafe(join(lib, `${id}.json`));
  return isObject(cfg) ? asString(cfg.inferenceBedrockProfile) : undefined;
}

const adapter: Adapter = {
  id: 'cowork',
  label: 'Claude desktop (Cowork)',

  async detect({ home }): Promise<DetectResult> {
    try {
      const dir = sessionsDir(home);
      return hasFile(dir, isAudit)
        ? { installed: true, detail: dir }
        : { installed: false, detail: `no audit logs under ${dir}` };
    } catch {
      return { installed: false, detail: 'detect failed' };
    }
  },

  async *ingest(ctx) {
    const root = sessionsDir(ctx.home);
    yield* ingestClaudeFiles(ctx, {
      agent: 'cowork',
      root,
      files: listFiles(root, isAudit),
      isSubagent: (rec) => typeof rec.parent_tool_use_id === 'string',
      awsProfileHint: awsProfile(ctx.home),
    });
  },
};

export default adapter;
