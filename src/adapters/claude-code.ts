import { join } from 'node:path';
import { asString, hasFile, isObject, listFiles, readJsonSafe } from './kit';
import { ingestClaudeFiles } from './lib/claude-files';
import type { Adapter, DetectResult } from '../core/types';

const isJsonl = (p: string): boolean => p.endsWith('.jsonl');
const projectsDir = (home: string): string => join(home, '.claude', 'projects');

function awsProfile(home: string): string | undefined {
  const settings = readJsonSafe(join(home, '.claude', 'settings.json'));
  const env = isObject(settings) && isObject(settings.env) ? settings.env : undefined;
  return env ? asString(env.AWS_PROFILE) : undefined;
}

const adapter: Adapter = {
  id: 'claude-code',
  label: 'Claude Code',

  async detect({ home }): Promise<DetectResult> {
    try {
      const dir = projectsDir(home);
      return hasFile(dir, isJsonl)
        ? { installed: true, detail: dir }
        : { installed: false, detail: `no transcripts under ${dir}` };
    } catch {
      return { installed: false, detail: 'detect failed' };
    }
  },

  async *ingest(ctx) {
    const root = projectsDir(ctx.home);
    yield* ingestClaudeFiles(ctx, {
      agent: 'claude-code',
      root,
      files: listFiles(root, isJsonl),
      isSubagent: (rec, file) => rec.isSidechain === true || file.includes('/subagents/'),
      awsProfileHint: awsProfile(ctx.home),
    });
  },
};

export default adapter;
