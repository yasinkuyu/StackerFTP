import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { normalizeRemotePath, sanitizeRelativePath, matchesPattern, formatFileSize, resolveConfiguredLocalPath } from '../src/utils/helpers';

describe('helpers', () => {
  it('normalizeRemotePath collapses slashes and backslashes', () => {
    expect(normalizeRemotePath('\\var\\www//html//')).toBe('/var/www/html/');
  });

  it('sanitizeRelativePath rejects path traversal', () => {
    expect(() => sanitizeRelativePath('../secrets.txt')).toThrow();
    expect(() => sanitizeRelativePath('..\\secrets.txt')).toThrow();
  });

  it('sanitizeRelativePath rejects absolute paths', () => {
    expect(() => sanitizeRelativePath('/etc/passwd')).toThrow();
  });

  it('matchesPattern supports double star', () => {
    expect(matchesPattern('src/utils/helpers.ts', ['**/*.ts'])).toBe(true);
    expect(matchesPattern('src/utils/helpers.ts', ['**/*.js'])).toBe(false);
  });

  it('formatFileSize formats bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1024)).toBe('1 KB');
  });

  it('resolveConfiguredLocalPath resolves relative local paths against workspace root', () => {
    expect(resolveConfiguredLocalPath('/workspace/site', '.vitepress/dist')).toBe(path.resolve('/workspace/site/.vitepress/dist'));
  });

  it('resolveConfiguredLocalPath treats missing root-prefixed paths as workspace-relative', () => {
    expect(resolveConfiguredLocalPath('/workspace/site', '/.vitepress/dist')).toBe(path.resolve('/workspace/site/.vitepress/dist'));
  });
});
