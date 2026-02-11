/**
 * StackerFTP - Connection Form WebView Provider
 *
 * Minimalist connection form compatible with native VS Code UI
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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
  private _selectedWorkspaceRoot?: string;
  private _configWatcher?: vscode.FileSystemWatcher;

  constructor(private readonly _extensionUri: vscode.Uri) {
    connectionManager.onConnectionChanged(() => {
      this.refresh();
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    // Start watching for config changes
    this._resolveWorkspaceRoot().then(root => {
      if (root) {
        if (this._configWatcher) {
          this._configWatcher.dispose();
        }

        this._configWatcher = configManager.watchConfig(root, () => {
          this._sendConfigs();
        });

        webviewView.onDidDispose(() => {
          if (this._configWatcher) {
            this._configWatcher.dispose();
            this._configWatcher = undefined;
          }
        });
      }
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    const nonce = this._getNonce();
    this._getHtmlForWebview(webviewView.webview, nonce).then(html => {
      webviewView.webview.html = html;
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      try {
        switch (data.type) {
          case 'ready': // Added ready handshake
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
            vscode.commands.executeCommand('setContext', 'stackerftp.formVisible', true);
            vscode.commands.executeCommand('stackerftp.connectionForm.focus');
            break;
          case 'hideForm':
            vscode.commands.executeCommand('setContext', 'stackerftp.formVisible', false);
            vscode.commands.executeCommand('stackerftp.tree.refresh');
            vscode.commands.executeCommand('stackerftp.remoteExplorerTree.focus');
            break;
        }
      } catch (error: any) {
        logger.error('ConnectionFormProvider message handler error', error);
        statusBar.error(`Form error: ${error.message || error}`);
      }
    });

    // Send initial configs with a small delay to ensure webview is ready
    setTimeout(() => this._sendConfigs(), 500);
  }

  private _getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private async _resolveWorkspaceRoot(requireSelection: boolean = false): Promise<string | undefined> {
    if (this._selectedWorkspaceRoot) {
      return this._selectedWorkspaceRoot;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }

    if (folders.length === 1) {
      this._selectedWorkspaceRoot = folders[0].uri.fsPath;
      return this._selectedWorkspaceRoot;
    }

    if (!requireSelection) {
      // Default to first folder to avoid prompting on initial load
      this._selectedWorkspaceRoot = folders[0].uri.fsPath;
      return this._selectedWorkspaceRoot;
    }

    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'Select workspace folder for SFTP config'
    });
    if (!picked) return undefined;

    this._selectedWorkspaceRoot = picked.uri.fsPath;
    return this._selectedWorkspaceRoot;
  }

  private async _sendConfigs() {
    if (!this._view) return;

    const workspaceRoot = await this._resolveWorkspaceRoot(false);
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
    const workspaceRoot = await this._resolveWorkspaceRoot(true);
    if (!workspaceRoot) {
      this._view?.webview.postMessage({ type: 'saveError', message: 'No workspace folder selected' });
      statusBar.error('Select a workspace folder to save the configuration');
      return;
    }

    try {
      statusBar.info('Saving connection configuration...');
      await configManager.loadConfig(workspaceRoot);
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

      if (typeof editIndex === 'number' && editIndex >= 0) {
        configs[editIndex] = newConfig;
      } else {
        configs.push(newConfig);
      }

      await configManager.saveConfig(workspaceRoot, configs);

      this._editingConfig = undefined;
      this._editingIndex = undefined;

      this._view?.webview.postMessage({ type: 'saveSuccess' });
      statusBar.success('Connection saved');
      vscode.window.showInformationMessage(`StackerFTP: Saved to ${configManager.getConfigPath(workspaceRoot)}`);
      await this._sendConfigs();
    } catch (error: any) {
      this._view?.webview.postMessage({ type: 'saveError', message: error.message });
      statusBar.error(`Failed to save: ${error.message}`);
    }
  }

  private async _handleDeleteConfig(index: number) {
    const workspaceRoot = await this._resolveWorkspaceRoot(true);
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (typeof index !== 'number' || index < 0 || index >= configs.length) return;

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
    const workspaceRoot = await this._resolveWorkspaceRoot(true);
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (typeof index !== 'number' || index < 0 || index >= configs.length) return;

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
    const workspaceRoot = await this._resolveWorkspaceRoot(true);
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (typeof index !== 'number' || index < 0 || index >= configs.length) return;

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
    const workspaceRoot = await this._resolveWorkspaceRoot(true);
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (typeof index !== 'number' || index < 0 || index >= configs.length) return;

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

  private async _getHtmlForWebview(webview: vscode.Webview, nonce: string): Promise<string> {
    // Get paths to resources
    const resourcesPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview');

    // Read files safely using VS Code FS API
    let htmlContent = '';
    let cssContent = '';
    let jsContent = '';

    try {
      const htmlUri = vscode.Uri.joinPath(resourcesPath, 'connection-form.html');
      const cssUri = vscode.Uri.joinPath(resourcesPath, 'connection-form.css');
      const jsUri = vscode.Uri.joinPath(resourcesPath, 'connection-form.js');

      const [htmlData, cssData, jsData] = await Promise.all([
        vscode.workspace.fs.readFile(htmlUri),
        vscode.workspace.fs.readFile(cssUri),
        vscode.workspace.fs.readFile(jsUri)
      ]);

      const decoder = new TextDecoder('utf-8');
      htmlContent = decoder.decode(htmlData);
      cssContent = decoder.decode(cssData);
      jsContent = decoder.decode(jsData);
    } catch (e) {
      logger.error('Failed to read webview resources using VS Code FS', e);
      htmlContent = `<div style="padding: 20px;"><h3>Error loading view resources</h3><p>${e}</p></div>`;
    }

    // Get codicon CSS URI
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource};">
  <title>StackerFTP Connections</title>
  <link href="${codiconUri}" rel="stylesheet" />
  <style>
    ${cssContent}
  </style>
</head>
<body>
    ${htmlContent}
    <script nonce="${nonce}">
      (function() {
        ${jsContent}
      })();
    </script>
</body>
</html>`;
  }
}
