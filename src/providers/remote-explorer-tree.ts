/**
 * StackerFTP - Remote Explorer Tree Provider
 * 
 * Native VS Code TreeView with full File Icon Theme support
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { transferManager } from '../core/transfer-manager';
import { BaseConnection } from '../core/connection';
import { FileEntry, FTPConfig } from '../types';
import { logger } from '../utils/logger';
import { formatFileSize, formatDate, normalizeRemotePath } from '../utils/helpers';

export class RemoteTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: FileEntry,
    public readonly config: FTPConfig,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly connectionRef?: BaseConnection
  ) {
    super(entry.name, collapsibleState);
    
    this.tooltip = this.createTooltip();
    
    // Show concise info: just size for files (permissions/date in tooltip)
    if (entry.type === 'file') {
      this.description = formatFileSize(entry.size);
    } else {
      // Directories show nothing in description, details in tooltip
      this.description = '';
    }
    
    // Use VS Code's native file icons
    if (entry.type === 'directory') {
      this.iconPath = vscode.ThemeIcon.Folder;
    } else {
      // For files, use the file icon based on extension
      // Remove leading slashes and create a proper file URI for icon detection
      const cleanPath = entry.path.replace(/^\/+/, '');
      this.resourceUri = vscode.Uri.file(`/tmp/stackerftp-icons/${cleanPath}`);
      this.iconPath = undefined; // Let VS Code decide based on resourceUri
    }
    
    this.contextValue = entry.type;
    
    if (entry.type === 'file') {
      this.command = {
        command: 'stackerftp.tree.openFile',
        title: 'Open Remote File',
        arguments: [this]
      };
    }
  }
  
  private formatPermissions(rights: { user: string; group: string; other: string }): string {
    return `${rights.user}${rights.group}${rights.other}`;
  }
  
  private createTooltip(): string {
    const lines = [
      `Name: ${this.entry.name}`,
      `Type: ${this.entry.type}`,
      `Path: ${this.entry.path}`
    ];
    
    if (this.entry.type === 'file') {
      lines.push(`Size: ${formatFileSize(this.entry.size)}`);
    }
    
    lines.push(`Modified: ${formatDate(this.entry.modifyTime)}`);
    
    if (this.entry.rights) {
      lines.push(`Permissions: ${this.formatPermissions(this.entry.rights)}`);
    }
    
    return lines.join('\n');
  }
}

export class RemoteConfigTreeItem extends vscode.TreeItem {
  constructor(
    public readonly config: FTPConfig,
    public readonly connected: boolean,
    public readonly connectionRef?: BaseConnection
  ) {
    super(config.name || config.host, 
      connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    
    const port = config.port || (config.protocol === 'sftp' ? 22 : 21);
    this.tooltip = `${config.name || config.host}\nProtocol: ${config.protocol.toUpperCase()}\nHost: ${config.host}:${port}\nUser: ${config.username}`;
    this.description = connected ? 'connected' : 'disconnected';
    
    // Use different icons based on connection status
    if (connected) {
      this.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('testing.iconPassed'));
    } else {
      this.iconPath = new vscode.ThemeIcon('cloud-upload');
    }
    
    this.contextValue = connected ? 'connected' : 'disconnected';
  }
}

export class RemoteExplorerTreeProvider implements vscode.TreeDataProvider<RemoteTreeItem | RemoteConfigTreeItem>, vscode.FileDecorationProvider {
  private _onDidChangeTreeData: vscode.EventEmitter<RemoteTreeItem | RemoteConfigTreeItem | undefined | null | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<RemoteTreeItem | RemoteConfigTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
  
  private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter();
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;
  
  private connection: BaseConnection | undefined;
  private currentConfig: FTPConfig | undefined;
  private fileCache: Map<string, FileEntry[]> = new Map();
  
  constructor(private workspaceRoot: string) {
    // Register as file decoration provider for custom icons
    vscode.window.registerFileDecorationProvider(this);
  }
  
  provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
    // This allows us to add badges/colors to files if needed
    return undefined;
  }
  
  refresh(): void {
    logger.info('RemoteExplorerTreeProvider.refresh() called');
    this._onDidChangeTreeData.fire();
  }
  
  getTreeItem(element: RemoteTreeItem | RemoteConfigTreeItem): vscode.TreeItem {
    return element;
  }
  
  async getChildren(element?: RemoteTreeItem | RemoteConfigTreeItem): Promise<(RemoteTreeItem | RemoteConfigTreeItem)[]> {
    logger.info(`getChildren called, element: ${element ? (element instanceof RemoteConfigTreeItem ? 'RemoteConfigTreeItem' : 'RemoteTreeItem') : 'root'}`);
    
    if (!element) {
      // Root level - show all active connections as root nodes
      const activeConnections = connectionManager.getAllActiveConnections();
      logger.info(`getChildren root - activeConnections: ${activeConnections.length}`);
      
      if (activeConnections.length === 0) {
        logger.info('No active connections, returning empty');
        return [];
      }
      
      // If only one connection, show files directly at root
      if (activeConnections.length === 1) {
        const { connection, config } = activeConnections[0];
        this.connection = connection;
        this.currentConfig = config;
        const remotePath = config.remotePath || '/';
        
        logger.info(`Single connection: ${config.name || config.host}, path: ${remotePath}, connected: ${connection.connected}`);
        
        if (!connection.connected) {
          logger.error('Connection exists but not connected');
          return [];
        }
        
        try {
          logger.info(`Calling connection.list(${remotePath})`);
          const entries = await connection.list(remotePath);
          logger.info(`Got ${entries.length} entries from list()`);
          this.fileCache.set(remotePath, entries);
          return this.sortEntries(entries, config, connection);
        } catch (error: any) {
          logger.error(`Failed to list directory: ${error.message}`, error);
          vscode.window.showErrorMessage(`Failed to list remote directory: ${error.message}`);
          return [];
        }
      }
      
      // Multiple connections - show each as a root folder
      logger.info(`Multiple connections: ${activeConnections.length}`);
      return activeConnections.map(({ config, connection }) => 
        new RemoteConfigTreeItem(config, true, connection)
      );
    }
    
    // Handle RemoteConfigTreeItem (for multi-connection mode)
    if (element instanceof RemoteConfigTreeItem) {
      const conn = element.connectionRef || connectionManager.getConnection(element.config);
      const remotePath = element.config.remotePath || '/';
      logger.info(`RemoteConfigTreeItem getChildren - config: ${element.config.name}, path: ${remotePath}`);
      
      if (!conn || !conn.connected) {
        logger.error('No valid connection for config');
        return [];
      }
      
      try {
        const entries = await conn.list(remotePath);
        logger.info(`Listed ${entries.length} entries`);
        this.fileCache.set(remotePath, entries);
        return this.sortEntries(entries, element.config, conn);
      } catch (error: any) {
        logger.error(`Failed to list: ${error.message}`, error);
        return [];
      }
    }
    
    if (element instanceof RemoteTreeItem && element.entry.type === 'directory') {
      // Directory level - show contents
      const conn = element.connectionRef || connectionManager.getConnection(element.config);
      if (!conn || !conn.connected) {
        logger.error('No connection for directory listing');
        return [];
      }
      
      try {
        logger.info(`Listing directory: ${element.entry.path}`);
        const entries = await conn.list(element.entry.path);
        this.fileCache.set(element.entry.path, entries);
        return this.sortEntries(entries, element.config, conn);
      } catch (error: any) {
        logger.error(`Failed to list directory: ${error.message}`, error);
        return [];
      }
    }
    
    return [];
  }
  
  private sortEntries(entries: FileEntry[], config: FTPConfig, conn?: BaseConnection): RemoteTreeItem[] {
    // Sort directories first, then files alphabetically
    const sorted = entries.sort((a, b) => {
      if (a.type === b.type) {
        return a.name.localeCompare(b.name);
      }
      return a.type === 'directory' ? -1 : 1;
    });
    
    return sorted.map(entry => {
      const collapsibleState = entry.type === 'directory' 
        ? vscode.TreeItemCollapsibleState.Collapsed 
        : vscode.TreeItemCollapsibleState.None;
      
      return new RemoteTreeItem(entry, config, collapsibleState, conn);
    });
  }
  
  async connect(config: FTPConfig): Promise<void> {
    try {
      this.connection = await connectionManager.connect(config);
      this.currentConfig = config;
      this.refresh();
    } catch (error) {
      logger.error('Failed to connect', error);
      throw error;
    }
  }
  
  async disconnect(): Promise<void> {
    if (this.currentConfig) {
      await connectionManager.disconnect(this.currentConfig);
      this.connection = undefined;
      this.currentConfig = undefined;
      this.fileCache.clear();
      this.refresh();
    }
  }
  
  getConnection(): BaseConnection | undefined {
    return this.connection;
  }
  
  getCurrentConfig(): FTPConfig | undefined {
    return this.currentConfig;
  }
  
  isConnected(): boolean {
    return !!this.connection && this.connection.connected;
  }
  
  async downloadFile(item: RemoteTreeItem): Promise<void> {
    if (!this.connection) return;
    
    const relativePath = this.currentConfig ? 
      path.relative(this.currentConfig.remotePath, item.entry.path) : 
      path.basename(item.entry.path);
    const localPath = path.join(this.workspaceRoot, relativePath);
    
    await transferManager.downloadFile(this.connection, item.entry.path, localPath);
    
    // Open the file after download
    const doc = await vscode.workspace.openTextDocument(localPath);
    await vscode.window.showTextDocument(doc);
  }
  
  async openFile(item: RemoteTreeItem): Promise<void> {
    // Use connection from item or fallback to class property
    const conn = item.connectionRef || this.connection;
    const config = item.config || this.currentConfig;
    
    if (!conn || !config) {
      vscode.window.showErrorMessage('No active connection');
      return;
    }

    try {
      // Check user preference
      const vsConfig = vscode.workspace.getConfiguration('stackerftp');
      const downloadToWorkspace = vsConfig.get<boolean>('downloadWhenOpenInRemoteExplorer', false);

      const os = require('os');
      const fs = require('fs');
      let targetPath: string;

      if (downloadToWorkspace) {
        // Download to workspace (original behavior)
        const relativePath = path.relative(config.remotePath || '/', item.entry.path);
        targetPath = path.join(this.workspaceRoot, relativePath);
      } else {
        // Open in temp directory (don't pollute workspace)
        const tempDir = path.join(os.tmpdir(), 'stackerftp', config.host);
        targetPath = path.join(tempDir, path.basename(item.entry.path));
      }

      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      await conn.download(item.entry.path, targetPath);

      const targetUri = vscode.Uri.file(targetPath);
      
      // Use vscode.open command which handles all file types (binary, text, images, etc.)
      await vscode.commands.executeCommand('vscode.open', targetUri);

      logger.info(`Opened remote file: ${item.entry.path} -> ${targetPath}`);
    } catch (error: any) {
      logger.error('Failed to open file', error);
      vscode.window.showErrorMessage(`Failed to open file: ${error.message}`);
    }
  }
  
  private getLanguageId(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const languageMap: { [key: string]: string } = {
      '.js': 'javascript',
      '.ts': 'typescript',
      '.jsx': 'javascriptreact',
      '.tsx': 'typescriptreact',
      '.html': 'html',
      '.css': 'css',
      '.scss': 'scss',
      '.less': 'less',
      '.json': 'json',
      '.md': 'markdown',
      '.php': 'php',
      '.py': 'python',
      '.rb': 'ruby',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.c': 'c',
      '.cpp': 'cpp',
      '.h': 'c',
      '.cs': 'csharp',
      '.swift': 'swift',
      '.sql': 'sql',
      '.sh': 'shellscript',
      '.bash': 'shellscript',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.xml': 'xml',
      '.dockerfile': 'dockerfile'
    };
    return languageMap[ext] || 'plaintext';
  }
  
  async deleteFile(item: RemoteTreeItem): Promise<void> {
    if (!this.connection) return;
    
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${item.entry.name}?`,
      { modal: true },
      'Delete', 'Cancel'
    );
    
    if (confirm !== 'Delete') return;
    
    try {
      if (item.entry.type === 'directory') {
        await this.connection.rmdir(item.entry.path, true);
      } else {
        await this.connection.delete(item.entry.path);
      }
      this.refresh();
    } catch (error) {
      logger.error('Failed to delete', error);
      throw error;
    }
  }
  
  async refreshItem(item: RemoteTreeItem): Promise<void> {
    this._onDidChangeTreeData.fire(item);
  }
}
