/**
 * StackerFTP - Sync Engine
 *
 * Compare-based sync: scan both sides, build a plan of only the changes that
 * matter, let the user review it, then apply exactly that plan.
 *
 * Change detection: size + modification time (with a protocol-dependent
 * tolerance). Transfers preserve timestamps (stackerftp.preserveTimestamps),
 * so synced files compare as unchanged afterwards. Where the server cannot
 * set times, "newer side wins" still converges because the transferred copy
 * is always newer than its source.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BaseConnection } from './connection';
import { transferManager } from './transfer-manager';
import { FTPConfig, SyncResult } from '../types';
import { matchesPattern, normalizeRemotePath, ALWAYS_IGNORED } from '../utils/helpers';
import { logger } from '../utils/logger';

export type SyncDirection = 'toRemote' | 'toLocal' | 'both';
export type SyncActionType = 'upload' | 'download' | 'deleteRemote' | 'deleteLocal';
export type SyncReason = 'new' | 'changed' | 'newer' | 'conflict' | 'orphan';

export interface FileStamp {
  size: number;
  mtime: number;
}

export interface SyncAction {
  type: SyncActionType;
  reason: SyncReason;
  relativePath: string;
  localPath: string;
  remotePath: string;
  local?: FileStamp;
  remote?: FileStamp;
  /** Pre-selected in the preview. Risky actions (conflicts) are not. */
  recommended: boolean;
  /** Human readable explanation for the preview */
  note: string;
}

export interface SyncPlan {
  direction: SyncDirection;
  localRoot: string;
  remoteRoot: string;
  actions: SyncAction[];
  unchanged: number;
  localCount: number;
  remoteCount: number;
}

export interface ScanResult {
  local: Map<string, FileStamp>;
  remote: Map<string, FileStamp>;
}

/** Never transferred, regardless of user config (credentials, VCS, temp files) */
const MANDATORY_IGNORE = ALWAYS_IGNORED;
/** Used when the connection has no "ignore" list */
const DEFAULT_IGNORE = ['node_modules', '.DS_Store', 'Thumbs.db', '.vscode', '.idea', '__pycache__', '*.pyc'];

export function getIgnorePatterns(config: FTPConfig): string[] {
  const user = Array.isArray(config.ignore) && config.ignore.length > 0 ? config.ignore : DEFAULT_IGNORE;
  return [...MANDATORY_IGNORE, ...user];
}

/** FTP listings often only have minute precision */
export function getTimeTolerance(config: FTPConfig): number {
  return config.protocol === 'sftp' ? 2000 : 60000;
}

export function isSameFile(a: FileStamp, b: FileStamp, toleranceMs: number): boolean {
  return a.size === b.size && Math.abs(a.mtime - b.mtime) <= toleranceMs;
}

async function scanLocal(root: string, ignore: string[], token?: vscode.CancellationToken): Promise<Map<string, FileStamp>> {
  const files = new Map<string, FileStamp>();

  const visited = new Set<string>(); // real paths, guards against symlink loops

  const walk = async (dir: string): Promise<void> => {
    if (token?.isCancellationRequested) return;
    let entries: fs.Dirent[];
    try {
      const real = await fs.promises.realpath(dir);
      if (visited.has(real)) return;
      visited.add(real);
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const subdirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (matchesPattern(rel, ignore)) continue;

      if (entry.isDirectory()) {
        subdirs.push(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          // stat follows symlinks: a linked folder is walked like a folder
          const st = await fs.promises.stat(full);
          if (st.isDirectory()) {
            subdirs.push(full);
          } else if (st.isFile()) {
            files.set(rel, { size: st.size, mtime: st.mtimeMs });
          }
        } catch {
          // Vanished, unreadable or broken link - skip
        }
      }
    }

    for (let i = 0; i < subdirs.length; i += 16) {
      await Promise.all(subdirs.slice(i, i + 16).map(walk));
    }
  };

  if (!fs.existsSync(root)) {
    return files; // Local root does not exist: everything is remote-only
  }

  await walk(root);
  return files;
}

