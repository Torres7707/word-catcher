import manifest from '../public/manifest.json';

describe('manifest privacy claims (ticket #10)', () => {
  it('asks only for storage up front; gateway access stays optional', () => {
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest).not.toHaveProperty('host_permissions');
  });
  it('the description says AI is optional and no longer claims there is no network', () => {
    expect(manifest.description).toContain('AI');
    expect(manifest.description).toContain('可选');
    expect(manifest.description).not.toContain('无网络');
  });
  it('the description fits the Chrome Web Store limit of 132 characters', () => {
    expect([...manifest.description].length).toBeLessThanOrEqual(132);
  });
});
