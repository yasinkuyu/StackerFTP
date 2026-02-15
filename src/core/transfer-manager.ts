/**
 * StackerFTP - Transfer Manager
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BaseConnection } from './connection';
import { connectionManager } from './connection-manager';
import { TransferItem, SyncResult, FTPConfig } from '../types';
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

  async uploadFile(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    config: FTPConfig
  ): Promise<void> {
    const stats = await fs.promises.stat(localPath);
    return new Promise(async (resolve, reject) => {
      const item: TransferItem = {
        id: generateId(),
        localPath,
        remotePath,
        direction: 'upload',
        status: 'pending',
        progress: 0,
        size: stats.size,
        transferred: 0,
        config,
        resolve,
        reject
      };

      this.queue.push(item);
      this.emit('queueUpdate', this.queue);

      if (!this.active) {
        this.processQueue();
      }
    });
  }

  async downloadFile(
    connection: BaseConnection,
    remotePath: string,
    localPath: string,
    config?: FTPConfig
  ): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const item: TransferItem = {
        id: generateId(),
        localPath,
        remotePath,
        direction: 'download',
        status: 'pending',
        progress: 0,
        size: 0,
        transferred: 0,
        config: config || connection.getConfig(),
        resolve,
        reject
      };

      this.queue.push(item);
      this.emit('queueUpdate', this.queue);

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

    try {
      while (this.queue.length > 0 && !this.cancelled) {
        const item = this.queue.find(i => i.status === 'pending');
        if (!item) break;

        this.currentItem = item;
        item.status = 'transferring';
        item.startTime = new Date();
        this.emit('transferStart', item);

        try {
          // Get the correct connection for THIS specific item
          // This is the critical fix - each item uses its own server connection
          if (!item.config) {
            throw new Error('Transfer item missing config - cannot determine target server');
          }

          const connection = connectionManager.getConnection(item.config);
          if (!connection || !connection.connected) {
            throw new Error(`No active connection for ${item.config.name || item.config.host}`);
          }

          if (item.direction === 'upload') {
            await connection.upload(item.localPath, item.remotePath);
          } else {
            await connection.download(item.remotePath, item.localPath);
          }

          item.status = 'completed';
          item.progress = 100;
          item.endTime = new Date();

          if ((item as any).resolve) {
            (item as any).resolve();
          }
        } catch (error: any) {
          item.status = 'error';
          item.error = error.message;
          item.endTime = new Date();
          logger.error(`Transfer failed: ${item.remotePath}`, error);

          if ((item as any).reject) {
            (item as any).reject(error);
          }
        }

        this.emit('transferComplete', item);
        // Keep completed items in queue for history
        // this.queue = this.queue.filter(i => i.id !== item.id);
        this.emit('queueUpdate', this.queue);
      }
    } finally {
      this.isProcessing = false;
      this.active = false;
      this.currentItem = undefined;
      this.emit('queueComplete');
    }
  }

  async uploadDirectory(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    config: FTPConfig
  ): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      failed: [],
      skipped: []
    };

    const files = await this.getLocalFiles(localPath);
    const concurrency = vscode.workspace.getConfiguration('stackerftp').get<number>('transferConcurrency', 5);

    // Process files in batches
    for (let i = 0; i < files.length; i += concurrency) {
      if (this.cancelled) break;

      const batch = files.slice(i, i + concurrency);
      const promises = batch.map(async (file) => {
        const relativePath = path.relative(localPath, file);
        const remoteFilePath = normalizeRemotePath(path.join(remotePath, relativePath));

        // Check ignore patterns
        if (config.ignore && matchesPattern(relativePath, config.ignore)) {
          result.skipped.push(relativePath);
          return;
        }

        try {
          // Ensure remote directory exists
          const remoteDir = normalizeRemotePath(path.dirname(remoteFilePath));
          try {
            await connection.mkdir(remoteDir);
          } catch {
            // Directory might already exist
          }

          // Show file name in status bar
          statusBar.streamFileName('upload', relativePath);

          await connection.upload(file, remoteFilePath);
          result.uploaded.push(relativePath);
        } catch (error: any) {
          result.failed.push({ path: relativePath, error: error.message });
        }
      });

      await Promise.all(promises);

      // Update progress
      const progress = Math.round(((i + batch.length) / files.length) * 100);
      this.emit('batchProgress', { completed: i + batch.length, total: files.length, percentage: progress });
    }

    return result;
  }

  async downloadDirectory(
    connection: BaseConnection,
    remotePath: string,
    localPath: string,
    config: FTPConfig
  ): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      failed: [],
      skipped: []
    };

    const files = await this.getRemoteFiles(connection, remotePath);

    for (const file of files) {
      if (this.cancelled) break;

      const relativePath = path.relative(remotePath, file.path);
      const localFilePath = path.join(localPath, relativePath);

      // Check ignore patterns
      if (config.ignore && matchesPattern(relativePath, config.ignore)) {
        result.skipped.push(relativePath);
        continue;
      }

      try {
        // Ensure local directory exists
        const localDir = path.dirname(localFilePath);
        await fs.promises.mkdir(localDir, { recursive: true });

        // Check if local path exists and is a directory
        let localStats: fs.Stats | null = null;
        try {
          localStats = await fs.promises.stat(localFilePath);
        } catch {
          // Path doesn't exist - that's fine
        }

        if (file.type === 'directory' || file.isSymlinkToDirectory) {
          if (localStats && !localStats.isDirectory()) {
            logger.warn(`Skipping directory creation: ${relativePath} (local file exists)`);
            result.failed.push({ path: relativePath, error: 'Local file exists at directory path' });
            continue;
          }
          await fs.promises.mkdir(localFilePath, { recursive: true });
        } else {
          if (localStats && localStats.isDirectory()) {
            logger.warn(`Skipping file download: ${relativePath} (local directory exists)`);
            result.failed.push({ path: relativePath, error: 'Local directory exists at file path' });
            continue;
          }

          // Show file name in status bar
          statusBar.streamFileName('download', relativePath);

          await connection.download(file.path, localFilePath);
          result.downloaded.push(relativePath);
        }
      } catch (error: any) {
        result.failed.push({ path: relativePath, error: error.message });
      }
    }

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
    const MAX_FILES = 100000; // Safety limit
    const MAX_DEPTH = 50;

    const traverse = async (currentDir: string, depth: number) => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;

      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (files.length >= MAX_FILES) break;
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await traverse(fullPath, depth + 1);
        } else {
          files.push(fullPath);
        }
      }
    };

    await traverse(dir, 0);
    if (files.length >= MAX_FILES) {
      logger.warn(`Directory traversal reached limit of ${MAX_FILES} files. Some files may have been skipped.`);
      statusBar.warn('Sync limit reached (100k files).');
    }
    return files;
  }

  private async getRemoteFiles(connection: BaseConnection, remotePath: string): Promise<any[]> {
    const files: any[] = [];
    const MAX_FILES = 100000; // Safety limit
    const MAX_DEPTH = 50;

    const traverse = async (currentPath: string, depth: number) => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;

      const entries = await connection.list(currentPath);

      for (const entry of entries) {
        if (files.length >= MAX_FILES) break;
        const fullPath = normalizeRemotePath(path.join(currentPath, entry.name));

        if (entry.type === 'directory') {
          files.push({ ...entry, path: fullPath });
          await traverse(fullPath, depth + 1);
        } else {
          files.push({ ...entry, path: fullPath });
        }
      }
    };

    await traverse(remotePath, 0);
    if (files.length >= MAX_FILES) {
      logger.warn(`Remote directory traversal reached limit of ${MAX_FILES} files. Some files may have been skipped.`);
      statusBar.warn('Sync limit reached (100k files).');
    }
    return files;
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    this.emit('queueUpdate', this.queue);
  }

  /**
   * Cancel a specific transfer by ID
   */
  cancelItem(id: string): void {
    const index = this.queue.findIndex(item => item.id === id);
    if (index !== -1) {
      this.queue[index].status = 'error';
      this.queue[index].error = 'Cancelled by user';
      this.queue.splice(index, 1);
      this.emit('queueUpdate', this.queue);
    }
  }

  /**
   * Clear completed and error items from queue
   */
  clearCompleted(): void {
    this.queue = this.queue.filter(item =>
      item.status === 'pending' || item.status === 'transferring'
    );
    this.emit('queueUpdate', this.queue);
  }

  getQueue(): TransferItem[] {
    return [...this.queue];
  }

  getCurrentItem(): TransferItem | undefined {
    return this.currentItem;
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
