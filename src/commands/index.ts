/**
 * StackerFTP - Commands
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { transferManager } from '../core/transfer-manager';
import { webMasterTools } from '../webmaster/tools';
import { logger } from '../utils/logger';
import { normalizeRemotePath, formatFileSize } from '../utils/helpers';
import { ConnectionWizard } from '../core/connection-wizard';
import { createGitIntegration } from '../core/git-integration';

import { ConnectionFormProvider } from '../providers/connection-form-provider';

export function registerCommands(
  context: vscode.ExtensionContext,
  remoteExplorer?: any,
  connectionFormProvider?: ConnectionFormProvider
): void {

  // ==================== Configuration Commands ====================

  const configCommand = vscode.commands.registerCommand('stackerftp.config', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    if (configManager.configExists(workspaceRoot)) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(add) Create New Connection (Wizard)', description: 'Step-by-step connection setup', value: 'wizard' },
          { label: '$(file-code) Open Config File', description: 'Edit sftp.json directly', value: 'open' },
          { label: '$(repo-forked) Create New Config (JSON)', description: 'Create raw JSON config', value: 'json' },
          { label: '$(symbol-color) Edit Profiles', description: 'Manage connection profiles', value: 'profiles' }
        ],
        { placeHolder: 'Select an action' }
      );

      if (!choice) return;

      switch (choice.value) {
        case 'wizard':
          await ConnectionWizard.createNewConnection(workspaceRoot);
          break;
        case 'open':
          const configPath = configManager.getConfigPath(workspaceRoot);
          const doc = await vscode.workspace.openTextDocument(configPath);
          await vscode.window.showTextDocument(doc);
          break;
        case 'json':
          await configManager.createDefaultConfig(workspaceRoot);
          break;
        case 'profiles':
          vscode.window.showInformationMessage('Profile management coming soon!');
          break;
      }
    } else {
      // No config exists - offer wizard or simple config
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(add) Connection Wizard (Recommended)', description: 'Step-by-step setup with protocol selection', value: 'wizard' },
          { label: '$(file-code) Simple Config', description: 'Create basic JSON template', value: 'simple' }
        ],
        { placeHolder: 'How would you like to create your first connection?' }
      );

      if (choice?.value === 'wizard') {
        await ConnectionWizard.createNewConnection(workspaceRoot);
      } else if (choice?.value === 'simple') {
        await configManager.createDefaultConfig(workspaceRoot);
      }
    }
  });

  // ==================== Connection Commands ====================

  const connectCommand = vscode.commands.registerCommand('stackerftp.connect', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);

    if (configs.length === 0) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(add) Create New Connection', description: 'Set up a new server connection', value: 'new' },
          { label: '$(file-code) Open Config', description: 'Edit configuration file', value: 'config' }
        ],
        { placeHolder: 'No connections found. What would you like to do?' }
      );

      if (choice?.value === 'new') {
        await ConnectionWizard.createNewConnection(workspaceRoot);
      } else if (choice?.value === 'config') {
        await vscode.commands.executeCommand('stackerftp.config');
      }
      return;
    }

    // Show connection selector if multiple configs exist
    if (configs.length === 1) {
      try {
        await connectionManager.connect(configs[0]);
        vscode.window.showInformationMessage(`StackerFTP: Connected to ${configs[0].name || configs[0].host}`);
        if (remoteExplorer?.refresh) {
          remoteExplorer.refresh();
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`Connection failed: ${error.message}`);
      }
      return;
    }

    const items = configs.map((config, index) => {
      const isConnected = connectionManager.isConnected(config);
      return {
        label: `${isConnected ? '$(debug-start)' : '$(debug-disconnect)'} ${config.name || config.host}`,
        description: `${config.protocol.toUpperCase()} | ${config.username}@${config.host}:${config.port || (config.protocol === 'sftp' ? 22 : 21)}`,
        detail: isConnected ? 'Connected' : 'Click to connect',
        config,
        index
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Select Connection',
      placeHolder: 'Choose a server to connect'
    });

    if (!selected) return;

    try {
      await connectionManager.connect(selected.config);
      vscode.window.showInformationMessage(`StackerFTP: Connected to ${selected.config.name || selected.config.host}`);
      if (remoteExplorer?.refresh) {
        remoteExplorer.refresh();
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Connection failed: ${error.message}`);
    }
  });

  const disconnectCommand = vscode.commands.registerCommand('stackerftp.disconnect', async () => {
    const activeConnections = connectionManager.getActiveConnections();

    if (activeConnections.length === 0) {
      vscode.window.showInformationMessage('No active connections to disconnect');
      return;
    }

    try {
      await connectionManager.disconnect();
      vscode.window.showInformationMessage('Disconnected from all servers');
      if (remoteExplorer?.refresh) {
        remoteExplorer.refresh();
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Disconnect failed: ${error.message}`);
    }
  });

  const setProfileCommand = vscode.commands.registerCommand('stackerftp.setProfile', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const profiles = configManager.getAvailableProfiles(workspaceRoot);
    if (profiles.length === 0) {
      vscode.window.showInformationMessage('No profiles configured');
      return;
    }

    const selected = await vscode.window.showQuickPick(profiles, {
      placeHolder: 'Select a profile'
    });

    if (selected) {
      configManager.setProfile(workspaceRoot, selected);
      vscode.window.showInformationMessage(`Switched to profile: ${selected}`);

    }
  });

  // ==================== Transfer Commands ====================

  const uploadCommand = vscode.commands.registerCommand('stackerftp.upload', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    const localPath = uri?.fsPath;
    if (!localPath) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = path.relative(workspaceRoot, localPath);
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      if (fs.statSync(localPath).isDirectory()) {
        const result = await transferManager.uploadDirectory(connection, localPath, remotePath, config);
        showSyncResult(result, 'upload');
      } else {
        // Ensure remote directory exists
        const remoteDir = normalizeRemotePath(path.dirname(remotePath));
        try {
          await connection.mkdir(remoteDir);
        } catch {
          // Directory might already exist
        }
        await transferManager.uploadFile(connection, localPath, remotePath, config);
      }

      vscode.window.showInformationMessage(`Uploaded: ${path.basename(localPath)}`);

    } catch (error: any) {
      vscode.window.showErrorMessage(`Upload failed: ${error.message}`);
    }
  });

  const uploadCurrentFileCommand = vscode.commands.registerCommand('stackerftp.uploadCurrentFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor');
      return;
    }

    const localPath = editor.document.fileName;
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = path.relative(workspaceRoot, localPath);
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      // Save file first if modified
      if (editor.document.isDirty) {
        await editor.document.save();
      }

      // Ensure remote directory exists
      const remoteDir = normalizeRemotePath(path.dirname(remotePath));
      try {
        await connection.mkdir(remoteDir);
      } catch {
        // Directory might already exist
      }

      await transferManager.uploadFile(connection, localPath, remotePath, config);
      vscode.window.showInformationMessage(`Uploaded: ${path.basename(localPath)}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Upload failed: ${error.message}`);
    }
  });

  const downloadCommand = vscode.commands.registerCommand('stackerftp.download', async (item?: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);

      let remotePath: string;
      let localPath: string;

      if (item) {
        remotePath = item.entry.path;
        const relativePath = path.relative(config.remotePath, remotePath);
        localPath = path.join(workspaceRoot, relativePath);
      } else {
        // Download entire project
        const choice = await vscode.window.showWarningMessage(
          'Download entire project?',
          'Yes', 'No'
        );
        if (choice !== 'Yes') return;

        remotePath = config.remotePath;
        localPath = workspaceRoot;
      }

      if (item?.entry.type === 'directory' || !item) {
        const result = await transferManager.downloadDirectory(connection, remotePath, localPath, config);
        showSyncResult(result, 'download');
      } else {
        // Ensure local directory exists
        const localDir = path.dirname(localPath);
        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }
        await transferManager.downloadFile(connection, remotePath, localPath);
      }

      vscode.window.showInformationMessage(`Downloaded: ${path.basename(remotePath)}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Download failed: ${error.message}`);
    }
  });

  const downloadProjectCommand = vscode.commands.registerCommand('stackerftp.downloadProject', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      'Download entire project?',
      'Yes', 'No'
    );
    if (choice !== 'Yes') return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      const result = await transferManager.downloadDirectory(connection, config.remotePath, workspaceRoot, config);
      showSyncResult(result, 'download');
      vscode.window.showInformationMessage('Project downloaded successfully');
    } catch (error: any) {
      vscode.window.showErrorMessage(`Download failed: ${error.message}`);
    }
  });

  // ==================== Sync Commands ====================

  const syncToRemoteCommand = vscode.commands.registerCommand('stackerftp.syncToRemote', async (uri?: vscode.Uri) => {
    await performSync('toRemote', uri);
  });

  const syncToLocalCommand = vscode.commands.registerCommand('stackerftp.syncToLocal', async (uri?: vscode.Uri) => {
    await performSync('toLocal', uri);
  });

  const syncBothWaysCommand = vscode.commands.registerCommand('stackerftp.syncBothWays', async (uri?: vscode.Uri) => {
    await performSync('both', uri);
  });

  async function performSync(direction: 'toRemote' | 'toLocal' | 'both', uri?: vscode.Uri) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    const confirmSync = vscode.workspace.getConfiguration('stackerftp').get<boolean>('confirmSync', true);
    if (confirmSync) {
      const action = direction === 'toRemote' ? 'Local → Remote' : direction === 'toLocal' ? 'Remote → Local' : 'Both ways';
      const choice = await vscode.window.showWarningMessage(
        `Sync ${action}?`,
        { modal: true },
        'Yes', 'No'
      );
      if (choice !== 'Yes') return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);

      let localPath: string;
      let remotePath: string;

      if (uri) {
        localPath = uri.fsPath;
        const relativePath = path.relative(workspaceRoot, localPath);
        remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));
      } else {
        localPath = workspaceRoot;
        remotePath = config.remotePath;
      }

      let result;
      if (direction === 'toRemote') {
        result = await transferManager.syncToRemote(connection, localPath, remotePath, config);
      } else if (direction === 'toLocal') {
        result = await transferManager.syncToLocal(connection, remotePath, localPath, config);
      } else {
        result = await transferManager.syncBothWays(connection, localPath, remotePath, config);
      }

      showSyncResult(result, direction === 'toRemote' ? 'upload' : 'download');

    } catch (error: any) {
      vscode.window.showErrorMessage(`Sync failed: ${error.message}`);
    }
  }

  function showSyncResult(result: { uploaded: string[]; downloaded: string[]; failed: any[] }, type: string): void {
    const messages: string[] = [];

    if (result.uploaded.length > 0) {
      messages.push(`Uploaded: ${result.uploaded.length} files`);
    }
    if (result.downloaded.length > 0) {
      messages.push(`Downloaded: ${result.downloaded.length} files`);
    }
    if (result.failed.length > 0) {
      messages.push(`Failed: ${result.failed.length} files`);
    }

    if (messages.length > 0) {
      vscode.window.showInformationMessage(messages.join(', '));
    }

    if (result.failed.length > 0) {
      logger.error('Sync failures', result.failed);
    }
  }

  // ==================== File Management Commands ====================

  const openRemoteFileCommand = vscode.commands.registerCommand('stackerftp.openRemoteFile', async (item: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      const content = await connection.readFile(item.entry.path);

      // Create a temporary file
      const tempDir = path.join(require('os').tmpdir(), 'stackerftp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const tempPath = path.join(tempDir, item.entry.name);
      fs.writeFileSync(tempPath, content);

      const doc = await vscode.workspace.openTextDocument(tempPath);
      await vscode.window.showTextDocument(doc);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to open file: ${error.message}`);
    }
  });

  const deleteRemoteCommand = vscode.commands.registerCommand('stackerftp.deleteRemote', async (item: any) => {
    const confirmDelete = vscode.workspace.getConfiguration('stackerftp').get<boolean>('confirmDelete', true);

    if (confirmDelete) {
      const choice = await vscode.window.showWarningMessage(
        `Delete ${item.entry.name}?`,
        { modal: true },
        'Delete', 'Cancel'
      );
      if (choice !== 'Delete') return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    try {
      const connection = await connectionManager.ensureConnection(config);

      if (item.entry.type === 'directory') {
        await connection.rmdir(item.entry.path, true);
      } else {
        await connection.delete(item.entry.path);
      }

      vscode.window.showInformationMessage(`Deleted: ${item.entry.name}`);

    } catch (error: any) {
      vscode.window.showErrorMessage(`Delete failed: ${error.message}`);
    }
  });

  const newFolderCommand = vscode.commands.registerCommand('stackerftp.newFolder', async (item?: any) => {
    const folderName = await vscode.window.showInputBox({
      prompt: 'Enter folder name',
      placeHolder: 'new-folder'
    });

    if (!folderName) return;

    // Get config and connection from item if available, otherwise pick from active connections
    let config: any;
    let connection: any;
    
    if (item?.config) {
      config = item.config;
      connection = item.connectionRef || connectionManager.getConnection(config);
    } else {
      // Pick from active connections
      const activeConnections = connectionManager.getAllActiveConnections();
      if (activeConnections.length === 0) {
        vscode.window.showErrorMessage('No active connection. Connect first.');
        return;
      } else if (activeConnections.length === 1) {
        config = activeConnections[0].config;
        connection = activeConnections[0].connection;
      } else {
        const selected = await vscode.window.showQuickPick(
          activeConnections.map(c => ({ label: c.config.name || c.config.host, config: c.config, connection: c.connection })),
          { placeHolder: 'Select connection for new folder' }
        );
        if (!selected) return;
        config = selected.config;
        connection = selected.connection;
      }
    }

    if (!connection || !config) {
      vscode.window.showErrorMessage('No active connection');
      return;
    }

    try {
      let parentPath: string;
      if (item && item.entry?.type === 'directory') {
        parentPath = item.entry.path;
      } else if (item?.entry) {
        parentPath = path.dirname(item.entry.path);
      } else {
        parentPath = config.remotePath || '/';
      }

      const newPath = normalizeRemotePath(path.join(parentPath, folderName));
      await connection.mkdir(newPath);

      vscode.window.showInformationMessage(`Created folder: ${folderName}`);
      if (remoteExplorer) remoteExplorer.refresh();

    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to create folder: ${error.message}`);
    }
  });

  const newFileCommand = vscode.commands.registerCommand('stackerftp.newFile', async (item?: any) => {
    const fileName = await vscode.window.showInputBox({
      prompt: 'Enter file name',
      placeHolder: 'new-file.txt'
    });

    if (!fileName) return;

    // Get config and connection from item if available, otherwise pick from active connections
    let config: any;
    let connection: any;
    
    if (item?.config) {
      config = item.config;
      connection = item.connectionRef || connectionManager.getConnection(config);
    } else {
      // Pick from active connections
      const activeConnections = connectionManager.getAllActiveConnections();
      if (activeConnections.length === 0) {
        vscode.window.showErrorMessage('No active connection. Connect first.');
        return;
      } else if (activeConnections.length === 1) {
        config = activeConnections[0].config;
        connection = activeConnections[0].connection;
      } else {
        const selected = await vscode.window.showQuickPick(
          activeConnections.map(c => ({ label: c.config.name || c.config.host, config: c.config, connection: c.connection })),
          { placeHolder: 'Select connection for new file' }
        );
        if (!selected) return;
        config = selected.config;
        connection = selected.connection;
      }
    }

    if (!connection || !config) {
      vscode.window.showErrorMessage('No active connection');
      return;
    }

    try {
      let parentPath: string;
      if (item && item.entry?.type === 'directory') {
        parentPath = item.entry.path;
      } else if (item?.entry) {
        parentPath = path.dirname(item.entry.path);
      } else {
        parentPath = config.remotePath || '/';
      }

      const newPath = normalizeRemotePath(path.join(parentPath, fileName));
      await connection.writeFile(newPath, '');

      vscode.window.showInformationMessage(`Created file: ${fileName}`);
      if (remoteExplorer) remoteExplorer.refresh();

    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to create file: ${error.message}`);
    }
  });

  const collapseAllCommand = vscode.commands.registerCommand('stackerftp.collapseAll', () => {
    // This command is handled by VS Code's native tree view collapse functionality
    vscode.commands.executeCommand('workbench.actions.treeView.stackerftp.remoteExplorerTree.collapseAll');
  });

  const renameCommand = vscode.commands.registerCommand('stackerftp.rename', async (item: any) => {
    if (!item?.entry) {
      vscode.window.showErrorMessage('No item selected');
      return;
    }

    const newName = await vscode.window.showInputBox({
      prompt: 'Enter new name',
      value: item.entry.name
    });

    if (!newName || newName === item.entry.name) return;

    // Get config and connection from item
    const config = item.config;
    const connection = item.connectionRef || connectionManager.getConnection(config);

    if (!connection || !config) {
      vscode.window.showErrorMessage('No active connection');
      return;
    }

    try {
      const newPath = normalizeRemotePath(path.join(path.dirname(item.entry.path), newName));

      await connection.rename(item.entry.path, newPath);
      vscode.window.showInformationMessage(`Renamed to: ${newName}`);
      if (remoteExplorer) remoteExplorer.refresh();

    } catch (error: any) {
      vscode.window.showErrorMessage(`Rename failed: ${error.message}`);
    }
  });

  const duplicateCommand = vscode.commands.registerCommand('stackerftp.duplicate', async (item: any) => {
    if (!item?.entry) {
      vscode.window.showErrorMessage('No item selected');
      return;
    }

    // Get config and connection from item
    const config = item.config;
    const connection = item.connectionRef || connectionManager.getConnection(config);

    if (!connection || !config) {
      vscode.window.showErrorMessage('No active connection');
      return;
    }

    try {
      const content = await connection.readFile(item.entry.path);

      const ext = path.extname(item.entry.name);
      const base = path.basename(item.entry.name, ext);
      const newName = `${base}_copy${ext}`;
      const newPath = normalizeRemotePath(path.join(path.dirname(item.entry.path), newName));

      await connection.writeFile(newPath, content);
      vscode.window.showInformationMessage(`Duplicated: ${newName}`);
      if (remoteExplorer) remoteExplorer.refresh();

    } catch (error: any) {
      vscode.window.showErrorMessage(`Duplicate failed: ${error.message}`);
    }
  });

  const refreshCommand = vscode.commands.registerCommand('stackerftp.refresh', () => {
    if (remoteExplorer?.refresh) {
      remoteExplorer.refresh();
      logger.info('Remote explorer refreshed');
    } else {
      logger.warn('No remote explorer available to refresh');
    }
  });

  // ==================== Utility Commands ====================

  const diffCommand = vscode.commands.registerCommand('stackerftp.diff', async (uri?: vscode.Uri, item?: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    try {
      let localPath: string;
      let remotePath: string;
      let fileName: string;

      if (uri && !item) {
        // Called from local file
        localPath = uri.fsPath;
        const relativePath = path.relative(workspaceRoot, localPath);
        remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));
        fileName = path.basename(localPath);
      } else if (item) {
        // Called from remote explorer
        remotePath = item.entry.path;
        const relativePath = path.relative(config.remotePath, remotePath);
        localPath = path.join(workspaceRoot, relativePath);
        fileName = item.entry.name;
      } else {
        vscode.window.showErrorMessage('No file selected');
        return;
      }

      // Check if local file exists
      if (!fs.existsSync(localPath)) {
        vscode.window.showErrorMessage(`Local file not found: ${fileName}`);
        return;
      }

      // Download remote file to temp
      const connection = await connectionManager.ensureConnection(config);
      const tempDir = path.join(require('os').tmpdir(), 'stackerftp-diff');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempRemotePath = path.join(tempDir, `${fileName}.remote`);

      await connection.download(remotePath, tempRemotePath);

      // Show diff
      const localUri = vscode.Uri.file(localPath);
      const remoteUri = vscode.Uri.file(tempRemotePath);

      await vscode.commands.executeCommand('vscode.diff', remoteUri, localUri,
        `${fileName} (Remote) ↔ ${fileName} (Local)`,
        { preview: true }
      );

      logger.info(`Diff shown for ${fileName}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Diff failed: ${error.message}`);
    }
  });

  const terminalCommand = vscode.commands.registerCommand('stackerftp.terminal', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    if (config.protocol !== 'sftp') {
      vscode.window.showErrorMessage('Remote terminal is only available with SFTP protocol');
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: `SFTP: ${config.host}`,
      shellPath: 'ssh',
      shellArgs: [
        '-p', String(config.port || 22),
        `${config.username}@${config.host}`
      ]
    });

    terminal.show();
  });

  const viewLogsCommand = vscode.commands.registerCommand('stackerftp.viewLogs', () => {
    logger.show();
  });

  const clearLogsCommand = vscode.commands.registerCommand('stackerftp.clearLogs', () => {
    logger.clear();
    vscode.window.showInformationMessage('Logs cleared');
  });

  const cancelTransferCommand = vscode.commands.registerCommand('stackerftp.cancelTransfer', () => {
    transferManager.cancel();
    vscode.window.showInformationMessage('Transfer cancelled');
  });

  const transferQueueCommand = vscode.commands.registerCommand('stackerftp.transferQueue', () => {
    const queue = transferManager.getQueue();
    if (queue.length === 0) {
      vscode.window.showInformationMessage('Transfer queue is empty');
      return;
    }

    const items = queue.map(item => ({
      label: `${item.direction === 'upload' ? '$(arrow-up)' : '$(arrow-down)'} ${path.basename(item.localPath)}`,
      description: `${item.status} - ${Math.round(item.progress)}%`,
      item
    }));

    vscode.window.showQuickPick(items, {
      title: `Transfer Queue (${queue.length} items)`
    });
  });

  // ==================== Web Master Commands ====================

  const chmodCommand = vscode.commands.registerCommand('stackerftp.webmaster.chmod', async (item: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      await webMasterTools.showChmodDialog(connection, item.entry);

    } catch (error: any) {
      vscode.window.showErrorMessage(`chmod failed: ${error.message}`);
    }
  });

  const checksumCommand = vscode.commands.registerCommand('stackerftp.webmaster.checksum', async (item: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      const algorithm = await vscode.window.showQuickPick(
        ['md5', 'sha1', 'sha256'],
        { placeHolder: 'Select checksum algorithm' }
      ) as 'md5' | 'sha1' | 'sha256';

      if (!algorithm) return;

      const checksum = await webMasterTools.calculateRemoteChecksum(connection, item.entry.path, algorithm);
      await webMasterTools.showChecksumResult({ algorithm, remote: checksum }, item.entry.name);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Checksum failed: ${error.message}`);
    }
  });

  const fileInfoCommand = vscode.commands.registerCommand('stackerftp.webmaster.fileInfo', async (item: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      const info = await webMasterTools.getFileInfo(connection, item.entry);
      await webMasterTools.showFileInfo(info);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to get file info: ${error.message}`);
    }
  });

  const searchCommand = vscode.commands.registerCommand('stackerftp.webmaster.search', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    const pattern = await vscode.window.showInputBox({
      prompt: 'Enter search pattern',
      placeHolder: 'search text'
    });

    if (!pattern) return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      const results = await webMasterTools.searchInRemoteFiles(connection, config.remotePath, pattern);
      await webMasterTools.showSearchResults(results);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Search failed: ${error.message}`);
    }
  });

  const backupCommand = vscode.commands.registerCommand('stackerftp.webmaster.backup', async (item: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    const backupName = await vscode.window.showInputBox({
      prompt: 'Enter backup name (optional)',
      placeHolder: `backup-${new Date().toISOString().split('T')[0]}`
    });

    try {
      const connection = await connectionManager.ensureConnection(config);
      const backupPath = await webMasterTools.createBackup(connection, item.entry.path, backupName || undefined);
      vscode.window.showInformationMessage(`Backup created: ${backupPath}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Backup failed: ${error.message}`);
    }
  });

  const compareFoldersCommand = vscode.commands.registerCommand('stackerftp.webmaster.compareFolders', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    try {
      const connection = await connectionManager.ensureConnection(config);

      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Comparing folders...',
        cancellable: false
      }, async (progress) => {
        progress.report({ message: 'Scanning local files...' });
        const result = await webMasterTools.compareFolders(connection, workspaceRoot, config.remotePath);

        progress.report({ message: 'Done' });

        // Show results
        const items = [
          `$(file-add) Only in local: ${result.onlyLocal.length}`,
          `$(file-subtract) Only in remote: ${result.onlyRemote.length}`,
          `$(git-compare) Different: ${result.different.length}`
        ];

        const selected = await vscode.window.showQuickPick(items, {
          title: 'Folder Comparison Results',
          canPickMany: false
        });

        if (selected) {
          let detailList: string[] = [];
          if (selected.includes('Only in local')) {
            detailList = result.onlyLocal.slice(0, 50);
          } else if (selected.includes('Only in remote')) {
            detailList = result.onlyRemote.slice(0, 50);
          } else if (selected.includes('Different')) {
            detailList = result.different.slice(0, 50);
          }

          if (detailList.length > 0) {
            await vscode.window.showQuickPick(detailList, {
              title: selected,
              placeHolder: `Showing ${Math.min(detailList.length, 50)} of ${detailList.length} files`
            });
          }
        }
      });
    } catch (error: any) {
      vscode.window.showErrorMessage(`Folder comparison failed: ${error.message}`);
    }
  });

  const replaceCommand = vscode.commands.registerCommand('stackerftp.webmaster.replace', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      await webMasterTools.showFindAndReplaceDialog(connection, config.remotePath);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Find and replace failed: ${error.message}`);
    }
  });

  const purgeCacheCommand = vscode.commands.registerCommand('stackerftp.webmaster.purgeCache', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    const choice = await vscode.window.showWarningMessage(
      'Purge remote cache directories?',
      { modal: true },
      'Yes', 'No'
    );

    if (choice !== 'Yes') return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      await webMasterTools.purgeRemoteCache(connection, config.remotePath);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Purge cache failed: ${error.message}`);
    }
  });

  // ==================== Connection Wizard Commands ====================

  const newConnectionCommand = vscode.commands.registerCommand('stackerftp.newConnection', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Show the connection form in the webview
    if (connectionFormProvider) {
      // Focus on connection form and show new form
      await vscode.commands.executeCommand('stackerftp.connectionForm.focus');
      connectionFormProvider.showNewConnectionForm();
    } else {
      // Fallback to wizard
      await ConnectionWizard.createNewConnection(workspaceRoot);
    }
  });

  // ==================== Git Integration Commands ====================

  const uploadChangedFilesCommand = vscode.commands.registerCommand('stackerftp.uploadChangedFiles', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    const gitIntegration = createGitIntegration(workspaceRoot);

    if (!gitIntegration.isGitRepository()) {
      vscode.window.showErrorMessage('Not a Git repository');
      return;
    }

    try {
      const changedFiles = await gitIntegration.getChangedFiles();
      const uploadableFiles = gitIntegration.filterUploadable(changedFiles);

      if (uploadableFiles.length === 0) {
        vscode.window.showInformationMessage('No changed files to upload');
        return;
      }

      const choice = await vscode.window.showQuickPick(
        [
          { label: `$(cloud-upload) Upload All (${uploadableFiles.length} files)`, value: 'all' },
          { label: '$(list-selection) Select Files...', value: 'select' }
        ],
        { placeHolder: `${uploadableFiles.length} changed files found` }
      );

      if (!choice) return;

      let filesToUpload = uploadableFiles;

      if (choice.value === 'select') {
        const selected = await vscode.window.showQuickPick(
          uploadableFiles.map(f => ({
            label: `$(${f.status === 'added' ? 'add' : 'edit'}) ${f.path}`,
            description: f.status,
            file: f,
            picked: true
          })),
          {
            placeHolder: 'Select files to upload',
            canPickMany: true
          }
        );

        if (!selected || selected.length === 0) return;
        filesToUpload = selected.map(s => s.file);
      }

      const connection = await connectionManager.ensureConnection(config);

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Uploading changed files...',
        cancellable: true
      }, async (progress, token) => {
        let uploaded = 0;
        const total = filesToUpload.length;

        for (const file of filesToUpload) {
          if (token.isCancellationRequested) break;

          const relativePath = path.relative(workspaceRoot, file.absolutePath);
          const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

          progress.report({
            message: `${uploaded + 1}/${total}: ${path.basename(file.path)}`,
            increment: 100 / total
          });

          try {
            const remoteDir = normalizeRemotePath(path.dirname(remotePath));
            try {
              await connection.mkdir(remoteDir);
            } catch { }

            await transferManager.uploadFile(connection, file.absolutePath, remotePath, config);
            uploaded++;
          } catch (error: any) {
            logger.error(`Failed to upload ${file.path}`, error);
          }
        }

        vscode.window.showInformationMessage(`Uploaded ${uploaded}/${total} changed files`);
      });

    } catch (error: any) {
      vscode.window.showErrorMessage(`Upload failed: ${error.message}`);
    }
  });

  const uploadProjectCommand = vscode.commands.registerCommand('stackerftp.uploadProject', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      'Upload entire project to remote? This may overwrite remote files.',
      { modal: true },
      'Yes', 'No'
    );

    if (choice !== 'Yes') return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      const result = await transferManager.uploadDirectory(connection, workspaceRoot, config.remotePath, config);

      vscode.window.showInformationMessage(
        `Project uploaded: ${result.uploaded.length} files (${result.failed.length} failed)`
      );
    } catch (error: any) {
      vscode.window.showErrorMessage(`Upload project failed: ${error.message}`);
    }
  });

  // ==================== List Commands ====================

  const listCommand = vscode.commands.registerCommand('stackerftp.list', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const entries = await connection.list(config.remotePath);

      const items = entries.map(e => ({
        label: `$(${e.type === 'directory' ? 'folder' : 'file'}) ${e.name}`,
        description: e.type === 'file' ? formatFileSize(e.size) : '',
        detail: e.path,
        entry: e
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `${entries.length} items in ${config.remotePath}`
      });

      if (selected && selected.entry.type === 'file') {
        // Download and open
        const relativePath = path.relative(config.remotePath, selected.entry.path);
        const localPath = path.join(workspaceRoot, relativePath);
        const localDir = path.dirname(localPath);

        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }

        await transferManager.downloadFile(connection, selected.entry.path, localPath);
        const doc = await vscode.workspace.openTextDocument(localPath);
        await vscode.window.showTextDocument(doc);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`List failed: ${error.message}`);
    }
  });

  const listAllCommand = vscode.commands.registerCommand('stackerftp.listAll', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);

      const allFiles: any[] = [];

      async function listRecursive(dirPath: string) {
        const entries = await connection.list(dirPath);
        for (const entry of entries) {
          if (entry.type === 'file') {
            allFiles.push(entry);
          } else if (entry.type === 'directory' && !entry.name.startsWith('.')) {
            await listRecursive(entry.path);
          }
        }
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Scanning remote files...',
        cancellable: false
      }, async () => {
        await listRecursive(config.remotePath);
      });

      const items = allFiles.map(e => ({
        label: `$(file) ${path.basename(e.name)}`,
        description: formatFileSize(e.size),
        detail: e.path,
        entry: e
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `${allFiles.length} files found`,
        matchOnDetail: true
      });

      if (selected) {
        const relativePath = path.relative(config.remotePath, selected.entry.path);
        const localPath = path.join(workspaceRoot, relativePath);
        const localDir = path.dirname(localPath);

        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }

        await transferManager.downloadFile(connection, selected.entry.path, localPath);
        const doc = await vscode.workspace.openTextDocument(localPath);
        await vscode.window.showTextDocument(doc);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`List all failed: ${error.message}`);
    }
  });

  // ==================== Refresh Active File ====================

  const refreshActiveFileCommand = vscode.commands.registerCommand('stackerftp.refreshActiveFile', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      vscode.window.showErrorMessage('No active file');
      return;
    }

    const localPath = activeEditor.document.fileName;
    if (!localPath.startsWith(workspaceRoot)) {
      vscode.window.showErrorMessage('File is not in workspace');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = path.relative(workspaceRoot, localPath);
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      await transferManager.downloadFile(connection, remotePath, localPath);

      // Reload the document
      const doc = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(doc);

      vscode.window.showInformationMessage(`Refreshed: ${path.basename(localPath)}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Refresh failed: ${error.message}`);
    }
  });

  // ==================== Remote-to-Remote Transfer ====================

  const copyToOtherRemoteCommand = vscode.commands.registerCommand('stackerftp.copyToOtherRemote', async (item: any) => {
    if (!item || !item.entry) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }

    const sourceConfig = item.config;
    const activeConnections = connectionManager.getAllActiveConnections();

    // Filter out the source connection
    const otherConnections = activeConnections.filter(c =>
      c.config.host !== sourceConfig.host || c.config.username !== sourceConfig.username
    );

    if (otherConnections.length === 0) {
      vscode.window.showWarningMessage('No other remote connections available. Connect to another server first.');
      return;
    }

    // Let user select target connection
    const targetItems = otherConnections.map(c => ({
      label: c.config.name || c.config.host,
      description: `${c.config.protocol.toUpperCase()} · ${c.config.username}@${c.config.host}`,
      config: c.config,
      connection: c.connection
    }));

    const selected = await vscode.window.showQuickPick(targetItems, {
      placeHolder: 'Select target remote server'
    });

    if (!selected) return;

    // Ask for target path
    const targetPath = await vscode.window.showInputBox({
      prompt: 'Enter target path',
      value: path.join(selected.config.remotePath, path.basename(item.entry.path)),
      placeHolder: '/remote/path/filename'
    });

    if (!targetPath) return;

    try {
      const sourceConnection = connectionManager.getConnection(sourceConfig);
      if (!sourceConnection) {
        vscode.window.showErrorMessage('Source connection not available');
        return;
      }

      // Create temp file
      const os = require('os');
      const tempDir = path.join(os.tmpdir(), 'stackerftp-transfer');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempPath = path.join(tempDir, path.basename(item.entry.path));

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Transferring ${item.entry.name}...`,
        cancellable: false
      }, async (progress) => {
        // Step 1: Download from source
        progress.report({ message: 'Downloading from source...', increment: 0 });
        await sourceConnection.download(item.entry.path, tempPath);

        // Step 2: Upload to target
        progress.report({ message: 'Uploading to target...', increment: 50 });
        await selected.connection.upload(tempPath, targetPath);

        // Step 3: Cleanup
        progress.report({ message: 'Cleaning up...', increment: 90 });
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      });

      vscode.window.showInformationMessage(
        `Transferred ${item.entry.name} to ${selected.config.name || selected.config.host}`
      );

      // Refresh remote explorer
      vscode.commands.executeCommand('stackerftp.tree.refresh');

    } catch (error: any) {
      vscode.window.showErrorMessage(`Transfer failed: ${error.message}`);
    }
  });

  const compareRemotesCommand = vscode.commands.registerCommand('stackerftp.compareRemotes', async (item: any) => {
    if (!item || !item.entry || item.entry.type !== 'file') {
      vscode.window.showErrorMessage('Select a file to compare');
      return;
    }

    const sourceConfig = item.config;
    const activeConnections = connectionManager.getAllActiveConnections();

    const otherConnections = activeConnections.filter(c =>
      c.config.host !== sourceConfig.host || c.config.username !== sourceConfig.username
    );

    if (otherConnections.length === 0) {
      vscode.window.showWarningMessage('No other remote connections available. Connect to another server first.');
      return;
    }

    // Let user select target connection
    const targetItems = otherConnections.map(c => ({
      label: c.config.name || c.config.host,
      description: `${c.config.protocol.toUpperCase()} · ${c.config.username}@${c.config.host}`,
      config: c.config,
      connection: c.connection
    }));

    const selected = await vscode.window.showQuickPick(targetItems, {
      placeHolder: 'Select remote server to compare with'
    });

    if (!selected) return;

    // Ask for target file path
    const targetPath = await vscode.window.showInputBox({
      prompt: 'Enter file path on target server',
      value: item.entry.path,
      placeHolder: '/remote/path/filename'
    });

    if (!targetPath) return;

    try {
      const sourceConnection = connectionManager.getConnection(sourceConfig);
      if (!sourceConnection) {
        vscode.window.showErrorMessage('Source connection not available');
        return;
      }

      const os = require('os');
      const tempDir = path.join(os.tmpdir(), 'stackerftp-compare');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const sourceFileName = `${sourceConfig.host}_${path.basename(item.entry.path)}`;
      const targetFileName = `${selected.config.host}_${path.basename(targetPath)}`;

      const sourceTempPath = path.join(tempDir, sourceFileName);
      const targetTempPath = path.join(tempDir, targetFileName);

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Downloading files for comparison...',
        cancellable: false
      }, async (progress) => {
        progress.report({ message: `Downloading from ${sourceConfig.host}...`, increment: 0 });
        await sourceConnection.download(item.entry.path, sourceTempPath);

        progress.report({ message: `Downloading from ${selected.config.host}...`, increment: 50 });
        await selected.connection.download(targetPath, targetTempPath);
      });

      // Open diff view
      const sourceUri = vscode.Uri.file(sourceTempPath);
      const targetUri = vscode.Uri.file(targetTempPath);

      await vscode.commands.executeCommand('vscode.diff',
        sourceUri,
        targetUri,
        `${sourceConfig.host} ↔ ${selected.config.host}: ${path.basename(item.entry.path)}`
      );

    } catch (error: any) {
      vscode.window.showErrorMessage(`Compare failed: ${error.message}`);
    }
  });

  const syncBetweenRemotesCommand = vscode.commands.registerCommand('stackerftp.syncBetweenRemotes', async (item: any) => {
    if (!item || !item.entry || item.entry.type !== 'directory') {
      vscode.window.showErrorMessage('Select a folder to sync');
      return;
    }

    const sourceConfig = item.config;
    const activeConnections = connectionManager.getAllActiveConnections();

    const otherConnections = activeConnections.filter(c =>
      c.config.host !== sourceConfig.host || c.config.username !== sourceConfig.username
    );

    if (otherConnections.length === 0) {
      vscode.window.showWarningMessage('No other remote connections available. Connect to another server first.');
      return;
    }

    const targetItems = otherConnections.map(c => ({
      label: c.config.name || c.config.host,
      description: `${c.config.protocol.toUpperCase()} · ${c.config.username}@${c.config.host}`,
      config: c.config,
      connection: c.connection
    }));

    const selected = await vscode.window.showQuickPick(targetItems, {
      placeHolder: 'Select target remote server for sync'
    });

    if (!selected) return;

    const targetPath = await vscode.window.showInputBox({
      prompt: 'Enter target folder path',
      value: item.entry.path,
      placeHolder: '/remote/path/folder'
    });

    if (!targetPath) return;

    const confirm = await vscode.window.showWarningMessage(
      `Sync folder "${item.entry.name}" from ${sourceConfig.host} to ${selected.config.host}?`,
      { modal: true },
      'Sync'
    );

    if (confirm !== 'Sync') return;

    try {
      const sourceConnection = connectionManager.getConnection(sourceConfig);
      if (!sourceConnection) {
        vscode.window.showErrorMessage('Source connection not available');
        return;
      }

      // Get file list from source
      const sourceFiles = await sourceConnection.list(item.entry.path);
      const files = sourceFiles.filter(f => f.type === 'file');

      const os = require('os');
      const tempDir = path.join(os.tmpdir(), 'stackerftp-sync', Date.now().toString());
      fs.mkdirSync(tempDir, { recursive: true });

      let transferred = 0;
      const total = files.length;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Syncing ${total} files...`,
        cancellable: true
      }, async (progress, token) => {
        for (const file of files) {
          if (token.isCancellationRequested) break;

          const fileName = file.name;
          const sourcePath = file.path;
          const tempPath = path.join(tempDir, fileName);
          const destPath = normalizeRemotePath(path.join(targetPath, fileName));

          progress.report({
            message: `${fileName} (${transferred + 1}/${total})`,
            increment: (1 / total) * 100
          });

          try {
            await sourceConnection.download(sourcePath, tempPath);
            await selected.connection.upload(tempPath, destPath);
            transferred++;
          } catch (err) {
            logger.error(`Failed to sync ${fileName}`, err);
          }
        }

        // Cleanup temp dir
        fs.rmSync(tempDir, { recursive: true, force: true });
      });

      vscode.window.showInformationMessage(
        `Synced ${transferred}/${total} files to ${selected.config.host}`
      );

      vscode.commands.executeCommand('stackerftp.tree.refresh');

    } catch (error: any) {
      vscode.window.showErrorMessage(`Sync failed: ${error.message}`);
    }
  });

  // ==================== Reveal in Remote Explorer ====================

  const revealInRemoteExplorerCommand = vscode.commands.registerCommand('stackerftp.revealInRemoteExplorer', async (uri?: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    // Get file path from URI or active editor
    let localPath: string | undefined;
    if (uri) {
      localPath = uri.fsPath;
    } else if (vscode.window.activeTextEditor) {
      localPath = vscode.window.activeTextEditor.document.fileName;
    }

    if (!localPath) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }

    if (!localPath.startsWith(workspaceRoot)) {
      vscode.window.showErrorMessage('File is not in workspace');
      return;
    }

    try {
      const relativePath = path.relative(workspaceRoot, localPath);
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      // Focus on Remote Explorer and show the path
      await vscode.commands.executeCommand('stackerftp.remoteExplorer.focus');

      vscode.window.showInformationMessage(`Remote path: ${remotePath}`);

      // If using tree view, try to reveal the item
      if (remoteExplorer && typeof remoteExplorer.navigateToPath === 'function') {
        await remoteExplorer.navigateToPath(remotePath);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Reveal failed: ${error.message}`);
    }
  });

  const switchProtocolCommand = vscode.commands.registerCommand('stackerftp.switchProtocol', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    await ConnectionWizard.switchProtocol(workspaceRoot);
  });

  const quickConnectCommand = vscode.commands.registerCommand('stackerftp.quickConnect', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);

    if (configs.length === 0) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(add) Create New Connection', description: 'Set up a new server connection', value: 'new' },
          { label: '$(file-code) Open Config', description: 'Edit configuration file', value: 'config' }
        ],
        { placeHolder: 'No connections found. What would you like to do?' }
      );

      if (choice?.value === 'new') {
        await ConnectionWizard.createNewConnection(workspaceRoot);
      } else if (choice?.value === 'config') {
        await vscode.commands.executeCommand('stackerftp.config');
      }
      return;
    }

    // Show connection selector
    const items = configs.map(config => {
      const isConnected = connectionManager.isConnected(config);
      return {
        label: `${isConnected ? '$(debug-start)' : '$(debug-disconnect)'} ${config.name || config.host}`,
        description: `${config.protocol.toUpperCase()} | ${config.username}@${config.host}:${config.port}`,
        detail: isConnected ? 'Connected' : 'Disconnected',
        config
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Select Connection',
      placeHolder: 'Choose a connection to connect/disconnect'
    });

    if (!selected) return;

    if (connectionManager.isConnected(selected.config)) {
      await connectionManager.disconnect(selected.config);
      vscode.window.showInformationMessage(`Disconnected from ${selected.config.name || selected.config.host}`);
    } else {
      try {
        await connectionManager.connect(selected.config);

      } catch (error: any) {
        vscode.window.showErrorMessage(`Connection failed: ${error.message}`);
      }
    }
  });

  // ==================== Upload/Download Extended Commands ====================

  const uploadToAllProfilesCommand = vscode.commands.registerCommand('stackerftp.uploadToAllProfiles', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (configs.length === 0) {
      vscode.window.showErrorMessage('No SFTP configurations found');
      return;
    }

    const localPath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
    if (!localPath) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }

    const results: { name: string; success: boolean; error?: string }[] = [];

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Uploading to all profiles...',
      cancellable: false
    }, async (progress) => {
      for (let i = 0; i < configs.length; i++) {
        const config = configs[i];
        const profileName = config.name || config.host;
        progress.report({ message: `${profileName} (${i + 1}/${configs.length})`, increment: (100 / configs.length) });

        try {
          const connection = await connectionManager.ensureConnection(config);
          const relativePath = path.relative(workspaceRoot, localPath);
          const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

          // Ensure remote directory exists
          const remoteDir = normalizeRemotePath(path.dirname(remotePath));
          try {
            await connection.mkdir(remoteDir);
          } catch {
            // Directory might already exist
          }

          await transferManager.uploadFile(connection, localPath, remotePath, config);
          results.push({ name: profileName, success: true });
        } catch (error: any) {
          results.push({ name: profileName, success: false, error: error.message });
        }
      }
    });

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success);

    if (failed.length === 0) {
      vscode.window.showInformationMessage(`Uploaded to all ${successful} profiles successfully`);
    } else {
      vscode.window.showWarningMessage(
        `Uploaded to ${successful}/${results.length} profiles. Failed: ${failed.map(f => f.name).join(', ')}`
      );
    }
  });

  const uploadFolderCommand = vscode.commands.registerCommand('stackerftp.uploadFolder', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    const localPath = uri?.fsPath;
    if (!localPath) {
      vscode.window.showErrorMessage('No folder selected');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = path.relative(workspaceRoot, localPath);
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      const result = await transferManager.uploadDirectory(connection, localPath, remotePath, config);
      showSyncResult(result, 'upload');
    } catch (error: any) {
      vscode.window.showErrorMessage(`Upload folder failed: ${error.message}`);
    }
  });

  const downloadFolderCommand = vscode.commands.registerCommand('stackerftp.downloadFolder', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    const localPath = uri?.fsPath;
    if (!localPath) {
      vscode.window.showErrorMessage('No folder selected');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = path.relative(workspaceRoot, localPath);
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      const result = await transferManager.downloadDirectory(connection, remotePath, localPath, config);
      showSyncResult(result, 'download');
    } catch (error: any) {
      vscode.window.showErrorMessage(`Download folder failed: ${error.message}`);
    }
  });

  const editInLocalCommand = vscode.commands.registerCommand('stackerftp.editInLocal', async (item?: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Use item's config if available, otherwise get active config
    const config = item?.config || configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    if (!item || !item.entry) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const remotePath = item.entry.path;
      
      // Calculate relative path correctly
      const configRemotePath = config.remotePath || '/';
      let relativePath = remotePath;
      
      // If remote path starts with config's remotePath, strip it
      if (remotePath.startsWith(configRemotePath)) {
        relativePath = remotePath.substring(configRemotePath.length);
      }
      
      // Remove leading slashes
      relativePath = relativePath.replace(/^\/+/, '');
      
      // Build local path
      const localPath = path.join(workspaceRoot, relativePath);
      const localDir = path.dirname(localPath);

      // Ensure local directory exists
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }

      // Download file to local
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${path.basename(remotePath)}...`,
        cancellable: false
      }, async () => {
        await transferManager.downloadFile(connection, remotePath, localPath);
      });

      // Open in editor
      const doc = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(doc);

      vscode.window.showInformationMessage(`Editing: ${path.basename(localPath)} (synced from remote)`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to edit file: ${error.message}`);
    }
  });

  const revealInExplorerCommand = vscode.commands.registerCommand('stackerftp.revealInExplorer', async (item?: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    if (!item || !item.entry) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }

    try {
      const remotePath = item.entry.path;
      const relativePath = path.relative(config.remotePath, remotePath);
      const localPath = path.join(workspaceRoot, relativePath);

      if (fs.existsSync(localPath)) {
        // Reveal in VS Code explorer
        const localUri = vscode.Uri.file(localPath);
        await vscode.commands.executeCommand('revealInExplorer', localUri);
      } else {
        // Download first then reveal
        const connection = await connectionManager.ensureConnection(config);
        const localDir = path.dirname(localPath);

        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }

        await transferManager.downloadFile(connection, remotePath, localPath);

        const localUri = vscode.Uri.file(localPath);
        await vscode.commands.executeCommand('revealInExplorer', localUri);

        vscode.window.showInformationMessage(`Downloaded and revealed: ${path.basename(localPath)}`);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to reveal file: ${error.message}`);
    }
  });

  const forceUploadCommand = vscode.commands.registerCommand('stackerftp.forceUpload', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    const localPath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
    if (!localPath) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Force upload will overwrite the remote file. Continue?`,
      { modal: true },
      'Yes', 'No'
    );
    if (choice !== 'Yes') return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = path.relative(workspaceRoot, localPath);
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      // Ensure remote directory exists
      const remoteDir = normalizeRemotePath(path.dirname(remotePath));
      try {
        await connection.mkdir(remoteDir);
      } catch {
        // Directory might already exist
      }

      await transferManager.uploadFile(connection, localPath, remotePath, config);
      vscode.window.showInformationMessage(`Force uploaded: ${path.basename(localPath)}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Force upload failed: ${error.message}`);
    }
  });

  const forceDownloadCommand = vscode.commands.registerCommand('stackerftp.forceDownload', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    const localPath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
    if (!localPath) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Force download will overwrite the local file. Continue?`,
      { modal: true },
      'Yes', 'No'
    );
    if (choice !== 'Yes') return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = path.relative(workspaceRoot, localPath);
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      await transferManager.downloadFile(connection, remotePath, localPath);
      vscode.window.showInformationMessage(`Force downloaded: ${path.basename(localPath)}`);

      // Refresh the editor if file is open
      const openDoc = vscode.workspace.textDocuments.find(d => d.fileName === localPath);
      if (openDoc) {
        vscode.commands.executeCommand('workbench.action.files.revert');
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Force download failed: ${error.message}`);
    }
  });

  const listRemoteRevisionsCommand = vscode.commands.registerCommand('stackerftp.listRemoteRevisions', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      vscode.window.showErrorMessage('No SFTP configuration found');
      return;
    }

    const localPath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
    if (!localPath) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = path.relative(workspaceRoot, localPath);
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));
      const remoteDir = path.dirname(remotePath);
      const baseName = path.basename(remotePath, path.extname(remotePath));
      const ext = path.extname(remotePath);

      // List directory and find backup files
      const entries = await connection.list(remoteDir);
      const revisions = entries.filter(e =>
        e.name.startsWith(baseName) &&
        (e.name.includes('.bak') || e.name.includes('.backup') || e.name.match(/\.\d{4}-\d{2}-\d{2}/))
      );

      if (revisions.length === 0) {
        vscode.window.showInformationMessage('No remote revisions found for this file');
        return;
      }

      const items = revisions.map(r => ({
        label: r.name,
        description: `${r.size} bytes`,
        detail: `Modified: ${r.modifyTime.toLocaleString()}`,
        entry: r
      }));

      const selected = await vscode.window.showQuickPick(items, {
        title: 'Remote Revisions',
        placeHolder: 'Select a revision to download'
      });

      if (selected) {
        const revisionPath = normalizeRemotePath(path.join(remoteDir, selected.entry.name));
        const localRevisionPath = path.join(path.dirname(localPath), selected.entry.name);

        await transferManager.downloadFile(connection, revisionPath, localRevisionPath);
        vscode.window.showInformationMessage(`Downloaded revision: ${selected.entry.name}`);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to list revisions: ${error.message}`);
    }
  });

  // ==================== Helper Functions ====================

  function getWorkspaceRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open');
      return undefined;
    }
    return workspaceFolders[0].uri.fsPath;
  }

  // Register all commands
  context.subscriptions.push(
    configCommand,
    connectCommand,
    disconnectCommand,
    setProfileCommand,
    uploadCommand,
    uploadCurrentFileCommand,
    downloadCommand,
    downloadProjectCommand,
    syncToRemoteCommand,
    syncToLocalCommand,
    syncBothWaysCommand,
    openRemoteFileCommand,
    deleteRemoteCommand,
    newFolderCommand,
    newFileCommand,
    renameCommand,
    duplicateCommand,
    refreshCommand,
    diffCommand,
    terminalCommand,
    viewLogsCommand,
    clearLogsCommand,
    cancelTransferCommand,
    transferQueueCommand,
    chmodCommand,
    checksumCommand,
    fileInfoCommand,
    searchCommand,
    backupCommand,
    compareFoldersCommand,
    replaceCommand,
    purgeCacheCommand,
    newConnectionCommand,
    switchProtocolCommand,
    quickConnectCommand,
    uploadToAllProfilesCommand,
    uploadFolderCommand,
    downloadFolderCommand,
    editInLocalCommand,
    revealInExplorerCommand,
    forceUploadCommand,
    forceDownloadCommand,
    listRemoteRevisionsCommand,
    uploadChangedFilesCommand,
    uploadProjectCommand,
    listCommand,
    listAllCommand,
    refreshActiveFileCommand,
    collapseAllCommand,
    revealInRemoteExplorerCommand,
    copyToOtherRemoteCommand,
    compareRemotesCommand,
    syncBetweenRemotesCommand
  );
}
