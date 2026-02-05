/**
 * StackerFTP - VS Code Extension
 * 
 * A professional FTP/SFTP client with file manager and web master tools
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { RemoteExplorerWebviewProvider } from './providers/remote-explorer-webview';
import { RemoteExplorerTreeProvider } from './providers/remote-explorer-tree';
import { ConnectionFormProvider } from './providers/connection-form-provider';
import { RemoteDocumentProvider } from './providers/remote-document-provider';
import { configManager } from './core/config';
import { connectionManager } from './core/connection-manager';
import { transferManager } from './core/transfer-manager';
import { logger } from './utils/logger';
import { statusBar } from './utils/status-bar';
import { registerCommands } from './commands';
import { fileWatcherManager } from './core/file-watcher';

let remoteExplorerProvider: RemoteExplorerWebviewProvider;
let remoteTreeProvider: RemoteExplorerTreeProvider;
let connectionFormProvider: ConnectionFormProvider;
let remoteDocumentProvider: RemoteDocumentProvider;

// Session-based auto-upload confirmation state
let autoUploadConfirmed = false;

export function activate(context: vscode.ExtensionContext): void {
  logger.info('StackerFTP extension activating...');

  // Register show output command for status bar click
  context.subscriptions.push(
    vscode.commands.registerCommand('stackerftp.showOutput', () => {
      logger.show();
    })
  );

  const workspaceFolders = vscode.workspace.workspaceFolders;
  
  if (!workspaceFolders || workspaceFolders.length === 0) {
    logger.info('No workspace folder open, waiting for folder...');
    
    vscode.window.showInformationMessage(
      'StackerFTP: Open a workspace folder to start using SFTP features',
      'Open Folder'
    ).then(selection => {
      if (selection === 'Open Folder') {
        vscode.commands.executeCommand('vscode.openFolder');
      }
    });
    
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // Register Remote Document Provider for viewing remote files
  remoteDocumentProvider = new RemoteDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      RemoteDocumentProvider.scheme,
      remoteDocumentProvider
    )
  );

  // Register viewContent command
  context.subscriptions.push(
    vscode.commands.registerCommand('stackerftp.viewContent', async (item?: any) => {
      if (!item || !item.entry) {
        statusBar.error('No file selected');
        return;
      }

      const remotePath = item.entry.path;
      const fileName = item.entry.name || path.basename(remotePath);

      // Check for system files
      if (RemoteDocumentProvider.isSystemFile(remotePath)) {
        statusBar.warn(`Cannot view system file: ${fileName}`);
        return;
      }

      // Check for binary files
      if (RemoteDocumentProvider.isBinaryFile(remotePath)) {
        const choice = await vscode.window.showWarningMessage(
          `"${fileName}" is a binary file and cannot be viewed as text. Would you like to download it instead?`,
          'Download', 'Cancel'
        );
        if (choice === 'Download') {
          vscode.commands.executeCommand('stackerftp.tree.download', item);
        }
        return;
      }

      // Store config for multi-connection support
      if (item.config) {
        RemoteDocumentProvider.setConfigForPath(remotePath, item.config);
      }

      try {
        const uri = RemoteDocumentProvider.createUri(remotePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (error: any) {
        statusBar.error(`Failed to open file: ${error.message}`);
      }
    })
  );

  // Register Connection Form Provider (always visible)
  connectionFormProvider = new ConnectionFormProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ConnectionFormProvider.viewType,
      connectionFormProvider
    )
  );

  // Register Native TreeView for Remote Explorer
  remoteTreeProvider = new RemoteExplorerTreeProvider(workspaceRoot);
  
  const treeView = vscode.window.createTreeView('stackerftp.remoteExplorerTree', {
    treeDataProvider: remoteTreeProvider,
    showCollapseAll: true,
    canSelectMany: true
  });
  
  context.subscriptions.push(treeView);
  context.subscriptions.push(
    vscode.commands.registerCommand('stackerftp.tree.openFile', (item) => {
      remoteTreeProvider.openFile(item);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('stackerftp.tree.download', (item) => {
      remoteTreeProvider.downloadFile(item);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('stackerftp.tree.delete', (item) => {
      remoteTreeProvider.deleteFile(item);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('stackerftp.tree.refresh', async () => {
      await remoteTreeProvider.refreshWithProgress();
    })
  );

  // Register commands
  registerCommands(context, remoteTreeProvider, connectionFormProvider, treeView);

  // Load initial configuration
  loadConfiguration(workspaceRoot);
  
  // Start file watcher if enabled
  startFileWatcher(workspaceRoot);

  // Watch for workspace changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async event => {
      // Kaldırılan klasörleri temizle
      for (const removed of event.removed) {
        const removedPath = removed.uri.fsPath;
        logger.info(`Workspace folder removed: ${removedPath}`);
        // File watcher'ları durdur
        fileWatcherManager.stopAll();
        // Bağlantıları kapat
        await connectionManager.disconnect();
      }
      
      // Eklenen klasörleri yükle
      for (const added of event.added) {
        const newRoot = added.uri.fsPath;
        await loadConfiguration(newRoot);
      }
    })
  );

  // Watch for file changes (upload on save + config reload)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async document => {
      // Check if it's the config file
      const configPath = path.join(workspaceRoot, '.vscode', 'sftp.json');
      if (document.fileName === configPath) {
        logger.info('Config file changed, reloading...');
        await loadConfiguration(workspaceRoot);
        
        // Refresh connection form to show updated configs
        if (connectionFormProvider) {
          connectionFormProvider.refresh();
        }
        
        statusBar.success('Configuration reloaded');
        return;
      }
      
      // Check if this is a temp file from Edit Local
      const editMappings = (global as any).stackerftpEditMappings;
      if (editMappings && editMappings.has(document.fileName)) {
        const metadata = editMappings.get(document.fileName);
        try {
          const connection = await connectionManager.ensureConnection(metadata.config);
          await transferManager.uploadFile(connection, document.fileName, metadata.remotePath, metadata.config);
          statusBar.success(`Uploaded: ${path.basename(metadata.remotePath)}`);
        } catch (error: any) {
          statusBar.error(`Failed to upload: ${error.message}`, true);
        }
        return;
      }
      
      // Handle upload on save
      handleFileSave(document, workspaceRoot);
    })
  );

  // Register file system provider for remote files
  const remoteFileProvider: vscode.FileSystemProvider = {
    onDidChangeFile: new vscode.EventEmitter<vscode.FileChangeEvent[]>().event,
    watch: () => ({ dispose: () => {} }),
    stat: async () => ({
      type: vscode.FileType.File,
      ctime: Date.now(),
      mtime: Date.now(),
      size: 0
    }),
    readDirectory: async () => [],
    createDirectory: async () => {},
    readFile: async () => Buffer.from(''),
    writeFile: async () => {},
    delete: async () => {},
    rename: async () => {}
  };
  
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('stackerftp', remoteFileProvider, { isCaseSensitive: true })
  );

  logger.info('StackerFTP extension activated successfully');
}

async function loadConfiguration(workspaceRoot: string): Promise<void> {
  try {
    if (configManager.configExists(workspaceRoot)) {
      await configManager.loadConfig(workspaceRoot);
      logger.info('Configuration loaded successfully');
      
      const config = configManager.getActiveConfig(workspaceRoot);
      if (config) {
        logger.info(`Active config: ${config.name || config.host}`);
      }
    } else {
      logger.info('No configuration file found');
    }
  } catch (error) {
    logger.error('Failed to load configuration', error);
  }
}

async function handleFileSave(document: vscode.TextDocument, workspaceRoot: string): Promise<void> {
  if (!document.fileName.startsWith(workspaceRoot)) {
    return;
  }

  const config = configManager.getActiveConfig(workspaceRoot);
  if (!config || !config.uploadOnSave) {
    return;
  }

  const relativePath = path.relative(workspaceRoot, document.fileName);
  if (config.ignore) {
    for (const pattern of config.ignore) {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      if (regex.test(relativePath)) {
        return;
      }
    }
  }

  // Ask for confirmation once per session
  if (!autoUploadConfirmed) {
    const choice = await vscode.window.showInformationMessage(
      `Auto-upload is enabled. Upload "${path.basename(document.fileName)}" to ${config.name || config.host}?`,
      { modal: false },
      'Yes, upload',
      'Yes, always in this session',
      'No'
    );

    if (choice === 'No' || !choice) {
      return;
    }

    if (choice === 'Yes, always in this session') {
      autoUploadConfirmed = true;
    }
  }

  try {
    const connection = await connectionManager.ensureConnection(config);
    const remotePath = path.join(config.remotePath, relativePath).replace(/\\/g, '/');
    
    const remoteDir = path.dirname(remotePath);
    try {
      await connection.mkdir(remoteDir);
    } catch (error: any) {
      // Directory might already exist
      if (error.code !== 'EEXIST' && !error.message?.includes('exists')) {
        logger.warn(`Failed to create directory: ${remoteDir}`, error);
        // Permission hatası varsa bildir
        if (error.code === 'EACCES' || error.code === 'EPERM' || 
            error.message?.includes('permission') || error.message?.includes('Permission')) {
          throw new Error(`Permission denied creating directory: ${remoteDir}`);
        }
      }
    }

    await transferManager.uploadFile(connection, document.fileName, remotePath, config);
    vscode.window.setStatusBarMessage(`$(cloud-upload) Uploaded: ${path.basename(document.fileName)}`, 3000);
    logger.info(`Auto-uploaded: ${relativePath}`);
  } catch (error) {
    vscode.window.setStatusBarMessage(`$(error) Upload failed: ${path.basename(document.fileName)}`, 5000);
    logger.error(`Auto-upload failed for ${relativePath}`, error);
  }
}

async function startFileWatcher(workspaceRoot: string): Promise<void> {
  const config = configManager.getActiveConfig(workspaceRoot);
  if (config && config.watcher) {
    fileWatcherManager.startWatcher(workspaceRoot, config);
  }
}

export function deactivate(): void {
  logger.info('StackerFTP extension deactivating...');

  fileWatcherManager.stopAll();

  connectionManager.disconnect().catch(error => {
    console.error('Error disconnecting:', error);
  });

  statusBar.dispose();
  logger.dispose();
}
