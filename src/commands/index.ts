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
import { FTPConfig, Protocol } from '../types';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';
import { normalizeRemotePath, formatFileSize, sanitizeRelativePath, getLocalRelativePath, getLocalRoot, getLocalPathFromRemote } from '../utils/helpers';
import { ConnectionWizard } from '../core/connection-wizard';
import { createGitIntegration } from '../core/git-integration';
import { getWorkspaceRoot } from './utils';
import { registerWebMasterCommands } from './webmaster';
import { registerViewCommands } from './view';

import { ConnectionFormProvider } from '../providers/connection-form-provider';

export interface ProviderContainer {
  remoteExplorer?: any;
  connectionFormProvider?: ConnectionFormProvider;
  treeView?: vscode.TreeView<any>;
}

type ProfileAction = 'create' | 'edit' | 'delete' | 'setDefault' | 'clearDefault' | 'openJson';

function getConnectionLabel(config: FTPConfig): string {
  return config.name || config.host;
}

function getConnectionDescription(config: FTPConfig): string {
  return `${config.protocol.toUpperCase()} • ${config.username}@${config.host}`;
}

function setOptionalProfileField<K extends keyof FTPConfig>(
  profile: Partial<FTPConfig>,
  key: K,
  value: FTPConfig[K] | undefined
): void {
  if (value === undefined || value === '') {
    delete profile[key];
    return;
  }

  profile[key] = value;
}

async function promptOptionalInput(
  prompt: string,
  value: string,
  placeHolder: string
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    placeHolder,
    ignoreFocusOut: true
  });
}

async function promptOptionalPort(existing?: number): Promise<number | undefined | null> {
  while (true) {
    const rawValue = await promptOptionalInput(
      'Profile port override',
      typeof existing === 'number' ? String(existing) : '',
      'Leave empty to inherit the base connection port'
    );

    if (rawValue === undefined) {
      return undefined;
    }

    const trimmed = rawValue.trim();
    if (!trimmed) {
      return null;
    }

    const port = Number(trimmed);
    if (Number.isInteger(port) && port > 0) {
      return port;
    }

    statusBar.error('Port must be a positive integer');
  }
}

async function promptProfileProtocol(existing?: Protocol): Promise<Protocol | null | undefined> {
  const selected = await vscode.window.showQuickPick(
    [
      { label: 'Inherit Base Connection', value: null as Protocol | null, description: 'Do not override protocol' },
      { label: 'SFTP', value: 'sftp' as Protocol },
      { label: 'FTP', value: 'ftp' as Protocol },
      { label: 'FTPS', value: 'ftps' as Protocol }
    ],
    {
      placeHolder: `Protocol override${existing ? ` (current: ${existing.toUpperCase()})` : ''}`,
      ignoreFocusOut: true
    }
  );

  return selected?.value;
}

async function promptProfileSecure(
  existing?: FTPConfig['secure']
): Promise<FTPConfig['secure'] | null | undefined> {
  const describeCurrent = existing === undefined ? 'inherit' : String(existing);
  const selected = await vscode.window.showQuickPick(
    [
      { label: 'Inherit Base Connection', value: null as FTPConfig['secure'] | null, description: 'Do not override secure mode' },
      { label: 'Disabled', value: false as FTPConfig['secure'] },
      { label: 'Enabled', value: true as FTPConfig['secure'] },
      { label: 'Control', value: 'control' as FTPConfig['secure'] },
      { label: 'Implicit', value: 'implicit' as FTPConfig['secure'] }
    ],
    {
      placeHolder: `Secure mode override (current: ${describeCurrent})`,
      ignoreFocusOut: true
    }
  );

  return selected?.value;
}