async function scanRemote(
  connection: BaseConnection,
  root: string,
  ignore: string[],
  token?: vscode.CancellationToken
): Promise<Map<string, FileStamp>> {
  const files = new Map<string, FileStamp>();

  const walk = async (dir: string): Promise<void> => {
    if (token?.isCancellationRequested) return;
    let entries;
    try {
      entries = await connection.list(dir);
    } catch (error: any) {
      // Missing remote root is a normal case (first deploy); other errors must surface
      if (dir === root && /no such file|not found|ENOENT|550/i.test(String(error?.message || error))) return;
      throw error;
    }

    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const full = normalizeRemotePath(`${dir}/${entry.name}`);
      const rel = full.substring(normalizeRemotePath(root).length).replace(/^\/+/, '');
      if (matchesPattern(rel, ignore)) continue;

      if (entry.type === 'directory') {
        subdirs.push(full);
      } else if (entry.type === 'file') {
        files.set(rel, { size: entry.size, mtime: entry.modifyTime?.getTime() || 0 });
      }
      // Symlinks are not followed (avoids loops and writing through links)
    }

    for (let i = 0; i < subdirs.length; i += 8) {
      await Promise.all(subdirs.slice(i, i + 8).map(walk));
    }
  };

  await walk(normalizeRemotePath(root));
  return files;
}

export async function scanBothSides(
  connection: BaseConnection,
  config: FTPConfig,
  localRoot: string,
  remoteRoot: string,
  progress?: (message: string) => void,
  token?: vscode.CancellationToken
): Promise<ScanResult> {
  const ignore = getIgnorePatterns(config);
  progress?.('Scanning local files...');
  const local = await scanLocal(localRoot, ignore, token);
  progress?.(`Scanning remote files... (${local.size} local)`);
  const remote = await scanRemote(connection, remoteRoot, ignore, token);
  return { local, remote };
}

/** Scan result for a single file (sync/compare of one file) */
export async function scanSingleFile(
  connection: BaseConnection,
  localFile: string,
  remoteFile: string
): Promise<ScanResult> {
  const name = path.basename(localFile);
  const local = new Map<string, FileStamp>();
  const remote = new Map<string, FileStamp>();
  try {
    const st = await fs.promises.stat(localFile);
    if (st.isFile()) local.set(name, { size: st.size, mtime: st.mtimeMs });
  } catch {
    // Local missing
  }
  const entry = await connection.stat(remoteFile).catch(() => null);
  if (entry && entry.type === 'file') {
    remote.set(name, { size: entry.size, mtime: entry.modifyTime?.getTime() || 0 });
  }
  return { local, remote };
}

function describe(stamp?: FileStamp): string {
  if (!stamp) return '';
  return new Date(stamp.mtime).toLocaleString();
}

/**
 * Decide what to do with every file. deleteOrphans mirrors the source side
 * (syncMode "full"); it is never used for two-way sync since without sync
 * history a missing file cannot be told apart from a new one.
 */
