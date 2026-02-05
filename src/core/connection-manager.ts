/**
 * StackerFTP - Connection Manager
 */

import * as vscode from 'vscode';
import { BaseConnection } from './connection';
import { SFTPConnection } from './sftp-connection';
import { FTPConnection } from './ftp-connection';
import { FTPConfig, ConnectionStatus } from '../types';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';

export class ConnectionManager {
  private static instance: ConnectionManager;
  private connections: Map<string, BaseConnection> = new Map();
  private statusBarItem: vscode.StatusBarItem;
  private activeConnectionKey: string | undefined;
  private primaryConnectionKey: string | undefined;

  private _onConnectionChanged: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onConnectionChanged: vscode.Event<void> = this._onConnectionChanged.event;

  private constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = 'stackerftp.selectPrimaryConnection';
    this.updateStatusBar();
  }

  static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager();
    }
    return ConnectionManager.instance;
  }

  private getConnectionKey(config: FTPConfig): string {
    const port = config.port || (config.protocol === 'sftp' ? 22 : 21);
    return `${config.name || config.host}:${port}-${config.username}`;
  }

  getActiveConnection(): BaseConnection | undefined {
    if (!this.activeConnectionKey) return undefined;
    const conn = this.connections.get(this.activeConnectionKey);
    return conn?.connected ? conn : undefined;
  }

  getActiveConfig(): FTPConfig | undefined {
    const conn = this.getActiveConnection();
    return conn?.getConfig();
  }

  // Primary connection - used for file explorer uploads
  getPrimaryConnection(): BaseConnection | undefined {
    if (this.primaryConnectionKey) {
      const conn = this.connections.get(this.primaryConnectionKey);
      if (conn?.connected) return conn;
    }
    // Fallback to first active connection
    const activeConns = this.getAllActiveConnections();
    return activeConns.length > 0 ? activeConns[0].connection : undefined;
  }

  getPrimaryConfig(): FTPConfig | undefined {
    const conn = this.getPrimaryConnection();
    return conn?.getConfig();
  }

  setPrimaryConnection(config: FTPConfig): void {
    const key = this.getConnectionKey(config);
    const conn = this.connections.get(key);
    if (conn?.connected) {
      this.primaryConnectionKey = key;
      this.updateStatusBar();
      statusBar.success(`Primary: ${config.name || config.host}`);
    }
  }

  getAllActiveConnections(): Array<{ connection: BaseConnection; config: FTPConfig }> {
    const result: Array<{ connection: BaseConnection; config: FTPConfig }> = [];
    for (const [key, conn] of this.connections.entries()) {
      if (conn.connected) {
        result.push({ connection: conn, config: conn.getConfig() });
      }
    }
    return result;
  }

  private updateStatusBar(): void {
    const activeConns = this.getAllActiveConnections();

    if (activeConns.length === 0) {
      this.statusBarItem.text = `$(cloud) StackerFTP`;
      this.statusBarItem.tooltip = 'Click to select connection';
      this.statusBarItem.show();
      return;
    }

    if (activeConns.length === 1) {
      const config = activeConns[0].config;
      const name = config.name || config.host;
      this.statusBarItem.text = `$(cloud-upload) ${name}`;
      this.statusBarItem.tooltip = `Connected to ${name}\nClick to manage connections`;
      this.statusBarItem.show();
      return;
    }

    // Multiple connections
    const primaryConn = this.getPrimaryConnection();
    const primaryConfig = primaryConn?.getConfig();
    const primaryName = primaryConfig?.name || primaryConfig?.host || 'None';

    this.statusBarItem.text = `$(cloud-upload) ${primaryName} (+${activeConns.length - 1})`;
    this.statusBarItem.tooltip = `Primary: ${primaryName}\n${activeConns.length} connections active\nClick to change primary`;
    this.statusBarItem.show();
  }

  // Select target connection for upload/download when multiple are active
  async selectConnectionForTransfer(operation: 'upload' | 'download'): Promise<{ connection: BaseConnection; config: FTPConfig } | undefined> {
    const activeConns = this.getAllActiveConnections();

    if (activeConns.length === 0) {
      statusBar.warn('No active connections. Please connect first.');
      return undefined;
    }

    if (activeConns.length === 1) {
      return activeConns[0];
    }

    // Multiple connections - ask user
    const items = activeConns.map(({ config }) => ({
      label: config.name || config.host,
      description: `${config.protocol?.toUpperCase()} • ${config.username}@${config.host}`,
      config
    }));

    // Add "Primary" indicator
    const primaryConfig = this.getPrimaryConfig();
    if (primaryConfig) {
      const primaryItem = items.find(i =>
        i.config.name === primaryConfig.name && i.config.host === primaryConfig.host
      );
      if (primaryItem) {
        primaryItem.label = `$(star-full) ${primaryItem.label} (Primary)`;
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Select connection for ${operation}`,
      title: `${operation === 'upload' ? 'Upload' : 'Download'} - Select Target`
    });

    if (!selected) return undefined;

    const conn = activeConns.find(c =>
      c.config.name === selected.config.name && c.config.host === selected.config.host
    );
    return conn;
  }

  async connect(config: FTPConfig): Promise<BaseConnection> {
    const key = this.getConnectionKey(config);
    const displayName = config.name || config.host;

    // Check if already connected
    const existing = this.connections.get(key);
    if (existing && existing.connected) {
      logger.info(`Already connected to ${config.host}`);
      statusBar.info(`Already connected: ${displayName}`);
      return existing;
    }

    // If no password and no private key, prompt for password
    let workingConfig = { ...config };
    if (!workingConfig.password && !workingConfig.privateKeyPath) {
      const password = await vscode.window.showInputBox({
        prompt: `Enter password for ${workingConfig.username}@${workingConfig.host}`,
        password: true,
        ignoreFocusOut: true
      });

      if (password === undefined) {
        throw new Error('Connection cancelled - no password provided');
      }

      workingConfig.password = password;
    }

    // Show connecting status
    const progress = statusBar.startProgress('connect', `Connecting to ${displayName}...`);

    // Create new connection based on protocol
    let connection: BaseConnection;

    switch (workingConfig.protocol) {
      case 'sftp':
        connection = new SFTPConnection(workingConfig);
        break;
      case 'ftp':
      case 'ftps':
        connection = new FTPConnection(workingConfig);
        break;
      default:
        progress.fail(`Unsupported protocol: ${workingConfig.protocol}`);
        throw new Error(`Unsupported protocol: ${workingConfig.protocol}`);
    }

    // Set up event handlers
    connection.on('connected', () => {
      logger.info(`Connected to ${displayName}`);
      progress.complete(`Connected: ${displayName}`);
      // Set as primary if first connection
      if (!this.primaryConnectionKey) {
        this.primaryConnectionKey = key;
      }
      this.updateStatusBar();
      this._onConnectionChanged.fire();
    });

    connection.on('disconnected', () => {
      logger.info(`Disconnected from ${config.host}`);
      statusBar.info(`Disconnected: ${displayName}`);
      // Clear primary if this was it
      if (this.primaryConnectionKey === key) {
        this.primaryConnectionKey = undefined;
      }
      this.updateStatusBar();
      this._onConnectionChanged.fire();
    });

    connection.on('error', (error) => {
      logger.error(`Connection error on ${config.host}`, error);
      statusBar.error(`Error: ${error.message}`, true);
    });

    // Connect
    try {
      await connection.connect();
      this.connections.set(key, connection);
      this.activeConnectionKey = key;
      return connection;
    } catch (error: any) {
      progress.fail(`Connection failed: ${displayName}`);
      throw error;
    }
  }

  async disconnect(config?: FTPConfig): Promise<void> {
    if (config) {
      const key = this.getConnectionKey(config);
      const connection = this.connections.get(key);
      if (connection) {
        await connection.disconnect();
        this.connections.delete(key);
        if (this.activeConnectionKey === key) {
          this.activeConnectionKey = undefined;
        }
        if (this.primaryConnectionKey === key) {
          this.primaryConnectionKey = undefined;
        }
      }
    } else {
      // Disconnect all
      for (const [key, connection] of this.connections) {
        await connection.disconnect();
      }
      this.connections.clear();
      this.activeConnectionKey = undefined;
      this.primaryConnectionKey = undefined;
    }
    this.updateStatusBar();
    this._onConnectionChanged.fire();
  }

  getConnection(config: FTPConfig): BaseConnection | undefined {
    const key = this.getConnectionKey(config);
    return this.connections.get(key);
  }

  isConnected(config: FTPConfig): boolean {
    const key = this.getConnectionKey(config);
    const connection = this.connections.get(key);
    return connection ? connection.connected : false;
  }

  getActiveConnections(): BaseConnection[] {
    return Array.from(this.connections.values()).filter(c => c.connected);
  }

  getStatus(config: FTPConfig): ConnectionStatus {
    const connection = this.getConnection(config);
    if (connection) {
      return connection.getStatus();
    }
    return { connected: false };
  }

  async ensureConnection(config: FTPConfig): Promise<BaseConnection> {
    const connection = this.getConnection(config);
    if (connection && connection.connected) {
      return connection;
    }
    return this.connect(config);
  }

  dispose(): void {
    this.disconnect().catch(err => logger.error('Error disconnecting', err));
    this.statusBarItem.dispose();
  }
}

export const connectionManager = ConnectionManager.getInstance();
