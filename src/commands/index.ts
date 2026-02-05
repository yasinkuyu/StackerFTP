/**
 * StackerFTP - Commands
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { transferManager } from '../core/transfer-manager';
import { webMasterTools } from '../webmaster/tools';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';
import { normalizeRemotePath, formatFileSize, sanitizeRelativePath } from '../utils/helpers';
import { ConnectionWizard } from '../core/connection-wizard';
import { createGitIntegration } from '../core/git-integration';

import { ConnectionFormProvider } from '../providers/connection-form-provider';

export function registerCommands(
  context: vscode.ExtensionContext,
  remoteExplorer?: any,
  connectionFormProvider?: ConnectionFormProvider,
  treeView?: vscode.TreeView<any>
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
          statusBar.success('Profile management coming soon!');
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
        statusBar.success(`Connected to ${configs[0].name || configs[0].host}`);
        if (remoteExplorer?.refresh) {
          remoteExplorer.refresh();
        }
      } catch (error: any) {
        statusBar.error(`Connection failed: ${error.message}`, true);
      }
      return;
    }

    const items = configs.map((config, index) => {
      const isConnected = connectionManager.isConnected(config);
      return {
        label: `${isConnected ? '$(play)' : '$(primitive-square)'} ${config.name || config.host}`,
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
      statusBar.success(`Connected to ${selected.config.name || selected.config.host}`);
      if (remoteExplorer?.refresh) {
        remoteExplorer.refresh();
      }
    } catch (error: any) {
      statusBar.error(`Connection failed: ${error.message}`, true);
    }
  });

  const disconnectCommand = vscode.commands.registerCommand('stackerftp.disconnect', async () => {
    const activeConnections = connectionManager.getActiveConnections();

    if (activeConnections.length === 0) {
      statusBar.info('No active connections');
      return;
    }

    try {
      await connectionManager.disconnect();
      statusBar.success('Disconnected from all servers');
      if (remoteExplorer?.refresh) {
        remoteExplorer.refresh();
      }
    } catch (error: any) {
      statusBar.error(`Disconnect failed: ${error.message}`, true);
    }
  });

  const setProfileCommand = vscode.commands.registerCommand('stackerftp.setProfile', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const profiles = configManager.getAvailableProfiles(workspaceRoot);
    if (profiles.length === 0) {
      statusBar.info('No profiles configured');
      return;
    }

    const selected = await vscode.window.showQuickPick(profiles, {
      placeHolder: 'Select a profile'
    });

    if (selected) {
      configManager.setProfile(workspaceRoot, selected);
      statusBar.success(`Switched to profile: ${selected}`);
    }
  });

  // ==================== Transfer Commands ====================

  const uploadCommand = vscode.commands.registerCommand('stackerftp.upload', async (uriOrResource: vscode.Uri | { resourceUri: vscode.Uri }) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Handle both Uri (from explorer) and SourceControlResourceState (from SCM)
    let localPath: string | undefined;
    if (uriOrResource) {
      if ('resourceUri' in uriOrResource) {
        // SCM resource state
        localPath = uriOrResource.resourceUri.fsPath;
      } else if ('fsPath' in uriOrResource) {
        // Direct Uri
        localPath = uriOrResource.fsPath;
      }
    }

    if (!localPath) {
      statusBar.error('No file selected');
      return;
    }

    // Check for active connections first
    const activeConns = connectionManager.getAllActiveConnections();

    let config: any;
    let connection: any;

    if (activeConns.length === 0) {
      // No active connections - use config and connect
      config = configManager.getActiveConfig(workspaceRoot);
      if (!config) {
        statusBar.error('No SFTP configuration found', true);
        return;
      }
      connection = await connectionManager.ensureConnection(config);
    } else if (activeConns.length === 1) {
      // Single connection - use it
      config = activeConns[0].config;
      connection = activeConns[0].connection;
    } else {
      // Multiple connections - ask user or use primary
      const selected = await connectionManager.selectConnectionForTransfer('upload');
      if (!selected) return;
      config = selected.config;
      connection = selected.connection;
    }

    try {
      const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
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

      statusBar.success(`Uploaded: ${path.basename(localPath)}`);

    } catch (error: any) {
      statusBar.error(`Upload failed: ${error.message}`, true);
    }
  });

  const uploadCurrentFileCommand = vscode.commands.registerCommand('stackerftp.uploadCurrentFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      statusBar.error('No active editor');
      return;
    }

    const localPath = editor.document.fileName;
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Check for active connections first
    const activeConns = connectionManager.getAllActiveConnections();

    let config: any;
    let connection: any;

    if (activeConns.length === 0) {
      config = configManager.getActiveConfig(workspaceRoot);
      if (!config) {
        statusBar.error('No SFTP configuration found', true);
        return;
      }
      connection = await connectionManager.ensureConnection(config);
    } else if (activeConns.length === 1) {
      config = activeConns[0].config;
      connection = activeConns[0].connection;
    } else {
      const selected = await connectionManager.selectConnectionForTransfer('upload');
      if (!selected) return;
      config = selected.config;
      connection = selected.connection;
    }

    try {
      const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      // Save file first if modified
      if (editor.document.isDirty) {
        await editor.document.save();
      }

      // Ensure remote directory exists
      const remoteDir = normalizeRemotePath(path.dirname(remotePath));
      try {
        await connection.mkdir(remoteDir);
      } catch (error: any) {
        // Directory might already exist
        if (error.code !== 'EEXIST' && !error.message?.includes('exists')) {
          logger.warn(`Failed to create directory: ${remoteDir}`, error);
        }
      }

      await transferManager.uploadFile(connection, localPath, remotePath, config);
      statusBar.success(`Uploaded: ${path.basename(localPath)}`);
    } catch (error: any) {
      statusBar.error(`Upload failed: ${error.message}`, true);
    }
  });

  const downloadCommand = vscode.commands.registerCommand('stackerftp.download', async (itemOrResource?: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);

      let remotePath: string;
      let localPath: string;

      // Check if it's a SCM resource state (has resourceUri property)
      if (itemOrResource && 'resourceUri' in itemOrResource) {
        // SCM resource - download from remote to this local file
        localPath = itemOrResource.resourceUri.fsPath;
        const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
        remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));
      } else if (itemOrResource?.entry) {
        // Remote explorer item
        remotePath = itemOrResource.entry.path;
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

      // Determine if it's a directory based on source
      const isDirectory = itemOrResource?.entry?.type === 'directory' || !itemOrResource ||
        (itemOrResource && !('resourceUri' in itemOrResource) && !itemOrResource.entry);

      if (isDirectory) {
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

      statusBar.success(`Downloaded: ${path.basename(remotePath)}`);
    } catch (error: any) {
      statusBar.error(`Download failed: ${error.message}`, true);
    }
  });

  const downloadProjectCommand = vscode.commands.registerCommand('stackerftp.downloadProject', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
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
      statusBar.success('Project downloaded successfully');
    } catch (error: any) {
      statusBar.error(`Download failed: ${error.message}`, true);
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
      statusBar.error('No SFTP configuration found', true);
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
        const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
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
      statusBar.error(`Sync failed: ${error.message}`, true);
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
      statusBar.success(messages.join(', '));
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
      statusBar.error(`Failed to open file: ${error.message}`);
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

      statusBar.success(`Deleted: ${item.entry.name}`);

    } catch (error: any) {
      statusBar.error(`Delete failed: ${error.message}`, true);
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
        statusBar.error('No active connection. Connect first.');
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
      statusBar.error('No active connection');
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

      statusBar.success(`Created folder: ${folderName}`);
      if (remoteExplorer) remoteExplorer.refresh();

    } catch (error: any) {
      statusBar.error(`Failed to create folder: ${error.message}`, true);
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
        statusBar.error('No active connection. Connect first.');
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
      statusBar.error('No active connection');
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

      statusBar.success(`Created file: ${fileName}`);
      if (remoteExplorer) remoteExplorer.refresh();

    } catch (error: any) {
      statusBar.error(`Failed to create file: ${error.message}`, true);
    }
  });

  const expandAllCommand = vscode.commands.registerCommand('stackerftp.expandAll', async () => {
    if (!treeView || !remoteExplorer) {
      statusBar.warn('No tree view available');
      return;
    }

    try {
      const rootItems = await remoteExplorer.getChildren();
      if (!rootItems || rootItems.length === 0) {
        statusBar.info('No items to expand');
        return;
      }

      // Expand each root item and its children recursively
      for (const item of rootItems) {
        await expandItemRecursively(treeView, remoteExplorer, item, 3); // Max depth 3
      }
      statusBar.success('Expanded all items');
    } catch (error: any) {
      logger.error('Failed to expand all', error);
    }
  });

  // Helper function to expand items recursively
  async function expandItemRecursively(
    tv: vscode.TreeView<any>,
    provider: any,
    item: any,
    maxDepth: number,
    currentDepth: number = 0
  ): Promise<void> {
    if (currentDepth >= maxDepth) return;

    try {
      // Reveal and expand the item
      await tv.reveal(item, { expand: true, select: false, focus: false });

      // Get children and expand them
      const children = await provider.getChildren(item);
      if (children && children.length > 0) {
        for (const child of children) {
          // Only expand directories
          if (child.entry?.type === 'directory' || child.contextValue === 'connection') {
            await expandItemRecursively(tv, provider, child, maxDepth, currentDepth + 1);
          }
        }
      }
    } catch (e) {
      // Ignore errors for individual items
    }
  }

  // Collapse all command
  const collapseAllCommand = vscode.commands.registerCommand('stackerftp.collapseAll', async () => {
    if (!treeView || !remoteExplorer) {
      statusBar.warn('No tree view available');
      return;
    }

    try {
      const rootItems = await remoteExplorer.getChildren();
      if (!rootItems || rootItems.length === 0) return;

      // Collapse each root item
      for (const item of rootItems) {
        try {
          await treeView.reveal(item, { expand: false, select: false, focus: false });
        } catch (e) {
          // Ignore
        }
      }
      statusBar.success('Collapsed all items');
    } catch (error: any) {
      logger.error('Failed to collapse all', error);
    }
  });

  // Expand single connection
  const expandConnectionCommand = vscode.commands.registerCommand('stackerftp.expandConnection', async (item: any) => {
    if (!treeView || !remoteExplorer || !item) return;

    try {
      await expandItemRecursively(treeView, remoteExplorer, item, 3);
      const name = item.label || item.entry?.name || 'Connection';
      statusBar.success(`Expanded: ${name}`);
    } catch (error: any) {
      logger.error('Failed to expand connection', error);
    }
  });

  // Collapse single connection
  const collapseConnectionCommand = vscode.commands.registerCommand('stackerftp.collapseConnection', async (item: any) => {
    if (!treeView || !item) return;

    try {
      await treeView.reveal(item, { expand: false, select: false, focus: false });
      const name = item.label || item.entry?.name || 'Connection';
      statusBar.success(`Collapsed: ${name}`);
    } catch (error: any) {
      logger.error('Failed to collapse connection', error);
    }
  });

  const renameCommand = vscode.commands.registerCommand('stackerftp.rename', async (item: any) => {
    if (!item?.entry) {
      statusBar.error('No item selected');
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
      statusBar.error('No active connection');
      return;
    }

    try {
      const newPath = normalizeRemotePath(path.join(path.dirname(item.entry.path), newName));

      await connection.rename(item.entry.path, newPath);
      statusBar.success(`Renamed to: ${newName}`);
      if (remoteExplorer) remoteExplorer.refresh();

    } catch (error: any) {
      statusBar.error(`Rename failed: ${error.message}`, true);
    }
  });

  const duplicateCommand = vscode.commands.registerCommand('stackerftp.duplicate', async (item: any) => {
    if (!item?.entry) {
      statusBar.error('No item selected');
      return;
    }

    // Get config and connection from item
    const config = item.config;
    const connection = item.connectionRef || connectionManager.getConnection(config);

    if (!connection || !config) {
      statusBar.error('No active connection');
      return;
    }

    try {
      const content = await connection.readFile(item.entry.path);

      const ext = path.extname(item.entry.name);
      const base = path.basename(item.entry.name, ext);
      const newName = `${base}_copy${ext}`;
      const newPath = normalizeRemotePath(path.join(path.dirname(item.entry.path), newName));

      await connection.writeFile(newPath, content);
      statusBar.success(`Duplicated: ${newName}`);
      if (remoteExplorer) remoteExplorer.refresh();

    } catch (error: any) {
      statusBar.error(`Duplicate failed: ${error.message}`, true);
    }
  });

  const refreshCommand = vscode.commands.registerCommand('stackerftp.refresh', () => {
    // Refresh both connection form and remote explorer
    if (connectionFormProvider?.refresh) {
      connectionFormProvider.refresh();
      logger.info('Connection form refreshed');
    }
    if (remoteExplorer?.refresh) {
      remoteExplorer.refresh();
      logger.info('Remote explorer refreshed');
    }
  });

  // ==================== Utility Commands ====================

  const diffCommand = vscode.commands.registerCommand('stackerftp.diff', async (uri?: vscode.Uri, item?: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    try {
      let localPath: string;
      let remotePath: string;
      let fileName: string;
      let activeConfig: any;

      if (item && item.entry) {
        // Called from remote explorer - use item's config
        activeConfig = item.config;
        if (!activeConfig) {
          statusBar.error('No configuration found for this connection');
          return;
        }
        remotePath = item.entry.path;
        if (!remotePath) {
          statusBar.error('Remote path is undefined');
          return;
        }
        fileName = item.entry.name || path.basename(remotePath);

        // Calculate relative path from remote root
        const remoteRoot = activeConfig.remotePath || '/';
        let relativePath = remotePath;
        if (remotePath.startsWith(remoteRoot)) {
          relativePath = remotePath.substring(remoteRoot.length);
        }
        // Remove leading slash
        if (relativePath.startsWith('/')) {
          relativePath = relativePath.substring(1);
        }
        localPath = path.join(workspaceRoot, relativePath);
      } else if (uri) {
        // Called from local file
        activeConfig = configManager.getActiveConfig(workspaceRoot);
        if (!activeConfig) {
          statusBar.error('No SFTP configuration found', true);
          return;
        }
        localPath = uri.fsPath;
        const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
        remotePath = normalizeRemotePath(path.posix.join(activeConfig.remotePath, relativePath.replace(/\\/g, '/')));
        fileName = path.basename(localPath);
      } else {
        statusBar.error('No file selected');
        return;
      }

      // Check if local file exists
      if (!fs.existsSync(localPath)) {
        statusBar.error(`Local file not found: ${fileName}. Download the file first to compare.`);
        return;
      }

      // Download remote file to temp
      const connection = await connectionManager.ensureConnection(activeConfig);
      const tempDir = path.join(require('os').tmpdir(), 'stackerftp-diff');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempRemotePath = path.join(tempDir, `${Date.now()}-${fileName}.remote`);

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
      statusBar.error(`Diff failed: ${error.message}`);
    }
  });

  const terminalCommand = vscode.commands.registerCommand('stackerftp.terminal', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    if (config.protocol !== 'sftp') {
      statusBar.error('Remote terminal is only available with SFTP protocol');
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
    statusBar.success('Logs cleared');
  });

  const cancelTransferCommand = vscode.commands.registerCommand('stackerftp.cancelTransfer', () => {
    transferManager.cancel();
    statusBar.success('Transfer cancelled');
  });

  const transferQueueCommand = vscode.commands.registerCommand('stackerftp.transferQueue', () => {
    const queue = transferManager.getQueue();
    if (queue.length === 0) {
      statusBar.success('Transfer queue is empty');
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
      statusBar.error(`chmod failed: ${error.message}`);
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
      statusBar.error(`Checksum failed: ${error.message}`);
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
      statusBar.error(`Failed to get file info: ${error.message}`);
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
      statusBar.error(`Search failed: ${error.message}`);
    }
  });

  const backupCommand = vscode.commands.registerCommand('stackerftp.webmaster.backup', async (item: any) => {
    if (!item?.entry) {
      statusBar.error('No file or folder selected');
      return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Use item's config if available, otherwise get active config
    const config = item.config || configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No configuration found');
      return;
    }

    // Check if protocol supports exec (SFTP only)
    if (config.protocol !== 'sftp') {
      statusBar.warn('Backup requires SFTP protocol');
      return;
    }

    const backupName = await vscode.window.showInputBox({
      prompt: 'Enter backup name (optional)',
      placeHolder: `backup-${new Date().toISOString().split('T')[0]}`
    });

    if (backupName === undefined) return; // User cancelled

    try {
      const connection = item.connectionRef || await connectionManager.ensureConnection(config);
      const backupPath = await webMasterTools.createBackup(connection, item.entry.path, backupName || undefined);
      statusBar.success(`Backup created: ${backupPath}`);
    } catch (error: any) {
      statusBar.error(`Backup failed: ${error.message}`);
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
      statusBar.error(`Folder comparison failed: ${error.message}`);
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
      statusBar.error(`Find and replace failed: ${error.message}`);
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
      statusBar.error(`Purge cache failed: ${error.message}`);
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
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    const gitIntegration = createGitIntegration(workspaceRoot);

    if (!gitIntegration.isGitRepository()) {
      statusBar.error('Not a Git repository');
      return;
    }

    try {
      const changedFiles = await gitIntegration.getChangedFiles();
      const uploadableFiles = gitIntegration.filterUploadable(changedFiles);

      if (uploadableFiles.length === 0) {
        statusBar.success('No changed files to upload');
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

          const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, file.absolutePath));
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

        statusBar.success(`Uploaded ${uploaded}/${total} changed files`);
      });

    } catch (error: any) {
      statusBar.error(`Upload failed: ${error.message}`);
    }
  });

  const uploadProjectCommand = vscode.commands.registerCommand('stackerftp.uploadProject', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
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

      statusBar.success(`Project uploaded: ${result.uploaded.length} files (${result.failed.length} failed)`);
    } catch (error: any) {
      statusBar.error(`Upload project failed: ${error.message}`);
    }
  });

  // ==================== List Commands ====================

  const listCommand = vscode.commands.registerCommand('stackerftp.list', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
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
      statusBar.error(`List failed: ${error.message}`);
    }
  });

  const listAllCommand = vscode.commands.registerCommand('stackerftp.listAll', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
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
      statusBar.error(`List all failed: ${error.message}`);
    }
  });

  // ==================== Refresh Active File ====================

  const refreshActiveFileCommand = vscode.commands.registerCommand('stackerftp.refreshActiveFile', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      statusBar.error('No active file');
      return;
    }

    const localPath = activeEditor.document.fileName;
    if (!localPath.startsWith(workspaceRoot)) {
      statusBar.error('File is not in workspace');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      await transferManager.downloadFile(connection, remotePath, localPath);

      // Reload the document
      const doc = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(doc);

      statusBar.success(`Refreshed: ${path.basename(localPath)}`);
    } catch (error: any) {
      statusBar.error(`Refresh failed: ${error.message}`);
    }
  });

  // ==================== Remote-to-Remote Transfer ====================

  const copyToOtherRemoteCommand = vscode.commands.registerCommand('stackerftp.copyToOtherRemote', async (item: any) => {
    if (!item || !item.entry) {
      statusBar.error('No file selected');
      return;
    }

    const sourceConfig = item.config;
    const activeConnections = connectionManager.getAllActiveConnections();

    // Filter out the source connection
    const otherConnections = activeConnections.filter(c =>
      c.config.host !== sourceConfig.host || c.config.username !== sourceConfig.username
    );

    if (otherConnections.length === 0) {
      statusBar.warn('No other remote connections available. Connect to another server first.');
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
        statusBar.error('Source connection not available');
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

      statusBar.success(`Transferred ${item.entry.name} to ${selected.config.name || selected.config.host}`);

      // Refresh remote explorer
      vscode.commands.executeCommand('stackerftp.tree.refresh');

    } catch (error: any) {
      statusBar.error(`Transfer failed: ${error.message}`);
    }
  });

  const compareRemotesCommand = vscode.commands.registerCommand('stackerftp.compareRemotes', async (item: any) => {
    if (!item || !item.entry || item.entry.type !== 'file') {
      statusBar.error('Select a file to compare');
      return;
    }

    const sourceConfig = item.config;
    const activeConnections = connectionManager.getAllActiveConnections();

    const otherConnections = activeConnections.filter(c =>
      c.config.host !== sourceConfig.host || c.config.username !== sourceConfig.username
    );

    if (otherConnections.length === 0) {
      statusBar.warn('No other remote connections available. Connect to another server first.');
      return;
    }
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
        statusBar.error('Source connection not available');
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
      statusBar.error(`Compare failed: ${error.message}`);
    }
  });

  const syncBetweenRemotesCommand = vscode.commands.registerCommand('stackerftp.syncBetweenRemotes', async (item: any) => {
    if (!item || !item.entry || item.entry.type !== 'directory') {
      statusBar.error('Select a folder to sync');
      return;
    }

    const sourceConfig = item.config;
    const activeConnections = connectionManager.getAllActiveConnections();

    const otherConnections = activeConnections.filter(c =>
      c.config.host !== sourceConfig.host || c.config.username !== sourceConfig.username
    );

    if (otherConnections.length === 0) {
      statusBar.warn('No other remote connections available. Connect to another server first.');
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
        statusBar.error('Source connection not available');
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

      statusBar.success(`Synced ${transferred}/${total} files to ${selected.config.host}`);

      vscode.commands.executeCommand('stackerftp.tree.refresh');

    } catch (error: any) {
      statusBar.error(`Sync failed: ${error.message}`);
    }
  });

  // ==================== Reveal in Remote Explorer ====================

  const revealInRemoteExplorerCommand = vscode.commands.registerCommand('stackerftp.revealInRemoteExplorer', async (uri?: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
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
      statusBar.error('No file selected');
      return;
    }

    if (!localPath.startsWith(workspaceRoot)) {
      statusBar.error('File is not in workspace');
      return;
    }

    try {
      const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      // Focus on Remote Explorer and show the path
      await vscode.commands.executeCommand('stackerftp.remoteExplorer.focus');

      statusBar.success(`Remote path: ${remotePath}`);

      // If using tree view, try to reveal the item
      if (remoteExplorer && typeof remoteExplorer.navigateToPath === 'function') {
        await remoteExplorer.navigateToPath(remotePath);
      }
    } catch (error: any) {
      statusBar.error(`Reveal failed: ${error.message}`);
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
        label: `${isConnected ? '$(play)' : '$(primitive-square)'} ${config.name || config.host}`,
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
      // Disconnected message shown by connection-manager
    } else {
      try {
        await connectionManager.connect(selected.config);
        // Connected message shown by connection-manager
      } catch (error: any) {
        statusBar.error(`Connection failed: ${error.message}`, true);
      }
    }
  });

  // ==================== Upload/Download Extended Commands ====================

  const uploadToAllProfilesCommand = vscode.commands.registerCommand('stackerftp.uploadToAllProfiles', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (configs.length === 0) {
      statusBar.error('No SFTP configurations found', true);
      return;
    }

    const localPath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
    if (!localPath) {
      statusBar.error('No file selected');
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
          const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
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
      statusBar.success(`Uploaded to all ${successful} profiles successfully`);
    } else {
      statusBar.warn(`Uploaded to ${successful}/${results.length} profiles. Failed: ${failed.map(f => f.name).join(', ')}`);
    }
  });

  const uploadFolderCommand = vscode.commands.registerCommand('stackerftp.uploadFolder', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    const localPath = uri?.fsPath;
    if (!localPath) {
      statusBar.error('No folder selected');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      const result = await transferManager.uploadDirectory(connection, localPath, remotePath, config);
      showSyncResult(result, 'upload');
    } catch (error: any) {
      statusBar.error(`Upload folder failed: ${error.message}`);
    }
  });

  const downloadFolderCommand = vscode.commands.registerCommand('stackerftp.downloadFolder', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    const localPath = uri?.fsPath;
    if (!localPath) {
      statusBar.error('No folder selected');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      const result = await transferManager.downloadDirectory(connection, remotePath, localPath, config);
      showSyncResult(result, 'download');
    } catch (error: any) {
      statusBar.error(`Download folder failed: ${error.message}`);
    }
  });

  const editInLocalCommand = vscode.commands.registerCommand('stackerftp.editInLocal', async (item?: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Use item's config if available, otherwise get active config
    const config = item?.config || configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    if (!item || !item.entry) {
      statusBar.error('No file selected');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const remotePath = item.entry.path;
      const fileName = path.basename(remotePath);

      // Create temp directory for editing
      const tempDir = path.join(os.tmpdir(), 'stackerftp-edit', config.name || config.host);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Use unique temp file name to avoid conflicts
      const uniqueId = Date.now().toString(36);
      const tempFileName = `${path.basename(fileName, path.extname(fileName))}_${uniqueId}${path.extname(fileName)}`;
      const tempPath = path.join(tempDir, tempFileName);

      // Download file to temp
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${fileName}...`,
        cancellable: false
      }, async () => {
        await transferManager.downloadFile(connection, remotePath, tempPath);
      });

      // Open in editor
      const doc = await vscode.workspace.openTextDocument(tempPath);
      const editor = await vscode.window.showTextDocument(doc);

      // Store mapping for upload on save
      const metadata = {
        remotePath,
        configName: config.name,
        config
      };

      // Store in extension context for later use
      (global as any).stackerftpEditMappings = (global as any).stackerftpEditMappings || new Map();
      (global as any).stackerftpEditMappings.set(tempPath, metadata);

      statusBar.success(`Editing: ${fileName} - Save to upload changes`);
    } catch (error: any) {
      statusBar.error(`Failed to edit file: ${error.message}`);
    }
  });

  const revealInExplorerCommand = vscode.commands.registerCommand('stackerftp.revealInExplorer', async (item?: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    if (!item || !item.entry) {
      statusBar.error('No file selected');
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

        statusBar.success(`Downloaded and revealed: ${path.basename(localPath)}`);
      }
    } catch (error: any) {
      statusBar.error(`Failed to reveal file: ${error.message}`);
    }
  });

  const forceUploadCommand = vscode.commands.registerCommand('stackerftp.forceUpload', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    const localPath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
    if (!localPath) {
      statusBar.error('No file selected');
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
      const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      // Ensure remote directory exists
      const remoteDir = normalizeRemotePath(path.dirname(remotePath));
      try {
        await connection.mkdir(remoteDir);
      } catch {
        // Directory might already exist
      }

      await transferManager.uploadFile(connection, localPath, remotePath, config);
      statusBar.success(`Force uploaded: ${path.basename(localPath)}`);
    } catch (error: any) {
      statusBar.error(`Force upload failed: ${error.message}`, true);
    }
  });

  const forceDownloadCommand = vscode.commands.registerCommand('stackerftp.forceDownload', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    const localPath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
    if (!localPath) {
      statusBar.error('No file selected');
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
      const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      await transferManager.downloadFile(connection, remotePath, localPath);
      statusBar.success(`Force downloaded: ${path.basename(localPath)}`);

      // Refresh the editor if file is open
      const openDoc = vscode.workspace.textDocuments.find(d => d.fileName === localPath);
      if (openDoc) {
        vscode.commands.executeCommand('workbench.action.files.revert');
      }
    } catch (error: any) {
      statusBar.error(`Force download failed: ${error.message}`, true);
    }
  });

  const listRemoteRevisionsCommand = vscode.commands.registerCommand('stackerftp.listRemoteRevisions', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    const localPath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
    if (!localPath) {
      statusBar.error('No file selected');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
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
        statusBar.success('No remote revisions found for this file');
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
        statusBar.success(`Downloaded revision: ${selected.entry.name}`);
      }
    } catch (error: any) {
      statusBar.error(`Failed to list revisions: ${error.message}`);
    }
  });

  // ==================== Select Primary Connection Command ====================

  const selectPrimaryConnectionCommand = vscode.commands.registerCommand('stackerftp.selectPrimaryConnection', async () => {
    const activeConns = connectionManager.getAllActiveConnections();

    if (activeConns.length === 0) {
      // No active connections - offer to connect
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) return;

      const configs = configManager.getConfigs(workspaceRoot);
      if (configs.length === 0) {
        statusBar.success('No connections configured. Use "StackerFTP: New Connection" to add one.');
        return;
      }

      const items = configs.map(c => ({
        label: c.name || c.host,
        description: `${c.protocol?.toUpperCase()} • ${c.username}@${c.host}`,
        config: c
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'No active connections. Select one to connect.',
        title: 'Connect to Server'
      });

      if (selected) {
        try {
          await connectionManager.connect(selected.config);
          // Connected message shown by connection-manager
        } catch (error: any) {
          statusBar.error(`Connection failed: ${error.message}`, true);
        }
      }
      return;
    }

    // Active connections exist
    const primaryConfig = connectionManager.getPrimaryConfig();

    const items = activeConns.map(({ config }) => ({
      label: (primaryConfig && config.name === primaryConfig.name && config.host === primaryConfig.host)
        ? `$(star-full) ${config.name || config.host}`
        : `$(star-empty) ${config.name || config.host}`,
      description: `${config.protocol?.toUpperCase()} • ${config.username}@${config.host}`,
      detail: (primaryConfig && config.name === primaryConfig.name && config.host === primaryConfig.host)
        ? 'Current primary connection'
        : 'Click to set as primary',
      config
    }));

    // Add disconnect all option
    items.push({
      label: '$(close-all) Disconnect All',
      description: `Disconnect from all ${activeConns.length} servers`,
      detail: '',
      config: null as any
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select primary connection for uploads/downloads',
      title: `Active Connections (${activeConns.length})`
    });

    if (selected) {
      if (!selected.config) {
        // Disconnect all
        await connectionManager.disconnect();
        statusBar.success('Disconnected from all servers');
      } else {
        connectionManager.setPrimaryConnection(selected.config);
      }
    }
  });

  // ==================== View Settings Commands ====================

  const toggleHiddenFilesCommand = vscode.commands.registerCommand('stackerftp.toggleHiddenFiles', async () => {
    const config = vscode.workspace.getConfiguration('stackerftp');
    const current = config.get<boolean>('showHiddenFiles', false);
    await config.update('showHiddenFiles', !current, vscode.ConfigurationTarget.Workspace);
    statusBar.success(`Hidden files: ${!current ? 'shown' : 'hidden'}`);
    if (remoteExplorer?.refresh) {
      remoteExplorer.refresh();
    }
  });

  const sortByNameCommand = vscode.commands.registerCommand('stackerftp.sortByName', async () => {
    const config = vscode.workspace.getConfiguration('stackerftp');
    await config.update('remoteExplorerSortOrder', 'name', vscode.ConfigurationTarget.Workspace);
    statusBar.success('Sorted by name');
    if (remoteExplorer?.refresh) {
      remoteExplorer.refresh();
    }
  });

  const sortBySizeCommand = vscode.commands.registerCommand('stackerftp.sortBySize', async () => {
    const config = vscode.workspace.getConfiguration('stackerftp');
    await config.update('remoteExplorerSortOrder', 'size', vscode.ConfigurationTarget.Workspace);
    statusBar.success('Sorted by size');
    if (remoteExplorer?.refresh) {
      remoteExplorer.refresh();
    }
  });

  const sortByDateCommand = vscode.commands.registerCommand('stackerftp.sortByDate', async () => {
    const config = vscode.workspace.getConfiguration('stackerftp');
    await config.update('remoteExplorerSortOrder', 'date', vscode.ConfigurationTarget.Workspace);
    statusBar.success('Sorted by date');
    if (remoteExplorer?.refresh) {
      remoteExplorer.refresh();
    }
  });

  const selectAllFilesCommand = vscode.commands.registerCommand('stackerftp.selectAllFiles', async () => {
    statusBar.info('Select All: Use Ctrl+A in the file list');
  });

  // ==================== Helper Functions ====================

  function getWorkspaceRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      statusBar.error('No workspace folder open');
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
    expandAllCommand,
    collapseAllCommand,
    expandConnectionCommand,
    collapseConnectionCommand,
    revealInRemoteExplorerCommand,
    copyToOtherRemoteCommand,
    compareRemotesCommand,
    syncBetweenRemotesCommand,
    selectPrimaryConnectionCommand,
    toggleHiddenFilesCommand,
    sortByNameCommand,
    sortBySizeCommand,
    sortByDateCommand,
    selectAllFilesCommand
  );
}