export function buildSyncPlan(
  scan: ScanResult,
  config: FTPConfig,
  localRoot: string,
  remoteRoot: string,
  direction: SyncDirection,
  deleteOrphans: boolean
): SyncPlan {
  const tol = getTimeTolerance(config);
  const actions: SyncAction[] = [];
  let unchanged = 0;

  const toLocalPath = (rel: string) => path.join(localRoot, ...rel.split('/'));
  const toRemotePath = (rel: string) => normalizeRemotePath(`${remoteRoot}/${rel}`);
  const add = (a: Omit<SyncAction, 'localPath' | 'remotePath'>) =>
    actions.push({ ...a, localPath: toLocalPath(a.relativePath), remotePath: toRemotePath(a.relativePath) });

  for (const [rel, local] of scan.local) {
    const remote = scan.remote.get(rel);

    if (!remote) {
      if (direction !== 'toLocal') {
        add({ type: 'upload', reason: 'new', relativePath: rel, local, recommended: true, note: 'New local file' });
      } else if (deleteOrphans) {
        add({ type: 'deleteLocal', reason: 'orphan', relativePath: rel, local, recommended: true, note: 'Not on remote (full sync)' });
      }
      continue;
    }

    if (isSameFile(local, remote, tol)) {
      unchanged++;
      continue;
    }

    const localNewer = local.mtime > remote.mtime + tol;
    const remoteNewer = remote.mtime > local.mtime + tol;
    const sizes = local.size !== remote.size ? ` • local ${local.size} B / remote ${remote.size} B` : '';

    if (direction === 'toRemote') {
      if (remoteNewer) {
        add({ type: 'upload', reason: 'conflict', relativePath: rel, local, remote, recommended: false,
          note: `Remote is newer (${describe(remote)}) – would be overwritten` });
      } else {
        add({ type: 'upload', reason: 'changed', relativePath: rel, local, remote, recommended: true,
          note: `Local changed${sizes}` });
      }
    } else if (direction === 'toLocal') {
      if (localNewer) {
        add({ type: 'download', reason: 'conflict', relativePath: rel, local, remote, recommended: false,
          note: `Local is newer (${describe(local)}) – would be overwritten` });
      } else {
        add({ type: 'download', reason: 'changed', relativePath: rel, local, remote, recommended: true,
          note: `Remote changed${sizes}` });
      }
    } else if (localNewer) {
      add({ type: 'upload', reason: 'newer', relativePath: rel, local, remote, recommended: true, note: 'Local is newer' });
    } else if (remoteNewer) {
      add({ type: 'download', reason: 'newer', relativePath: rel, local, remote, recommended: true, note: 'Remote is newer' });
    } else {
      add({ type: 'upload', reason: 'conflict', relativePath: rel, local, remote, recommended: false,
        note: `Same time, different size (${local.size} vs ${remote.size}) – choose manually` });
    }
  }

  for (const [rel, remote] of scan.remote) {
    if (scan.local.has(rel)) continue;
    if (direction !== 'toRemote') {
      add({ type: 'download', reason: 'new', relativePath: rel, remote, recommended: true, note: 'New remote file' });
    } else if (deleteOrphans) {
      add({ type: 'deleteRemote', reason: 'orphan', relativePath: rel, remote, recommended: true, note: 'Not in local (full sync)' });
    }
  }

  actions.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    direction,
    localRoot,
    remoteRoot,
    actions,
    unchanged,
    localCount: scan.local.size,
    remoteCount: scan.remote.size
  };
}

/**
 * Apply selected actions. Transfers go through the queue (progress, retry and
 * error reporting); overwrite was approved in the preview, so no collision prompts.
 */
export async function applySyncActions(
  connection: BaseConnection,
  config: FTPConfig,
  actions: SyncAction[],
  label: string
): Promise<SyncResult> {
  const result: SyncResult = { uploaded: [], downloaded: [], deleted: [], failed: [], skipped: [] };
  const batchId = `sync-batch-${Date.now()}`;
  const meta = { batchId, groupName: label, groupPath: label };

  transferManager.resetBatchCollision();

  const transfers = actions.filter(a => a.type === 'upload' || a.type === 'download').map(async action => {
    try {
      if (action.type === 'upload') {
        const res = await transferManager.uploadFile(connection, action.localPath, action.remotePath, config, {
          ...meta, size: action.local?.size, targetExists: false, sourceMtime: action.local?.mtime
        });
        (res.status === 'cancelled' ? result.skipped : result.uploaded).push(action.relativePath);
      } else {
        const res = await transferManager.downloadFile(connection, action.remotePath, action.localPath, config, {
          ...meta, size: action.remote?.size, targetExists: false, targetType: 'file', sourceMtime: action.remote?.mtime
        });
        (res.status === 'cancelled' ? result.skipped : result.downloaded).push(action.relativePath);
      }
    } catch (error: any) {
      result.failed.push({ path: action.relativePath, error: error?.message || String(error) });
    }
  });
  await Promise.all(transfers);

  // Deletes run after transfers, one by one
  for (const action of actions) {
    try {
      if (action.type === 'deleteRemote') {
        await connection.delete(action.remotePath);
        result.deleted.push(action.relativePath);
      } else if (action.type === 'deleteLocal') {
        // Local deletes go to the trash so they can be restored
        await vscode.workspace.fs.delete(vscode.Uri.file(action.localPath), { useTrash: true });
        result.deleted.push(action.relativePath);
      }
    } catch (error: any) {
      result.failed.push({ path: action.relativePath, error: error?.message || String(error) });
    }
  }

  logger.info(`Sync applied: ${result.uploaded.length} up, ${result.downloaded.length} down, ` +
    `${result.deleted.length} deleted, ${result.failed.length} failed, ${result.skipped.length} skipped`);
  return result;
}
