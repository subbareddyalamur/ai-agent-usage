import { join } from 'node:path';
import { antigravityAdapter } from './lib/antigravity';

export default antigravityAdapter({
  id: 'antigravity-cli',
  label: 'Antigravity CLI',
  root: (home) => join(home, '.gemini', 'antigravity-cli'),
});
