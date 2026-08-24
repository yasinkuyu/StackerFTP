/**
 * StackerFTP - Transfer Manager
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BaseConnection } from './connection';
import { connectionManager } from './connection-manager';
import { TransferItem, SyncResult, FTPConfig, TransferBatchInfo } from '../types';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';
import { generateId, normalizeRemotePath, matchesPattern } from '../utils/helpers';
import { EventEmitter } from 'stream';

export interface TransferProgress {
  completed: number;
  total: number;
  currentFile?: string;
  percentage: number;
}

export class TransferManager extends EventEmitter implements vscode.Disposable {
  private queue: TransferItem[] = [];
  private active = false;
  private isProcessing = false;
  private cancelled = false;
  private currentItem?: TransferItem;
  private sessionCollisionAction: 'ask' | 'overwrite' | 'skip' = 'ask';
  private batchCollisionAction: 'ask' | 'overwrite' | 'skip' = 'ask';
  private collisionLock: Promise<void> = Promise.resolve();
  private queueUpdateTimeout: NodeJS.Timeout | undefined;
  private _activeCount = 0;
  private completionResolve: (() => void) | null = null;
  private static readonly TRANSFER_TIMEOUT_MS = 180000; // 3 minutes safeguard against stalled transfers


  private emitQueueUpdate(): void {
    if (this.queueUpdateTimeout) return;
    this.queueUpdateTimeout = setTimeout(() => {
      this.emit('queueUpdate', this.queue);
      this.queueUpdateTimeout = undefined;
    }, 150); // 150ms debounce for UI stability
  }

  private withTransferTimeout<T>(promise: Promise<T>, ms: number, context: string): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;

    return new Promise<T>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        const err = new Error(`Transfer timeout after ${Math.round(ms / 1000)}s (${context})`);
        (err as any).code = 'TRANSFER_TIMEOUT';
        reject(err);
      }, ms);

      promise.then(
        value => resolve(value),
        error => reject(error)
      ).finally(() => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      });
    });
  }

  private async handleCollision(targetPath: string, type: 'local' | 'remote', isDir = false): Promise<'overwrite' | 'skip' | 'cancel'> {
    if (this.cancelled) return 'cancel';

    // 1. Check persistent configuration setting in VS Code Settings
    const configuredBehavior = vscode.workspace.getConfiguration('stackerftp').get<string>('overwriteBehavior', 'ask');
    if (configuredBehavior === 'always' || configuredBehavior === 'overwrite') {
      return 'overwrite';
    }
    if (configuredBehavior === 'skip') {
      return 'skip';
    }

    // 2. Check session-level action (set ONLY if user clicked "Always Overwrite")
    if (this.sessionCollisionAction === 'overwrite') return 'overwrite';
    if (this.sessionCollisionAction === 'skip') return 'skip';

    // 3. Check batch-level action (set if user clicked "Overwrite All" or "Skip All" in this batch)
    if (this.batchCollisionAction === 'overwrite') return 'overwrite';
    if (this.batchCollisionAction === 'skip') return 'skip';

    // Correctly serialize modal dialogs using a promise chain lock
    const currentLock = this.collisionLock;
    let resolveNext: () => void;
    this.collisionLock = new Promise(resolve => {
      resolveNext = resolve;
    });

    await currentLock;
    logger.debug(`Checking collision for: ${targetPath}`);

    try {
      if (this.cancelled) return 'cancel';

      // Re-check after acquiring lock in case it was set by another worker in the same batch/session
      const sessionAction = this.sessionCollisionAction as 'ask' | 'overwrite' | 'skip';
      const batchAction = this.batchCollisionAction as 'ask' | 'overwrite' | 'skip';
      if (sessionAction === 'overwrite' || batchAction === 'overwrite') return 'overwrite';
      if (sessionAction === 'skip' || batchAction === 'skip') return 'skip';

      const location = type === 'local' ? 'Local' : 'Remote';
      const kind = isDir ? 'directory' : 'file';
      const message = `${location} ${kind} already exists at "${targetPath}". Would you like to overwrite it?`;

      // Show modal dialog (VS Code modal automatically adds the native Cancel button)
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        'Overwrite All', 'Overwrite', 'Skip All', 'Skip', 'Always Overwrite'
      );

      logger.debug(`Collision choice for ${targetPath}: ${choice}`);

      if (choice === 'Always Overwrite') {
        this.sessionCollisionAction = 'overwrite';
        this.batchCollisionAction = 'overwrite';
        statusBar.info('Overwrite mode set to "Always Overwrite" for current session');
        return 'overwrite';
      } else if (choice === 'Overwrite All') {
        this.batchCollisionAction = 'overwrite';
        return 'overwrite';
      } else if (choice === 'Overwrite') {
        return 'overwrite';
      } else if (choice === 'Skip All') {
        this.batchCollisionAction = 'skip';
        return 'skip';
      } else if (choice === 'Skip') {
        return 'skip';
      } else {
        // User pressed 'Cancel', clicked Esc, or closed the modal dialog
        this.cancelled = true;
        this.cancel();
        statusBar.info('Transfer cancelled');
        return 'cancel';
      }
    } finally {
      resolveNext!();
    }
  }

  async uploadFile(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    config: FTPConfig,
    metadata?: {
      size?: number;
      targetExists?: boolean;
      targetType?: 'file' | 'directory' | 'symlink';
      batchId?: string;
      groupName?: string;
      groupPath?: string;
    }
  ): Promise<TransferItem> {
    return new Promise((resolve, reject) => {
      this.cancelled = false;
      const item: TransferItem = {
        id: generateId(),
        localPath,
        remotePath,
        direction: 'upload',
        status: 'pending',
        progress: 0,
        size: metadata?.size || 0,
        transferred: 0,
        config,
        resolve: () => resolve(item),
        reject,
        targetExists: metadata?.targetExists,
        targetType: metadata?.targetType,
        batchId: metadata?.batchId,
        groupName: metadata?.groupName,
        groupPath: metadata?.groupPath
      };

      this.queue.push(item);
      this._activeCount++;
      this.emitQueueUpdate();

      if (!this.active) {
        this.processQueue();
      }
    });
  }

  async downloadFile(
    connection: BaseConnection,
    remotePath: string,
    localPath: string,
    config?: FTPConfig,
    metadata?: {
      size?: number;
      targetExists?: boolean;
      targetType?: 'file' | 'directory' | 'symlink';
      batchId?: string;
      groupName?: string;
      groupPath?: string;
    }
  ): Promise<TransferItem> {
    return new Promise((resolve, reject) => {
      this.cancelled = false;
      const item: TransferItem = {
        id: generateId(),
        localPath,
        remotePath,
        direction: 'download',
        status: 'pending',
        progress: 0,
        size: metadata?.size || 0,
        transferred: 0,
        config: config || connection.getConfig(),
        resolve: () => resolve(item),
        reject,
        targetExists: metadata?.targetExists,
        targetType: metadata?.targetType,
        batchId: metadata?.batchId,
        groupName: metadata?.groupName,
        groupPath: metadata?.groupPath
      };

      this.queue.push(item);
      this._activeCount++;
      this.emitQueueUpdate();

      if (!this.active) {
        this.processQueue();
      }
    });
  }

  /**
   * Process the transfer queue using per-item connections.
   * Each item stores its own config, ensuring transfers go to the correct server.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;
    this.active = true;
    this.cancelled = false;

    const concurrency = vscode.workspace.getConfiguration('stackerftp').get<number>('transferConcurrency', 4);
    let activeTransfers = 0;

    const processNext = async () => {
      if (this.cancelled) return;

      const item = this.queue.find(i => i.status === 'pending');
      if (!item) return;

      item.status = 'transferring';
      item.startTime = new Date();
      activeTransfers++;
      this.emit('transferStart', item);

      let pooledConnection: BaseConnection | undefined;
      let timedOut = false;
      try {
        if (!item.config) {
          throw new Error('Transfer item missing config - cannot determine target server');
        }

        // Acquire a pooled connection for parallel transfers
        pooledConnection = await connectionManager.getPooledConnection(item.config);
        const connection = pooledConnection;

        if (item.direction === 'upload') {
          // Fill missing local size lazily to keep queueing fast for large folders.
          if (!item.size || item.size <= 0) {
            try {
              const localStat = await fs.promises.stat(item.localPath);
              item.size = localStat.size;
            } catch {
              // Size is optional for queue display; transfer can continue.
            }
          }

          // Optimization: Bypass stat if metadata provided or session/batch already set to overwrite
          let exists = item.targetExists;
          let targetType = item.targetType;

          const shouldCheckCollision =
            this.sessionCollisionAction !== 'overwrite' &&
            this.batchCollisionAction !== 'overwrite';

          if (exists === undefined && shouldCheckCollision) {
            try {
              const remoteStat = await connection.stat(item.remotePath);
              exists = !!remoteStat;
              targetType = remoteStat?.type;
            } catch {
              exists = false;
            }
          }

          if (exists && shouldCheckCollision) {
            const action = await this.handleCollision(item.remotePath, 'remote', targetType === 'directory');
            if (action === 'cancel' || this.cancelled) {
              item.status = 'cancelled';
              if ((item as any).resolve) (item as any).resolve(item);
              return;
            }
            if (action === 'skip') {
              item.status = 'cancelled';
              item.error = undefined;
              item.progress = 100;
              logger.info(`Skipped existing remote target: ${item.remotePath}`);
              if ((item as any).resolve) (item as any).resolve(item);
              return;
            }
            if (targetType === 'directory') {
              await connection.rmdir(item.remotePath, true);
            }
          }

          await this.withTransferTimeout(
            connection.upload(item.localPath, item.remotePath),
            TransferManager.TRANSFER_TIMEOUT_MS,
            `upload ${path.basename(item.localPath)}`
          );
        } else {
          // Optimization: Bypass stat if metadata provided or session/batch already set to overwrite
          let exists = item.targetExists;
          let targetType = item.targetType;

          const shouldCheckCollision =
            this.sessionCollisionAction !== 'overwrite' &&
            this.batchCollisionAction !== 'overwrite';

          if (exists === undefined && shouldCheckCollision) {
            try {
              const stats = await fs.promises.stat(item.localPath);
              exists = true;
              targetType = stats.isDirectory() ? 'directory' : 'file';
            } catch {
              exists = false;
            }
          }

          if (exists && shouldCheckCollision) {
            const action = await this.handleCollision(item.localPath, 'local', targetType === 'directory');
            if (action === 'cancel' || this.cancelled) {
              item.status = 'cancelled';
              if ((item as any).resolve) (item as any).resolve(item);
              return;
            }
            if (action === 'skip') {
              item.status = 'cancelled';
              item.error = undefined;
              item.progress = 100;
              logger.info(`Skipped existing local target: ${item.localPath}`);
              if ((item as any).resolve) (item as any).resolve(item);
              return;
            }
            if (targetType === 'directory') {
              await fs.promises.rm(item.localPath, { recursive: true, force: true });
            }
          }

          // Optimization: Skip remote stat if we already know it's a file from scanning
          if (item.targetExists === undefined) {
            try {
              const remoteStat = await connection.stat(item.remotePath);
              if (remoteStat && remoteStat.type === 'directory') {
                throw new Error('Cannot download a directory as a file. Please use Download Folder.');
              }
            } catch (e: any) {
              if (e.message.includes('directory')) throw e;
            }
          }

          await this.withTransferTimeout(
            connection.download(item.remotePath, item.localPath),
            TransferManager.TRANSFER_TIMEOUT_MS,
            `download ${path.basename(item.remotePath)}`
          );
        }

        item.status = 'completed';
        item.progress = 100;
        if ((item as any).resolve) (item as any).resolve();
      } catch (error: any) {
        if (error?.code === 'TRANSFER_TIMEOUT' || String(error?.message || '').includes('Transfer timeout')) {
          timedOut = true;
        }
        item.status = 'error';
        item.error = error.message;
        logger.error(`Transfer failed: ${item.remotePath}`, error);
        if ((item as any).reject) (item as any).reject(error);
      } finally {
        if (timedOut && pooledConnection && item.config) {
          const primary = connectionManager.getConnection(item.config);
          const isPrimary = primary === pooledConnection;
          if (!isPrimary) {
            try {
              await pooledConnection.disconnect();
            } catch (disconnectError) {
              logger.warn(`Failed to disconnect timed-out pooled connection for ${item.config.host}`, disconnectError);
            }
          }
        }
        // Release pooled connection back to pool
        if (pooledConnection && item.config) {
          connectionManager.releasePooledConnection(item.config, pooledConnection);
        }
        item.endTime = new Date();
        activeTransfers--;
        if ((item.status === 'completed' || item.status === 'error') && this._activeCount > 0) {
          this._activeCount--;
        }
        this.emit('transferComplete', item);
        this.emitQueueUpdate();

        // Spawn workers up to concurrency for pending items
        if (!this.cancelled) {
          const pendingCount = this.queue.filter(i => i.status === 'pending').length;
          if (pendingCount > 0) {
            const slotsAvailable = concurrency - activeTransfers;
            const toSpawn = Math.min(pendingCount, slotsAvailable);
            for (let i = 0; i < toSpawn; i++) {
              processNext().catch(() => {});
            }
          } else if (activeTransfers === 0 && this.completionResolve) {
            this.completionResolve();
            this.completionResolve = null;
          }
        }
      }
    };

    try {
      // Start initial batch
      const initialPromises = [];
      const count = Math.min(concurrency, this.queue.filter(i => i.status === 'pending').length);

      for (let i = 0; i < count; i++) {
        initialPromises.push(processNext());
      }

      await Promise.all(initialPromises);

      // Wait for any remaining in-flight transfers to complete
      if (activeTransfers > 0 || this.queue.some(i => i.status === 'pending')) {
        await new Promise<void>(resolve => {
          this.completionResolve = resolve;
        });
      }

    } finally {
      this.isProcessing = false;
      this.active = false;
      this.batchCollisionAction = 'ask';
      this.emit('queueComplete');
    }
  }

  async uploadDirectory(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    config: FTPConfig
  ): Promise<SyncResult> {
    this.cancelled = false;
    this.batchCollisionAction = 'ask';
    this.collisionLock = Promise.resolve();
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      failed: [],
      skipped: []
    };

    statusBar.info(`Scanning local files: ${path.basename(localPath)}...`);
    const files = await this.getLocalFiles(localPath);
    if (files.length === 0) {
      statusBar.info('No files found to upload');
      return result;
    }

    const batchId = `upload-batch-${generateId()}`;
    const groupName = path.basename(localPath);
    const groupPath = localPath;

    this.batchCollisionAction = 'ask';
    statusBar.info(`Adding ${files.length} files to queue...`);

    const filePromises = files.map(async (file) => {
      if (this.cancelled) return;

      const relativePath = path.relative(localPath, file);
      const remoteFilePath = normalizeRemotePath(path.join(remotePath, relativePath));

      if (config.ignore && matchesPattern(relativePath, config.ignore)) {
        result.skipped.push(relativePath);
        return;
      }

      try {
        // Existence/collision checks are done lazily in processQueue.
        const transferRes = await this.uploadFile(connection, file, remoteFilePath, config, {
          batchId,
          groupName,
          groupPath
        });
        if (transferRes.status === 'cancelled') {
          result.skipped.push(relativePath);
        } else {
          result.uploaded.push(relativePath);
        }
      } catch (error: any) {
        logger.error(`Upload failed for ${relativePath}:`, error);
        result.failed.push({ path: relativePath, error: error.message });
      }
    });

    // Wait for all queued items to complete
    await Promise.all(filePromises);

    logger.info(`Upload directory complete: ${result.uploaded.length} uploaded, ${result.failed.length} failed, ${result.skipped.length} skipped`);
    return result;
  }

  async downloadDirectory(
    connection: BaseConnection,
    remotePath: string,
    localPath: string,
    config: FTPConfig
  ): Promise<SyncResult> {
    this.cancelled = false;
    this.batchCollisionAction = 'ask';
    this.collisionLock = Promise.resolve();
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      failed: [],
      skipped: []
    };

    statusBar.info(`Scanning remote files: ${path.basename(remotePath)}...`);
    const files = await this.getRemoteFiles(connection, remotePath);
    if (files.length === 0) {
      statusBar.info('No files found to download');
      return result;
    }

    const batchId = `download-batch-${generateId()}`;
    const groupName = path.basename(remotePath) || 'root';
    const groupPath = localPath;

    this.batchCollisionAction = 'ask';

    // Process directory creation first
    statusBar.info(`Creating directory structure...`);
    for (const file of files) {
      if (file.type === 'directory' || file.isSymlinkToDirectory) {
        const relativePath = path.relative(remotePath, file.path);
        const localFilePath = path.join(localPath, relativePath);
        try {
          await fs.promises.mkdir(localFilePath, { recursive: true });
        } catch (error: any) {
          result.failed.push({ path: relativePath, error: error.message });
        }
      }
    }

    const dataFiles = files.filter(f => f.type !== 'directory' && !f.isSymlinkToDirectory);
    statusBar.info(`Adding ${dataFiles.length} files to queue...`);

    const filePromises = dataFiles.map(async (file) => {
      if (this.cancelled) return;

      const relativePath = path.relative(remotePath, file.path);
      const localFilePath = path.join(localPath, relativePath);

      if (config.ignore && matchesPattern(relativePath, config.ignore)) {
        result.skipped.push(relativePath);
        return;
      }

      try {
        // Bypass redundant stat calls by passing known remote and local metadata
        const transferRes = await this.downloadFile(connection, file.path, localFilePath, config, {
          size: file.size,
          targetType: 'file',
          batchId,
          groupName,
          groupPath
        });
        if (transferRes.status === 'cancelled') {
          result.skipped.push(relativePath);
        } else {
          result.downloaded.push(relativePath);
        }
      } catch (error: any) {
        result.failed.push({ path: relativePath, error: error.message });
      }
    });

    await Promise.all(filePromises);
    return result;
  }

  async syncToRemote(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    config: FTPConfig
  ): Promise<SyncResult> {
    return this.uploadDirectory(connection, localPath, remotePath, config);
  }

  async syncToLocal(
    connection: BaseConnection,
    remotePath: string,
    localPath: string,
    config: FTPConfig
  ): Promise<SyncResult> {
    return this.downloadDirectory(connection, remotePath, localPath, config);
  }

  async syncBothWays(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    config: FTPConfig
  ): Promise<SyncResult> {
    // First download from remote
    const downloadResult = await this.downloadDirectory(connection, remotePath, localPath, config);

    // Then upload to remote
    const uploadResult = await this.uploadDirectory(connection, localPath, remotePath, config);

    return {
      uploaded: uploadResult.uploaded,
      downloaded: downloadResult.downloaded,
      deleted: [...downloadResult.deleted, ...uploadResult.deleted],
      failed: [...downloadResult.failed, ...uploadResult.failed],
      skipped: [...downloadResult.skipped, ...uploadResult.skipped]
    };
  }

  private async getLocalFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    const MAX_FILES = 100000;
    const MAX_DEPTH = 50;

    const traverse = async (currentDir: string, depth: number) => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;

      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      const subdirs: string[] = [];

      for (const entry of entries) {
        if (files.length >= MAX_FILES) break;
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          subdirs.push(fullPath);
        } else {
          files.push(fullPath);
        }
      }

      // Process subdirectories in parallel batches of 25
      for (let i = 0; i < subdirs.length; i += 25) {
        const batch = subdirs.slice(i, i + 25);
        await Promise.all(batch.map(d => traverse(d, depth + 1)));
      }
    };

    await traverse(dir, 0);
    return files;
  }

  private async getRemoteFiles(connection: BaseConnection, remotePath: string): Promise<any[]> {
    const files: any[] = [];
    const MAX_FILES = 100000;
    const MAX_DEPTH = 50;

    const traverse = async (currentPath: string, depth: number) => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;

      const entries = await connection.list(currentPath);
      const subdirs: string[] = [];

      for (const entry of entries) {
        if (files.length >= MAX_FILES) break;
        const fullPath = normalizeRemotePath(path.join(currentPath, entry.name));

        if (entry.type === 'directory') {
          files.push({ ...entry, path: fullPath });
          subdirs.push(fullPath);
        } else {
          files.push({ ...entry, path: fullPath });
        }
      }

      // Process remote subdirectories in parallel batches of 25
      for (let i = 0; i < subdirs.length; i += 25) {
        const batch = subdirs.slice(i, i + 25);
        await Promise.all(batch.map(d => traverse(d, depth + 1)));
      }
    };

    await traverse(remotePath, 0);
    return files;
  }

    public resetCollisionBehavior(): void {
    this.sessionCollisionAction = 'ask';
    this.batchCollisionAction = 'ask';
    this.cancelled = false;
    this.collisionLock = Promise.resolve();
    statusBar.info('Overwrite & collision confirmation settings have been reset to default.');
  }

  public resetBatchCollision(): void {
    this.batchCollisionAction = 'ask';
    this.cancelled = false;
    this.collisionLock = Promise.resolve();
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    this._activeCount = 0;
    this.collisionLock = Promise.resolve();
    if (this.completionResolve) {
      this.completionResolve();
      this.completionResolve = null;
    }
    this.emitQueueUpdate();
  }

  /**
   * Cancel a specific transfer by ID
   */
  cancelItem(id: string): void {
    const index = this.queue.findIndex(item => item.id === id);
    if (index !== -1) {
      if (this.queue[index].status === 'pending' || this.queue[index].status === 'transferring') {
        this._activeCount--;
      }
      this.queue[index].status = 'error';
      this.queue[index].error = 'Cancelled by user';
      this.queue.splice(index, 1);
      this.emitQueueUpdate();
    }
  }

  /**
   * Cancel all transfers belonging to a specific batch
   */
  cancelBatch(batchId: string): void {
    const itemsToCancel = this.queue.filter(item => item.batchId === batchId);
    for (const item of itemsToCancel) {
      if (item.status === 'pending' || item.status === 'transferring') {
        this._activeCount--;
      }
      item.status = 'error';
      item.error = 'Cancelled by user';
    }
    this.queue = this.queue.filter(item => item.batchId !== batchId);
    this.emitQueueUpdate();
  }

  /**
   * Retry all failed items belonging to a specific batch
   */
  retryBatch(batchId: string): number {
    const failedIds = this.queue
      .filter(item => item.batchId === batchId && item.status === 'error')
      .map(item => item.id);
    return this.retryItems(failedIds);
  }

  /**
   * Retry failed transfers by resetting them back to pending state.
   * Returns the number of transfers that were re-queued.
   */
  retryItems(ids: string[]): number {
    let retriedCount = 0;

    for (const id of ids) {
      const item = this.queue.find(queueItem => queueItem.id === id);
      if (!item || item.status !== 'error') {
        continue;
      }

      item.status = 'pending';
      item.progress = 0;
      item.transferred = 0;
      item.error = undefined;
      item.startTime = undefined;
      item.endTime = undefined;
      item.resolve = undefined;
      item.reject = undefined;
      retriedCount++;
      this._activeCount++;
    }

    if (retriedCount > 0) {
      this.emitQueueUpdate();

      if (!this.active) {
        this.processQueue().catch(() => {});
      }
    }

    return retriedCount;
  }

  /**
   * Clear completed and error items from queue
   */
  clearCompleted(): void {
    this.queue = this.queue.filter(item =>
      item.status === 'pending' || item.status === 'transferring'
    );
    this.emitQueueUpdate();
  }

  getQueue(): TransferItem[] {
    return [...this.queue];
  }

  getCurrentItem(): TransferItem | undefined {
    return this.currentItem;
  }

  getActiveCount(): number {
    return this._activeCount;
  }

  isActive(): boolean {
    return this.active;
  }

  dispose(): void {
    this.cancel();
    this.removeAllListeners();
  }
}

export const transferManager = new TransferManager();
