import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));
vi.mock('../src/core/transfer-manager', () => ({ transferManager: {} }));
vi.mock('../src/utils/logger', () => ({ logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import { buildSyncPlan, getIgnorePatterns, ScanResult, FileStamp } from '../src/core/sync-engine';
import { matchesPattern } from '../src/utils/helpers';
import { FTPConfig } from '../src/types';

const sftp: FTPConfig = { host: 'h', protocol: 'sftp', username: 'u', remotePath: '/var/www' };
const T = 1_700_000_000_000;

function scan(local: Record<string, FileStamp>, remote: Record<string, FileStamp>): ScanResult {
  return { local: new Map(Object.entries(local)), remote: new Map(Object.entries(remote)) };
}

function plan(s: ScanResult, direction: 'toRemote' | 'toLocal' | 'both', deleteOrphans = false, config = sftp) {
  return buildSyncPlan(s, config, '/proj', '/var/www', direction, deleteOrphans);
}

describe('buildSyncPlan', () => {
  it('treats same size and time (within tolerance) as unchanged', () => {
    const p = plan(scan({ 'a.php': { size: 10, mtime: T } }, { 'a.php': { size: 10, mtime: T + 1500 } }), 'toRemote');
    expect(p.actions).toHaveLength(0);
    expect(p.unchanged).toBe(1);
  });

  it('uses minute tolerance for FTP listings', () => {
    const ftp: FTPConfig = { ...sftp, protocol: 'ftp' };
    const p = plan(scan({ 'a': { size: 1, mtime: T } }, { 'a': { size: 1, mtime: T + 45_000 } }), 'toRemote', false, ftp);
    expect(p.actions).toHaveLength(0);
  });

  it('toRemote: uploads new and changed files, maps paths', () => {
    const p = plan(scan(
      { 'new.php': { size: 1, mtime: T }, 'sub/changed.css': { size: 5, mtime: T + 60_000 } },
      { 'sub/changed.css': { size: 4, mtime: T } }
    ), 'toRemote');
    expect(p.actions.map(a => [a.type, a.reason, a.relativePath, a.recommended])).toEqual([
      ['upload', 'new', 'new.php', true],
      ['upload', 'changed', 'sub/changed.css', true]
    ]);
    expect(p.actions[1].remotePath).toBe('/var/www/sub/changed.css');
  });

  it('toRemote: newer remote file is a conflict and not pre-selected', () => {
    const p = plan(scan({ 'a': { size: 1, mtime: T } }, { 'a': { size: 2, mtime: T + 600_000 } }), 'toRemote');
    expect(p.actions[0]).toMatchObject({ type: 'upload', reason: 'conflict', recommended: false });
  });

  it('toRemote: remote-only files are kept unless full sync', () => {
    const s = scan({}, { 'old.php': { size: 1, mtime: T } });
    expect(plan(s, 'toRemote').actions).toHaveLength(0);
    expect(plan(s, 'toRemote', true).actions[0]).toMatchObject({ type: 'deleteRemote', reason: 'orphan' });
  });

  it('toLocal: downloads new/changed, local-only deleted only in full sync', () => {
    const s = scan(
      { 'local-only': { size: 1, mtime: T }, 'x': { size: 1, mtime: T } },
      { 'remote-only': { size: 1, mtime: T }, 'x': { size: 3, mtime: T + 60_000 } }
    );
    expect(plan(s, 'toLocal').actions.map(a => [a.type, a.relativePath])).toEqual([
      ['download', 'remote-only'],
      ['download', 'x']
    ]);
    expect(plan(s, 'toLocal', true).actions.some(a => a.type === 'deleteLocal' && a.relativePath === 'local-only')).toBe(true);
  });

  it('both: newer side wins, new files go both ways, never deletes', () => {
    const p = plan(scan(
      { 'l': { size: 1, mtime: T }, 'up': { size: 1, mtime: T + 60_000 }, 'down': { size: 1, mtime: T } },
      { 'r': { size: 1, mtime: T }, 'up': { size: 2, mtime: T }, 'down': { size: 2, mtime: T + 60_000 } }
    ), 'both', true);
    const byPath = Object.fromEntries(p.actions.map(a => [a.relativePath, a.type]));
    expect(byPath).toEqual({ l: 'upload', r: 'download', up: 'upload', down: 'download' });
  });

  it('both: same time but different size needs a manual decision', () => {
    const p = plan(scan({ 'a': { size: 1, mtime: T } }, { 'a': { size: 2, mtime: T } }), 'both');
    expect(p.actions[0]).toMatchObject({ reason: 'conflict', recommended: false });
  });
});

describe('getIgnorePatterns', () => {
  it('always excludes credentials and VCS, even with a custom ignore list', () => {
    const patterns = getIgnorePatterns({ ...sftp, ignore: ['dist'] });
    expect(matchesPattern('.vscode/sftp.json', patterns)).toBe(true);
    expect(matchesPattern('.git/config', patterns)).toBe(true);
    expect(matchesPattern('dist/app.js', patterns)).toBe(true);
    expect(matchesPattern('node_modules/x/index.js', patterns)).toBe(false);
  });

  it('uses defaults when no ignore list is configured', () => {
    expect(matchesPattern('node_modules/x/index.js', getIgnorePatterns(sftp))).toBe(true);
    expect(matchesPattern('src/index.php', getIgnorePatterns(sftp))).toBe(false);
  });
});
