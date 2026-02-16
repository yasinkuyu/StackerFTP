import * as vscode from 'vscode';
import * as path from 'path';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { webMasterTools } from '../webmaster/tools';
import { statusBar } from '../utils/status-bar';
import { getWorkspaceRoot } from './utils';
import { CompareViewProvider } from '../providers/compare-view';

export function registerWebMasterCommands(): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

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

  const compareChecksumCommand = vscode.commands.registerCommand('stackerftp.webmaster.compareChecksum', async (item: any) => {
    if (!item?.entry || item.entry.type !== 'file') {
      statusBar.error('Select a remote file to compare');
      return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = item.config || configManager.getActiveConfig(workspaceRoot);
    if (!config) return;

    try {
      const localPick = await vscode.window.showOpenDialog({
        title: 'Select local file to compare',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false
      });

      if (!localPick || localPick.length === 0) return;

      const connection = item.connectionRef || await connectionManager.ensureConnection(config);
      const result = await webMasterTools.compareChecksums(connection, localPick[0].fsPath, item.entry.path, 'md5');
      await webMasterTools.showChecksumResult(result, item.entry.name);
    } catch (error: any) {
      statusBar.error(`Checksum compare failed: ${error.message}`);
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
      await webMasterTools.showSearchResults(results, config);
    } catch (error: any) {
      statusBar.error(`Search failed: ${error.message}`);
    }
  });

  // Quick Search - Opens in new panel
  const quickSearchCommand = vscode.commands.registerCommand('stackerftp.webmaster.quickSearch', async (item?: any) => {
    // Import the panel here to avoid circular dependencies
    const { QuickSearchPanel } = await import('../providers/quick-search-panel');

    // Pass the item if it's from remote explorer
    const uri = item?.entry?.path ? vscode.Uri.file(item.entry.path) : undefined;
    await QuickSearchPanel.show(uri);
  });

  // Quick Search Change Path - called from webview
  const quickSearchChangePathCommand = vscode.commands.registerCommand('stackerftp.webmaster.quickSearchChangePath', async () => {
    const { QuickSearchPanel } = await import('../providers/quick-search-panel');
    await QuickSearchPanel.changePathFromCommand();
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

  // Singleton instance for CompareViewProvider
  let compareViewProvider: CompareViewProvider | undefined;

  const compareFoldersCommand = vscode.commands.registerCommand('stackerftp.webmaster.compareFolders', async (uri?: vscode.Uri) => {
    // Create provider if not exists
    if (!compareViewProvider) {
      const extensionUri = vscode.Uri.parse('');
      compareViewProvider = new CompareViewProvider(extensionUri);
    }

    try {
      // Check if called from context menu with a specific folder
      let localPath: string | undefined;

      if (uri && uri.fsPath) {
        // Context menu - check if it's a folder
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          localPath = uri.fsPath;
        }
      }

      // If we have a folder path, ask user what to compare
      if (localPath) {
        const workspaceRoot = getWorkspaceRoot();
        if (workspaceRoot && localPath.startsWith(workspaceRoot)) {
          const relativePath = path.relative(workspaceRoot, localPath);

          if (relativePath) {
            const choice = await vscode.window.showQuickPick([
              { label: `$(file-directory) Selected: ${path.basename(localPath)}`, description: 'Compare only this folder', value: 'selected' },
              { label: '$(files) Entire Workspace', description: 'Compare entire workspace', value: 'workspace' }
            ], {
              title: 'Compare Folders',
              placeHolder: 'What would you like to compare?'
            });

            if (!choice) return;

            if (choice.value === 'workspace') {
              localPath = undefined; // Will use workspace root
            }
            // If 'selected', use the localPath
          }
        }
      }

      await compareViewProvider.show(localPath);
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

  disposables.push(
    chmodCommand,
    checksumCommand,
    compareChecksumCommand,
    fileInfoCommand,
    searchCommand,
    backupCommand,
    compareFoldersCommand,
    replaceCommand,
    purgeCacheCommand
  );

  return disposables;
}
