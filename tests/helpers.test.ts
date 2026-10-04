import * as path from 'path';
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { normalizeRemotePath, sanitizeRelativePath, matchesPattern, formatFileSize, getLocalRelativePath, getLocalRoot, getLocalPathFromRemote, resolveConfiguredLocalPath } from '../src/utils/helpers';

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

  it('matchesPattern handles folder names and nested files', () => {
    expect(matchesPattern('node_modules/lodash/index.js', ['node_modules'])).toBe(true);
    expect(matchesPattern('vendor/bundle/gems', ['vendor'])).toBe(true);
    expect(matchesPattern('.git/objects/abc', ['.git'])).toBe(true);
    expect(matchesPattern('logs/server.log', ['*.log'])).toBe(true);
    expect(matchesPattern('src/components/App.tsx', ['**/*.tsx'])).toBe(true);
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

  it('formatFileSize formats large bytes', () => {
    expect(formatFileSize(1048576)).toBe('1 MB');
    expect(formatFileSize(1073741824)).toBe('1 GB');
  });

  it('resolveConfiguredLocalPath resolves relative local paths against workspace root', () => {
    expect(resolveConfiguredLocalPath('/workspace/site', '.vitepress/dist')).toBe(path.resolve('/workspace/site/.vitepress/dist'));
  });

  it('resolveConfiguredLocalPath treats missing root-prefixed paths as workspace-relative', () => {
    expect(resolveConfiguredLocalPath('/workspace/site', '/.vitepress/dist')).toBe(path.resolve('/workspace/site/.vitepress/dist'));
  });

  it('resolveConfiguredLocalPath keeps existing absolute paths and expands ~', () => {
    expect(resolveConfiguredLocalPath('/workspace/site', os.tmpdir())).toBe(os.tmpdir());
    expect(resolveConfiguredLocalPath('/workspace/site', '~/projects')).toBe(path.join(os.homedir(), 'projects'));
  });

  it('getLocalRoot accepts localPath as an alias of context (context wins)', () => {
    expect(getLocalRoot('/ws', { localPath: 'dist' })).toBe(path.resolve('/ws/dist'));
    expect(getLocalRoot('/ws', { context: 'www', localPath: 'dist' })).toBe(path.resolve('/ws/www'));
    expect(getLocalRelativePath('/ws', path.resolve('/ws/dist/a/b.js'), { localPath: 'dist' })).toBe(path.join('a', 'b.js'));
    expect(getLocalPathFromRemote('/ws', '/var/www/a.js', { remotePath: '/var/www', localPath: 'dist' })).toBe(path.join(path.resolve('/ws/dist'), 'a.js'));
  });
});
