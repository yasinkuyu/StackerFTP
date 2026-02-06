import * as vscode from 'vscode';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { statusBar } from '../utils/status-bar';
import { getWorkspaceRoot } from './utils';

export function registerViewCommands(remoteExplorer?: any): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  const selectPrimaryConnectionCommand = vscode.commands.registerCommand('stackerftp.selectPrimaryConnection', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (configs.length === 0) {
      statusBar.success('No connections configured. Use "StackerFTP: New Connection" to add one.');
      return;
    }

    const activeConns = connectionManager.getAllActiveConnections();
    const primaryConfig = connectionManager.getPrimaryConfig();

    const items = configs.map(config => {
      const isConnected = connectionManager.isConnected(config);
      const isPrimary = primaryConfig && config.name === primaryConfig.name && config.host === primaryConfig.host;

      let icon = '$(primitive-square)'; // Default disconnected
      if (isPrimary) icon = '$(star-full)';
      else if (isConnected) icon = '$(star-empty)';

      const description = `${config.protocol?.toUpperCase()} • ${config.username}@${config.host}`;
      let detail = 'Disconnected - Click to connect';

      if (isPrimary) detail = 'Primary Connection - Click to manage';
      else if (isConnected) detail = 'Connected - Click to set as Primary';

      return {
        label: `${icon} ${config.name || config.host}`,
        description,
        detail,
        config,
        isPrimary,
        isConnected
      };
    });

    // Add connect all / disconnect all options if relevant
    if (activeConns.length > 0) {
      items.push({
        label: '$(close-all) Disconnect All',
        description: `Disconnect from all ${activeConns.length} servers`,
        detail: '',
        config: null as any,
        isPrimary: false,
        isConnected: false
      });
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Manage Connections (Select to connect or set as primary)',
      title: `Connections (${activeConns.length} active)`
    });

    if (!selected) return;

    if (!selected.config) {
      // Disconnect all
      await connectionManager.disconnect();
      statusBar.success('Disconnected from all servers');
      vscode.commands.executeCommand('stackerftp.tree.refresh');
      return;
    }

    if (selected.isPrimary) {
      // Already primary - maybe verify or disconnect?
      // For now, let's offer to disconnect this specific one
      const action = await vscode.window.showQuickPick(
        ['Disconnect', 'Keep as Primary'],
        { placeHolder: `Action for ${selected.config.name || selected.config.host}` }
      );

      if (action === 'Disconnect') {
        await connectionManager.disconnect(selected.config);
        vscode.commands.executeCommand('stackerftp.tree.refresh');
      }
    } else if (selected.isConnected) {
      // Connected but not primary - set as primary
      connectionManager.setPrimaryConnection(selected.config);
      statusBar.success(`Primary connection set to: ${selected.config.name || selected.config.host}`);
      vscode.commands.executeCommand('stackerftp.tree.refresh');
    } else {
      // Disconnected - connect and set as primary (if it's the first connection, connectionManager does this automatically)
      try {
        await connectionManager.connect(selected.config);
        // If there are other connections, we might want to enforce this as primary explicitly
        if (activeConns.length > 0) {
          connectionManager.setPrimaryConnection(selected.config);
        }
        vscode.commands.executeCommand('stackerftp.tree.refresh');
      } catch (error: any) {
        statusBar.error(`Connection failed: ${error.message}`, true);
      }
    }
  });

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

  disposables.push(
    selectPrimaryConnectionCommand,
    toggleHiddenFilesCommand,
    sortByNameCommand,
    sortBySizeCommand,
    sortByDateCommand,
    selectAllFilesCommand
  );

  return disposables;
}
