import { join } from 'node:path';
import { antigravityAdapter } from './lib/antigravity';

export default antigravityAdapter({
  id: 'antigravity',
  label: 'Antigravity',
  root: (home) => join(home, '.gemini', 'antigravity'),
});
