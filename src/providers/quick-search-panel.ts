/**
 * StackerFTP - Quick Search Panel
 *
 * Ultra-fast search in a new panel
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
import { formatFileSize, normalizeRemotePath } from '../utils/helpers';
import { statusBar } from '../utils/status-bar';

export class QuickSearchPanel {
  private static _panel?: vscode.WebviewPanel;
  private static _extensionUri?: vscode.Uri;
  private static _connection?: any;
  private static _config?: any;
  private static _workspaceRoot?: string;
  private static _searchPath?: string;

  /**
   * Open the quick search panel
   */
  public static async show(uri?: vscode.Uri): Promise<void> {
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

    // Determine search path
    let searchPath = config.remotePath;
    let searchLabel = 'Entire Remote';

    if (uri) {
      // Try to get path from tree item
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          searchPath = uri.fsPath;
          searchLabel = path.basename(searchPath);
        }
      } catch {
        // Not a directory in workspace, check if it's from remote explorer
      }
    }

    this._config = config;
    this._workspaceRoot = workspaceRoot;
    this._searchPath = searchPath;

    // Create or show panel
    if (QuickSearchPanel._panel) {
      QuickSearchPanel._panel.reveal(vscode.ViewColumn.One);
      // Update search path display
      QuickSearchPanel._panel.webview.postMessage({ type: 'setSearchPath', path: searchLabel });
    } else {
      QuickSearchPanel._panel = vscode.window.createWebviewPanel(
        'stackerftp.quickSearch',
        'Quick Search',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      QuickSearchPanel._panel.onDidDispose(() => {
        QuickSearchPanel._panel = undefined;
      });

      QuickSearchPanel._panel.webview.onDidReceiveMessage(async (data) => {
        await this._handleMessage(data);
      });
    }

    // Connect and show initial state
    try {
      this._connection = await connectionManager.ensureConnection(config);
      this._updateHtml(this._getInitialHtml(searchLabel));
    } catch (error: any) {
      this._updateHtml(this._getErrorHtml(error.message));
    }
  }

  /**
   * Change path from command (called from outside webview)
   */
  public static async changePathFromCommand(): Promise<void> {
    if (!this._config) return;

    const input = await vscode.window.showInputBox({
      prompt: 'Enter remote path to search',
      value: this._searchPath || this._config.remotePath
    });

    if (!input || !this._panel) return;

    this._searchPath = input;
    const label = input === this._config.remotePath ? 'Entire Remote' : path.basename(input);
    this._panel.webview.postMessage({ type: 'setSearchPath', path: label });
  }

  /**
   * Handle messages from webview
   */
  private static async _handleMessage(data: any): Promise<void> {
    switch (data.type) {
      case 'search':
        await this._performSearch(data.query);
        break;
      case 'openFile':
        await this._openFile(data.path);
        break;
      case 'downloadFile':
        await this._downloadFile(data.path);
        break;
      case 'revealInExplorer':
        await this._revealInExplorer(data.path);
        break;
      case 'changePath':
        await this._changeSearchPath();
        break;
    }
  }

  /**
   * Perform search - ultra fast using parallel directory listing
   */
  private static async _performSearch(query: string): Promise<void> {
    if (!this._connection || !this._config || !query || query.length < 1) {
      this._updateHtml(this._getResultsHtml([], query, true));
      return;
    }

    this._updateHtml(this._getLoadingHtml(query));

    try {
      const startTime = Date.now();
      const results = await this._fastSearch(query);
      const elapsed = Date.now() - startTime;

      this._updateHtml(this._getResultsHtml(results, query, false, elapsed));
    } catch (error: any) {
      this._updateHtml(this._getErrorHtml(error.message));
    }
  }

  /**
   * Fast parallel search - optimized
   */
  private static async _fastSearch(query: string): Promise<any[]> {
    const results: any[] = [];
    const searchPath = this._searchPath || this._config?.remotePath || '/';
    const pattern = query.toLowerCase();

    // Simple string matching - much faster than regex
    const matches = (name: string): boolean => {
      return name.toLowerCase().includes(pattern);
    };

    const maxResults = 50; // Reduced for speed
    const maxDepth = 5; // Reduced depth
    const maxConcurrency = 10; // Limit concurrent requests

    // Queue for breadth-first search
    const queue: { path: string; depth: number }[] = [{ path: searchPath, depth: 0 }];
    let activeRequests = 0;

    // Process queue with concurrency limit
    const processQueue = async (): Promise<void> => {
      while (queue.length > 0 && results.length < maxResults) {
        if (activeRequests >= maxConcurrency) {
          // Wait for a slot to free up
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }

        const item = queue.shift();
        if (!item || item.depth > maxDepth) continue;

        activeRequests++;

        try {
          const entries = await this._connection.list(item.path) as any[];

          const files = entries.filter((e: any) => e.type === 'file');
          const dirs = entries.filter((e: any) => e.type === 'directory');

          // Check files for match
          for (const entry of files) {
            if (results.length >= maxResults) {
              activeRequests--;
              return;
            }
            if (matches(entry.name)) {
              results.push({
                name: entry.name,
                path: entry.path,
                size: entry.size,
                type: 'file',
                sizeFormatted: formatFileSize(entry.size)
              });
            }
          }

          // Check directories for match
          for (const entry of dirs) {
            if (results.length >= maxResults) {
              activeRequests--;
              return;
            }
            if (matches(entry.name)) {
              results.push({
                name: entry.name,
                path: entry.path,
                size: 0,
                type: 'directory',
                sizeFormatted: 'Folder'
              });
            }
          }

          // Add subdirectories to queue
          if (item.depth < maxDepth) {
            for (const dir of dirs) {
              queue.push({ path: dir.path, depth: item.depth + 1 });
            }
          }
        } catch {
          // Skip inaccessible directories
        }

        activeRequests--;
      }
    };

    await processQueue();

    // Sort: directories first, then by name
    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return results;
  }

  /**
   * Change search path - notify webview to handle it via command
   */
  private static async _changeSearchPath(): Promise<void> {
    // Trigger a command that will show the input box outside webview context
    // The webview will handle the result via message
    vscode.commands.executeCommand('stackerftp.webmaster.quickSearchChangePath');
  }

  /**
   * Open file
   */
  private static async _openFile(filePath: string): Promise<void> {
    if (!this._workspaceRoot || !this._config) return;

    const localPath = path.join(this._workspaceRoot, path.relative(this._config.remotePath, filePath));
    const localDir = path.dirname(localPath);

    try {
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }

      await this._connection.download(filePath, localPath);
      const doc = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(doc);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to open: ${error.message}`);
    }
  }

  /**
   * Download file
   */
  private static async _downloadFile(filePath: string): Promise<void> {
    if (!this._workspaceRoot || !this._config) return;

    const localPath = path.join(this._workspaceRoot, path.relative(this._config.remotePath, filePath));
    const localDir = path.dirname(localPath);

    try {
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }

      await this._connection.download(filePath, localPath);
      statusBar.success(`Downloaded: ${path.basename(filePath)}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to download: ${error.message}`);
    }
  }

  /**
   * Reveal in explorer
   */
  private static async _revealInExplorer(filePath: string): Promise<void> {
    if (!this._workspaceRoot || !this._config) return;

    const localPath = path.join(this._workspaceRoot, path.relative(this._config.remotePath, filePath));

    if (fs.existsSync(localPath)) {
      await vscode.commands.executeCommand('revealFileInExplorer', vscode.Uri.file(localPath));
    } else {
      // Download first then reveal
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }
      await this._connection.download(filePath, localPath);
      await vscode.commands.executeCommand('revealFileInExplorer', vscode.Uri.file(localPath));
    }
  }

  /**
   * Update HTML
   */
  private static _updateHtml(html: string): void {
    if (QuickSearchPanel._panel) {
      QuickSearchPanel._panel.webview.html = html;
    }
  }

  /**
   * Get initial HTML
   */
  private static _getInitialHtml(searchPath: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      padding: 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .search-box {
      display: flex;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 8px 12px;
    }
    .search-box:focus-within {
      border-color: var(--vscode-focusBorder);
    }
    .search-icon { margin-right: 8px; font-size: 16px; }
    input {
      flex: 1;
      border: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-size: 16px;
      outline: none;
      caret-color: var(--vscode-input-foreground);
    }
    input::placeholder { color: var(--vscode-input-placeholderForeground); }
    .path-info {
      margin-top: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .path-btn {
      background: none;
      border: none;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font-size: 12px;
    }
    .path-btn:hover { text-decoration: underline; }
    .results {
      flex: 1;
      overflow: auto;
      padding: 8px;
    }
    .result-item {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      cursor: pointer;
      border-radius: 4px;
      margin: 2px 0;
    }
    .result-item:hover { background: var(--vscode-list-hoverBackground); }
    .icon { margin-right: 10px; font-size: 16px; }
    .name { flex: 1; font-size: 14px; }
    .size { color: var(--vscode-descriptionForeground); font-size: 12px; margin-right: 12px; }
    .actions { display: none; gap: 4px; }
    .result-item:hover .actions { display: flex; }
    .action-btn {
      padding: 4px 8px;
      background: var(--vscode-button-secondaryBackground);
      border: none;
      border-radius: 3px;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 11px;
    }
    .action-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .empty {
      text-align: center;
      padding: 60px 20px;
      color: var(--vscode-descriptionForeground);
    }
    .loading {
      text-align: center;
      padding: 60px 20px;
    }
    .spinner {
      width: 30px;
      height: 30px;
      border: 3px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-progressBar-background);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .stats {
      padding: 8px 16px;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="search-box">
      <span class="search-icon">🔍</span>
      <input type="text" id="searchInput" placeholder="Type to search files..." autofocus>
    </div>
    <div class="path-info">
      <span>📁 Searching in: <strong id="searchPath">${searchPath}</strong></span>
      <button class="path-btn" onclick="changePath()">Change</button>
    </div>
  </div>
  <div class="results" id="results">
    <div class="empty">Start typing to search...</div>
  </div>
  <div class="stats" id="stats"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');
    const resultsDiv = document.getElementById('results');
    const statsDiv = document.getElementById('stats');

    // Auto-focus on load
    searchInput.focus();

    // Debounced search
    let timeout;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(timeout);
      const value = e.target.value;
      if (value.length < 1) {
        resultsDiv.innerHTML = '<div class="empty">Start typing to search...</div>';
        statsDiv.textContent = '';
        return;
      }
      timeout = setTimeout(() => {
        vscode.postMessage({ type: 'search', query: value });
      }, 150); // Very fast 150ms debounce
    });

    // Listen for messages from extension
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data.type === 'setSearchPath') {
        document.getElementById('searchPath').textContent = data.path;
      }
    });

    function openFile(path) {
      vscode.postMessage({ type: 'openFile', path });
    }

    function downloadFile(path) {
      vscode.postMessage({ type: 'downloadFile', path });
    }

    function revealInExplorer(path) {
      vscode.postMessage({ type: 'revealInExplorer', path });
    }

    function changePath() {
      vscode.postMessage({ type: 'changePath' });
    }
  </script>
</body>
</html>`;
  }

  /**
   * Get loading HTML
   */
  private static _getLoadingHtml(query: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      padding: 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .search-box {
      display: flex;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 8px 12px;
    }
    .search-box:focus-within { border-color: var(--vscode-focusBorder); }
    .search-icon { margin-right: 8px; font-size: 16px; }
    input {
      flex: 1;
      border: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-size: 16px;
      outline: none;
      caret-color: var(--vscode-input-foreground);
    }
    .path-info {
      margin-top: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .results {
      flex: 1;
      overflow: auto;
      padding: 8px;
    }
    .loading {
      text-align: center;
      padding: 60px 20px;
    }
    .spinner {
      width: 30px;
      height: 30px;
      border: 3px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-progressBar-background);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="header">
    <div class="search-box">
      <span class="search-icon">🔍</span>
      <input type="text" id="searchInput" value="${query}" placeholder="Type to search files...">
    </div>
    <div class="path-info">Searching...</div>
  </div>
  <div class="results">
    <div class="loading">
      <div class="spinner"></div>
      <div>Searching...</div>
    </div>
  </div>
  <script>
    const searchInput = document.getElementById('searchInput');
    searchInput.focus();
  </script>
</body>
</html>`;
  }

  /**
   * Get results HTML
   */
  private static _getResultsHtml(results: any[], query: string, isEmpty: boolean, elapsed?: number): string {
    const escapedQuery = query.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let resultsHtml = '';
    if (isEmpty) {
      resultsHtml = '<div class="empty">Start typing to search...</div>';
    } else if (results.length === 0) {
      resultsHtml = `<div class="empty">No files found matching "${escapedQuery}"</div>`;
    } else {
      for (const r of results) {
        const icon = r.type === 'directory' ? '📁' : '📄';
        // Use encodeURIComponent for safe path handling
        const encodedPath = encodeURIComponent(r.path);

        resultsHtml += `<div class="result-item" data-path="${encodedPath}">
          <span class="icon">${icon}</span>
          <span class="name">${r.name}</span>
          <span class="size">${r.sizeFormatted}</span>
          <div class="actions">
            <button class="action-btn" data-action="open" data-path="${encodedPath}">Open</button>
            <button class="action-btn" data-action="download" data-path="${encodedPath}">Download</button>
            <button class="action-btn" data-action="reveal" data-path="${encodedPath}">Reveal</button>
          </div>
        </div>`;
      }
    }

    const statsText = elapsed !== undefined
      ? `Found ${results.length} results in ${elapsed}ms`
      : results.length > 0
        ? `${results.length} results`
        : '';

    return `<!DOCTYPE html>
<html>
<head>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      padding: 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .search-box {
      display: flex;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 8px 12px;
    }
    .search-box:focus-within { border-color: var(--vscode-focusBorder); }
    .search-icon { margin-right: 8px; font-size: 16px; }
    input {
      flex: 1;
      border: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-size: 16px;
      outline: none;
      caret-color: var(--vscode-input-foreground);
    }
    .path-info {
      margin-top: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .path-btn {
      background: none;
      border: none;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font-size: 12px;
    }
    .path-btn:hover { text-decoration: underline; }
    .results {
      flex: 1;
      overflow: auto;
      padding: 8px;
    }
    .result-item {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      cursor: pointer;
      border-radius: 4px;
      margin: 2px 0;
    }
    .result-item:hover { background: var(--vscode-list-hoverBackground); }
    .icon { margin-right: 10px; font-size: 16px; }
    .name { flex: 1; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .size { color: var(--vscode-descriptionForeground); font-size: 12px; margin-right: 12px; }
    .actions { display: none; gap: 4px; }
    .result-item:hover .actions { display: flex; }
    .action-btn {
      padding: 4px 8px;
      background: var(--vscode-button-secondaryBackground);
      border: none;
      border-radius: 3px;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 11px;
    }
    .action-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .empty {
      text-align: center;
      padding: 60px 20px;
      color: var(--vscode-descriptionForeground);
    }
    .stats {
      padding: 8px 16px;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="search-box">
      <span class="search-icon">🔍</span>
      <input type="text" id="searchInput" value="${escapedQuery}" placeholder="Type to search files...">
    </div>
    <div class="path-info">
      <span>📁 <span id="searchPath">Remote</span></span>
      <button class="path-btn" onclick="changePath()">Change</button>
    </div>
  </div>
  <div class="results" id="results">
    ${resultsHtml}
  </div>
  <div class="stats" id="stats">${statsText}</div>

  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');

    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);

    let timeout;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(timeout);
      const value = e.target.value;
      if (value.length < 1) {
        document.getElementById('results').innerHTML = '<div class="empty">Start typing to search...</div>';
        document.getElementById('stats').textContent = '';
        return;
      }
      timeout = setTimeout(() => {
        vscode.postMessage({ type: 'search', query: value });
      }, 150);
    });

    // Event delegation for action buttons
    document.getElementById('results').addEventListener('click', (e) => {
      const btn = e.target.closest('.action-btn');
      if (!btn) return;

      e.stopPropagation();
      const action = btn.dataset.action;
      const encodedPath = btn.dataset.path;
      if (!action || !encodedPath) return;

      const path = decodeURIComponent(encodedPath);

      switch (action) {
        case 'open':
          vscode.postMessage({ type: 'openFile', path });
          break;
        case 'download':
          vscode.postMessage({ type: 'downloadFile', path });
          break;
        case 'reveal':
          vscode.postMessage({ type: 'revealInExplorer', path });
          break;
      }
    });

    // Double-click to open
    document.getElementById('results').addEventListener('dblclick', (e) => {
      const item = e.target.closest('.result-item');
      if (!item) return;

      const encodedPath = item.dataset.path;
      if (encodedPath) {
        const path = decodeURIComponent(encodedPath);
        vscode.postMessage({ type: 'openFile', path });
      }
    });

    function changePath() {
      vscode.postMessage({ type: 'changePath' });
    }
  </script>
</body>
</html>`;
  }

  /**
   * Get error HTML
   */
  private static _getErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-errorForeground);
      padding: 20px;
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
  </div>
</body>
</html>`;
  }
}
