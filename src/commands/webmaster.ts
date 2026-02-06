import * as vscode from 'vscode';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { webMasterTools } from '../webmaster/tools';
import { statusBar } from '../utils/status-bar';
import { getWorkspaceRoot } from './utils';

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