async function promptForProfileOverrides(
  profileName: string,
  existing: Partial<FTPConfig> = {}
): Promise<Partial<FTPConfig> | undefined> {
  const profile: Partial<FTPConfig> = { ...existing };

  const protocol = await promptProfileProtocol(existing.protocol);
  if (protocol === undefined) return undefined;
  setOptionalProfileField(profile, 'protocol', protocol ?? undefined);

  const host = await promptOptionalInput(
    `Host override for profile "${profileName}"`,
    existing.host || '',
    'Leave empty to inherit the base connection host'
  );
  if (host === undefined) return undefined;
  setOptionalProfileField(profile, 'host', host.trim() || undefined);

  const port = await promptOptionalPort(existing.port);
  if (port === undefined) return undefined;
  setOptionalProfileField(profile, 'port', port === null ? undefined : port);

  const username = await promptOptionalInput(
    `Username override for profile "${profileName}"`,
    existing.username || '',
    'Leave empty to inherit the base connection username'
  );
  if (username === undefined) return undefined;
  setOptionalProfileField(profile, 'username', username.trim() || undefined);

  const remotePath = await promptOptionalInput(
    `Remote path override for profile "${profileName}"`,
    existing.remotePath || '',
    'Leave empty to inherit the base connection remote path'
  );
  if (remotePath === undefined) return undefined;
  setOptionalProfileField(profile, 'remotePath', remotePath.trim() || undefined);

  const password = await promptOptionalInput(
    `Password override for profile "${profileName}"`,
    existing.password || '',
    'Leave empty to inherit the base connection password'
  );
  if (password === undefined) return undefined;
  setOptionalProfileField(profile, 'password', password || undefined);

  const privateKeyPath = await promptOptionalInput(
    `Private key override for profile "${profileName}"`,
    existing.privateKeyPath || '',
    'Leave empty to inherit the base connection private key path'
  );
  if (privateKeyPath === undefined) return undefined;
  setOptionalProfileField(profile, 'privateKeyPath', privateKeyPath.trim() || undefined);

  const passphrase = await promptOptionalInput(
    `Passphrase override for profile "${profileName}"`,
    existing.passphrase || '',
    'Leave empty to inherit the base connection passphrase'
  );
  if (passphrase === undefined) return undefined;
  setOptionalProfileField(profile, 'passphrase', passphrase || undefined);

  const secure = await promptProfileSecure(existing.secure);
  if (secure === undefined) return undefined;
  setOptionalProfileField(profile, 'secure', secure ?? undefined);

  return profile;
}

function collectCommandSelection(args: any[]): any[] {
  const items: any[] = [];
  const seen = new Set<any>();

  const addItem = (item: any) => {
    if (!item || seen.has(item)) return;
    seen.add(item);
    items.push(item);
  };

  const visit = (value: any) => {
    if (!value) return;

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if ((typeof value?.fsPath === 'string' && typeof value?.scheme === 'string') || value?.resourceUri || value?.entry) {
      addItem(value);
    }

    if (typeof value !== 'object') {
      return;
    }

    for (const key of ['selectedItems', 'selection', 'selectedResourceStates', 'resourceStates', 'scmResourceStates', 'items']) {
      if (key in value) {
        visit(value[key]);
      }
    }
  };

  for (const arg of args) {
    visit(arg);
  }

  return items;
}

function getCommandItemUri(item: any): vscode.Uri | undefined {
  if (!item) return undefined;
  if (item.resourceUri) return item.resourceUri;
  if (typeof item.fsPath === 'string' && typeof item.scheme === 'string') return item;
  if (typeof item.fsPath === 'string') return vscode.Uri.file(item.fsPath);
  return undefined;
}

function getWorkspaceRootFromItems(items: any[]): string | undefined {
  for (const item of items) {
    const itemUri = getCommandItemUri(item);
    if (itemUri) {
      const workspaceRoot = getWorkspaceRoot(itemUri);
      if (workspaceRoot) {
        return workspaceRoot;
      }
    }
  }

  return getWorkspaceRoot();
}

async function getResolvedActiveConfig(workspaceRoot: string): Promise<FTPConfig | undefined> {
  let config = configManager.getActiveConfig(workspaceRoot);
  if (config) {
    return config;
  }

  if (!configManager.configExists(workspaceRoot)) {
    return undefined;
  }

  await configManager.loadConfig(workspaceRoot);
  config = configManager.getActiveConfig(workspaceRoot);
  return config;
}

