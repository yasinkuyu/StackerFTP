/**
 * StackerFTP - Connection Wizard
 * 
 * Provides an interactive wizard for creating and managing connections
 * with protocol selection (FTP, FTPS, SFTP)
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { FTPConfig, Protocol, HopConfig } from '../types';
import { configManager } from './config';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';
import { ConnectionHopping } from './connection-hopping';

interface WizardStep {
  title: string;
  execute(): Promise<boolean>;
}

export class ConnectionWizard {
  private config: Partial<FTPConfig> = {};
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async start(): Promise<FTPConfig | undefined> {
    const steps: WizardStep[] = [
      { title: 'Select Protocol', execute: () => this.selectProtocol() },
      { title: 'Enter Connection Name', execute: () => this.enterName() },
      { title: 'Enter Host', execute: () => this.enterHost() },
      { title: 'Enter Port', execute: () => this.enterPort() },
      { title: 'Enter Username', execute: () => this.enterUsername() },
      { title: 'Select Authentication', execute: () => this.selectAuth() },
      { title: 'Enter Remote Path', execute: () => this.enterRemotePath() },
      { title: 'Configure Options', execute: () => this.configureOptions() }
    ];

    for (const step of steps) {
      const success = await step.execute();
      if (!success) {
        logger.info('Connection wizard cancelled');
        return undefined;
      }
    }

    return this.config as FTPConfig;
  }

  private async selectProtocol(): Promise<boolean> {
    const protocols: { label: string; description: string; protocol: Protocol; icon: string; defaultPort: number }[] = [
      {
        label: '$(cloud) SFTP',
        description: 'SSH File Transfer Protocol - Secure, encrypted connection',
        protocol: 'sftp',
        icon: '$(lock)',
        defaultPort: 22
      },
      {
        label: '$(folder-opened) FTP',
        description: 'Standard File Transfer Protocol - Unencrypted',
        protocol: 'ftp',
        icon: '$(warning)',
        defaultPort: 21
      },
      {
        label: '$(lock) FTPS',
        description: 'FTP over SSL/TLS - Secure with certificates',
        protocol: 'ftps',
        icon: '$(shield)',
        defaultPort: 21
      }
    ];

    const selected = await vscode.window.showQuickPick(protocols, {
      title: 'Select Connection Protocol',
      placeHolder: 'Choose the protocol for your connection',
      ignoreFocusOut: true
    });

    if (!selected) return false;

    this.config.protocol = selected.protocol;
    this.config.port = selected.defaultPort;
    this.config.secure = selected.protocol === 'ftps';

    return true;
  }

  private async enterName(): Promise<boolean> {
    const name = await vscode.window.showInputBox({
      title: 'Connection Name',
      placeHolder: 'My Server',
      prompt: 'Enter a friendly name for this connection',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Connection name is required';
        }
        return null;
      }
    });

    if (!name) return false;
    this.config.name = name.trim();
    return true;
  }

  private async enterHost(): Promise<boolean> {
    const host = await vscode.window.showInputBox({
      title: 'Server Host',
      placeHolder: 'example.com or 192.168.1.100',
      prompt: 'Enter the server hostname or IP address',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Host is required';
        }
        return null;
      }
    });

    if (!host) return false;
    this.config.host = host.trim();
    return true;
  }

  private async enterPort(): Promise<boolean> {
    const defaultPort = this.config.port || 22;

    const port = await vscode.window.showInputBox({
      title: 'Port',
      value: String(defaultPort),
      prompt: `Enter the port number (default: ${defaultPort})`,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value) return null; // Use default
        const num = parseInt(value);
        if (isNaN(num) || num < 1 || num > 65535) {
          return 'Please enter a valid port number (1-65535)';
        }
        return null;
      }
    });

    if (port === undefined) return false;
    this.config.port = port ? parseInt(port) : defaultPort;
    return true;
  }

  private async enterUsername(): Promise<boolean> {
    const username = await vscode.window.showInputBox({
      title: 'Username',
      placeHolder: 'root, admin, or your username',
      prompt: 'Enter your username for authentication',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Username is required';
        }
        return null;
      }
    });

    if (!username) return false;
    this.config.username = username.trim();
    return true;
  }

  private async selectAuth(): Promise<boolean> {
    const isSFTP = this.config.protocol === 'sftp';

    const authOptions: { label: string; description: string; type: 'password' | 'key' }[] = [
      {
        label: '$(key) Password',
        description: 'Authenticate using a password',
        type: 'password'
      }
    ];

    if (isSFTP) {
      authOptions.push({
        label: '$(file-code) Private Key',
        description: 'Authenticate using SSH private key',
        type: 'key'
      });
    }

    const selected = await vscode.window.showQuickPick(authOptions, {
      title: 'Select Authentication Method',
      placeHolder: 'How would you like to authenticate?',
      ignoreFocusOut: true
    });

    if (!selected) return false;

    if (selected.type === 'password') {
      const password = await vscode.window.showInputBox({
        title: 'Password',
        prompt: 'Enter your password (optional - can be entered later)',
        password: true,
        ignoreFocusOut: true
      });

      if (password !== undefined) {
        this.config.password = password;
      }
    } else {
      // Private key authentication
      const keyPath = await vscode.window.showOpenDialog({
        title: 'Select Private Key File',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          'Key Files': ['pem', 'key', 'ppk'],
          'All Files': ['*']
        }
      });

      if (!keyPath || keyPath.length === 0) return false;

      this.config.privateKeyPath = keyPath[0].fsPath;

      // Ask for passphrase if needed
      const hasPassphrase = await vscode.window.showQuickPick(
        ['Yes', 'No'],
        {
          title: 'Does your key have a passphrase?',
          placeHolder: 'Select Yes if your private key is encrypted'
        }
      );

      if (hasPassphrase === 'Yes') {
        const passphrase = await vscode.window.showInputBox({
          title: 'Passphrase',
          prompt: 'Enter the passphrase for your private key',
          password: true,
          ignoreFocusOut: true
        });

        if (passphrase !== undefined) {
          this.config.passphrase = passphrase;
        }
      }
    }

    return true;
  }

  private async enterRemotePath(): Promise<boolean> {
    const defaultPaths: Record<Protocol, string> = {
      'sftp': '/home/' + (this.config.username || 'user'),
      'ftp': '/public_html',
      'ftps': '/public_html'
    };

    const remotePath = await vscode.window.showInputBox({
      title: 'Remote Path',
      value: defaultPaths[this.config.protocol!],
      placeHolder: '/var/www/html',
      prompt: 'Enter the remote directory path',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Remote path is required';
        }
        if (!value.startsWith('/')) {
          return 'Remote path should start with /';
        }
        return null;
      }
    });

    if (!remotePath) return false;
    this.config.remotePath = remotePath.trim();
    return true;
  }

  private async configureOptions(): Promise<boolean> {
    const options: { label: string; picked?: boolean; config: Partial<FTPConfig> }[] = [
      {
        label: '$(sync) Upload on Save',
        picked: false,
        config: { uploadOnSave: true }
      },
      {
        label: '$(eye-closed) Ignore Common Files',
        picked: true,
        config: {
          ignore: ['.git', '.DS_Store', 'node_modules', '*.log', '.vscode']
        }
      },
      {
        label: '$(globe) Passive Mode (FTP/FTPS only)',
        picked: true,
        config: { passive: true }
      },
      {
        label: '$(repo-forked) Connection Hopping (Jump Host)',
        picked: false,
        config: { hop: undefined }
      }
    ];

    const selected = await vscode.window.showQuickPick(options, {
      title: 'Additional Options',
      placeHolder: 'Select options (can be changed later)',
      canPickMany: true,
      ignoreFocusOut: true
    });

    if (selected === undefined) return false;

    // Apply selected options
    for (const option of selected) {
      if (option.label.includes('Connection Hopping')) {
        // Configure hop separately
        const hopConfig = await ConnectionHopping.configureHopping();
        if (hopConfig) {
          this.config.hop = hopConfig;
        }
      } else {
        Object.assign(this.config, option.config);
      }
    }

    return true;
  }

  // Static method to quickly add a new connection
  static async createNewConnection(workspaceRoot: string): Promise<void> {
    const wizard = new ConnectionWizard(workspaceRoot);
    const config = await wizard.start();

    if (!config) {
      statusBar.success('Connection creation cancelled');
      return;
    }

    try {
      // Load existing configs
      const configs = configManager.getConfigs(workspaceRoot);

      // Add new config
      configs.push(config);

      // Save
      await configManager.saveConfig(workspaceRoot, configs);

      // Open config file for review
      const configPath = configManager.getConfigPath(workspaceRoot);
      const doc = await vscode.workspace.openTextDocument(configPath);
      await vscode.window.showTextDocument(doc);

      vscode.window.showInformationMessage(
        `Connection "${config.name}" created successfully!`,
        'Connect Now'
      ).then(action => {
        if (action === 'Connect Now') {
          vscode.commands.executeCommand('stackerftp.connect');
        }
      });

      logger.info(`New ${config.protocol.toUpperCase()} connection created: ${config.name}`);
    } catch (error: any) {
      statusBar.error(`Failed to save configuration: ${error.message}`);
      logger.error('Failed to save new connection', error);
    }
  }

  // Quick protocol switcher
  static async switchProtocol(workspaceRoot: string): Promise<void> {
    const configs = configManager.getConfigs(workspaceRoot);
    if (configs.length === 0) {
      statusBar.warn('No connections configured');
      return;
    }

    // Select connection to modify
    const selectedConfig = await vscode.window.showQuickPick(
      configs.map(c => ({
        label: `$(server) ${c.name || c.host}`,
        description: `${c.protocol.toUpperCase()}://${c.host}:${c.port}`,
        config: c
      })),
      {
        title: 'Select Connection to Modify',
        placeHolder: 'Choose a connection to change its protocol'
      }
    );

    if (!selectedConfig) return;

    // Select new protocol
    const protocols: { label: string; protocol: Protocol; port: number }[] = [
      { label: '$(cloud) SFTP (SSH)', protocol: 'sftp', port: 22 },
      { label: '$(folder-opened) FTP (Unencrypted)', protocol: 'ftp', port: 21 },
      { label: '$(lock) FTPS (FTP over SSL)', protocol: 'ftps', port: 21 }
    ];

    const newProtocol = await vscode.window.showQuickPick(
      protocols.map(p => ({
        ...p,
        description: p.protocol === selectedConfig.config.protocol ? '(current)' : ''
      })),
      {
        title: 'Select New Protocol',
        placeHolder: 'Choose the new protocol'
      }
    );

    if (!newProtocol || newProtocol.protocol === selectedConfig.config.protocol) {
      return;
    }

    // Update config
    const configIndex = configs.findIndex(c =>
      (c.name || c.host) === (selectedConfig.config.name || selectedConfig.config.host)
    );

    if (configIndex >= 0) {
      configs[configIndex].protocol = newProtocol.protocol;
      configs[configIndex].port = newProtocol.port;
      configs[configIndex].secure = newProtocol.protocol === 'ftps';

      await configManager.saveConfig(workspaceRoot, configs);

      statusBar.success(`Protocol changed to ${newProtocol.protocol.toUpperCase()}`);

      logger.info(`Protocol switched for ${selectedConfig.config.name}: ${newProtocol.protocol}`);
    }
  }
}
