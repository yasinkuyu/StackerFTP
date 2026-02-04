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
import { statusBar } from '../utils/status-bar';
import { formatFileSize, formatDate, normalizeRemotePath } from '../utils/helpers';
import { RemoteDocumentProvider } from './remote-document-provider';

export class RemoteTreeItem extends vscode.TreeItem {
  public isLoading: boolean = false;
  
  constructor(
    public readonly entry: FileEntry,
    public readonly config: FTPConfig,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly connectionRef?: BaseConnection,
    loading: boolean = false
  ) {
    super(entry.name, collapsibleState);
    
    this.isLoading = loading;
    this.tooltip = this.createTooltip();
    
    // If loading, show spinner icon and loading description
    if (loading) {
      this.iconPath = new vscode.ThemeIcon('loading~spin');
      this.description = 'Processing...';
      return;
    }
    
    // Show concise info: just size for files (permissions/date in tooltip)
    if (entry.type === 'file') {
      this.description = formatFileSize(entry.size);
    } else if (entry.type === 'symlink') {
      this.description = entry.target ? `→ ${entry.target}` : '→ symlink';
    } else {
      // Directories show nothing in description, details in tooltip
      this.description = '';
    }
    
    // Use VS Code's native file icons
    if (entry.type === 'directory') {
      this.iconPath = vscode.ThemeIcon.Folder;
    } else if (entry.type === 'symlink') {
      // Symlinks get special handling
      if (entry.isSymlinkToDirectory) {
        this.iconPath = new vscode.ThemeIcon('folder-symlink');
      } else {
        this.iconPath = new vscode.ThemeIcon('file-symlink-file');
      }
    } else {
      // For files, use the file icon based on extension
      // Remove leading slashes and create a proper file URI for icon detection
      const cleanPath = entry.path.replace(/^\/+/, '');
      this.resourceUri = vscode.Uri.file(`/tmp/stackerftp-icons/${cleanPath}`);
      this.iconPath = undefined; // Let VS Code decide based on resourceUri
    }
    
    this.contextValue = entry.type;
    
    // Allow opening files and symlinks (symlinks to files)
    if (entry.type === 'file' || (entry.type === 'symlink' && !entry.isSymlinkToDirectory)) {
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
    
    this.contextValue = connected ? 'connection' : 'disconnected';
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
  private loadingPaths: Set<string> = new Set();
  private loadingItems: Set<string> = new Set(); // Track items with inline loading
  private statusBarItem: vscode.StatusBarItem;
  
  constructor(private workspaceRoot: string) {
    // Register as file decoration provider for custom icons
    vscode.window.registerFileDecorationProvider(this);
    
    // Create status bar item for loading indicator
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.name = 'StackerFTP Loading';
  }
  
  private showLoading(message: string): void {
    this.statusBarItem.text = `$(sync~spin) ${message}`;
    this.statusBarItem.show();
  }
  
  private hideLoading(): void {
    this.statusBarItem.hide();
  }
  
  dispose(): void {
    this.statusBarItem.dispose();
  }
  
  provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
    // This allows us to add badges/colors to files if needed
    return undefined;
  }
  
  refresh(): void {
    logger.info('RemoteExplorerTreeProvider.refresh() called');
    // Show loading in status bar during refresh
    this.showLoading('Refreshing...');
    // Clear file cache to force fresh data
    this.fileCache.clear();
    this._onDidChangeTreeData.fire();
  }
  
  // Refresh with loading indicator
  async refreshWithProgress(): Promise<void> {
    const progress = statusBar.startProgress('refresh', 'Refreshing...');
    try {
      this.fileCache.clear();
      this._onDidChangeTreeData.fire();
      await new Promise(resolve => setTimeout(resolve, 300));
      progress.complete();
    } catch (error) {
      progress.fail('Refresh failed');
    }
  }
  
  getTreeItem(element: RemoteTreeItem | RemoteConfigTreeItem): vscode.TreeItem {
    // If it's a RemoteTreeItem and it's loading, return a new item with loading state
    if (element instanceof RemoteTreeItem && this.loadingItems.has(element.entry.path)) {
      return new RemoteTreeItem(
        element.entry,
        element.config,
        element.collapsibleState,
        element.connectionRef,
        true // loading = true
      );
    }
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
          this.showLoading(`Loading ${remotePath}...`);
          logger.info(`Calling connection.list(${remotePath})`);
          const entries = await connection.list(remotePath);
          this.hideLoading();
          logger.info(`Got ${entries.length} entries from list()`);
          this.fileCache.set(remotePath, entries);
          return this.sortEntries(entries, config, connection);
        } catch (error: any) {
          this.hideLoading();
          logger.error(`Failed to list directory: ${error.message}`, error);
          statusBar.error(`Failed to list: ${error.message}`, true);
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
        this.showLoading(`Loading ${element.config.name || element.config.host}...`);
        const entries = await conn.list(remotePath);
        this.hideLoading();
        logger.info(`Listed ${entries.length} entries`);
        this.fileCache.set(remotePath, entries);
        return this.sortEntries(entries, element.config, conn);
      } catch (error: any) {
        this.hideLoading();
        logger.error(`Failed to list: ${error.message}`, error);
        return [];
      }
    }
    
