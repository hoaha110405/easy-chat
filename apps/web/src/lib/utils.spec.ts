import { describe, it, expect } from 'vitest';
import { safeUrl } from './utils';
describe('external attachment URLs', () => {
  it('allows web attachments and rejects script, data and relative URLs', () => {
    expect(safeUrl('https://example.com/test.pdf')).toBe(
      'https://example.com/test.pdf',
    );
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,hello',
      '/private',
      null,
      '',
    ])
      expect(safeUrl(value)).toBeUndefined();
  });
});
