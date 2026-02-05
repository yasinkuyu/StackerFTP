/**
 * StackerFTP - Connection Form WebView Provider
 *
 * Minimalist connection form compatible with native VS Code UI
 */

import * as vscode from 'vscode';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { FTPConfig, Protocol } from '../types';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';

export class ConnectionFormProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'stackerftp.connectionForm';

  private _view?: vscode.WebviewView;
  private _editingConfig?: FTPConfig;
  private _editingIndex?: number;

  constructor(private readonly _extensionUri: vscode.Uri) { }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'loadConfigs':
          await this._sendConfigs();
          break;
        case 'saveConfig':
          await this._handleSaveConfig(data.config, data.index);
          break;
        case 'deleteConfig':
          await this._handleDeleteConfig(data.index);
          break;
        case 'testConnection':
          await this._handleTestConnection(data.config);
          break;
        case 'connect':
          await this._handleConnect(data.index);
          break;
        case 'disconnect':
          await this._handleDisconnect(data.index);
          break;
        case 'editConfig':
          await this._handleEditConfig(data.index);
          break;
        case 'browsePrivateKey':
          await this._handleBrowsePrivateKey();
          break;
        case 'showForm':
          // Focus the connection form view to ensure it's visible and expanded
          vscode.commands.executeCommand('setContext', 'stackerftp.formVisible', true);
          // Ensure Connections panel is expanded by focusing it
          vscode.commands.executeCommand('stackerftp.connectionForm.focus');
          break;
        case 'hideForm':
          // Focus Remote Explorer to expand it and show files
          vscode.commands.executeCommand('setContext', 'stackerftp.formVisible', false);
          // Refresh and focus Remote Explorer
          vscode.commands.executeCommand('stackerftp.tree.refresh');
          vscode.commands.executeCommand('stackerftp.remoteExplorerTree.focus');
          break;
      }
    });

    this._sendConfigs();
  }

  private _getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async _sendConfigs() {
    if (!this._view) return;

    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) {
      this._view.webview.postMessage({ type: 'noWorkspace' });
      return;
    }

    try {
      // Always reload configs from file to ensure freshness
      await configManager.loadConfig(workspaceRoot);

      const configs = configManager.getConfigs(workspaceRoot);
      logger.info(`_sendConfigs: loaded ${configs.length} configs from ${workspaceRoot}`);

      const configsWithStatus = configs.map((config, index) => ({
        ...config,
        index,
        connected: connectionManager.isConnected(config)
      }));

      this._view.webview.postMessage({
        type: 'configs',
        configs: configsWithStatus,
        editing: this._editingConfig ? {
          config: this._editingConfig,
          index: this._editingIndex
        } : null
      });
    } catch (error) {
      logger.error('_sendConfigs error', error);
      this._view.webview.postMessage({ type: 'configs', configs: [] });
    }
  }

  private async _handleSaveConfig(configData: any, editIndex?: number) {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return;

    try {
      let configs = configManager.getConfigs(workspaceRoot);

      // Get existing config if editing to preserve all fields
      const existingConfig = (editIndex !== undefined && editIndex >= 0)
        ? configs[editIndex]
        : {};

      // Merge with existing config to preserve fields not in form
      const newConfig: FTPConfig = {
        ...existingConfig,  // Preserve existing fields (watcher, ignore, profiles, etc.)
        name: configData.name || configData.host,
        host: configData.host,
        port: parseInt(configData.port) || (configData.protocol === 'sftp' ? 22 : 21),
        protocol: configData.protocol as Protocol,
        username: configData.username,
        password: configData.password || undefined,
        privateKeyPath: configData.privateKeyPath || undefined,
        passphrase: configData.passphrase || undefined,
        remotePath: configData.remotePath || '/',
        uploadOnSave: configData.uploadOnSave || false,
        secure: configData.secure || false
      };

      if (editIndex !== undefined && editIndex >= 0) {
        configs[editIndex] = newConfig;
      } else {
        configs.push(newConfig);
      }

      await configManager.saveConfig(workspaceRoot, configs);

      this._editingConfig = undefined;
      this._editingIndex = undefined;

      this._view?.webview.postMessage({ type: 'saveSuccess' });
      await this._sendConfigs();
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'saveError', message: error.message });
      statusBar.error(`Failed to save: ${error.message}`);
    }
  }

  private async _handleDeleteConfig(index: number) {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (index < 0 || index >= configs.length) return;

    const config = configs[index];
    const confirm = await vscode.window.showWarningMessage(
      `Delete connection "${config.name || config.host}"?`,
      { modal: true },
      'Delete', 'Cancel'
    );

    if (confirm !== 'Delete') return;

    configs.splice(index, 1);
    await configManager.saveConfig(workspaceRoot, configs);
    await this._sendConfigs();

    statusBar.success('Connection deleted');
  }

  private async _handleTestConnection(configData: any) {
    this._view?.webview.postMessage({ type: 'testing' });

    try {
      const testConfig: FTPConfig = {
        name: configData.name || 'Test',
        host: configData.host,
        port: parseInt(configData.port) || (configData.protocol === 'sftp' ? 22 : 21),
        protocol: configData.protocol as Protocol,
        username: configData.username,
        password: configData.password || undefined,
        privateKeyPath: configData.privateKeyPath || undefined,
        passphrase: configData.passphrase || undefined,
        remotePath: configData.remotePath || '/',
        secure: configData.secure || false
      };

      const connection = await connectionManager.connect(testConfig);
      await connection.list(testConfig.remotePath);
      await connectionManager.disconnect(testConfig);

      this._view?.webview.postMessage({ type: 'testSuccess' });
      statusBar.success('Connection test successful!');
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'testError', message: error.message });
      statusBar.error(`Connection test failed: ${error.message}`);
    }
  }

  private async _handleConnect(index: number) {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (index < 0 || index >= configs.length) return;

    try {
      await connectionManager.connect(configs[index]);
      // Connected message shown by connection-manager via statusBar
      await this._sendConfigs();

      // Small delay to ensure connection is fully ready, then refresh and focus Remote Explorer
      setTimeout(() => {
        vscode.commands.executeCommand('stackerftp.tree.refresh');
        // Focus and reveal Remote Explorer view
        vscode.commands.executeCommand('stackerftp.remoteExplorerTree.focus');
      }, 100);
    } catch (error: any) {
      statusBar.error(`Connection failed: ${error.message}`, true);
    }
  }

  private async _handleDisconnect(index: number) {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (index < 0 || index >= configs.length) return;

    try {
      await connectionManager.disconnect(configs[index]);
      await this._sendConfigs();
      statusBar.success(`Disconnected: ${configs[index].name || configs[index].host}`);
      // Refresh remote explorer to clear the connection
      vscode.commands.executeCommand('stackerftp.tree.refresh');
    } catch (error: any) {
      statusBar.error(`Disconnect failed: ${error.message}`, true);
    }
  }

  private async _handleEditConfig(index: number) {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (index < 0 || index >= configs.length) return;

    this._editingConfig = configs[index];
    this._editingIndex = index;
    await this._sendConfigs();
  }

  private async _handleBrowsePrivateKey() {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'Private Key': ['pem', 'ppk', 'key', '*'] },
      title: 'Select Private Key File'
    });

    if (result && result[0]) {
      this._view?.webview.postMessage({
        type: 'privateKeySelected',
        path: result[0].fsPath
      });
    }
  }

  public refresh() {
    this._sendConfigs();
  }

  public showNewConnectionForm() {
    // Focus the Connections panel first to make it visible
    vscode.commands.executeCommand('stackerftp.connectionForm.focus');

    // Set context to show form is visible
    vscode.commands.executeCommand('setContext', 'stackerftp.formVisible', true);
    this._view?.webview.postMessage({ type: 'triggerNewForm' });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    // Get codicon CSS
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StackerFTP Connections</title>
  <link href="${codiconUri}" rel="stylesheet" />
  <style>

    
    /* Button variants */
    .btn-connect {
      color: var(--vscode-testing-iconPassed, #89d185);
    }
    
    .btn-disconnect {
      color: var(--vscode-testing-iconFailed, #f48771);
    }
    
    /* Dropdown styles */
    .dropdown {
      position: relative;
      display: inline-block;
    }
    
    .dropdown-menu {
      display: none;
      position: absolute;
      right: 0;
      top: 100%;
      min-width: 120px;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      z-index: 1000;
      padding: 4px 0;
    }
    
    .dropdown-menu.show {
      display: block;
    }
    
    .dropdown-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 12px;
      background: none;
      border: none;
      color: var(--vscode-menu-foreground);
      font-size: 12px;
      cursor: pointer;
      text-align: left;
    }
    
    .dropdown-item:hover {
      background: var(--vscode-menu-selectionBackground);
      color: var(--vscode-menu-selectionForeground);
    }
    
    .dropdown-item .codicon {
      font-size: 12px;
    }
    
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
      padding: 0;
    }

    .container {
      padding: 12px;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;
      padding: 4px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
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

    .header-actions {
      display: flex;
      gap: 4px;
    }

    /* Buttons */
    .btn {
      padding: 4px 8px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: background 0.1s;
    }

    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .btn-icon {
      padding: 4px;
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      border-radius: 3px;
      opacity: 0.7;
    }

    .btn-icon:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }

    /* Connection List */
    .connection-list {
      margin-bottom: 16px;
    }

    .connection-item {
      display: flex;
      align-items: center;
      padding: 8px;
      margin-bottom: 4px;
      background: var(--vscode-list-hoverBackground);
      border-radius: 4px;
      cursor: pointer;
    }

    .connection-item:hover {
      background: var(--vscode-list-activeSelectionBackground);
    }

    .connection-item.connected {
      border-left: 3px solid var(--vscode-testing-iconPassed);
    }

    .connection-icon {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-badge-background);
      border-radius: 4px;
      margin-right: 10px;
      font-size: 16px;
      color: var(--vscode-foreground);
    }

    .connection-icon.status-connected {
      background: var(--vscode-testing-iconPassed);
      color: var(--vscode-editor-background);
    }

    .connection-info {
      flex: 1;
      min-width: 0;
    }

    .connection-name {
      font-weight: 500;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .connection-details {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .connection-actions {
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.1s;
    }

    .connection-item:hover .connection-actions {
      opacity: 1;
    }

    /* Form */
    .form-section {
      background: var(--vscode-editor-background);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
    }

    .form-title {
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .form-row {
      margin-bottom: 10px;
    }

    .form-row:last-child {
      margin-bottom: 0;
    }

    .form-label {
      display: block;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .form-input {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      font-size: 12px;
      outline: none;
    }

    .form-input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .form-input.input-error {
      border-color: var(--vscode-inputValidation-errorBorder);
      background: var(--vscode-inputValidation-errorBackground);
    }

    .form-input-error-message {
      color: var(--vscode-inputValidation-errorForeground);
      font-size: 11px;
      margin-top: 4px;
      display: none;
    }

    .form-input.input-error + .form-input-error-message {
      display: block;
    }

    .form-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .form-select {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 3px;
      font-size: 12px;
      outline: none;
    }

    .form-row-inline {
      display: grid;
      grid-template-columns: 1fr 80px;
      gap: 8px;
    }

    .form-checkbox {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      cursor: pointer;
    }

    .form-checkbox input {
      width: 14px;
      height: 14px;
    }

    .form-input-group {
      display: flex;
      gap: 4px;
    }

    .form-input-group .form-input {
      flex: 1;
    }

    /* Protocol Tabs */
    .protocol-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
    }

    .protocol-tab {
      flex: 1;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-foreground);
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      text-align: center;
      transition: all 0.1s;
    }

    .protocol-tab:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .protocol-tab.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    /* Actions */
    .form-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }

    .form-actions .btn {
      flex: 1;
      justify-content: center;
      padding: 8px;
    }

    /* Status */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 500;
    }

    .status-badge.connected {
      background: var(--vscode-testing-iconPassed);
      color: white;
    }

    .status-badge.disconnected {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 24px;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state p {
      margin-bottom: 12px;
      font-size: 12px;
    }

    /* Collapsible */
    .collapsible-header {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      padding: 6px 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .collapsible-content {
      display: none;
      padding-top: 8px;
    }

    .collapsible-content.open {
      display: block;
    }

    /* Loading */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Responsive */
    .hidden {
      display: none !important;
    }
  </style>
</head>
<body>

    <!-- Connection List -->
    <div class="connection-list" id="connectionList">
      <div class="empty-state" id="emptyState">
        <p>No connections configured</p>
        <button class="btn btn-primary" id="btnFirstConnection">Create Connection</button>
      </div>
    </div>

    <!-- Hidden buttons for JS compatibility -->
    <button id="btnHeaderNew" style="display:none;"></button>
    <button id="btnHeaderRefresh" style="display:none;"></button>

    <!-- Connection Form -->
    <div class="form-section hidden" id="connectionForm">
      <div class="form-title">
        <span id="formTitle">New Connection</span>
      </div>

      <!-- Protocol Selection -->
      <div class="protocol-tabs">
        <button class="protocol-tab active" data-protocol="sftp">SFTP</button>
        <button class="protocol-tab" data-protocol="ftp">FTP</button>
        <button class="protocol-tab" data-protocol="ftps">FTPS</button>
      </div>

      <!-- Basic Info -->
      <div class="form-row">
        <label class="form-label">Connection Name</label>
        <input type="text" class="form-input" id="inputName" placeholder="My Server">
      </div>

      <div class="form-row form-row-inline">
        <div>
          <label class="form-label">Host</label>
          <input type="text" class="form-input" id="inputHost" placeholder="example.com">
        </div>
        <div>
          <label class="form-label">Port</label>
          <input type="number" class="form-input" id="inputPort" placeholder="22">
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">Username</label>
        <input type="text" class="form-input" id="inputUsername" placeholder="username">
      </div>

      <!-- Auth Section -->
      <div class="form-row">
        <label class="form-label">Password</label>
        <input type="password" class="form-input" id="inputPassword" placeholder="Enter password">
      </div>

      <!-- SFTP Key Auth -->
      <div id="sftpAuthSection">
        <div class="collapsible-header" id="toggleKeyAuth">
          <span>▶</span> Use Private Key
        </div>
        <div class="collapsible-content" id="keyAuthContent">
          <div class="form-row">
            <label class="form-label">Private Key Path</label>
            <div class="form-input-group">
              <input type="text" class="form-input" id="inputPrivateKey" placeholder="~/.ssh/id_rsa">
              <button class="btn btn-secondary" id="btnBrowseKey">Browse</button>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">Passphrase (optional)</label>
            <input type="password" class="form-input" id="inputPassphrase" placeholder="Key passphrase">
          </div>
        </div>
      </div>

      <!-- Remote Path -->
      <div class="form-row">
        <label class="form-label">Remote Path</label>
        <input type="text" class="form-input" id="inputRemotePath" placeholder="/var/www/html">
      </div>

      <!-- Options -->
      <div class="form-row">
        <label class="form-checkbox">
          <input type="checkbox" id="inputUploadOnSave">
          Upload on Save
        </label>
      </div>

      <!-- FTPS Options -->
      <div id="ftpsOptions" class="hidden">
        <div class="form-row">
          <label class="form-checkbox">
            <input type="checkbox" id="inputSecure">
            Use TLS/SSL
          </label>
        </div>
      </div>

      <!-- Actions -->
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="btnCancel">Cancel</button>
        <button type="button" class="btn btn-secondary" id="btnTest">Test</button>
        <button type="button" class="btn btn-primary" id="btnSave">Save</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // State
    let configs = [];
    let editingIndex = null;
    let selectedProtocol = 'sftp';
    let showForm = false;

    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.dropdown')) {
        document.querySelectorAll('.dropdown-menu.show').forEach(menu => {
          menu.classList.remove('show');
        });
      }
    });

    // Elements
    const connectionList = document.getElementById('connectionList');
    const emptyState = document.getElementById('emptyState');
    const connectionForm = document.getElementById('connectionForm');
    const formTitle = document.getElementById('formTitle');
    const sftpAuthSection = document.getElementById('sftpAuthSection');
    const ftpsOptions = document.getElementById('ftpsOptions');
    const keyAuthContent = document.getElementById('keyAuthContent');

    // Inputs
    const inputName = document.getElementById('inputName');
    const inputHost = document.getElementById('inputHost');
    const inputPort = document.getElementById('inputPort');
    const inputUsername = document.getElementById('inputUsername');
    const inputPassword = document.getElementById('inputPassword');
    const inputPrivateKey = document.getElementById('inputPrivateKey');
    const inputPassphrase = document.getElementById('inputPassphrase');
    const inputRemotePath = document.getElementById('inputRemotePath');
    const inputUploadOnSave = document.getElementById('inputUploadOnSave');
    const inputSecure = document.getElementById('inputSecure');

    // Protocol tabs
    document.querySelectorAll('.protocol-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.protocol-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        selectedProtocol = tab.dataset.protocol;
        updateFormForProtocol();
      });
    });

    function updateFormForProtocol() {
      // Show/hide SFTP key auth
      sftpAuthSection.classList.toggle('hidden', selectedProtocol !== 'sftp');

      // Show/hide FTPS options
      ftpsOptions.classList.toggle('hidden', selectedProtocol !== 'ftps');

      // Update default port
      if (!inputPort.value || inputPort.value === '22' || inputPort.value === '21' || inputPort.value === '990') {
        inputPort.placeholder = selectedProtocol === 'sftp' ? '22' : '21';
      }
    }

    // Toggle key auth section
    document.getElementById('toggleKeyAuth').addEventListener('click', () => {
      keyAuthContent.classList.toggle('open');
      document.getElementById('toggleKeyAuth').querySelector('span').textContent =
        keyAuthContent.classList.contains('open') ? '▼' : '▶';
    });

    // Header buttons
    document.getElementById('btnHeaderNew').addEventListener('click', showNewForm);
    document.getElementById('btnHeaderRefresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'loadConfigs' });
    });

    // New connection button (only btnFirstConnection remains in empty state)
    const btnFirstConnection = document.getElementById('btnFirstConnection');
    if (btnFirstConnection) {
      btnFirstConnection.addEventListener('click', showNewForm);
    }

    function showNewForm() {
      editingIndex = null;
      formTitle.textContent = 'New Connection';
      clearForm();
      connectionForm.classList.remove('hidden');
      showForm = true;
      // Notify to collapse Remote Explorer
      vscode.postMessage({ type: 'showForm' });
    }
    
    // Expose showNewForm for external calls
    window.showNewForm = showNewForm;

    function clearForm() {
      inputName.value = '';
      inputHost.value = '';
      inputPort.value = '';
      inputUsername.value = '';
      inputPassword.value = '';
      inputPrivateKey.value = '';
      inputPassphrase.value = '';
      inputRemotePath.value = '/';
      inputUploadOnSave.checked = false;
      inputSecure.checked = false;
      selectedProtocol = 'sftp';
      document.querySelectorAll('.protocol-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.protocol === 'sftp');
      });
      updateFormForProtocol();
    }

    function loadConfigToForm(config) {
      inputName.value = config.name || '';
      inputHost.value = config.host || '';
      inputPort.value = config.port || '';
      inputUsername.value = config.username || '';
      inputPassword.value = config.password || '';
      inputPrivateKey.value = config.privateKeyPath || '';
      inputPassphrase.value = config.passphrase || '';
      inputRemotePath.value = config.remotePath || '/';
      inputUploadOnSave.checked = config.uploadOnSave || false;
      inputSecure.checked = config.secure || false;

      selectedProtocol = config.protocol || 'sftp';
      document.querySelectorAll('.protocol-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.protocol === selectedProtocol);
      });
      updateFormForProtocol();

      if (config.privateKeyPath) {
        keyAuthContent.classList.add('open');
        document.getElementById('toggleKeyAuth').querySelector('span').textContent = '▼';
      }
    }

    function getFormData() {
      return {
        name: inputName.value.trim() || inputHost.value.trim(),
        host: inputHost.value.trim(),
        port: inputPort.value || (selectedProtocol === 'sftp' ? 22 : 21),
        protocol: selectedProtocol,
        username: inputUsername.value.trim(),
        password: inputPassword.value,
        privateKeyPath: inputPrivateKey.value.trim() || undefined,
        passphrase: inputPassphrase.value || undefined,
        remotePath: inputRemotePath.value.trim() || '/',
        uploadOnSave: inputUploadOnSave.checked,
        secure: inputSecure.checked
      };
    }

    function validateForm(data) {
      let isValid = true;
      const errors = [];

      // Reset errors
      document.querySelectorAll('.form-input').forEach(input => {
        input.classList.remove('input-error');
      });
      document.querySelectorAll('.form-input-error-message').forEach(msg => {
        msg.remove();
      });

      // Helper to show error
      const showError = (elementId, message) => {
        const input = document.getElementById(elementId);
        if (input) {
          input.classList.add('input-error');
          const msg = document.createElement('div');
          msg.className = 'form-input-error-message';
          msg.textContent = message;
          input.parentNode.insertBefore(msg, input.nextSibling);
        }
        isValid = false;
      };

      if (!data.host) {
        showError('inputHost', 'Host is required');
      }

      if (data.protocol !== 'sftp' && !data.username) {
        // Username might be optional for some anon FTP? But usually required.
        // Let's enforce it for now as per user request for validation.
        showError('inputUsername', 'Username is required');
      }

      if (data.protocol === 'sftp') {
         if (!data.username) {
            showError('inputUsername', 'Username is required');
         }
      }

      return isValid;
    }

    // Form actions
    document.getElementById('btnCancel').addEventListener('click', () => {
      connectionForm.classList.add('hidden');
      showForm = false;
      editingIndex = null;
      // Notify to expand Remote Explorer
      vscode.postMessage({ type: 'hideForm' });
    });

    document.getElementById('btnTest').addEventListener('click', () => {
      console.log('Test button clicked');
      try {
        const config = getFormData();
        if (!validateForm(config)) {
          console.warn('Form validation failed');
          
          // Visual feedback for missing fields
          const btn = document.getElementById('btnTest');
          const originalText = btn.textContent;
          btn.textContent = 'Required!';
          btn.classList.add('btn-disconnect'); // Red color
          
          setTimeout(() => { 
            btn.textContent = 'Test'; 
            btn.classList.remove('btn-disconnect');
          }, 2000);
          
          return;
        }
        
        // Show immediate feedback
        const btn = document.getElementById('btnTest');
        const originalText = btn.textContent;
        btn.textContent = 'Sending...';
        
        vscode.postMessage({ type: 'testConnection', config });
        console.log('Test message sent to extension', config);
      } catch (e) {
        console.error('Error in test button handler:', e);
        const btn = document.getElementById('btnTest');
        btn.textContent = 'Error';
        setTimeout(() => { btn.textContent = 'Test'; }, 2000);
      }
    });

    document.getElementById('btnSave').addEventListener('click', () => {
      const config = getFormData();
      if (!validateForm(config)) {
        return;
      }
      vscode.postMessage({ type: 'saveConfig', config, index: editingIndex });
    });

    document.getElementById('btnBrowseKey').addEventListener('click', () => {
      vscode.postMessage({ type: 'browsePrivateKey' });
    });

    // Render connection list
    function renderConnections() {
      if (configs.length === 0) {
        emptyState.classList.remove('hidden');
        return;
      }

      emptyState.classList.add('hidden');

      // Remove old items (keep empty state)
      const oldItems = connectionList.querySelectorAll('.connection-item');
      oldItems.forEach(item => item.remove());

      configs.forEach((config, index) => {
        const item = document.createElement('div');
        item.className = 'connection-item' + (config.connected ? ' connected' : '');

        // Use codicon classes for icons
        const protocolIconClass = config.protocol === 'sftp' ? 'codicon-lock' : 'codicon-folder';
        const statusClass = config.connected ? 'status-connected' : '';

        item.innerHTML = \`
          <div class="connection-icon \${statusClass}">
            <span class="codicon \${protocolIconClass}"></span>
          </div>
          <div class="connection-info">
            <div class="connection-name">\${escapeHtml(config.name || config.host)}</div>
            <div class="connection-details">\${config.protocol.toUpperCase()} · \${config.username}@\${config.host}</div>
          </div>
          <div class="connection-actions">
            \${config.connected
              ? '<button class="btn-icon btn-disconnect" data-action="disconnect" title="Disconnect"><span class="codicon codicon-debug-disconnect"></span></button>'
              : '<button class="btn-icon btn-connect" data-action="connect" title="Connect"><span class="codicon codicon-plug"></span></button>'
            }
            <div class="dropdown">
              <button class="btn-icon dropdown-toggle" title="More actions"><span class="codicon codicon-ellipsis"></span></button>
              <div class="dropdown-menu">
                <button class="dropdown-item" data-action="edit"><span class="codicon codicon-edit"></span> Edit</button>
                <button class="dropdown-item" data-action="delete"><span class="codicon codicon-trash"></span> Delete</button>
              </div>
            </div>
          </div>
        \`;

        // Handle dropdown toggle
        const dropdownToggle = item.querySelector('.dropdown-toggle');
        const dropdownMenu = item.querySelector('.dropdown-menu');
        
        dropdownToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          // Close other open dropdowns
          document.querySelectorAll('.dropdown-menu.show').forEach(menu => {
            if (menu !== dropdownMenu) menu.classList.remove('show');
          });
          dropdownMenu.classList.toggle('show');
        });

        item.querySelectorAll('[data-action]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            // Close dropdown menu
            dropdownMenu.classList.remove('show');

            if (action === 'connect') {
              vscode.postMessage({ type: 'connect', index });
            } else if (action === 'disconnect') {
              vscode.postMessage({ type: 'disconnect', index });
            } else if (action === 'edit') {
              editingIndex = index;
              formTitle.textContent = 'Edit Connection';
              loadConfigToForm(config);
              connectionForm.classList.remove('hidden');
              // Notify to collapse Remote Explorer
              vscode.postMessage({ type: 'showForm' });
            } else if (action === 'delete') {
              vscode.postMessage({ type: 'deleteConfig', index });
            }
          });
        });

        // Double click to connect/disconnect
        item.addEventListener('dblclick', () => {
          if (config.connected) {
            vscode.postMessage({ type: 'disconnect', index });
          } else {
            vscode.postMessage({ type: 'connect', index });
          }
        });

        connectionList.appendChild(item);
      });
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Message handler
    window.addEventListener('message', event => {
      const msg = event.data;

      switch (msg.type) {
        case 'configs':
          configs = msg.configs || [];
          renderConnections();

          if (msg.editing) {
            editingIndex = msg.editing.index;
            formTitle.textContent = 'Edit Connection';
            loadConfigToForm(msg.editing.config);
            connectionForm.classList.remove('hidden');
          }
          break;

        case 'noWorkspace':
          connectionList.innerHTML = '<div class="empty-state"><p>Open a folder to manage connections</p></div>';
          break;

        case 'triggerNewForm':
          showNewForm();
          break;

        case 'saveSuccess':
          connectionForm.classList.add('hidden');
          editingIndex = null;
          // Notify to expand Remote Explorer
          vscode.postMessage({ type: 'hideForm' });
          break;

        case 'saveError':
          // Show error in form
          break;

        case 'testing':
          document.getElementById('btnTest').textContent = 'Testing...';
          document.getElementById('btnTest').disabled = true;
          break;

        case 'testSuccess':
        case 'testError':
          document.getElementById('btnTest').textContent = 'Test';
          document.getElementById('btnTest').disabled = false;
          break;

        case 'privateKeySelected':
          inputPrivateKey.value = msg.path;
          break;
      }
    });

    // Initial load
    vscode.postMessage({ type: 'loadConfigs' });
  </script>
</body>
</html>`;
  }
}
