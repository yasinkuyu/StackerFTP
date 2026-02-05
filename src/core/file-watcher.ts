/**
 * StackerFTP - File Watcher
 * 
 * Monitors local files for changes and automatically syncs with remote
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FTPConfig } from '../types';
import { configManager } from './config';
import { connectionManager } from './connection-manager';
import { transferManager } from './transfer-manager';
import { logger } from '../utils/logger';
import { normalizeRemotePath, matchesPattern } from '../utils/helpers';
import { wasRecentlyUploaded } from '../extension';

export class FileWatcher implements vscode.Disposable {
  private watchers: Map<string, vscode.FileSystemWatcher> = new Map();
  private workspaceRoot: string;
  private config: FTPConfig;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingChanges: Map<string, 'create' | 'change' | 'delete'> = new Map();

  constructor(workspaceRoot: string, config: FTPConfig) {
    this.workspaceRoot = workspaceRoot;
    this.config = config;
  }

  /**
   * Start watching files based on watcher configuration
   */
  start(): void {
    if (!this.config.watcher) {
      logger.info('No watcher configuration found');
      return;
    }

    const watcherConfig = this.config.watcher;

    // Handle boolean watcher config (watcher: true)
    const pattern = typeof watcherConfig === 'boolean'
      ? '**/*'
      : (watcherConfig?.files || '**/*');
    const globPattern = new vscode.RelativePattern(this.workspaceRoot, pattern);

    // Create watcher
    const watcher = vscode.workspace.createFileSystemWatcher(
      globPattern,
      false, // ignoreCreateEvents
      false, // ignoreChangeEvents
      false  // ignoreDeleteEvents
    );

    // Handle file creation
    watcher.onDidCreate((uri) => {
      this.handleFileChange(uri.fsPath, 'create');
    });

    // Handle file changes
    watcher.onDidChange((uri) => {
      this.handleFileChange(uri.fsPath, 'change');
    });

    // Handle file deletion
    watcher.onDidDelete((uri) => {
      this.handleFileChange(uri.fsPath, 'delete');
    });

    this.watchers.set(this.getWatcherKey(), watcher);
    logger.info(`File watcher started for pattern: ${pattern}`);
  }

  /**
   * Stop watching files
   */
  stop(): void {
    for (const [key, watcher] of this.watchers) {
      watcher.dispose();
      logger.info(`File watcher stopped: ${key}`);
    }
    this.watchers.clear();
    this.clearDebounceTimers();
  }

  /**
   * Restart the watcher with updated configuration
   */
  restart(): void {
    this.stop();
    this.start();
  }

  private handleFileChange(filePath: string, type: 'create' | 'change' | 'delete'): void {
    const relativePath = path.relative(this.workspaceRoot, filePath);

    // Check ignore patterns
    if (this.config.ignore && matchesPattern(relativePath, this.config.ignore)) {
      return;
    }

    logger.debug(`File ${type}: ${relativePath}`);

    // Debounce rapid changes
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Track the latest change type
    this.pendingChanges.set(filePath, type);

    // Debounce and process
    const timer = setTimeout(() => {
      this.processChange(filePath);
      this.debounceTimers.delete(filePath);
    }, 500); // 500ms debounce

    this.debounceTimers.set(filePath, timer);
  }

  private async processChange(filePath: string): Promise<void> {
    const changeType = this.pendingChanges.get(filePath);
    this.pendingChanges.delete(filePath);

    if (!changeType) return;

    const relativePath = path.relative(this.workspaceRoot, filePath);
    const remotePath = normalizeRemotePath(path.join(this.config.remotePath, relativePath));

    // Normalize watcher config (handle boolean case)
    const watcherConfig = typeof this.config.watcher === 'boolean'
      ? { files: '**/*', autoUpload: true, autoDelete: false }
      : this.config.watcher;

    try {
      switch (changeType) {
        case 'create':
        case 'change':
          // Check if autoUpload is enabled BEFORE establishing connection
          if (watcherConfig?.autoUpload === false) {
            logger.debug(`Auto-upload disabled, skipping: ${relativePath}`);
            return;
          }

          // Check if this file was recently uploaded via uploadOnSave
          // to prevent duplicate uploads
          if (wasRecentlyUploaded(filePath)) {
            logger.debug(`Skipping duplicate upload for recently uploaded file: ${relativePath}`);
            return;
          }

          if (!fs.existsSync(filePath)) {
            return;
          }

          // Now establish connection
          const uploadConnection = await connectionManager.ensureConnection(this.config);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            await uploadConnection.mkdir(remotePath);
          } else {
            // Ensure parent directory exists
            const remoteDir = normalizeRemotePath(path.dirname(remotePath));
            try {
              await uploadConnection.mkdir(remoteDir);
            } catch {
              // Directory might already exist
            }
            await transferManager.uploadFile(uploadConnection, filePath, remotePath, this.config);
            logger.info(`Auto-uploaded: ${relativePath}`);
          }
          break;

        case 'delete':
          if (watcherConfig?.autoDelete !== false) {
            // Establish connection for delete operation
            const deleteConnection = await connectionManager.ensureConnection(this.config);
            try {
              await deleteConnection.delete(remotePath);
              logger.info(`Auto-deleted: ${relativePath}`);
            } catch (error) {
              logger.warn(`Failed to auto-delete ${relativePath}`, error);
            }
          }
          break;
      }
    } catch (error: any) {
      logger.error(`Failed to process file change for ${relativePath}`, error);
    }
  }

  private getWatcherKey(): string {
    return `${this.config.host}:${this.config.port}-${this.config.remotePath}`;
  }

  private clearDebounceTimers(): void {
    for (const [filePath, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingChanges.clear();
  }

  dispose(): void {
    this.stop();
  }
}

export class FileWatcherManager {
  private static instance: FileWatcherManager;
  private watchers: Map<string, FileWatcher> = new Map();

  static getInstance(): FileWatcherManager {
    if (!FileWatcherManager.instance) {
      FileWatcherManager.instance = new FileWatcherManager();
    }
    return FileWatcherManager.instance;
  }

  startWatcher(workspaceRoot: string, config: FTPConfig): void {
    const key = `${workspaceRoot}-${config.host}`;

    // Stop existing watcher if any
    this.stopWatcher(key);

    if (!config.watcher) {
      return;
    }

    const watcher = new FileWatcher(workspaceRoot, config);
    watcher.start();
    this.watchers.set(key, watcher);
  }

  stopWatcher(key: string): void {
    const existing = this.watchers.get(key);
    if (existing) {
      existing.dispose();
      this.watchers.delete(key);
    }
  }

  stopAll(): void {
    for (const [key, watcher] of this.watchers) {
      watcher.dispose();
    }
    this.watchers.clear();
  }

  isWatching(key: string): boolean {
    return this.watchers.has(key);
  }
}

export const fileWatcherManager = FileWatcherManager.getInstance();
