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
import { formatFileSize, formatDate, normalizeRemotePath, isBinaryFile, isSystemFile } from '../utils/helpers';
import { RemoteDocumentProvider } from './remote-document-provider';
import * as os from 'os';
import * as fs from 'fs';

export class RemoteTreeItem extends vscode.TreeItem {
  public isLoading: boolean = false;

  constructor(
    public readonly entry: FileEntry,
    public readonly config: FTPConfig,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
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
      // If symlink target is a directory, ensure description reflects that if target path is not enough
      if (entry.isSymlinkToDirectory && entry.target) {
        this.description = `→ [Dir] ${entry.target}`;
      }
    } else {
      // Directories show nothing in description, details in tooltip
      this.description = '';
    }

    // Use VS Code's native file/folder icons where appropriate
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
      // We use a virtual path only if needed for icon theme, but let's avoid it if possible
      // to prevent VS Code from trying to access non-existent files
      const cleanPath = entry.path.replace(/^\/+/, '');
      this.resourceUri = vscode.Uri.parse(`stackerftp-remote:/${cleanPath}`);
      this.iconPath = undefined; // Let VS Code decide based on resourceUri scheme if theme supports it
    }

    // Prefix contextValue with protocol for filtering in package.json
    // e.g., 'sftp-file', 'ftp-directory', 'ftps-symlink'
    this.contextValue = `${config.protocol}-${entry.type}`;

    // Allow opening files and symlinks (symlinks to files)
    if (entry.type === 'file' || (entry.type === 'symlink' && !entry.isSymlinkToDirectory)) {
      this.command = {
        command: 'stackerftp.tree.openFile',
        title: 'Open Remote File',
        arguments: [this.entry, this.config]
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
    public readonly isPrimary: boolean
  ) {
    super(config.name || config.host,
      connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);

    const port = config.port || (config.protocol === 'sftp' ? 22 : 21);
    this.tooltip = `${config.name || config.host}\nProtocol: ${config.protocol.toUpperCase()}\nHost: ${config.host}:${port}\nUser: ${config.username}\nRemote Path: ${config.remotePath || '/'}`;

    // Add primary status to description
    let stateDesc = connected ? `${config.protocol.toUpperCase()}` : 'disconnected';
    if (isPrimary) {
      stateDesc += ' (Primary)';
      this.label = `★ ${this.label}`; // Add star to label for visibility
    }
    this.description = stateDesc;

    // Use server icon with connection status color
    if (connected) {
      this.iconPath = new vscode.ThemeIcon('server-environment', new vscode.ThemeColor('charts.green'));
    } else {
      this.iconPath = new vscode.ThemeIcon('server', new vscode.ThemeColor('disabledForeground'));
    }

    // Use 'connected' contextValue so inline buttons work (new file, new folder)
    // Prefix with protocol for context-specific commands
    this.contextValue = connected ? `${config.protocol}-connected` : 'disconnected';

    // Allow clicking to connect if disconnected
    if (!connected) {
      this.command = {
        command: 'stackerftp.connect',
        title: 'Connect',
        arguments: [{ config: this.config }]
      };
    }
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

    // Subscribe to connection changes
    connectionManager.onConnectionChanged(() => {
      this.refresh();
    });
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
        true // loading = true
      );
    }
    return element;
  }

  async getChildren(element?: RemoteTreeItem | RemoteConfigTreeItem): Promise<(RemoteTreeItem | RemoteConfigTreeItem)[]> {
    logger.info(`getChildren called, element: ${element ? (element instanceof RemoteConfigTreeItem ? 'RemoteConfigTreeItem' : 'RemoteTreeItem') : 'root'}`);

    if (!element) {
      // Root level - show ALL configured servers with their connection status
      const configs = configManager.getConfigs(this.workspaceRoot);

      if (configs.length === 0) {
        this.hideLoading();
        logger.info('No configs found, returning empty');
        return [];
      }

      // Show all servers - mark each as connected or disconnected
      logger.info(`Showing ${configs.length} configured server(s)`);

      const primaryConfig = connectionManager.getPrimaryConfig();

      const result = configs.map(config => {
        const connection = connectionManager.getConnection(config);
        const isConnected = connection?.connected ?? false;
        const isPrimary = !!(primaryConfig && config.name === primaryConfig.name && config.host === primaryConfig.host);

        return new RemoteConfigTreeItem(config, isConnected, isPrimary);
      });

      this.hideLoading();
      return result;
    }

    // Handle RemoteConfigTreeItem (connection node)
    if (element instanceof RemoteConfigTreeItem) {
      const conn = connectionManager.getConnection(element.config);
      const remotePath = element.config.remotePath || '/';
      logger.info(`RemoteConfigTreeItem getChildren - config: ${element.config.name}, path: ${remotePath}`);

      if (!conn || !conn.connected) {
        logger.error('No valid connection for config');
        this.hideLoading();
        return [];
      }

      this.connection = conn;
      this.currentConfig = element.config;

      try {
        this.showLoading(`Loading ${element.config.name || element.config.host}...`);
        const entries = await conn.list(remotePath);
        logger.info(`Listed ${entries.length} entries`);
        this.fileCache.set(remotePath, entries);
        return this.sortEntries(entries, element.config, conn);
      } catch (error: any) {
        logger.error(`Failed to list: ${error.message}`, error);
        return [];
      } finally {
        this.hideLoading();
      }
    }

    if (element instanceof RemoteTreeItem && (element.entry.type === 'directory' || (element.entry.type === 'symlink' && element.entry.isSymlinkToDirectory))) {
      // Directory level - show contents (including symlinks to directories)
      const conn = connectionManager.getConnection(element.config);
      if (!conn || !conn.connected) {
        logger.error('No connection for directory listing');
        this.hideLoading();
        return [];
      }

      try {
        this.showLoading(`Loading ${element.entry.name}...`);
        logger.info(`Listing directory: ${element.entry.path}`);
        const entries = await conn.list(element.entry.path);
        this.fileCache.set(element.entry.path, entries);
        return this.sortEntries(entries, element.config, conn);
      } catch (error: any) {
        logger.error(`Failed to list directory: ${error.message}`, error);
        return [];
      } finally {
        this.hideLoading();
      }
    }

    return [];
  }

  private sortEntries(entries: FileEntry[], config: FTPConfig, conn?: BaseConnection): RemoteTreeItem[] {
    // Get sort order from config or VS Code settings
    const vsConfig = vscode.workspace.getConfiguration('stackerftp');
    const sortOrder = config.remoteExplorerOrder || vsConfig.get<string>('remoteExplorerSortOrder', 'name');
    const showHiddenFiles = vsConfig.get<boolean>('showHiddenFiles', false);

    // Filter hidden files if setting is disabled
    let filteredEntries = entries;
    if (!showHiddenFiles) {
      filteredEntries = entries.filter(e => !e.name.startsWith('.'));
    }

    const sorted = filteredEntries.sort((a, b) => {
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

      return new RemoteTreeItem(entry, config, collapsibleState);
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

  async downloadFile(itemParam: RemoteTreeItem | FileEntry, configParam?: FTPConfig): Promise<void> {
    const item = itemParam instanceof RemoteTreeItem ? itemParam.entry : itemParam;
    const config = (itemParam instanceof RemoteTreeItem ? itemParam.config : configParam) || this.currentConfig;
    const conn = connectionManager.getConnection(config!) || this.connection;

    if (!conn || !config) return;

    const relativePath = path.relative(config.remotePath || '/', item.path);
    const localPath = path.join(this.workspaceRoot, relativePath);

    // If it's a directory or symlink to directory, use downloadDirectory
    if (item.type === 'directory' || (item.type === 'symlink' && item.isSymlinkToDirectory)) {
      await transferManager.downloadDirectory(conn, item.path, localPath, config);
      return;
    }

    await transferManager.downloadFile(conn, item.path, localPath, config);

    // Open the file after download (only for files)
    try {
      const doc = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(doc);
    } catch {
      // Might not be a text file or download might have been skipped
    }
  }

  async openFile(entryParam?: FileEntry | RemoteTreeItem, configParam?: FTPConfig): Promise<void> {
    // Handle both direct item pass and individual params (from command arguments)
    let item: FileEntry | undefined;
    let config: FTPConfig | undefined;

    if (entryParam instanceof RemoteTreeItem) {
      item = entryParam.entry;
      config = entryParam.config;
    } else {
      item = entryParam;
      config = configParam;
    }

    if (!item || !config) {
      statusBar.error('File or configuration missing');
      return;
    }

    // Get connection and fallback to class property
    const conn = connectionManager.getConnection(config) || this.connection;

    if (!conn || !config) {
      statusBar.error('No active connection');
      return;
    }

    const fileName = item.name || path.basename(item.path);
    const remotePath = item.path;
    const fileSize = item.size || 0;

    // Check for system files
    if (this.isSystemFile(remotePath)) {
      statusBar.warn(`Cannot open system file: ${fileName}`);
      return;
    }

    // Check if file is too large for preview (5MB limit)
    const MAX_PREVIEW_SIZE = 5 * 1024 * 1024;
    if (fileSize > MAX_PREVIEW_SIZE) {
      const sizeStr = (fileSize / (1024 * 1024)).toFixed(2);
      const choice = await vscode.window.showWarningMessage(
        `"${fileName}" is ${sizeStr} MB. Large files may cause performance issues.`,
        'Download Instead', 'Open Anyway', 'Cancel'
      );

      if (choice === 'Download Instead') {
        // Find RemoteTreeItem from cache if possible, or create a mock one for downloadFile
        // Actually, let's just make downloadFile accept FileEntry and Config
        await this.downloadFile(item, config);
        return;
      } else if (choice !== 'Open Anyway') {
        return;
      }
    }

    // Check if binary file - these need to be downloaded
    if (RemoteDocumentProvider.isBinaryFile(remotePath)) {
      await this.openBinaryFile(item, config, fileName);
      return;
    }

    // Check for symlinks to special files
    if (item.type === 'symlink' && !item.target) {
      statusBar.warn(`Broken symlink: ${fileName}`);
      return;
    }

    // Text files - open in memory using TextDocumentContentProvider (no temp file)
    try {
      // Store config for multi-connection support
      RemoteDocumentProvider.setConfigForPath(remotePath, config);

      const uri = RemoteDocumentProvider.createUri(remotePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });

      logger.info(`Opened remote file in memory: ${remotePath}`);
    } catch (error: any) {
      logger.error('Failed to open file', error);

      // More specific error handling
      const errMsg = error.message || '';
      if (errMsg.includes('550') || errMsg.includes('No such file')) {
        statusBar.error(`File not found or access denied: ${fileName}`, true);
      } else if (errMsg.includes('ENOENT')) {
        statusBar.error(`File does not exist: ${fileName}`, true);
      } else if (errMsg.includes('EPERM') || errMsg.includes('permission')) {
        statusBar.error(`Permission denied: ${fileName}`, true);
      } else if (errMsg.includes('ETIMEDOUT') || errMsg.includes('timeout')) {
        statusBar.error(`Connection timeout reading: ${fileName}`, true);
      } else if (errMsg.includes('binary') || errMsg.includes('null')) {
        // Fallback for files like adminer.php that might have null bytes but are essentially text
        logger.warn(`File detected as binary by VS Code, falling back to local download: ${fileName}`);
        await this.openBinaryFile(item, config, fileName);
      } else {
        statusBar.error(`Failed to open: ${errMsg}`, true);
      }
    }
  }

  // Open binary files by downloading to temp
  private async openBinaryFile(
    item: FileEntry,
    config: FTPConfig,
    fileName: string
  ): Promise<void> {
    const progress = statusBar.startProgress('open-binary', `Downloading ${fileName}...`);

    try {
      const conn = connectionManager.getConnection(config) || this.connection;
      if (!conn) throw new Error('No active connection');


      // Check user preference
      const downloadOnOpen = config.downloadOnOpen ?? false;
      const vsConfig = vscode.workspace.getConfiguration('stackerftp');
      const downloadToWorkspace = downloadOnOpen || vsConfig.get<boolean>('downloadWhenOpenInRemoteExplorer', false);

      let targetPath: string;

      if (downloadToWorkspace) {
        const relativePath = path.relative(config.remotePath || '/', item.path);
        targetPath = path.join(this.workspaceRoot, relativePath);
      } else {
        const tempDir = path.join(os.tmpdir(), 'stackerftp', config.host);
        targetPath = path.join(tempDir, path.basename(item.path));
      }

      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      await transferManager.downloadFile(conn, item.path, targetPath, config);

      const targetUri = vscode.Uri.file(targetPath);
      await vscode.commands.executeCommand('vscode.open', targetUri);

      progress.complete();
      logger.info(`Opened binary file via transferManager: ${item.path} -> ${targetPath}`);
    } catch (error: any) {
      logger.error('Failed to open binary file', error);
      progress.fail(`Failed to open: ${error.message}`);
    }
  }

  private isSystemFile(filePath: string): boolean {
    return isSystemFile(filePath);
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

  async deleteFile(itemParam: RemoteTreeItem | FileEntry, configParam?: FTPConfig): Promise<void> {
    const item = itemParam instanceof RemoteTreeItem ? itemParam.entry : itemParam;
    const config = (itemParam instanceof RemoteTreeItem ? itemParam.config : configParam) || this.currentConfig;
    const conn = connectionManager.getConnection(config!) || this.connection;

    if (!conn) {
      statusBar.error('No active connection');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Delete ${item.name}?`,
      { modal: true },
      'Delete', 'Cancel'
    );

    if (confirm !== 'Delete') return;

    const progress = statusBar.startProgress('delete', `Deleting ${item.name}...`);

    try {
      // Mark item as loading if it's a TreeItem
      if (itemParam instanceof RemoteTreeItem) {
        this.loadingItems.add(item.path);
        this._onDidChangeTreeData.fire(itemParam);
      }

      if (item.type === 'directory') {
        await conn.rmdir(item.path, true);
      } else {
        await conn.delete(item.path);
      }

      // Remove from loading
      this.loadingItems.delete(item.path);

      // Clear cache for parent directory
      const parentPath = path.dirname(item.path);
      this.fileCache.delete(parentPath);

      this.refresh();
      progress.complete(`Deleted: ${item.name}`);
    } catch (error: any) {
      this.loadingItems.delete(item.path);
      if (itemParam instanceof RemoteTreeItem) {
        this._onDidChangeTreeData.fire(itemParam);
      }
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