    if (element instanceof RemoteTreeItem && (element.entry.type === 'directory' || (element.entry.type === 'symlink' && element.entry.isSymlinkToDirectory))) {
      // Directory level - show contents (including symlinks to directories)
      const conn = element.connectionRef || connectionManager.getConnection(element.config);
      if (!conn || !conn.connected) {
        logger.error('No connection for directory listing');
        return [];
      }
      
      try {
        this.showLoading(`Loading ${element.entry.name}...`);
        logger.info(`Listing directory: ${element.entry.path}`);
        const entries = await conn.list(element.entry.path);
        this.hideLoading();
        this.fileCache.set(element.entry.path, entries);
        return this.sortEntries(entries, element.config, conn);
      } catch (error: any) {
        this.hideLoading();
        logger.error(`Failed to list directory: ${error.message}`, error);
        return [];
      }
    }
    
    return [];
  }
  
  private sortEntries(entries: FileEntry[], config: FTPConfig, conn?: BaseConnection): RemoteTreeItem[] {
    // Get sort order from config or VS Code settings
    const vsConfig = vscode.workspace.getConfiguration('stackerftp');
    const sortOrder = config.remoteExplorerOrder || vsConfig.get<string>('remoteExplorerSortOrder', 'name');
    
    const sorted = entries.sort((a, b) => {
      // Determine if each entry should be treated as a directory
      const aIsDir = a.type === 'directory' || (a.type === 'symlink' && a.isSymlinkToDirectory);
      const bIsDir = b.type === 'directory' || (b.type === 'symlink' && b.isSymlinkToDirectory);
      
      // Always sort directories first
      if (aIsDir !== bIsDir) {
        return aIsDir ? -1 : 1;
      }
      
      // Then sort by specified order
      switch (sortOrder) {
        case 'size':
          return (b.size || 0) - (a.size || 0); // Largest first
        case 'date':
          const aTime = a.modifyTime?.getTime() || 0;
          const bTime = b.modifyTime?.getTime() || 0;
          return bTime - aTime; // Newest first
        case 'type':
          // Within same type, sort by extension then name
          const aExt = a.name.includes('.') ? a.name.split('.').pop() || '' : '';
          const bExt = b.name.includes('.') ? b.name.split('.').pop() || '' : '';
          if (aExt !== bExt) {
            return aExt.localeCompare(bExt);
          }
          return a.name.localeCompare(b.name);
        case 'name':
        default:
          return a.name.localeCompare(b.name);
      }
    });
    
    return sorted.map(entry => {
      // Determine collapsible state based on type
      let collapsibleState: vscode.TreeItemCollapsibleState;
      if (entry.type === 'directory') {
        collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      } else if (entry.type === 'symlink' && entry.isSymlinkToDirectory) {
        collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      } else {
        collapsibleState = vscode.TreeItemCollapsibleState.None;
      }
      
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
      statusBar.error('No active connection');
      return;
    }

    const fileName = item.entry.name || path.basename(item.entry.path);
    const remotePath = item.entry.path;

    // Check for system files
    if (this.isSystemFile(remotePath)) {
      statusBar.warn(`Cannot open system file: ${fileName}`);
      return;
    }

    // Check if binary file - these need to be downloaded
    if (RemoteDocumentProvider.isBinaryFile(remotePath)) {
      await this.openBinaryFile(item, conn, config, fileName);
      return;
    }

    // Text files - open in memory using TextDocumentContentProvider (no temp file)
    try {
      statusBar.info(`Opening ${fileName}...`);

      // Store config for multi-connection support
      RemoteDocumentProvider.setConfigForPath(remotePath, config);

      const uri = RemoteDocumentProvider.createUri(remotePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });

      statusBar.success(`Opened: ${fileName}`);
      logger.info(`Opened remote file in memory: ${remotePath}`);
    } catch (error: any) {
      logger.error('Failed to open file', error);

      if (error.message?.includes('550')) {
        statusBar.error(`Cannot open "${fileName}": Special file type`, true);
      } else {
        statusBar.error(`Failed to open: ${error.message}`, true);
      }
    }
  }

  // Open binary files by downloading to temp
  private async openBinaryFile(
    item: RemoteTreeItem,
    conn: BaseConnection,
    config: FTPConfig,
    fileName: string
  ): Promise<void> {
    const progress = statusBar.startProgress('open-binary', `Downloading ${fileName}...`);

    try {
      const os = require('os');
      const fs = require('fs');

      // Check user preference
      const downloadOnOpen = config.downloadOnOpen ?? false;
      const vsConfig = vscode.workspace.getConfiguration('stackerftp');
      const downloadToWorkspace = downloadOnOpen || vsConfig.get<boolean>('downloadWhenOpenInRemoteExplorer', false);

      let targetPath: string;

      if (downloadToWorkspace) {
        const relativePath = path.relative(config.remotePath || '/', item.entry.path);
        targetPath = path.join(this.workspaceRoot, relativePath);
      } else {
        const tempDir = path.join(os.tmpdir(), 'stackerftp', config.host);
        targetPath = path.join(tempDir, path.basename(item.entry.path));
      }

      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      await conn.download(item.entry.path, targetPath);

      const targetUri = vscode.Uri.file(targetPath);
      await vscode.commands.executeCommand('vscode.open', targetUri);

      progress.complete(`Opened: ${fileName}`);
      logger.info(`Opened binary file: ${item.entry.path} -> ${targetPath}`);
    } catch (error: any) {
      logger.error('Failed to open binary file', error);
      progress.fail(`Failed to open: ${error.message}`);
    }
  }

  private isSystemFile(filePath: string): boolean {
    const systemPatterns = ['__MACOSX', '.DS_Store', 'Thumbs.db'];
    return systemPatterns.some(pattern => filePath.includes(pattern));
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
    // Use connection from item or fallback to class property
    const conn = item.connectionRef || this.connection;
    if (!conn) {
      statusBar.error('No active connection');
      return;
    }
    
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${item.entry.name}?`,
      { modal: true },
      'Delete', 'Cancel'
    );
    
    if (confirm !== 'Delete') return;

    const progress = statusBar.startProgress('delete', `Deleting ${item.entry.name}...`);

    try {
      // Mark item as loading and refresh to show spinner
      this.loadingItems.add(item.entry.path);
      this._onDidChangeTreeData.fire(item);

      if (item.entry.type === 'directory') {
        await conn.rmdir(item.entry.path, true);
      } else {
        await conn.delete(item.entry.path);
      }

      // Remove from loading and refresh parent
      this.loadingItems.delete(item.entry.path);

      // Clear cache for parent directory
      const parentPath = path.dirname(item.entry.path);
      this.fileCache.delete(parentPath);

      this.refresh();
      progress.complete(`Deleted: ${item.entry.name}`);
    } catch (error: any) {
      this.loadingItems.delete(item.entry.path);
      this._onDidChangeTreeData.fire(item);
      logger.error('Failed to delete', error);
      progress.fail(`Failed to delete: ${error.message}`);
    }
  }
  
  // Check if an item is currently loading
  isItemLoading(itemPath: string): boolean {
    return this.loadingItems.has(itemPath);
  }
  
  async refreshItem(item: RemoteTreeItem): Promise<void> {
    this._onDidChangeTreeData.fire(item);
  }
}
