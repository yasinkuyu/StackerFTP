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
import { connectionPool } from './connection-pool';

export class ConnectionManager {
  private static instance: ConnectionManager;
  private connections: Map<string, BaseConnection> = new Map();
  private statusBarItem: vscode.StatusBarItem;
  private activeConnectionKey: string | undefined;
  private primaryConnectionKey: string | undefined;
  private manualDisconnects: Set<string> = new Set();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private ongoingConnections: Map<string, Promise<BaseConnection>> = new Map();

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

    // Check if there is an ongoing connection attempt for this key
    const ongoing = this.ongoingConnections.get(key);
    if (ongoing) {
      return ongoing;
    }

    // Use a promise to track this connection attempt
    const connectionPromise = (async () => {
      try {
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
          this.manualDisconnects.delete(key);
          this.clearReconnectState(key);
          this.updateStatusBar();
          this._onConnectionChanged.fire();
        });

        connection.on('disconnected', () => {
          logger.info(`Disconnected from ${config.host}`);
          statusBar.info(`Disconnected: ${displayName}`);
          // Auto-reconnect if enabled and not a manual disconnect
          if (!this.manualDisconnects.has(key)) {
            this.scheduleReconnect(config, key);
          } else {
            this.manualDisconnects.delete(key);
          }
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
      } finally {
        // Remove from ongoing connections map either way
        this.ongoingConnections.delete(key);
      }
    })();

    this.ongoingConnections.set(key, connectionPromise);
    return connectionPromise;
  }

  async disconnect(config?: FTPConfig): Promise<void> {
    if (config) {
      const key = this.getConnectionKey(config);
      const connection = this.connections.get(key);
      if (connection) {
        this.manualDisconnects.add(key);
        this.clearReconnectState(key);
        await connectionPool.drain(config);
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
      await connectionPool.drainAll();
      for (const [key, connection] of this.connections) {
        this.manualDisconnects.add(key);
        this.clearReconnectState(key);
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

  private scheduleReconnect(config: FTPConfig, key: string): void {
    if (config.autoReconnect === false) return;

    // Avoid auto reconnect if no credentials are available
    if (!config.password && !config.privateKeyPath) {
      logger.warn(`Auto-reconnect skipped for ${config.host}: no stored credentials`);
      return;
    }

    if (this.reconnectTimers.has(key)) return;

    const attempt = (this.reconnectAttempts.get(key) || 0) + 1;
    this.reconnectAttempts.set(key, attempt);

    const delay = Math.min(30000, 2000 * attempt);
    logger.info(`Scheduling reconnect to ${config.host} in ${delay}ms (attempt ${attempt})`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(key);
      try {
        const existing = this.getConnection(config);
        if (existing && existing.connected) {
          this.clearReconnectState(key);
          return;
        }
        await this.connect(config);
      } catch (error) {
        logger.warn(`Reconnect attempt ${attempt} failed for ${config.host}`, error);
        this.scheduleReconnect(config, key);
      }
    }, delay);

    this.reconnectTimers.set(key, timer);
  }

  private clearReconnectState(key: string): void {
    const timer = this.reconnectTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(key);
    }
    this.reconnectAttempts.delete(key);
  }

  /**
   * Acquire a pooled connection for parallel transfers.
   * Falls back to the primary connection if pool creation fails.
   */
  async getPooledConnection(config: FTPConfig): Promise<BaseConnection> {
    // Ensure primary connection exists first
    const primary = this.getConnection(config);
    if (!primary || !primary.connected) {
      throw new Error(`No active connection for ${config.host}`);
    }

    return await connectionPool.acquire(config);
  }

  /**
   * Release a pooled connection back to the pool.
   */
  releasePooledConnection(config: FTPConfig, connection: BaseConnection): void {
    connectionPool.release(config, connection);
  }

  dispose(): void {
    connectionPool.dispose();
    this.disconnect().catch(err => logger.error('Error disconnecting', err));
    this.statusBarItem.dispose();
  }
}

export const connectionManager = ConnectionManager.getInstance();
