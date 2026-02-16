/**
 * StackerFTP - Compare View WebView Provider
 *
 * Provides a split-view interface for comparing local and remote folders
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { transferManager } from '../core/transfer-manager';
import { webMasterTools } from '../webmaster/tools';
import { getWorkspaceRoot } from '../commands/utils';
import { CompareResult, CompareTreeNode, CompareItem } from '../types';
import { formatFileSize, formatDate, normalizeRemotePath, sanitizeRelativePath } from '../utils/helpers';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';

export class CompareViewProvider {
  public static readonly viewType = 'stackerftp.compareView';

  private _panel?: vscode.WebviewPanel;
  private _extensionUri: vscode.Uri;
  private _compareResult?: CompareResult;
  private _workspaceRoot?: string;
  private _originalWorkspaceRoot?: string;
  private _config?: any;
  private _connection?: any;
  private _filter: 'all' | 'local' | 'remote' | 'different' = 'all';
  private _searchQuery: string = '';
  private _expandedFolders: Set<string> = new Set();
  private _isComparing: boolean = false;

  constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
  }

  /**
   * Open the compare view panel
   */
  public async show(localPath?: string): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    // Allow user to select a local folder if not provided
    let selectedLocalPath = localPath;
    if (!selectedLocalPath) {
      const selected = await vscode.window.showOpenDialog({
        title: 'Select Local Folder to Compare',
        defaultUri: vscode.Uri.file(workspaceRoot),
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false
      });

      if (!selected || selected.length === 0) {
        return; // User cancelled
      }

      selectedLocalPath = selected[0].fsPath;
    }

    // Store original workspace root for path calculations
    this._workspaceRoot = selectedLocalPath;
    this._config = config;
    this._originalWorkspaceRoot = workspaceRoot;

    // Reset state for new comparison
    this._compareResult = undefined;
    this._expandedFolders.clear();
    this._searchQuery = '';
    this._filter = 'all';
    this._isComparing = true;

    // Always create a fresh panel
    if (this._panel) {
      this._panel.dispose();
    }

    this._panel = vscode.window.createWebviewPanel(
      CompareViewProvider.viewType,
      'Compare Folders',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: false
      }
    );

    this._panel.onDidDispose(() => {
      this._panel = undefined;
      this._isComparing = false;
    });

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(async (data) => {
      await this._handleMessage(data);
    });

    // Show loading state immediately
    this._panel.webview.html = this._getLoadingHtml('Connecting to server...');

    // Calculate the remote path based on selected local folder
    const originalWorkspace = this._originalWorkspaceRoot || workspaceRoot;
    let remotePath = config.remotePath;
    if (this._workspaceRoot && this._workspaceRoot !== originalWorkspace && this._workspaceRoot.startsWith(originalWorkspace)) {
      const relativePath = path.relative(originalWorkspace, this._workspaceRoot);
      remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));
    }

    try {
      // Ensure connection
      const connection = await connectionManager.ensureConnection(config);
      this._connection = connection;

      // Start comparison with progress
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Comparing folders...',
        cancellable: false
      }, async (progress, token) => {
        // Check if cancelled or panel disposed
        if (token.isCancellationRequested || !this._panel) {
          this._isComparing = false;
          return;
        }

        progress.report({ message: 'Scanning files...' });

        this._compareResult = await webMasterTools.compareFolders(
          connection,
          this._workspaceRoot!,
          remotePath,
          {
            useMtime: true,
            onProgress: (message, increment) => {
              // Check if still valid
              if (!this._panel || !this._isComparing) return;
              progress.report({ message, increment });
            }
          }
        );

        // Mark as done
        this._isComparing = false;

        // Expand root by default
        this._expandedFolders.add('');

        // Update the view
        this._updateView();
      });

    } catch (error: any) {
      this._isComparing = false;
      // Only show error if panel still exists
      if (this._panel) {
        this._updateHtml(this._getErrorHtml(error.message));
      }
      logger.error('Compare folders failed', error);
    }
  }

  /**
   * Update the view with current filter and search
   */
  private _updateView(): void {
    if (!this._panel || !this._compareResult) return;

    const filteredTree = this._filterTree(this._compareResult.tree);
    const stats = this._getStats();

    this._updateHtml(this._getHtml(filteredTree, stats));
  }

  /**
   * Filter tree based on current filter and search
   */
  private _filterTree(node: CompareTreeNode): CompareTreeNode | null {
    const searchLower = this._searchQuery.toLowerCase();

    // Filter children first
    const filteredChildren: CompareTreeNode[] = [];
    for (const child of node.children) {
      const filteredChild = this._filterTree(child);
      if (filteredChild) {
        filteredChildren.push(filteredChild);
      }
    }

    // Check if this node matches filter
    let matchesFilter = false;
    const localItem = node.localItem;
    const remoteItem = node.remoteItem;

    if (localItem && this._filter === 'local') matchesFilter = true;
    if (remoteItem && this._filter === 'remote') matchesFilter = true;
    if ((localItem || remoteItem) && this._filter === 'different') {
      if (localItem?.side === 'different' || remoteItem?.side === 'different') {
        matchesFilter = true;
      }
    }
    if (this._filter === 'all') matchesFilter = true;

    // Check search query
    if (searchLower && !node.name.toLowerCase().includes(searchLower)) {
      // If no children match, filter out this node
      if (filteredChildren.length === 0 && !matchesFilter) {
        return null;
      }
      matchesFilter = true;
    }

    // Include if has matching children or matches filter
    if (filteredChildren.length > 0 || matchesFilter) {
      return {
        ...node,
        children: filteredChildren
      };
    }

    return null;
  }

  /**
   * Get statistics
   */
  private _getStats(): { onlyLocal: number; onlyRemote: number; different: number } {
    if (!this._compareResult) {
      return { onlyLocal: 0, onlyRemote: 0, different: 0 };
    }

    // Count items (not directories)
    const onlyLocal = this._compareResult.onlyLocal.filter(i => !i.path.endsWith('/')).length;
    const onlyRemote = this._compareResult.onlyRemote.filter(i => !i.path.endsWith('/')).length;
    const different = this._compareResult.different.filter(i => !i.path.endsWith('/')).length;

    return { onlyLocal, onlyRemote, different };
  }

  /**
   * Handle messages from webview
   */
  private _handleMessage = async (data: any): Promise<void> => {
    switch (data.type) {
      case 'setFilter':
        this._filter = data.filter;
        this._updateView();
        break;

      case 'search':
        this._searchQuery = data.query;
        this._updateView();
        break;

      case 'toggleFolder':
        this._toggleFolder(data.path);
        break;

      case 'showDiff':
        await this._showDiff(data.path);
        break;

      case 'upload':
        await this._uploadFile(data.path);
        break;

      case 'download':
        await this._downloadFile(data.path);
        break;

      case 'revealLocal':
        await this._revealLocal(data.path);
        break;

      case 'revealRemote':
        await this._revealRemote(data.path);
        break;

      case 'export':
        await this._exportResults(data.format);
        break;

      case 'refresh':
        await this._refresh();
        break;
    }
  };

  /**
   * Toggle folder expansion
   */
  private _toggleFolder(folderPath: string): void {
    if (this._expandedFolders.has(folderPath)) {
      this._expandedFolders.delete(folderPath);
    } else {
      this._expandedFolders.add(folderPath);
    }
    this._updateView();
  }

  /**
   * Show diff for a file
   */
  private async _showDiff(filePath: string): Promise<void> {
    if (!this._workspaceRoot || !this._config || !this._connection) return;

    const localPath = path.join(this._workspaceRoot, filePath);
    const remotePath = normalizeRemotePath(path.join(this._config.remotePath, filePath));

    // Check if local file exists
    if (!fs.existsSync(localPath)) {
      vscode.window.showErrorMessage('Local file not found. Download the file first to compare.');
      return;
    }

    try {
      // Download remote file to temp
      const tempDir = path.join(os.tmpdir(), 'stackerftp-compare');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempRemotePath = path.join(tempDir, `${Date.now()}-${path.basename(filePath)}`);

      await this._connection.download(remotePath, tempRemotePath);

      // Show diff
      const localUri = vscode.Uri.file(localPath);
      const remoteUri = vscode.Uri.file(tempRemotePath);

      await vscode.commands.executeCommand('vscode.diff', remoteUri, localUri,
        `${path.basename(filePath)} (Remote) ↔ ${path.basename(filePath)} (Local)`,
        { preview: true }
      );

    } catch (error: any) {
      vscode.window.showErrorMessage(`Diff failed: ${error.message}`);
    }
  }

  /**
   * Upload a file
   */
  private async _uploadFile(filePath: string): Promise<void> {
    if (!this._workspaceRoot || !this._config || !this._connection) return;

    const localPath = path.join(this._workspaceRoot, filePath);
    const remotePath = normalizeRemotePath(path.join(this._config.remotePath, filePath));

    try {
      // Ensure remote directory exists
      const remoteDir = normalizeRemotePath(path.dirname(remotePath));
      try {
        await this._connection.mkdir(remoteDir);
      } catch { }

      await transferManager.uploadFile(this._connection, localPath, remotePath, this._config);
      statusBar.success(`Uploaded: ${path.basename(filePath)}`);

      // Refresh comparison
      await this._refresh();

    } catch (error: any) {
      vscode.window.showErrorMessage(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Download a file
   */
  private async _downloadFile(filePath: string): Promise<void> {
    if (!this._workspaceRoot || !this._config || !this._connection) return;

    const localPath = path.join(this._workspaceRoot, filePath);
    const remotePath = normalizeRemotePath(path.join(this._config.remotePath, filePath));

    try {
      // Ensure local directory exists
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }

      await transferManager.downloadFile(this._connection, remotePath, localPath);
      statusBar.success(`Downloaded: ${path.basename(filePath)}`);

      // Refresh comparison
      await this._refresh();

    } catch (error: any) {
      vscode.window.showErrorMessage(`Download failed: ${error.message}`);
    }
  }

  /**
   * Reveal local file in explorer
   */
  private async _revealLocal(filePath: string): Promise<void> {
    if (!this._workspaceRoot) return;

    const localPath = path.join(this._workspaceRoot, filePath);

    if (fs.existsSync(localPath)) {
      await vscode.commands.executeCommand('revealFileInExplorer', vscode.Uri.file(localPath));
    } else {
      vscode.window.showErrorMessage('Local file not found');
    }
  }

  /**
   * Reveal remote file in remote explorer
   */
  private async _revealRemote(filePath: string): Promise<void> {
    if (!this._config) return;

    const remotePath = normalizeRemotePath(path.join(this._config.remotePath, filePath));

    // Focus on remote explorer and try to navigate
    await vscode.commands.executeCommand('stackerftp.remoteExplorerTree.focus');

    // Try to navigate to path if method exists
    // This is best-effort
    statusBar.success(`Remote path: ${remotePath}`);
  }

  /**
   * Export results
   */
  private async _exportResults(format: 'json' | 'csv'): Promise<void> {
    if (!this._compareResult) return;

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`compare-results.${format}`),
      filters: {
        [format.toUpperCase()]: [format]
      }
    });

    if (!uri) return;

    try {
      let content: string;

      if (format === 'json') {
        content = JSON.stringify({
          onlyLocal: this._compareResult.onlyLocal,
          onlyRemote: this._compareResult.onlyRemote,
          different: this._compareResult.different,
          exportedAt: new Date().toISOString()
        }, null, 2);
      } else {
        // CSV
        const lines = ['Type,Path,Size,Local Size,Remote Size,Local Mtime,Remote Mtime'];

        for (const item of this._compareResult.onlyLocal) {
          lines.push(`Local,${item.path},${item.size || ''},${item.size || ''},,${item.mtime || ''},`);
        }

        for (const item of this._compareResult.onlyRemote) {
          lines.push(`Remote,${item.path},${item.size || ''},,${item.size || ''},,${item.mtime || ''}`);
        }

        for (const item of this._compareResult.different) {
          lines.push(`Different,${item.path},,${item.localSize || ''},${item.remoteSize || ''},${item.localMtime || ''},${item.remoteMtime || ''}`);
        }

        content = lines.join('\n');
      }

      fs.writeFileSync(uri.fsPath, content);
      statusBar.success(`Exported to: ${uri.fsPath}`);

    } catch (error: any) {
      vscode.window.showErrorMessage(`Export failed: ${error.message}`);
    }
  }

  /**
   * Refresh comparison
   */
  private async _refresh(): Promise<void> {
    if (!this._workspaceRoot || !this._config || !this._connection) return;

    try {
      this._updateHtml(this._getLoadingHtml('Refreshing...'));

      this._compareResult = await webMasterTools.compareFolders(
        this._connection,
        this._workspaceRoot,
        this._config.remotePath,
        {
          useMtime: true,
          onProgress: (message) => {
            this._updateHtml(this._getLoadingHtml(message));
          }
        }
      );

      this._expandedFolders.clear();
      this._expandedFolders.add('');

      this._updateView();
      statusBar.success('Comparison refreshed');

    } catch (error: any) {
      this._updateHtml(this._getErrorHtml(error.message));
    }
  }

  /**
   * Update HTML content
   */
  private _updateHtml(html: string): void {
    if (this._panel) {
      this._panel.webview.html = html;
    }
  }

  /**
   * Get loading HTML
   */
  private _getLoadingHtml(message: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: var(--vscode-font-family);
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      color: var(--vscode-foreground);
    }
    .loading { text-align: center; }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-progressBar-background);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="loading">
    <div class="spinner"></div>
    <div>${message}</div>
  </div>
