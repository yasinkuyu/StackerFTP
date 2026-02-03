/**
 * StackerFTP - Remote Explorer TreeDataProvider
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { RemoteFileItem, RemoteConfigItem, RemoteMessageItem } from './remote-file';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { BaseConnection } from '../core/connection';
import { FileEntry, FTPConfig } from '../types';
import { logger } from '../utils/logger';
import { sortFileEntries } from '../utils/helpers';

export class RemoteExplorerProvider implements vscode.TreeDataProvider<RemoteFileItem | RemoteConfigItem | RemoteMessageItem>, vscode.Disposable {
  private _onDidChangeTreeData: vscode.EventEmitter<RemoteFileItem | RemoteConfigItem | RemoteMessageItem | undefined | null | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<RemoteFileItem | RemoteConfigItem | RemoteMessageItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private connections: Map<string, BaseConnection> = new Map();
  private cachedEntries: Map<string, FileEntry[]> = new Map();
  private expandedPaths: Set<string> = new Set();

  constructor(private workspaceRoot: string) {
    // Watch for configuration changes
    configManager.watchConfig(workspaceRoot, () => {
      this.refresh();
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  refreshItem(item: RemoteFileItem): void {
    this._onDidChangeTreeData.fire(item);
  }

  getTreeItem(element: RemoteFileItem | RemoteConfigItem | RemoteMessageItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RemoteFileItem | RemoteConfigItem | RemoteMessageItem): Promise<(RemoteFileItem | RemoteConfigItem | RemoteMessageItem)[]> {
    if (!this.workspaceRoot) {
      return [new RemoteMessageItem('No workspace folder open', 'warning')];
    }

    const configs = configManager.getConfigs(this.workspaceRoot);
    
    if (configs.length === 0) {
      return [new RemoteMessageItem('No SFTP configuration found. Run "SFTP: Config" to create one.', 'info')];
    }

    // Root level - show configurations
    if (!element) {
      return configs.map(config => {
        const connected = connectionManager.isConnected(config);
        return new RemoteConfigItem(
          config.name || config.host,
          config.host,
          config.protocol,
          connected
        );
      });
    }

    // Config level - show root directories
    if (element instanceof RemoteConfigItem) {
      const config = configs.find(c => (c.name || c.host) === element.configName);
      if (!config) {
        return [];
      }

      try {
        const connection = await this.ensureConnection(config);
        const entries = await connection.list(config.remotePath);
        const sorted = sortFileEntries(entries);
        
        return sorted.map(entry => this.createFileItem(entry, config));
      } catch (error) {
        logger.error('Failed to list remote directory', error);
        return [new RemoteMessageItem(`Error: ${error}`, 'error')];
      }
    }

    // Directory level - show contents
    if (element instanceof RemoteFileItem && element.entry.type === 'directory') {
      const config = configManager.getActiveConfig(this.workspaceRoot);
      if (!config) {
        return [];
      }

      try {
        const connection = await this.ensureConnection(config);
        const entries = await connection.list(element.entry.path);
        const sorted = sortFileEntries(entries);
        
        this.cachedEntries.set(element.entry.path, sorted);
        
        return sorted.map(entry => this.createFileItem(entry, config));
      } catch (error) {
        logger.error('Failed to list remote directory', error);
        return [new RemoteMessageItem(`Error: ${error}`, 'error')];
      }
    }

    return [];
  }

  private createFileItem(entry: FileEntry, config: FTPConfig): RemoteFileItem {
    const collapsibleState = entry.type === 'directory' 
      ? vscode.TreeItemCollapsibleState.Collapsed 
      : vscode.TreeItemCollapsibleState.None;
    
    return new RemoteFileItem(entry, config.name || config.host, collapsibleState);
  }

  private async ensureConnection(config: FTPConfig): Promise<BaseConnection> {
    const key = `${config.host}:${config.port}`;
    
    let connection = this.connections.get(key);
    if (!connection || !connection.connected) {
      connection = await connectionManager.connect(config);
      this.connections.set(key, connection);
    }
    
    return connection;
  }

  async connect(): Promise<void> {
    const config = configManager.getActiveConfig(this.workspaceRoot);
    if (!config) {
      const choice = await vscode.window.showWarningMessage(
        'No SFTP configuration found.',
        'Create Config'
      );
      if (choice === 'Create Config') {
        await configManager.createDefaultConfig(this.workspaceRoot);
      }
      return;
    }

    try {
      await this.ensureConnection(config);
      this.refresh();
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to connect: ${error.message}`);
    }
  }

  async disconnect(): Promise<void> {
    await connectionManager.disconnect();
    this.connections.clear();
    this.refresh();
  }

  getConnectionForItem(item: RemoteFileItem): BaseConnection | undefined {
    const config = configManager.getConfigs(this.workspaceRoot).find(
      c => (c.name || c.host) === item.configName
    );
    if (!config) return undefined;
    return this.connections.get(`${config.host}:${config.port}`);
  }

  getCachedEntries(path: string): FileEntry[] | undefined {
    return this.cachedEntries.get(path);
  }

  clearCache(): void {
    this.cachedEntries.clear();
  }

  dispose(): void {
    this.connections.clear();
    this.cachedEntries.clear();
    this.expandedPaths.clear();
  }
}
