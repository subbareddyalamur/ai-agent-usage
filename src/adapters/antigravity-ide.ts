import { join } from 'node:path';
import { antigravityAdapter } from './lib/antigravity';

export default antigravityAdapter({
  id: 'antigravity-ide',
  label: 'Antigravity IDE',
  root: (home) => join(home, '.gemini', 'antigravity-ide'),
});
