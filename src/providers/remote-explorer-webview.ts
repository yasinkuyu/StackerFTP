/**
 * StackerFTP - Remote Explorer WebView Provider
 * 
 * Modern, minimalist file manager with VS Code Codicons
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

export class RemoteExplorerWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'stackerftp.remoteExplorer';

  private _view?: vscode.WebviewView;
  private _connection?: BaseConnection;
  private _currentConfig?: FTPConfig;
  private _currentPath: string = '';
  private _fileCache: Map<string, FileEntry[]> = new Map();
  private _selectedFiles: Set<string> = new Set();

  constructor(private readonly _extensionUri: vscode.Uri) { }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri,
        vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
      ]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'checkConnection':
          await this._checkConnectionStatus();
          break;
        case 'listDirectory':
          await this._handleListDirectory(data.path);
          break;
        case 'navigateUp':
          await this._handleNavigateUp();
          break;
        case 'refresh':
          await this._handleRefresh();
          break;
        case 'preview':
          await this._handlePreview(data.path, data.name);
          break;
        case 'download':
          await this._handleDownload(data.path);
          break;
        case 'delete':
          await this._handleDelete(data.path, data.isDirectory);
          break;
        case 'mkdir':
          await this._handleMkdir(data.name);
          break;
        case 'rename':
          await this._handleRename(data.path, data.newName);
          break;
        case 'chmod':
          await this._handleChmod(data.path, data.mode);
          break;
        case 'duplicate':
          await this._handleDuplicate(data.path, data.name);
          break;
        case 'selectFile':
          await this._handleSelectFile(data.path, data.ctrlKey, data.shiftKey);
          break;
        case 'changeView':
          this._handleChangeView(data.viewMode);
          break;
        case 'uploadFiles':
          await this._handleUploadFiles(data.files);
          break;
        case 'openLocal':
          await this._openLocalFile(data.localPath);
          break;
        case 'openFile':
          await this._openFileInEditor(data.path, data.name);
          break;
      }
    });

    this._checkConnectionStatus();
  }

  private async _checkConnectionStatus() {
    if (!this._view) return;

    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) {
      this._view.webview.postMessage({ type: 'noWorkspace' });
      return;
    }

    // Check for active connections
    const configs = configManager.getConfigs(workspaceRoot);
    for (const config of configs) {
      if (connectionManager.isConnected(config)) {
        this._currentConfig = config;
        this._connection = connectionManager.getConnection(config);
        if (this._connection) {
          this._currentPath = config.remotePath;
          this._view.webview.postMessage({
            type: 'connected',
            host: config.host,
            path: this._currentPath,
            protocol: config.protocol
          });
          await this._handleListDirectory(this._currentPath);
          return;
        }
      }
    }

    this._view.webview.postMessage({ type: 'disconnected' });
  }

  public refresh() {
    this._checkConnectionStatus();
  }

  public async connectToConfig(config: FTPConfig) {
    if (!this._view || !config) return;

    this._currentConfig = config;

    try {
      this._view.webview.postMessage({ type: 'connecting' });
      this._connection = await connectionManager.connect(config);
      vscode.window.showInformationMessage(`StackerFTP: Connected to ${config.name || config.host}`);
      this._currentPath = config.remotePath;

      this._view.webview.postMessage({
        type: 'connected',
        host: config.host,
        path: this._currentPath,
        protocol: config.protocol
      });

      await this._handleListDirectory(this._currentPath);
    } catch (error: any) {
      this._view.webview.postMessage({
        type: 'error',
        message: `Connection failed: ${error.message}`
      });
    }
  }

  public async handleDisconnect() {
    await this._handleDisconnect();
  }

  private _getCodiconsUri(webview: vscode.Webview): vscode.Uri {
    return webview.asWebviewUri(vscode.Uri.joinPath(
      this._extensionUri,
      'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'
    ));
  }

  private async _sendConfigs() {
    if (!this._view) return;

    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) {
      this._view.webview.postMessage({ type: 'noWorkspace' });
      return;
    }

    const configs = configManager.getConfigs(workspaceRoot);
    this._view.webview.postMessage({
      type: 'configs',
      configs: configs.map(c => ({
        name: c.name || c.host,
        host: c.host,
        protocol: c.protocol,
        username: c.username,
        remotePath: c.remotePath
      }))
    });
  }

  private async _handleConnect(configIndex: number) {
    if (!this._view) return;

    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (configIndex >= configs.length) return;

    this._currentConfig = configs[configIndex];

    try {
      this._view.webview.postMessage({ type: 'connecting' });
      this._connection = await connectionManager.connect(this._currentConfig);
      vscode.window.showInformationMessage(`StackerFTP: Connected to ${this._currentConfig.name || this._currentConfig.host}`);
      this._currentPath = this._currentConfig.remotePath;

      this._view.webview.postMessage({
        type: 'connected',
        host: this._currentConfig.host,
        path: this._currentPath,
        protocol: this._currentConfig.protocol
      });

      await this._handleListDirectory(this._currentPath);
    } catch (error: any) {
      this._view.webview.postMessage({
        type: 'error',
        message: `Connection failed: ${error.message}`
      });
    }
  }

  private async _handleDisconnect() {
    if (this._currentConfig) {
      await connectionManager.disconnect(this._currentConfig);
      this._connection = undefined;
      this._currentPath = '';
      this._fileCache.clear();
      this._selectedFiles.clear();

      this._view?.webview.postMessage({ type: 'disconnected' });
    }
  }

  private async _handleListDirectory(dirPath: string) {
    if (!this._connection || !this._view) return;

    try {
      this._view.webview.postMessage({ type: 'loading' });
      this._selectedFiles.clear();

      const entries = await this._connection.list(dirPath);
      this._currentPath = dirPath;
      this._fileCache.set(dirPath, entries);

      const files = entries.filter(e => e.type === 'file');
      const dirs = entries.filter(e => e.type === 'directory');
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);

      this._view.webview.postMessage({
        type: 'directoryList',
        path: dirPath,
        entries: entries.map(e => ({
          name: e.name,
          type: e.type,
          size: e.size,
          sizeFormatted: formatFileSize(e.size),
          modifyTime: e.modifyTime.toISOString(),
          modifyTimeFormatted: formatDate(e.modifyTime),
          path: e.path,
          permissions: e.rights ? `${e.rights.user}${e.rights.group}${e.rights.other}` : '---',
          ext: path.extname(e.name).toLowerCase()
        })),
        stats: {
          fileCount: files.length,
          dirCount: dirs.length,
          totalSize: formatFileSize(totalSize)
        }
      });
    } catch (error: any) {
      this._view.webview.postMessage({
        type: 'error',
        message: `Failed to list directory: ${error.message}`
      });
    }
  }

  private async _handleNavigateUp() {
    if (!this._currentPath) return;
    const parentPath = normalizeRemotePath(path.dirname(this._currentPath));
    if (parentPath && parentPath !== this._currentPath) {
      await this._handleListDirectory(parentPath);
    }
  }

  private async _handleRefresh() {
    if (this._currentPath) {
      await this._handleListDirectory(this._currentPath);
    }
  }

  private async _handlePreview(filePath: string, fileName: string) {
    if (!this._connection) return;

    try {
      const ext = path.extname(fileName).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp'].includes(ext);
      const isText = !isImage && !['.zip', '.tar', '.gz', '.rar', '.exe', '.dll', '.so'].includes(ext);

      if (isImage) {
        const buffer = await this._connection.readFile(filePath);
        const base64 = buffer.toString('base64');
        const mimeType = this._getMimeType(ext);
        this._view?.webview.postMessage({
          type: 'preview',
          previewType: 'image',
          content: `data:${mimeType};base64,${base64}`,
          fileName
        });
      } else if (isText) {
        const buffer = await this._connection.readFile(filePath);
        const content = buffer.toString('utf-8');
        const maxLength = 10000;
        this._view?.webview.postMessage({
          type: 'preview',
          previewType: 'text',
          content: content.length > maxLength ? content.substring(0, maxLength) + '\n\n... (truncated)' : content,
          fileName,
          language: ext
        });
      } else {
        vscode.window.showInformationMessage('Preview not available for this file type');
      }
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'error', message: `Preview failed: ${error.message}` });
    }
  }

  private _getMimeType(ext: string): string {
    const mimeTypes: { [key: string]: string } = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  private async _handleDownload(remotePath: string) {
    if (!this._connection) return;

    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return;

    try {
      const relativePath = this._currentConfig ?
        path.relative(this._currentConfig.remotePath, remotePath) :
        path.basename(remotePath);
      const localPath = path.join(workspaceRoot, relativePath);

      await transferManager.downloadFile(this._connection, remotePath, localPath);
      this._view?.webview.postMessage({ type: 'downloadComplete', localPath });
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'error', message: `Download failed: ${error.message}` });
    }
  }

  private async _handleDelete(filePath: string, isDirectory: boolean) {
    if (!this._connection) return;

    const confirm = await vscode.window.showWarningMessage(
      `Delete ${path.basename(filePath)}?`,
      { modal: true },
      'Delete', 'Cancel'
    );

    if (confirm !== 'Delete') return;

    try {
      if (isDirectory) {
        await this._connection.rmdir(filePath, true);
      } else {
        await this._connection.delete(filePath);
      }
      await this._handleRefresh();
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'error', message: `Delete failed: ${error.message}` });
    }
  }

  private async _handleMkdir(name: string) {
    if (!this._connection) return;

    try {
      const newPath = normalizeRemotePath(path.join(this._currentPath, name));
      await this._connection.mkdir(newPath);
      await this._handleRefresh();
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'error', message: `Create folder failed: ${error.message}` });
    }
  }

  private async _handleRename(oldPath: string, newName: string) {
    if (!this._connection) return;

    try {
      const newPath = normalizeRemotePath(path.join(path.dirname(oldPath), newName));
      await this._connection.rename(oldPath, newPath);
      await this._handleRefresh();
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'error', message: `Rename failed: ${error.message}` });
    }
  }

  private async _handleChmod(filePath: string, mode: string) {
    if (!this._connection) return;

    try {
      await this._connection.chmod(filePath, parseInt(mode, 8));
      await this._handleRefresh();
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'error', message: `Chmod failed: ${error.message}` });
    }
  }

  private async _handleDuplicate(filePath: string, fileName: string) {
    if (!this._connection) return;

    try {
      const content = await this._connection.readFile(filePath);

      const ext = path.extname(fileName);
      const base = path.basename(fileName, ext);
      const newName = `${base}_copy${ext}`;
      const newPath = normalizeRemotePath(path.join(path.dirname(filePath), newName));

      await this._connection.writeFile(newPath, content);
      await this._handleRefresh();

      vscode.window.showInformationMessage(`Duplicated: ${newName}`);
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'error', message: `Duplicate failed: ${error.message}` });
    }
  }

  private async _handleSelectFile(filePath: string, ctrlKey: boolean, shiftKey: boolean) {
    if (shiftKey && this._selectedFiles.size > 0) {
      const files = Array.from(this._fileCache.get(this._currentPath) || []);
      const lastSelected = Array.from(this._selectedFiles).pop();
      const lastIndex = files.findIndex(f => f.path === lastSelected);
      const currentIndex = files.findIndex(f => f.path === filePath);

      const [start, end] = lastIndex < currentIndex ? [lastIndex, currentIndex] : [currentIndex, lastIndex];
      for (let i = start; i <= end; i++) {
        this._selectedFiles.add(files[i].path);
      }
    } else if (ctrlKey) {
      if (this._selectedFiles.has(filePath)) {
        this._selectedFiles.delete(filePath);
      } else {
        this._selectedFiles.add(filePath);
      }
    } else {
      this._selectedFiles.clear();
      this._selectedFiles.add(filePath);

      // Auto-preview on single click for files
      const entry = this._fileCache.get(this._currentPath)?.find(f => f.path === filePath);
      if (entry && entry.type === 'file') {
        await this._handlePreview(filePath, entry.name);
      }
    }

    this._view?.webview.postMessage({
      type: 'selectionChange',
      selectedFiles: Array.from(this._selectedFiles)
    });
  }

  private _handleChangeView(viewMode: 'list' | 'grid' | 'details') {
    this._view?.webview.postMessage({ type: 'viewModeChanged', viewMode });
  }

  private async _handleUploadFiles(files: { name: string, content: string }[]) {
    if (!this._connection || !this._currentConfig) return;

    try {
      for (const file of files) {
        const remotePath = normalizeRemotePath(path.join(this._currentPath, file.name));
        const buffer = Buffer.from(file.content, 'base64');
        await this._connection.writeFile(remotePath, buffer);
      }
      await this._handleRefresh();
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'error', message: `Upload failed: ${error.message}` });
    }
  }

  private async _openLocalFile(localPath: string) {
    const doc = await vscode.workspace.openTextDocument(localPath);
    await vscode.window.showTextDocument(doc);
  }

  private async _openFileInEditor(filePath: string, fileName: string) {
    if (!this._connection || !this._currentConfig) return;

    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return;

    try {
      // Show inline loading state on the specific file
      this._view?.webview.postMessage({ type: 'fileLoading', path: filePath, loading: true });

      // Calculate local path (mirror remote structure in workspace)
      const relativePath = path.relative(this._currentConfig.remotePath, filePath);
      const localPath = path.join(workspaceRoot, relativePath);
      const localDir = path.dirname(localPath);

      // Ensure local directory exists
      if (!require('fs').existsSync(localDir)) {
        require('fs').mkdirSync(localDir, { recursive: true });
      }

      // Download file to workspace
      await this._connection.download(filePath, localPath);

      // Open the local file in VS Code editor
      const localUri = vscode.Uri.file(localPath);
      const doc = await vscode.workspace.openTextDocument(localUri);

      await vscode.window.showTextDocument(doc, {
        preview: true,  // Preview mode - single click opens in preview
        viewColumn: vscode.ViewColumn.One
      });

      // Hide inline loading state
      this._view?.webview.postMessage({ type: 'fileLoading', path: filePath, loading: false });

      logger.info(`Opened remote file: ${filePath} -> ${localPath}`);

    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'fileLoading', path: filePath, loading: false });
      this._view?.webview.postMessage({ type: 'error', message: `Failed to open file: ${error.message}` });
      vscode.window.showErrorMessage(`Failed to open file: ${error.message}`);
    }
  }

  private _getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const codiconsUri = this._getCodiconsUri(webview);
    const connectIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'connect.png'));
    const disconnectIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'disconnect.png'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StackerFTP Remote Explorer</title>
  <link rel="stylesheet" href="${codiconsUri}">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    
    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      flex-shrink: 0;
    }
    
    .header-logo {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--vscode-foreground);
      opacity: 0.9;
    }

    .header-title {
      flex: 1;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      opacity: 0.85;
      color: var(--vscode-foreground);
    }
    
    /* Breadcrumb Bar */
    .breadcrumb-bar {
      padding: 6px 12px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    
    .breadcrumb {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--vscode-editor-font-family);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    
    /* Toolbar */
    .toolbar {
      display: flex;
      gap: 2px;
      padding: 4px 8px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    
    .toolbar-group {
      display: flex;
      gap: 2px;
    }
    
    .toolbar-separator {
      width: 1px;
      background: var(--vscode-panel-border);
      margin: 2px 4px;
    }
    
    .btn {
      padding: 4px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      min-height: 24px;
      transition: background 0.1s;
    }
    
    .btn:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground);
    }
    
    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    
    .btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    
    .btn i, .btn img {
      font-size: 14px;
    }
    
    /* File List Container */
    .file-list-container {
      flex: 1;
      overflow: auto;
      position: relative;
    }
    
    /* File List Header */
    .file-list-header {
      display: flex;
      padding: 4px 12px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    
    .col-name { flex: 1; min-width: 100px; }
    .col-size { width: 70px; text-align: right; }
    .col-date { width: 80px; text-align: right; }
    
    /* File List */
    .file-list {
      list-style: none;
    }
    
    .file-item {
      display: flex;
      align-items: center;
      padding: 4px 12px;
      cursor: pointer;
      transition: background 0.05s;
      user-select: none;
      font-size: 12px;
    }
    
    .file-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    
    .file-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    
    .file-item.drag-over {
      background: var(--vscode-list-dropBackground);
    }
    
    .file-item i {
      font-size: 14px;
      margin-right: 6px;
      flex-shrink: 0;
    }
    
    .file-name {
      flex: 1;
      min-width: 100px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
    }
    
    .file-size {
      width: 70px;
      text-align: right;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-family: var(--vscode-editor-font-family);
    }
    
    .file-date {
      width: 80px;
      text-align: right;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }
    
    .file-item.selected .file-size,
    .file-item.selected .file-date {
      color: inherit;
      opacity: 0.8;
    }
    
    /* Inline Loading */
    .file-item.loading {
      opacity: 0.7;
      pointer-events: none;
    }
    
    .inline-spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-left: 8px;
      vertical-align: middle;
    }
    
    /* Empty State */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    
    .empty-state i {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.3;
    }
    
    .empty-state h3 {
      font-weight: 400;
      font-size: 14px;
      margin-bottom: 8px;
    }
    
    .empty-state p {
      font-size: 12px;
      opacity: 0.8;
    }
    
    /* Loading */
    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
    }
    
    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 12px;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    /* Stats Footer */
    .stats-footer {
      padding: 6px 12px;
      background: var(--vscode-editor-background);
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      justify-content: space-between;
      flex-shrink: 0;
    }
    
    /* Context Menu */
    .context-menu {
      position: absolute;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      z-index: 1000;
      min-width: 160px;
      display: none;
    }
    
    .context-menu.visible {
      display: block;
    }
    
    .context-menu-item {
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--vscode-menu-foreground);
    }
    
    .context-menu-item:hover {
      background: var(--vscode-menu-selectionBackground);
      color: var(--vscode-menu-selectionForeground);
    }
    
    .context-menu-item i {
      font-size: 14px;
    }
    
    .context-menu-separator {
      height: 1px;
      background: var(--vscode-menu-separatorBackground);
      margin: 4px 0;
    }
    
    /* Dialog */
    .dialog-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    }
    
    .dialog-overlay.visible {
      display: flex;
    }
    
    .dialog {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 16px;
      min-width: 300px;
      max-width: 90%;
    }
    
    .dialog h3 {
      margin-bottom: 12px;
      font-size: 14px;
      font-weight: 600;
    }
    
    .dialog input {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      margin-bottom: 12px;
      font-size: 12px;
      outline: none;
    }
    
    .dialog input:focus {
      border-color: var(--vscode-focusBorder);
    }
    
    .dialog-buttons {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    
    .dialog .btn {
      padding: 4px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
    }
    
    .dialog .btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    
    /* Drop Zone */
    .drop-zone {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--vscode-list-dropBackground);
      border: 2px dashed var(--vscode-focusBorder);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 50;
      flex-direction: column;
      gap: 12px;
    }
    
    .drop-zone.visible {
      display: flex;
    }
    
    .drop-zone i {
      font-size: 48px;
      opacity: 0.5;
    }
    
    .drop-zone p {
      font-size: 14px;
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <div id="app">
    <div class="header">
      <div class="header-logo">
        <span class="codicon codicon-remote-explorer"></span>
      </div>
      <div class="header-title">STACKER FTP</div>
      <div class="header-actions">
        <button class="btn" title="Refresh" onclick="vscode.postMessage({type:'refresh'})">
          <span class="codicon codicon-refresh"></span>
        </button>
      </div>
    </div>

    <!-- Breadcrumb -->
    <div class="breadcrumb-bar">
      <div class="breadcrumb" id="breadcrumb">
        <i class="codicon codicon-folder"></i>
        <span id="breadcrumbText">Not connected</span>
      </div>
    </div>
    
    <!-- Toolbar -->
    <div class="toolbar" id="toolbar">
      <div class="toolbar-group">
        <button class="btn" id="btnRefresh" title="Refresh" disabled>
          <span class="codicon codicon-refresh"></span>
        </button>
        <button class="btn" id="btnUp" title="Parent Directory" disabled>
          <i class="codicon codicon-arrow-up"></i>
        </button>
      </div>
      <div class="toolbar-separator"></div>
      <div class="toolbar-group">
        <button class="btn" id="btnNewFolder" title="New Folder" disabled>
          <i class="codicon codicon-new-folder"></i>
        </button>
        <button class="btn" id="btnUpload" title="Upload Files" disabled>
          <span class="codicon codicon-cloud-upload"></span>
        </button>
      </div>
    </div>
    
    <!-- File List Container -->
    <div class="file-list-container" id="fileListContainer">
      <!-- Header -->
      <div class="file-list-header" id="listHeader" style="display:none;">
        <span class="col-name">Name</span>
        <span class="col-size">Size</span>
        <span class="col-date">Modified</span>
      </div>
      
      <!-- Empty State -->
      <div class="empty-state" id="emptyState">
        <i class="codicon codicon-plug"></i>
        <h3>Not Connected</h3>
        <p>Connect from the Connections panel above</p>
      </div>
      
      <!-- File List -->
      <ul class="file-list" id="fileList" style="display:none;"></ul>
      
      <!-- Loading -->
      <div class="loading" id="loading" style="display:none;">
        <div class="spinner"></div>
        <p>Loading...</p>
      </div>
      
      <!-- Drop Zone -->
      <div class="drop-zone" id="dropZone">
        <i class="codicon codicon-cloud-upload"></i>
        <p>Drop files here to upload</p>
      </div>
    </div>
    
    <!-- Stats Footer -->
    <div class="stats-footer" id="statsFooter" style="display:none;">
      <span id="fileCount">0 items</span>
      <span id="totalSize">0 B</span>
    </div>
  </div>
  
  <!-- Context Menu -->
  <div class="context-menu" id="contextMenu">
    <div class="context-menu-item" data-action="open">
      <i class="codicon codicon-file-code"></i>
      Open
    </div>
    <div class="context-menu-item" data-action="download">
      <i class="codicon codicon-cloud-download"></i>
      Download
    </div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-action="rename">
      <i class="codicon codicon-edit"></i>
      Rename
    </div>
    <div class="context-menu-item" data-action="duplicate">
      <i class="codicon codicon-files"></i>
      Duplicate
    </div>
    <div class="context-menu-item" data-action="chmod">
      <i class="codicon codicon-lock"></i>
      Permissions
    </div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-action="delete">
      <i class="codicon codicon-trash"></i>
      Delete
    </div>
  </div>
  
  <!-- Dialog -->
  <div class="dialog-overlay" id="dialogOverlay">
    <div class="dialog">
      <h3 id="dialogTitle">Input</h3>
      <input type="text" id="dialogInput" placeholder="Enter value...">
      <div class="dialog-buttons">
        <button class="btn secondary" id="dialogCancel">Cancel</button>
        <button class="btn" id="dialogOk">OK</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    
    // State
    let currentPath = '';
    let isConnected = false;
    let contextMenuTarget = null;
    let selectedFiles = new Set();
    let currentEntries = [];
    let viewMode = 'list';
    
    // Elements
    const breadcrumbText = document.getElementById('breadcrumbText');
    const emptyState = document.getElementById('emptyState');
    const fileList = document.getElementById('fileList');
    const listHeader = document.getElementById('listHeader');
    const loading = document.getElementById('loading');
    const statsFooter = document.getElementById('statsFooter');
    const contextMenu = document.getElementById('contextMenu');
    const dropZone = document.getElementById('dropZone');
    const dialogOverlay = document.getElementById('dialogOverlay');
    const dialogInput = document.getElementById('dialogInput');
    
    // Buttons
    const btnRefresh = document.getElementById('btnRefresh');
    const btnUp = document.getElementById('btnUp');
    const btnNewFolder = document.getElementById('btnNewFolder');
    const btnUpload = document.getElementById('btnUpload');
    
    // Button event listeners
    btnRefresh.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
    
    btnUp.addEventListener('click', () => {
      vscode.postMessage({ type: 'navigateUp' });
    });
    
    btnNewFolder.addEventListener('click', () => {
      showDialog('New Folder', 'Enter folder name:', (name) => {
        if (name) vscode.postMessage({ type: 'mkdir', name });
      });
    });
    
    btnUpload.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = (e) => {
        const files = e.target.files;
        if (files.length > 0) {
          handleFileUpload(files);
        }
      };
      input.click();
    });
    
    // Drag and Drop
    const fileListContainer = document.getElementById('fileListContainer');
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      fileListContainer.addEventListener(eventName, preventDefaults, false);
    });
    
    function preventDefaults(e) {
      e.preventDefault();
      e.stopPropagation();
    }
    
    ['dragenter', 'dragover'].forEach(eventName => {
      fileListContainer.addEventListener(eventName, () => {
        if (isConnected) dropZone.classList.add('visible');
      }, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        if (e.target === dropZone) dropZone.classList.remove('visible');
      }, false);
    });
    
    dropZone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const files = dt.files;
      handleFileUpload(files);
    });
    
    function handleFileUpload(files) {
      const fileArray = Array.from(files);
      const readers = fileArray.map(file => {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            resolve({
              name: file.name,
              content: e.target.result.split(',')[1]
            });
          };
          reader.readAsDataURL(file);
        });
      });
      
      Promise.all(readers).then(results => {
        vscode.postMessage({ type: 'uploadFiles', files: results });
      });
    }
    
    // Context Menu
    document.addEventListener('click', (e) => {
      if (!contextMenu.contains(e.target)) {
        contextMenu.classList.remove('visible');
      }
    });
    
    contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        handleContextAction(action, contextMenuTarget);
        contextMenu.classList.remove('visible');
      });
    });
    
    function handleContextAction(action, target) {
      if (!target) return;
      
      switch (action) {
        case 'open':
          if (target.type === 'file') {
            vscode.postMessage({ type: 'openFile', path: target.path, name: target.name });
          } else {
            vscode.postMessage({ type: 'listDirectory', path: target.path });
          }
          break;
        case 'download':
          vscode.postMessage({ type: 'download', path: target.path });
          break;
        case 'rename':
          showDialog('Rename', 'Enter new name:', (newName) => {
            if (newName && newName !== target.name) {
              vscode.postMessage({ type: 'rename', path: target.path, newName });
            }
          }, target.name);
          break;
        case 'duplicate':
          if (target.type === 'file') {
            vscode.postMessage({ type: 'duplicate', path: target.path, name: target.name });
          }
          break;
        case 'chmod':
          showDialog('Permissions', 'Enter permissions (e.g., 755):', (mode) => {
            if (mode) vscode.postMessage({ type: 'chmod', path: target.path, mode });
          });
          break;
        case 'delete':
          vscode.postMessage({ type: 'delete', path: target.path, isDirectory: target.type === 'directory' });
          break;
      }
    }
    
    // Dialog
    let dialogCallback = null;
    
    function showDialog(title, placeholder, callback, value = '') {
      document.getElementById('dialogTitle').textContent = title;
      dialogInput.placeholder = placeholder;
      dialogInput.value = value;
      dialogCallback = callback;
      dialogOverlay.classList.add('visible');
      dialogInput.focus();
      dialogInput.select();
    }
    
    document.getElementById('dialogOk').addEventListener('click', () => {
      if (dialogCallback) {
        dialogCallback(dialogInput.value);
        dialogCallback = null;
      }
      dialogOverlay.classList.remove('visible');
    });
    
    document.getElementById('dialogCancel').addEventListener('click', () => {
      dialogCallback = null;
      dialogOverlay.classList.remove('visible');
    });
    
    dialogInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') document.getElementById('dialogOk').click();
      if (e.key === 'Escape') document.getElementById('dialogCancel').click();
    });
    
    // Message Handler
    window.addEventListener('message', event => {
      const msg = event.data;
      
      switch (msg.type) {
        case 'noWorkspace':
          showNoWorkspace();
          break;
        case 'connecting':
          showLoading('Connecting...');
          break;
        case 'connected':
          setConnected(true, msg.host, msg.path, msg.protocol);
          break;
        case 'disconnected':
          setConnected(false);
          break;
        case 'directoryList':
          showFileList(msg.entries, msg.path, msg.stats);
          break;
        case 'loading':
          showLoading('Loading...');
          break;
        case 'fileLoading':
          setFileLoading(msg.path, msg.loading);
          break;
        case 'error':
          showError(msg.message);
          break;
        case 'selectionChange':
          updateSelection(msg.selectedFiles);
          break;
        case 'viewModeChanged':
          viewMode = msg.viewMode;
          break;
      }
    });
    
    // Functions
    function setFileLoading(filePath, isLoading) {
      const fileItem = document.querySelector(\`.file-item[data-path="\${filePath}"]\`);
      if (fileItem) {
        if (isLoading) {
          fileItem.classList.add('loading');
          const nameSpan = fileItem.querySelector('.file-name');
          if (nameSpan && !nameSpan.querySelector('.inline-spinner')) {
            const spinner = document.createElement('span');
            spinner.className = 'inline-spinner';
            nameSpan.appendChild(spinner);
          }
        } else {
          fileItem.classList.remove('loading');
          const spinner = fileItem.querySelector('.inline-spinner');
          if (spinner) spinner.remove();
        }
      }
    }
    
    function showNoWorkspace() {
      emptyState.innerHTML = '<i class="codicon codicon-folder"></i><h3>No Workspace</h3><p>Open a folder to use StackerFTP</p>';
      emptyState.style.display = 'flex';
      fileList.style.display = 'none';
      listHeader.style.display = 'none';
    }
    
    function setConnected(connected, host = '', path = '', protocol = '') {
      isConnected = connected;
      
      if (connected) {
        breadcrumbText.textContent = path || '/';
        currentPath = path;
        
        btnRefresh.disabled = false;
        btnUp.disabled = false;
        btnNewFolder.disabled = false;
        btnUpload.disabled = false;
      } else {
        breadcrumbText.textContent = 'Not connected';
        currentPath = '';
        selectedFiles.clear();
        
        btnRefresh.disabled = true;
        btnUp.disabled = true;
        btnNewFolder.disabled = true;
        btnUpload.disabled = true;
        
        emptyState.style.display = 'flex';
        fileList.style.display = 'none';
        listHeader.style.display = 'none';
        statsFooter.style.display = 'none';
      }
    }
    
    function showLoading(text) {
      loading.querySelector('p').textContent = text;
      loading.style.display = 'flex';
      emptyState.style.display = 'none';
      fileList.style.display = 'none';
      listHeader.style.display = 'none';
    }
    
    function showFileList(entries, path, stats) {
      loading.style.display = 'none';
      emptyState.style.display = 'none';
      fileList.style.display = 'block';
      listHeader.style.display = 'flex';
      statsFooter.style.display = 'flex';
      
      currentEntries = entries;
      selectedFiles.clear();
      
      fileList.innerHTML = '';
      
      // Sort: directories first, then files
      entries.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'directory' ? -1 : 1;
      });
      
      entries.forEach(entry => {
        const li = document.createElement('li');
        li.className = 'file-item';
        li.dataset.path = entry.path;
        
        const iconClass = getFileIconClass(entry.name, entry.type);
        
        li.innerHTML = \`
          <span class="file-name">
            <i class="codicon \${iconClass}"></i>
            \${escapeHtml(entry.name)}
          </span>
          <span class="file-size">\${entry.type === 'file' ? entry.sizeFormatted : ''}</span>
          <span class="file-date">\${entry.modifyTimeFormatted.split(' ')[0]}</span>
        \`;
        
        // Selection with auto-preview
        li.addEventListener('click', (e) => {
          vscode.postMessage({
            type: 'selectFile',
            path: entry.path,
            ctrlKey: e.ctrlKey || e.metaKey,
            shiftKey: e.shiftKey
          });
        });
        
        // Double click to open files or navigate folders
        li.addEventListener('dblclick', () => {
          if (entry.type === 'directory') {
            vscode.postMessage({ type: 'listDirectory', path: entry.path });
          } else {
            // Open file in editor
            vscode.postMessage({ type: 'openFile', path: entry.path, name: entry.name });
          }
        });
        
        // Context menu
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          contextMenuTarget = entry;
          contextMenu.style.left = e.pageX + 'px';
          contextMenu.style.top = e.pageY + 'px';
          contextMenu.classList.add('visible');
        });
        
        fileList.appendChild(li);
      });
      
      document.getElementById('fileCount').textContent = \`\${stats.fileCount + stats.dirCount} items\`;
      document.getElementById('totalSize').textContent = stats.totalSize;
    }
    
    function updateSelection(selectedPaths) {
      selectedFiles = new Set(selectedPaths);
      document.querySelectorAll('.file-item').forEach(item => {
        if (selectedFiles.has(item.dataset.path)) {
          item.classList.add('selected');
        } else {
          item.classList.remove('selected');
        }
      });
    }
    
    function showError(message) {
      hideLoading();
      console.error(message);
    }
    
    function hideLoading() {
      loading.style.display = 'none';
    }
    
    function getFileIconClass(filename, type) {
      if (type === 'directory') return 'codicon-folder';
      
      const ext = filename.split('.').pop()?.toLowerCase();
      const iconMap = {
        'js': 'codicon-file-code',
        'ts': 'codicon-file-code',
        'jsx': 'codicon-file-code',
        'tsx': 'codicon-file-code',
        'html': 'codicon-file-code',
        'css': 'codicon-file-code',
        'scss': 'codicon-file-code',
        'less': 'codicon-file-code',
        'json': 'codicon-file-json',
        'md': 'codicon-file-text',
        'txt': 'codicon-file-text',
        'pdf': 'codicon-file-pdf',
        'zip': 'codicon-file-zip',
        'tar': 'codicon-file-zip',
        'gz': 'codicon-file-zip',
        'jpg': 'codicon-file-media',
        'jpeg': 'codicon-file-media',
        'png': 'codicon-file-media',
        'gif': 'codicon-file-media',
        'svg': 'codicon-file-media',
        'mp3': 'codicon-file-media',
        'mp4': 'codicon-file-media',
        'php': 'codicon-file-code',
        'py': 'codicon-file-code',
        'rb': 'codicon-file-code',
        'java': 'codicon-file-code',
        'go': 'codicon-file-code',
        'rs': 'codicon-file-code',
        'sql': 'codicon-database',
        'xml': 'codicon-file-code',
        'yml': 'codicon-file-code',
        'yaml': 'codicon-file-code',
        'sh': 'codicon-terminal',
        'log': 'codicon-output'
      };
      return iconMap[ext] || 'codicon-file';
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    // Check connection status on load
    vscode.postMessage({ type: 'checkConnection' });
  </script>
</body>
</html>`;
  }
}
