import { expect, test } from 'bun:test';
import { defaultDeps } from '../../src/cli/index';

test('setInterval ticks until cancelled', async () => {
  let ticks = 0;
  const cancel = defaultDeps.setInterval(() => { ticks++; }, 2);
  await new Promise((r) => setTimeout(r, 30));
  cancel();
  const seen = ticks;
  await new Promise((r) => setTimeout(r, 20));
  expect(seen).toBeGreaterThan(0);
  expect(ticks).toBe(seen);
});

test('waitForExit resolves on SIGTERM and SIGINT', async () => {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    const done = defaultDeps.waitForExit();
    process.emit(sig, sig);
    await done;
  }
  expect(defaultDeps.now()).toBeGreaterThan(0);
});
