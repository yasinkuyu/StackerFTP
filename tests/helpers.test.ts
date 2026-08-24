import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { normalizeRemotePath, sanitizeRelativePath, matchesPattern, formatFileSize, getLocalRelativePath, getLocalRoot, getLocalPathFromRemote } from '../src/utils/helpers';

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
  it('getLocalRoot returns context dir if provided', () => {
    expect(getLocalRoot('/workspace', { context: 'out' })).toBe(path.resolve('/workspace', 'out'));
    expect(getLocalRoot('/workspace', {})).toBe('/workspace');
  });

  it('getLocalRelativePath strips context folder when inside context', () => {
    const ws = path.resolve('/workspace');
    const outDir = path.resolve(ws, 'out');
    const targetFile = path.resolve(outDir, 'index.html');
    const subFile = path.resolve(outDir, 'assets/main.js');
    const outsideFile = path.resolve(ws, 'src/app.ts');

    expect(getLocalRelativePath(ws, targetFile, { context: 'out' })).toBe('index.html');
    expect(getLocalRelativePath(ws, subFile, { context: 'out' })).toBe(path.join('assets', 'main.js'));
    expect(getLocalRelativePath(ws, outDir, { context: 'out' })).toBe('');
    expect(getLocalRelativePath(ws, outsideFile, { context: 'out' })).toBe(path.join('src', 'app.ts'));
  });

  it('getLocalPathFromRemote maps remote file back to context dir', () => {
    const ws = path.resolve('/workspace');
    const expected = path.resolve(ws, 'out/index.html');
    expect(getLocalPathFromRemote(ws, '/index.html', { remotePath: '/', context: 'out' })).toBe(expected);
  });
});
