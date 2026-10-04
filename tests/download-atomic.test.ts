import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { downloadAtomically, DOWNLOAD_TEMP_SUFFIX, isTransferTempFile } from '../src/utils/helpers';

describe('downloadAtomically', () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackerftp-test-'));
    target = path.join(dir, 'index.php');
    fs.writeFileSync(target, 'original content');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the existing file intact when the download fails midway', async () => {
    await expect(downloadAtomically(target, async tempPath => {
      fs.writeFileSync(tempPath, 'partial');
      throw new Error('Connection lost');
    })).rejects.toThrow('Connection lost');

    expect(fs.readFileSync(target, 'utf8')).toBe('original content');
    expect(fs.existsSync(target + DOWNLOAD_TEMP_SUFFIX)).toBe(false);
  });

  it('replaces the file only after a complete download and keeps its permissions', async () => {
    fs.chmodSync(target, 0o755);
    await downloadAtomically(target, async tempPath => {
      fs.writeFileSync(tempPath, 'new content');
    });

    expect(fs.readFileSync(target, 'utf8')).toBe('new content');
    expect(fs.existsSync(target + DOWNLOAD_TEMP_SUFFIX)).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    }
  });

  it('creates new files', async () => {
    const fresh = path.join(dir, 'new.txt');
    await downloadAtomically(fresh, async tempPath => fs.writeFileSync(tempPath, 'x'));
    expect(fs.readFileSync(fresh, 'utf8')).toBe('x');
  });

  it('recognises in-progress transfer files', () => {
    expect(isTransferTempFile('/a/b.php' + DOWNLOAD_TEMP_SUFFIX)).toBe(true);
    expect(isTransferTempFile('/a/b.php.stackerftp.tmp')).toBe(true);
    expect(isTransferTempFile('/a/b.php')).toBe(false);
  });
});