async function manageProfiles(workspaceRoot: string): Promise<void> {
  await configManager.loadConfig(workspaceRoot);
  const configs = configManager.getConfigs(workspaceRoot);

  if (configs.length === 0) {
    statusBar.info('No connections configured');
    return;
  }

  const selectedConfigItem = await vscode.window.showQuickPick(
    configs.map((config, index) => ({
      label: getConnectionLabel(config),
      description: getConnectionDescription(config),
      detail: `${Object.keys(config.profiles || {}).length} profile(s)${config.defaultProfile ? ` • default: ${config.defaultProfile}` : ''}`,
      index
    })),
    {
      placeHolder: 'Select a connection to manage profiles',
      ignoreFocusOut: true
    }
  );

  if (!selectedConfigItem) return;

  const config = configs[selectedConfigItem.index];
  const profileNames = Object.keys(config.profiles || {});
  const actionItems: { label: string; description: string; value: ProfileAction }[] = [
    { label: 'Create Profile', description: 'Add a new profile override for this connection', value: 'create' },
    { label: 'Open sftp.json', description: 'Edit profiles directly in JSON', value: 'openJson' }
  ];

  if (profileNames.length > 0) {
    actionItems.splice(1, 0,
      { label: 'Edit Profile', description: 'Update an existing profile override', value: 'edit' },
      { label: 'Delete Profile', description: 'Remove an existing profile', value: 'delete' },
      { label: 'Set Default Profile', description: 'Choose which profile should be active by default', value: 'setDefault' }
    );

    if (config.defaultProfile) {
      actionItems.push({
        label: 'Clear Default Profile',
        description: `Stop using "${config.defaultProfile}" as the default`,
        value: 'clearDefault'
      });
    }
  }

  const selectedAction = await vscode.window.showQuickPick(actionItems, {
    placeHolder: `Manage profiles for ${getConnectionLabel(config)}`,
    ignoreFocusOut: true
  });

  if (!selectedAction) return;

  if (selectedAction.value === 'openJson') {
    const configPath = configManager.getConfigPath(workspaceRoot);
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
    return;
  }

  config.profiles = config.profiles || {};

  switch (selectedAction.value) {
    case 'create': {
      const profileName = await vscode.window.showInputBox({
        prompt: 'Profile name',
        placeHolder: 'Example: production, staging, preview',
        ignoreFocusOut: true,
        validateInput: (value) => {
          const trimmed = value.trim();
          if (!trimmed) return 'Profile name is required';
          if (config.profiles?.[trimmed]) return 'A profile with this name already exists';
          return null;
        }
      });

      if (!profileName) return;

      const overrides = await promptForProfileOverrides(profileName.trim());
      if (!overrides) return;

      config.profiles[profileName.trim()] = overrides;

      if (!config.defaultProfile) {
        const makeDefault = await vscode.window.showQuickPick(
          ['Yes', 'No'],
          {
            placeHolder: `Use "${profileName.trim()}" as the default profile?`,
            ignoreFocusOut: true
          }
        );
        if (makeDefault === 'Yes') {
          config.defaultProfile = profileName.trim();
        }
      }

      break;
    }

    case 'edit': {
      const selectedProfile = await vscode.window.showQuickPick(profileNames, {
        placeHolder: 'Select a profile to edit',
        ignoreFocusOut: true
      });

      if (!selectedProfile) return;

      const overrides = await promptForProfileOverrides(selectedProfile, config.profiles[selectedProfile]);
      if (!overrides) return;

      config.profiles[selectedProfile] = overrides;
      break;
    }

    case 'delete': {
      const selectedProfile = await vscode.window.showQuickPick(profileNames, {
        placeHolder: 'Select a profile to delete',
        ignoreFocusOut: true
      });

      if (!selectedProfile) return;

      const confirm = await vscode.window.showWarningMessage(
        `Delete profile "${selectedProfile}" from ${getConnectionLabel(config)}?`,
        { modal: true },
        'Delete',
        'Cancel'
      );

      if (confirm !== 'Delete') return;

      delete config.profiles[selectedProfile];
      if (config.defaultProfile === selectedProfile) {
        delete config.defaultProfile;
      }
      break;
    }

    case 'setDefault': {
      const selectedProfile = await vscode.window.showQuickPick(profileNames, {
        placeHolder: 'Select the default profile',
        ignoreFocusOut: true
      });

      if (!selectedProfile) return;
      config.defaultProfile = selectedProfile;
      break;
    }

    case 'clearDefault':
      delete config.defaultProfile;
      break;
  }

  if (Object.keys(config.profiles).length === 0) {
    delete config.profiles;
  }

  await configManager.saveConfig(workspaceRoot, configs);
  await configManager.loadConfig(workspaceRoot);
  await vscode.commands.executeCommand('stackerftp.tree.refresh');
  statusBar.success(`Profiles updated for ${getConnectionLabel(config)}`);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  container: ProviderContainer
): void {
  const { remoteExplorer, connectionFormProvider, treeView } = container;

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
          await manageProfiles(workspaceRoot);
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

  const connectCommand = vscode.commands.registerCommand('stackerftp.connect', async (item?: any) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Handle direct connection from tree view
    if (item && item.config) {
      try {
        await connectionManager.connect(item.config);
        statusBar.success(`Connected to ${item.config.name || item.config.host}`);
        if (remoteExplorer?.refresh) {
          remoteExplorer.refresh();
        }
        if (connectionFormProvider?.refresh) {
          connectionFormProvider.refresh();
        }
      } catch (error: any) {
        statusBar.error(`Connection failed: ${error.message}`, true);
      }
      return;
    }

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
    // Changed: Always show list if multiple configs, even if some are connected
    if (configs.length === 1) {
      const isConnected = connectionManager.isConnected(configs[0]);
      if (isConnected) {
        statusBar.info(`Already connected to ${configs[0].name || configs[0].host}`);
        return;
      }

      try {
        await connectionManager.connect(configs[0]);
        statusBar.success(`Connected to ${configs[0].name || configs[0].host}`);
        if (remoteExplorer?.refresh) {
          remoteExplorer.refresh();
        }
        if (connectionFormProvider?.refresh) {
          connectionFormProvider.refresh();
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
      if (connectionFormProvider?.refresh) {
        connectionFormProvider.refresh();
      }
    } catch (error: any) {
      statusBar.error(`Connection failed: ${error.message}`, true);
    }
  });

  const disconnectCommand = vscode.commands.registerCommand('stackerftp.disconnect', async (item?: any) => {
    // Handle disconnection from tree view
    if (item && item.config) {
      try {
        await connectionManager.disconnect(item.config);
        statusBar.success(`Disconnected: ${item.config.name || item.config.host}`);
        if (remoteExplorer?.refresh) {
          remoteExplorer.refresh();
        }
        if (connectionFormProvider?.refresh) {
          connectionFormProvider.refresh();
        }
      } catch (error: any) {
        statusBar.error(`Disconnect failed: ${error.message}`, true);
      }
      return;
    }

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
      if (connectionFormProvider?.refresh) {
        connectionFormProvider.refresh();
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

  const uploadCommand = vscode.commands.registerCommand(
    'stackerftp.upload',
    async (...commandArgs: any[]) => {
    const items = collectCommandSelection(commandArgs);
    const workspaceRoot = getWorkspaceRootFromItems(items);
    if (!workspaceRoot) return;

    if (!items || items.length === 0) {
      statusBar.error('No file selected');
      return;
    }

    // Extract local paths from items
    const localPaths: string[] = [];
    for (const item of items) {
      if (!item) continue;
      if ('resourceUri' in item) {
        localPaths.push(item.resourceUri.fsPath);
      } else if ('fsPath' in item) {
        localPaths.push(item.fsPath);
      }
    }

    if (localPaths.length === 0) {
      statusBar.error('No valid file selected');
      return;
    }

    // Check for active connections first
    const activeConns = connectionManager.getAllActiveConnections();

    let config: any;
    let connection: any;

    if (activeConns.length === 0) {
      // No active connections - use config and connect
      config = await getResolvedActiveConfig(workspaceRoot);
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
      let uploadedCount = 0;
      let failedCount = 0;

      for (const localPath of localPaths) {
        try {
          const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, config));
          const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

          if (fs.statSync(localPath).isDirectory()) {
            const result = await transferManager.uploadDirectory(connection, localPath, remotePath, config);
            uploadedCount += result.uploaded.length;
            failedCount += result.failed.length;
          } else {
            // Ensure remote directory exists
            const remoteDir = normalizeRemotePath(path.dirname(remotePath));
            try {
              await connection.mkdir(remoteDir);
            } catch {
              // Directory might already exist
            }
            await transferManager.uploadFile(connection, localPath, remotePath, config);
            uploadedCount++;
          }
        } catch (err) {
          failedCount++;
        }
      }

      if (failedCount === 0) {
        statusBar.success(`Uploaded: ${uploadedCount} item(s)`);
      } else {
        statusBar.info(`Uploaded: ${uploadedCount}, Failed: ${failedCount}`);
      }

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
    const workspaceRoot = getWorkspaceRoot(editor.document.uri);
    if (!workspaceRoot) return;

    // Check for active connections first
    const activeConns = connectionManager.getAllActiveConnections();

    let config: any;
    let connection: any;

    if (activeConns.length === 0) {
      config = await getResolvedActiveConfig(workspaceRoot);
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
      const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, config));
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

  const downloadCommand = vscode.commands.registerCommand('stackerftp.download', async (...commandArgs: any[]) => {
    const items = collectCommandSelection(commandArgs);
    const workspaceRoot = getWorkspaceRootFromItems(items);
    if (!workspaceRoot) return;

    const config = await getResolvedActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    if (items.length === 0) {
      statusBar.error('No item selected. Use "Download Project" for full project download.');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);

      let downloadedCount = 0;
      let failedCount = 0;
      let handledCount = 0;

      for (const itemOrResource of items) {
        if (!itemOrResource) continue;

        let remotePath: string;
        let localPath: string;
        let isDirectory = false;

        // Check if it's a SCM resource state (has resourceUri property)
        if (itemOrResource && 'resourceUri' in itemOrResource) {
          // SCM resource - download from remote to this local file
          localPath = itemOrResource.resourceUri.fsPath;
          const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, config));
          remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));
        } else if (itemOrResource && 'fsPath' in itemOrResource) {
          // Local Explorer / editor resource - download matching remote path to selected local target
          localPath = itemOrResource.fsPath;
          const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, config));
          remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

          try {
            isDirectory = fs.statSync(localPath).isDirectory();
          } catch {
            isDirectory = false;
          }
        } else if (itemOrResource?.entry) {
          // Remote explorer item
          remotePath = itemOrResource.entry.path;
          localPath = getLocalPathFromRemote(workspaceRoot, remotePath, config);
          isDirectory = itemOrResource.entry.type === 'directory' ||
            (itemOrResource.entry.type === 'symlink' && itemOrResource.entry.isSymlinkToDirectory);
        } else {
          // Skip invalid items
          continue;
        }

        handledCount++;

        const itemConfig = itemOrResource?.config || config;
        const itemConnection = itemOrResource?.connectionRef || connectionManager.getConnection(itemConfig) || connection;

        try {
          if (isDirectory) {
            const result = await transferManager.downloadDirectory(itemConnection, remotePath, localPath, itemConfig);
            downloadedCount += result.downloaded.length;
            failedCount += result.failed.length;
          } else {
            // Ensure local directory exists
            const localDir = path.dirname(localPath);
            if (!fs.existsSync(localDir)) {
              fs.mkdirSync(localDir, { recursive: true });
            }
            await transferManager.downloadFile(itemConnection, remotePath, localPath, itemConfig);
            downloadedCount++;
          }
        } catch (err) {
          failedCount++;
        }
      }

      if (handledCount === 0) {
        statusBar.error('No valid selection. Use "Download Project" for full project download.');
        return;
      }

      if (failedCount === 0) {
        statusBar.success(`Downloaded: ${downloadedCount} item(s)`);
      } else {
        statusBar.info(`Downloaded: ${downloadedCount}, Failed: ${failedCount}`);
      }
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
        const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, config));
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
    if (!workspaceRoot && !item?.config) return;

    const config = item?.config || (workspaceRoot ? configManager.getActiveConfig(workspaceRoot) : undefined);
    if (!config) return;

    try {
      const connection = item?.connectionRef || connectionManager.getConnection(config) || await connectionManager.ensureConnection(config);
      const content = await connection.readFile(item.entry.path);

      // Create a temporary file
      const tempDir = path.join(os.tmpdir(), 'stackerftp');
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

  const deleteRemoteCommand = vscode.commands.registerCommand('stackerftp.deleteRemote', async (itemOrItems: any | any[]) => {
    // Handle both single item and array of items, filter out invalid items
    const rawItems = Array.isArray(itemOrItems) ? itemOrItems : (itemOrItems ? [itemOrItems] : []);
    const items = rawItems.filter(item => item && item.entry);

    if (items.length === 0) {
      statusBar.error('No item selected');
      return;
    }

    const names = items.map(i => i.entry.name).join(', ');
    const confirmDelete = vscode.workspace.getConfiguration('stackerftp').get<boolean>('confirmDelete', true);

    if (confirmDelete) {
      const message = items.length === 1
        ? `Delete "${items[0].entry.name}"?`
        : `Delete ${items.length} items (${names})?`;
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        'Delete', 'Cancel'
      );
      if (choice !== 'Delete') return;
    }

    const workspaceRoot = getWorkspaceRoot();

    try {
      for (const item of items) {
        const config = item.config || (workspaceRoot ? configManager.getActiveConfig(workspaceRoot) : undefined);
        if (!config) continue;

        const connection = item.connectionRef || connectionManager.getConnection(config) || await connectionManager.ensureConnection(config);

        if (item.entry.type === 'directory') {
          await connection.rmdir(item.entry.path, true);
        } else {
          await connection.delete(item.entry.path);
        }
      }

      statusBar.success(`Deleted: ${items.length === 1 ? items[0].entry.name : `${items.length} items`}`);

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
        const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, activeConfig));
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
      const tempDir = path.join(os.tmpdir(), 'stackerftp-diff');
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

    // Get active connections
    const activeConns = connectionManager.getAllActiveConnections();

    let targetConfig: any;

    if (activeConns.length === 0) {
      // No active connections - check if we have any configs
      const configs = configManager.getConfigs(workspaceRoot);
      if (configs.length === 0) {
        statusBar.error('No configurations found');
        return;
      }

      // Prompt to select a config to connect and open terminal
      const items = configs.map(c => ({
        label: c.name || c.host,
        description: `${c.protocol.toUpperCase()} • ${c.username}@${c.host}`,
        config: c
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a server to connect and open terminal'
      });

      if (!selected) return;

      try {
        await connectionManager.connect(selected.config);
        targetConfig = selected.config;
      } catch (error: any) {
        statusBar.error(`Connection failed: ${error.message}`);
        return;
      }
    } else if (activeConns.length === 1) {
      // Single active connection
      targetConfig = activeConns[0].config;
    } else {
      // Multiple active connections - prompt to select
      const primaryConfig = connectionManager.getPrimaryConfig();

      const items = activeConns.map(({ config }) => {
        const isPrimary = primaryConfig && config.name === primaryConfig.name && config.host === primaryConfig.host;
        return {
          label: isPrimary ? `$(star-full) ${config.name || config.host}` : (config.name || config.host),
          description: `${config.protocol.toUpperCase()} • ${config.username}@${config.host}`,
          detail: isPrimary ? 'Primary Connection' : '',
          config
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select connection for terminal'
      });

      if (!selected) return;
      targetConfig = selected.config;
    }

    if (!targetConfig) return;

    if (targetConfig.protocol !== 'sftp') {
      statusBar.error('Remote terminal is only available with SFTP protocol');
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: `SFTP: ${targetConfig.name || targetConfig.host}`,
      shellPath: 'ssh',
      shellArgs: [
        '-p', String(targetConfig.port || 22),
        `${targetConfig.username}@${targetConfig.host}`
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
    statusBar.success('All transfers cancelled');
  });

  // Show Transfer Queue panel (focus on tree view)
  const showTransferQueueCommand = vscode.commands.registerCommand('stackerftp.showTransferQueue', async () => {
    await vscode.commands.executeCommand('stackerftp.transferQueue.focus');
  });

  // Cancel specific transfer item
  const cancelTransferItemCommand = vscode.commands.registerCommand('stackerftp.cancelTransferItem', (item: any) => {
    if (item && item.transferItem) {
      transferManager.cancelItem(item.transferItem.id);
      statusBar.success(`Cancelled: ${path.basename(item.transferItem.localPath)}`);
    }
  });

  // Retry failed transfer items
  const retryTransferItemCommand = vscode.commands.registerCommand('stackerftp.retryTransferItem', (item: any, selectedItems?: any[]) => {
    const items = selectedItems && selectedItems.length > 0
      ? selectedItems
      : (item ? [item] : []);

    const retryableIds = items
      .filter(queueItem => queueItem?.transferItem?.status === 'error')
      .map(queueItem => queueItem.transferItem.id);

    if (retryableIds.length === 0) {
      statusBar.warn('No failed transfers selected');
      return;
    }

    const retriedCount = transferManager.retryItems(retryableIds);
    if (retriedCount === 0) {
      statusBar.warn('No failed transfers were re-queued');
      return;
    }

    statusBar.success(`Retried: ${retriedCount} transfer${retriedCount > 1 ? 's' : ''}`);
  });

  // Clear completed/error transfers
  const clearTransferQueueCommand = vscode.commands.registerCommand('stackerftp.clearTransferQueue', () => {
    transferManager.clearCompleted();
    statusBar.success('Queue cleared');
  });

  // Legacy quick pick for transfer queue (backwards compatibility)
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

          const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, file.absolutePath, config));
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
      const uploadRoot = getLocalRoot(workspaceRoot, config);
      const result = await transferManager.uploadDirectory(connection, uploadRoot, config.remotePath, config);

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
        const localPath = getLocalPathFromRemote(workspaceRoot, selected.entry.path, config);
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
        const localPath = getLocalPathFromRemote(workspaceRoot, selected.entry.path, config);
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
      const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, config));
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
      const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, config));
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      await connectionManager.ensureConnection(config);

      // Focus on Remote Explorer tree view (VS Code auto-generates .focus for views)
      await vscode.commands.executeCommand('stackerftp.remoteExplorerTree.focus');

      let revealed = false;
      if (remoteExplorer && typeof remoteExplorer.navigateToPath === 'function') {
        revealed = await remoteExplorer.navigateToPath(remotePath, config, treeView);
      }

      if (revealed) {
        statusBar.success(`Revealed: ${path.basename(remotePath)}`);
      } else {
        statusBar.warn(`Remote path found but could not be revealed: ${remotePath}`);
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

  const uploadToAllProfilesCommand = vscode.commands.registerCommand('stackerftp.uploadToAllProfiles', async (uri: vscode.Uri, selectedItems?: vscode.Uri[]) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const configs = configManager.getConfigs(workspaceRoot);
    if (configs.length === 0) {
      statusBar.error('No SFTP configurations found', true);
      return;
    }

    const localPaths = selectedItems && selectedItems.length > 0
      ? selectedItems.map(item => item.fsPath).filter(Boolean)
      : (uri?.fsPath ? [uri.fsPath] : (vscode.window.activeTextEditor?.document.fileName ? [vscode.window.activeTextEditor.document.fileName] : []));

    if (localPaths.length === 0) {
      statusBar.error('No file selected');
      return;
    }

    const results: { name: string; success: boolean; error?: string }[] = [];
    const totalOperations = configs.length * localPaths.length;
    let completedOperations = 0;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Uploading to all profiles...',
      cancellable: false
    }, async (progress) => {
      for (const localPath of localPaths) {
        for (let i = 0; i < configs.length; i++) {
          const config = configs[i];
          const profileName = config.name || config.host;
          completedOperations++;
          progress.report({
            message: `${path.basename(localPath)} -> ${profileName} (${completedOperations}/${totalOperations})`,
            increment: totalOperations > 0 ? (100 / totalOperations) : 100
          });

          try {
            const connection = await connectionManager.ensureConnection(config);
            const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, config));
            const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

            // Ensure remote directory exists
            const remoteDir = normalizeRemotePath(path.dirname(remotePath));
            try {
              await connection.mkdir(remoteDir);
            } catch {
              // Directory might already exist
            }

            await transferManager.uploadFile(connection, localPath, remotePath, config);
            results.push({ name: `${profileName}:${path.basename(localPath)}`, success: true });
          } catch (error: any) {
            results.push({ name: `${profileName}:${path.basename(localPath)}`, success: false, error: error.message });
          }
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

  // Note: uploadFolder and downloadFolder commands are disabled.
  // The main upload and download commands now automatically detect file/folder type.

  // const uploadFolderCommand = vscode.commands.registerCommand('stackerftp.uploadFolder', async (uri: vscode.Uri) => {
  //   const workspaceRoot = getWorkspaceRoot(uri);
  //   if (!workspaceRoot) return;

  //   const config = configManager.getActiveConfig(workspaceRoot);
  //   if (!config) {
  //     statusBar.error('No SFTP configuration found', true);
  //     return;
  //   }

  //   const localPath = uri?.fsPath;
  //   if (!localPath) {
  //     statusBar.error('No folder selected');
  //     return;
  //   }

  //   try {
  //     const folderName = path.basename(localPath);
  //     const progress = statusBar.startProgress('upload-folder', `Uploading folder: ${folderName} (connecting...)`);

  //     try {
  //       const connection = await connectionManager.ensureConnection(config);

  //       const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
  //       const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

  //       progress.update(`Uploading folder: ${folderName} (scanning and queueing files...)`);
  //       const result = await transferManager.uploadDirectory(connection, localPath, remotePath, config);
  //       progress.complete();
  //       showSyncResult(result, 'upload');
  //     } catch (error: any) {
  //       progress.fail(`Upload folder failed: ${error.message}`);
  //       throw error;
  //     }
  //   } catch (error: any) {
  //     statusBar.error(`Upload folder failed: ${error.message}`);
  //   }
  // });

  // Note: uploadFolder and downloadFolder commands are disabled.
  // The main upload and download commands now automatically detect file/folder type.

  // const downloadFolderCommand = vscode.commands.registerCommand('stackerftp.downloadFolder', async (uri: vscode.Uri) => {
  //   const workspaceRoot = getWorkspaceRoot(uri);
  //   if (!workspaceRoot) return;

  //   const config = configManager.getActiveConfig(workspaceRoot);
  //   if (!config) {
  //     statusBar.error('No SFTP configuration found', true);
  //     return;
  //   }

  //   const localPath = uri?.fsPath;
  //   if (!localPath) {
  //     statusBar.error('No folder selected');
  //     return;
  //   }

  //   try {
  //     const folderName = path.basename(localPath);
  //     const progress = statusBar.startProgress('download-folder', `Downloading folder: ${folderName} (connecting...)`);

  //     try {
  //       const connection = await connectionManager.ensureConnection(config);

  //       const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
  //       const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

  //       progress.update(`Downloading folder: ${folderName} (scanning and queueing files...)`);
  //       const result = await transferManager.downloadDirectory(connection, remotePath, localPath, config);
  //       progress.complete();
  //       showSyncResult(result, 'download');
  //     } catch (error: any) {
  //       progress.fail(`Download folder failed: ${error.message}`);
  //       throw error;
  //     }
  //   } catch (error: any) {
  //     statusBar.error(`Download folder failed: ${error.message}`);
  //   }
  // });

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
      const localPath = getLocalPathFromRemote(workspaceRoot, remotePath, config);

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

  const forceUploadCommand = vscode.commands.registerCommand('stackerftp.forceUpload', async (uri: vscode.Uri, selectedItems?: vscode.Uri[]) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    const localPaths = selectedItems && selectedItems.length > 0
      ? selectedItems.map(item => item.fsPath).filter(Boolean)
      : (uri?.fsPath ? [uri.fsPath] : (vscode.window.activeTextEditor?.document.fileName ? [vscode.window.activeTextEditor.document.fileName] : []));

    if (localPaths.length === 0) {
      statusBar.error('No file selected');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      localPaths.length === 1
        ? 'Force upload will overwrite the remote file. Continue?'
        : `Force upload will overwrite ${localPaths.length} remote files. Continue?`,
      { modal: true },
      'Yes', 'No'
    );
    if (choice !== 'Yes') return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      let uploadedCount = 0;
      let failedCount = 0;

      for (const localPath of localPaths) {
        try {
          const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, config));
          const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

          // Ensure remote directory exists
          const remoteDir = normalizeRemotePath(path.dirname(remotePath));
          try {
            await connection.mkdir(remoteDir);
          } catch {
            // Directory might already exist
          }

          await transferManager.uploadFile(connection, localPath, remotePath, config);
          uploadedCount++;
        } catch {
          failedCount++;
        }
      }

      if (failedCount === 0) {
        statusBar.success(`Force uploaded: ${uploadedCount} item(s)`);
      } else {
        statusBar.info(`Force uploaded: ${uploadedCount}, Failed: ${failedCount}`);
      }
    } catch (error: any) {
      statusBar.error(`Force upload failed: ${error.message}`, true);
    }
  });

  const forceDownloadCommand = vscode.commands.registerCommand('stackerftp.forceDownload', async (uri: vscode.Uri, selectedItems?: vscode.Uri[]) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No SFTP configuration found', true);
      return;
    }

    const localPaths = selectedItems && selectedItems.length > 0
      ? selectedItems.map(item => item.fsPath).filter(Boolean)
      : (uri?.fsPath ? [uri.fsPath] : (vscode.window.activeTextEditor?.document.fileName ? [vscode.window.activeTextEditor.document.fileName] : []));

    if (localPaths.length === 0) {
      statusBar.error('No file selected');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      localPaths.length === 1
        ? 'Force download will overwrite the local file. Continue?'
        : `Force download will overwrite ${localPaths.length} local files. Continue?`,
      { modal: true },
      'Yes', 'No'
    );
    if (choice !== 'Yes') return;

    try {
      const connection = await connectionManager.ensureConnection(config);
      let downloadedCount = 0;
      let failedCount = 0;

      for (const localPath of localPaths) {
        try {
          const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, config));
          const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

          await transferManager.downloadFile(connection, remotePath, localPath);
          downloadedCount++;

          // Refresh the editor if file is open
          const openDoc = vscode.workspace.textDocuments.find(d => d.fileName === localPath);
          if (openDoc) {
            vscode.commands.executeCommand('workbench.action.files.revert');
          }
        } catch {
          failedCount++;
        }
      }

      if (failedCount === 0) {
        statusBar.success(`Force downloaded: ${downloadedCount} item(s)`);
      } else {
        statusBar.info(`Force downloaded: ${downloadedCount}, Failed: ${failedCount}`);
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
      const relativePath = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localPath, config));
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


  // ==================== Tree View Specific Commands ====================
  // These are used by the native TreeView and passed config explicitly

  const treeOpenFileCommand = vscode.commands.registerCommand('stackerftp.tree.openFile', async (item: any, config: any) => {
    if (container.remoteExplorer) {
      await container.remoteExplorer.openFile(item, config);
    }
  });

  const treeDownloadCommand = vscode.commands.registerCommand('stackerftp.tree.download', async (itemOrItems: any, selectedItems?: any[]) => {
    // TreeView multi-select is passed as the second argument by VS Code.
    const items = selectedItems && selectedItems.length > 0
      ? selectedItems
      : (Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]);

    if (!items || items.length === 0) {
      statusBar.error('No item selected');
      return;
    }

    if (container.remoteExplorer) {
      let downloadedCount = 0;
      for (const item of items) {
        await container.remoteExplorer.downloadFile(item);
        downloadedCount++;
      }
      if (downloadedCount > 1) {
        statusBar.success(`Downloaded: ${downloadedCount} items`);
      }
    }
  });

  const treeDeleteCommand = vscode.commands.registerCommand('stackerftp.tree.delete', async (itemOrItems: any, selectedItems?: any[]) => {
    // TreeView multi-select is passed as the second argument by VS Code.
    const items = selectedItems && selectedItems.length > 0
      ? selectedItems
      : (Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]);

    if (!items || items.length === 0) {
      statusBar.error('No item selected');
      return;
    }

    const names = items.map((i: any) => i.entry?.name || i.name).join(', ');
    const confirm = await vscode.window.showWarningMessage(
      items.length === 1
        ? `Delete "${names}"?`
        : `Delete ${items.length} items (${names})?`,
      { modal: true },
      'Delete', 'Cancel'
    );

    if (confirm !== 'Delete') return;

    if (container.remoteExplorer) {
      // Multi-select: skip individual confirm dialogs
      const skipConfirm = items.length > 1;
      for (const item of items) {
        await container.remoteExplorer.deleteFile(item, undefined, skipConfirm);
      }
    }
  });

  const treeRefreshCommand = vscode.commands.registerCommand('stackerftp.tree.refresh', () => {
    if (container.remoteExplorer) {
      container.remoteExplorer.refresh();
    }
  });

  // Register all commands
  context.subscriptions.push(
    treeOpenFileCommand,
    treeDownloadCommand,
    treeDeleteCommand,
    treeRefreshCommand,
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
    newConnectionCommand,
    switchProtocolCommand,
    quickConnectCommand,
    uploadToAllProfilesCommand,
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
    showTransferQueueCommand,
    cancelTransferItemCommand,
    retryTransferItemCommand,
    clearTransferQueueCommand
  );

  const viewDisposables = registerViewCommands(container);
  const webMasterDisposables = registerWebMasterCommands();

  context.subscriptions.push(
    ...webMasterDisposables,
    ...viewDisposables
  );
}
