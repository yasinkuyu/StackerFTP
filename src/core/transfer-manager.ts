/**
 * StackerFTP - Transfer Manager
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BaseConnection } from './connection';
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
    const item: TransferItem = {
      id: generateId(),
      localPath,
      remotePath,
      direction: 'upload',
      status: 'pending',
      progress: 0,
      size: fs.statSync(localPath).size,
      transferred: 0
    };

    this.queue.push(item);
    this.emit('queueUpdate', this.queue);

    if (!this.active) {
      await this.processQueue(connection);
    }
  }

  async downloadFile(
    connection: BaseConnection,
    remotePath: string,
    localPath: string
  ): Promise<void> {
    const item: TransferItem = {
      id: generateId(),
      localPath,
      remotePath,
      direction: 'download',
      status: 'pending',
      progress: 0,
      size: 0,
      transferred: 0
    };

    this.queue.push(item);
    this.emit('queueUpdate', this.queue);

    if (!this.active) {
      await this.processQueue(connection);
    }
  }

  private async processQueue(connection: BaseConnection): Promise<void> {
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
        if (item.direction === 'upload') {
          await connection.upload(item.localPath, item.remotePath);
        } else {
          await connection.download(item.remotePath, item.localPath);
        }

        item.status = 'completed';
        item.progress = 100;
        item.endTime = new Date();
      } catch (error: any) {
        item.status = 'error';
        item.error = error.message;
        item.endTime = new Date();
        logger.error(`Transfer failed: ${item.remotePath}`, error);
      }

      this.emit('transferComplete', item);
      this.queue = this.queue.filter(i => i.id !== item.id);
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

    const files = this.getLocalFiles(localPath);
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
        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }

        if (file.type === 'directory') {
          if (!fs.existsSync(localFilePath)) {
            fs.mkdirSync(localFilePath, { recursive: true });
          }
        } else {
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

  private getLocalFiles(dir: string): string[] {
    const files: string[] = [];
    
    const traverse = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        
        if (entry.isDirectory()) {
          traverse(fullPath);
        } else {
          files.push(fullPath);
        }
      }
    };

    traverse(dir);
    return files;
  }

  private async getRemoteFiles(connection: BaseConnection, remotePath: string): Promise<any[]> {
    const files: any[] = [];

    const traverse = async (currentPath: string) => {
      const entries = await connection.list(currentPath);
      
      for (const entry of entries) {
        const fullPath = normalizeRemotePath(path.join(currentPath, entry.name));
        
        if (entry.type === 'directory') {
          files.push({ ...entry, path: fullPath });
          await traverse(fullPath);
        } else {
          files.push({ ...entry, path: fullPath });
        }
      }
    };

    await traverse(remotePath);
    return files;
  }

  cancel(): void {
    this.cancelled = true;
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
