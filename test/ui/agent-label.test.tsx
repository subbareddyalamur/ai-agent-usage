import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilterBar } from '../../ui/components/FilterBar';
import { readFilters, toApiQuery } from '../../ui/lib/filters';
import { formatAgent } from '../../ui/lib/format';

describe('agent display names', () => {
  test('labels Pi-Bolt without changing unknown agent IDs', () => {
    expect(formatAgent('pi')).toBe('Pi-Bolt / Pi');
    expect(formatAgent('claude-code')).toBe('claude-code');
  });

  test('the agent filter displays Pi-Bolt but keeps pi as the selected API value', () => {
    const filters = readFilters(new URLSearchParams('range=all&agents=pi'));
    const html = renderToStaticMarkup(<FilterBar filters={filters} options={{ agents: ['pi'], models: ['pi'], projects: [], minTs: null, maxTs: null }} onChange={() => {}} refreshing={false} refreshError={null} lastRefreshAt={null} onRefresh={() => {}} />);
    expect(html).toContain('Pi-Bolt / Pi');
    expect(html).toContain('checked=""');
    expect(new URLSearchParams(toApiQuery(filters, new Date())).get('agents')).toBe('pi');
  });
});