</body>
</html>`;
  }

  /**
   * Get error HTML
   */
  private _getErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-errorForeground);
    }
    .error { color: var(--vscode-errorForeground); }
    .retry {
      margin-top: 16px;
      padding: 8px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="error">
    <h3>Error</h3>
    <p>${message}</p>
    <button class="retry" onclick="vscode.postMessage({ type: 'refresh' })">Retry</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
  </script>
</body>
</html>`;
  }

  /**
   * Get the main HTML
   */
  private _getHtml(tree: CompareTreeNode | null, stats: { onlyLocal: number; onlyRemote: number; different: number }): string {
    const localRoot = this._workspaceRoot ? path.basename(this._workspaceRoot) : 'Local';
    const remoteRoot = this._config?.remotePath || '/';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }

    /* Toolbar */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-wrap: wrap;
    }

    .search-box {
      flex: 1;
      min-width: 200px;
      display: flex;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 4px 8px;
    }

    .search-box:focus-within {
      border-color: var(--vscode-focusBorder);
    }

    .search-box input {
      flex: 1;
      border: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      outline: none;
      font-size: 13px;
      caret-color: var(--vscode-input-foreground);
    }

    .search-box input:focus {
      outline: none;
    }

    .search-box input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .filter-btn {
      padding: 5px 12px;
      background: transparent;
      border: 1px solid var(--vscode-button-secondaryBackground);
      color: var(--vscode-foreground);
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
    }

    .filter-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .filter-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .export-btn {
      padding: 5px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .export-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    /* Main content */
    .main {
      display: flex;
      height: calc(100vh - 90px);
    }

    .panel {
      flex: 1;
      overflow: auto;
      padding: 8px;
    }

    .panel-header {
      font-weight: 600;
      padding: 8px 12px;
      background: var(--vscode-sideBar-sectionHeader-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .panel.local { border-right: 1px solid var(--vscode-panel-border); }

    /* Tree items */
    .tree-item {
      display: flex;
      align-items: center;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 13px;
      border-radius: 3px;
      margin: 1px 0;
    }

    .tree-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .tree-item.folder > .name {
      font-weight: 500;
    }

    .tree-item .icon {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 4px;
      font-size: 14px;
    }

    .tree-item .name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tree-item .size {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-right: 8px;
    }

    .tree-item .actions {
      display: none;
      gap: 4px;
    }

    .tree-item:hover .actions {
      display: flex;
    }

    .action-btn {
      padding: 2px 6px;
      background: var(--vscode-button-secondaryBackground);
      border: none;
      border-radius: 3px;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 11px;
    }

    .action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .action-btn.diff {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    /* Status colors */
    .status-local { color: #73c991; }
    .status-remote { color: #4fc1ff; }
    .status-different { color: #cca700; }
    .status-equal { color: #8c8c8c; }

    .bg-local { background: rgba(115, 201, 145, 0.1); }
    .bg-remote { background: rgba(79, 193, 255, 0.1); }
    .bg-different { background: rgba(204, 167, 0, 0.1); }

    /* Status bar */
    .status-bar {
      display: flex;
      justify-content: space-around;
      padding: 8px 16px;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 12px;
    }

    .status-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-count {
      font-weight: 600;
    }

    /* Indentation */
    .tree-children {
      margin-left: 16px;
    }

    /* Empty state */
    .empty {
      padding: 40px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="search-box">
      <span style="margin-right: 8px;">🔍</span>
      <input type="text" placeholder="Search files..." value="${this._escapeHtml(this._searchQuery)}" id="searchInput">
    </div>
    <button class="filter-btn ${this._filter === 'all' ? 'active' : ''}" onclick="setFilter('all')">All</button>
    <button class="filter-btn ${this._filter === 'local' ? 'active' : ''}" onclick="setFilter('local')">Only Local</button>
    <button class="filter-btn ${this._filter === 'remote' ? 'active' : ''}" onclick="setFilter('remote')">Only Remote</button>
    <button class="filter-btn ${this._filter === 'different' ? 'active' : ''}" onclick="setFilter('different')">Different</button>
    <button class="export-btn" onclick="exportResults()">Export</button>
    <button class="action-btn" onclick="refresh()" style="margin-left: auto;">↻ Refresh</button>
  </div>

  <div class="main">
    <div class="panel local">
      <div class="panel-header">📁 ${this._escapeHtml(localRoot)} (Local)</div>
      ${this._renderTree(tree, 'local')}
    </div>
    <div class="panel remote">
      <div class="panel-header">📁 ${this._escapeHtml(remoteRoot)} (Remote)</div>
      ${this._renderTree(tree, 'remote')}
    </div>
  </div>

  <div class="status-bar">
    <div class="status-item status-local">
      <span>Only Local:</span>
      <span class="status-count">${stats.onlyLocal}</span>
    </div>
    <div class="status-item status-different">
      <span>Different:</span>
      <span class="status-count">${stats.different}</span>
    </div>
    <div class="status-item status-remote">
      <span>Only Remote:</span>
      <span class="status-count">${stats.onlyRemote}</span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function setFilter(filter) {
      vscode.postMessage({ type: 'setFilter', filter });
    }

    // Debounced search
    let searchTimeout;
    let searchValue = "${this._escapeHtml(this._searchQuery)}";
    const searchInput = document.getElementById('searchInput');

    if (searchInput) {
      // Restore focus and value on load
      if (searchValue) {
        searchInput.value = searchValue;
      }
      searchInput.focus();

      searchInput.addEventListener('input', (e) => {
        searchValue = e.target.value;
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          vscode.postMessage({ type: 'search', query: searchValue });
        }, 300); // 300ms debounce
      });
    }

    function toggleFolder(path) {
      vscode.postMessage({ type: 'toggleFolder', path });
    }

    function showDiff(path) {
      vscode.postMessage({ type: 'showDiff', path });
    }

    function uploadFile(path) {
      vscode.postMessage({ type: 'upload', path });
    }

    function downloadFile(path) {
      vscode.postMessage({ type: 'download', path });
    }

    function revealLocal(path) {
      vscode.postMessage({ type: 'revealLocal', path });
    }

    function revealRemote(path) {
      vscode.postMessage({ type: 'revealRemote', path });
    }

    function exportResults() {
      const format = prompt('Export format (json/csv):', 'json');
      if (format === 'json' || format === 'csv') {
        vscode.postMessage({ type: 'export', format });
      }
    }

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }
  </script>
</body>
</html>`;
  }

  /**
   * Render tree node
   */
  private _renderTree(node: CompareTreeNode | null, side: 'local' | 'remote'): string {
    if (!node || !node.children || node.children.length === 0) {
      return '<div class="empty">No items</div>';
    }

    return this._renderNode(node, side);
  }

  /**
   * Render a single node
   */
  private _renderNode(node: CompareTreeNode, side: 'local' | 'remote'): string {
    const item = side === 'local' ? node.localItem : node.remoteItem;
    const isExpanded = this._expandedFolders.has(node.path);

    let html = '';

    // Render this item if it has content on this side
    if (item || (node.isDirectory && this._hasItemsInSubtree(node, side))) {
      const statusClass = this._getStatusClass(item);
      const bgClass = this._getBgClass(item);
      const icon = node.isDirectory ? (isExpanded ? '📂' : '📁') : '📄';
      const size = item?.size ? formatFileSize(item.size) : '';

      const canShowDiff = item?.side === 'different' && !node.isDirectory;
      const canUpload = side === 'local' && item?.side === 'local' && !node.isDirectory;
      const canDownload = side === 'remote' && item?.side === 'remote' && !node.isDirectory;

      const folderIcon = node.isDirectory
        ? `<span class="icon" onclick="toggleFolder('${this._escapeHtml(node.path)}')">${icon}</span>`
        : `<span class="icon">${icon}</span>`;
      const sizeSpan = size ? `<span class="size">${size}</span>` : '';
      const diffBtn = canShowDiff
        ? `<button class="action-btn diff" onclick="showDiff('${this._escapeHtml(node.path)}')" title="Show Diff">⇆</button>`
        : '';
      const uploadBtn = canUpload
        ? `<button class="action-btn" onclick="uploadFile('${this._escapeHtml(node.path)}')" title="Upload">↑</button>`
        : '';
      const downloadBtn = canDownload
        ? `<button class="action-btn" onclick="downloadFile('${this._escapeHtml(node.path)}')" title="Download">↓</button>`
        : '';
      const revealFunc = side === 'local' ? 'Local' : 'Remote';
      const revealBtn = `<button class="action-btn" onclick="reveal${revealFunc}('${this._escapeHtml(node.path)}')" title="Reveal">📂</button>`;

      html += `<div class="tree-item ${node.isDirectory ? 'folder' : 'file'} ${bgClass}" style="padding-left: ${this._getIndent(node.path)}px">
        ${folderIcon}
        <span class="name ${statusClass}">${this._escapeHtml(node.name)}</span>
        ${sizeSpan}
        <div class="actions">
          ${diffBtn}
          ${uploadBtn}
          ${downloadBtn}
          ${revealBtn}
        </div>
      </div>`;
    }

    // Render children if expanded
    if (node.isDirectory && isExpanded && node.children.length > 0) {
      html += '<div class="tree-children">';
      for (const child of node.children) {
        html += this._renderNode(child, side);
      }
      html += '</div>';
    }

    return html;
  }

  /**
   * Check if subtree has items
   */
  private _hasItemsInSubtree(node: CompareTreeNode, side: 'local' | 'remote'): boolean {
    const item = side === 'local' ? node.localItem : node.remoteItem;
    if (item) return true;

    for (const child of node.children) {
      if (this._hasItemsInSubtree(child, side)) return true;
    }

    return false;
  }

  /**
   * Get indent based on path depth
   */
  private _getIndent(path: string): number {
    if (!path) return 8;
    return 8 + (path.split('/').length - 1) * 16;
  }

  /**
   * Get status class
   */
  private _getStatusClass(item?: CompareItem): string {
    if (!item) return '';
    switch (item.side) {
      case 'local': return 'status-local';
      case 'remote': return 'status-remote';
      case 'different': return 'status-different';
      default: return '';
    }
  }

  /**
   * Get background class
   */
  private _getBgClass(item?: CompareItem): string {
    if (!item) return '';
    switch (item.side) {
      case 'local': return 'bg-local';
      case 'remote': return 'bg-remote';
      case 'different': return 'bg-different';
      default: return '';
    }
  }

  /**
   * Escape HTML
   */
  private _escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
