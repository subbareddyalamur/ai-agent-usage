import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAdapters } from '../../src/core/registry';

test('discovers valid adapters, reports broken ones, ignores kit/tests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapters-'));
  writeFileSync(join(dir, 'good.ts'), `export default { id: 'good', label: 'Good', detect: async () => ({ installed: false }), ingest: async function* () {} };`);
  writeFileSync(join(dir, 'bad.ts'), `export default { nope: true };`);
  writeFileSync(join(dir, 'throws.ts'), `throw new Error('load failure');`);
  writeFileSync(join(dir, 'kit.ts'), `export const x = 1;`);
  writeFileSync(join(dir, 'good.test.ts'), `throw new Error('must not load');`);
  const { adapters, problems } = await discoverAdapters(dir);
  expect(adapters.map((a) => a.id)).toEqual(['good']);
  expect(problems.length).toBe(2);
});
