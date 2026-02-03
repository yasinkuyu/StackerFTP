/**
 * StackerFTP - Connection Manager
 */

import * as vscode from 'vscode';
import { BaseConnection } from './connection';
import { SFTPConnection } from './sftp-connection';
import { FTPConnection } from './ftp-connection';
import { FTPConfig, ConnectionStatus } from '../types';
import { logger } from '../utils/logger';

export class ConnectionManager {
  private static instance: ConnectionManager;
  private connections: Map<string, BaseConnection> = new Map();
  private statusBarItem: vscode.StatusBarItem;
  private activeConnectionKey: string | undefined;

  private constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = 'stackerftp.connect';
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
    return `${config.host}:${port}-${config.username}`;
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

  getAllActiveConnections(): Array<{ connection: BaseConnection; config: FTPConfig }> {
    const result: Array<{ connection: BaseConnection; config: FTPConfig }> = [];
    logger.info(`getAllActiveConnections - checking ${this.connections.size} connections`);
    for (const [key, conn] of this.connections.entries()) {
      logger.info(`  Connection ${key}: connected=${conn.connected}`);
      if (conn.connected) {
        result.push({ connection: conn, config: conn.getConfig() });
      }
    }
    logger.info(`getAllActiveConnections - returning ${result.length} active connections`);
    return result;
  }

  private updateStatusBar(connected = false, host?: string): void {
    if (connected && host) {
      this.statusBarItem.text = `$(cloud-upload) SFTP: ${host}`;
      this.statusBarItem.tooltip = `Connected to ${host}`;
      this.statusBarItem.show();
    } else {
      this.statusBarItem.text = `$(cloud) SFTP: Disconnected`;
      this.statusBarItem.tooltip = 'Click to connect';
      this.statusBarItem.show();
    }
  }

  async connect(config: FTPConfig): Promise<BaseConnection> {
    const key = this.getConnectionKey(config);

    // Check if already connected
    const existing = this.connections.get(key);
    if (existing && existing.connected) {
      logger.info(`Already connected to ${config.host}`);
      return existing;
    }

    // Create new connection based on protocol
    let connection: BaseConnection;

    switch (config.protocol) {
      case 'sftp':
        connection = new SFTPConnection(config);
        break;
      case 'ftp':
      case 'ftps':
        connection = new FTPConnection(config);
        break;
      default:
        throw new Error(`Unsupported protocol: ${config.protocol}`);
    }

    // Set up event handlers
    connection.on('connected', () => {
      const displayName = config.name || config.host;
      logger.info(`Connected to ${displayName}`);
      this.updateStatusBar(true, config.host);
    });

    connection.on('disconnected', () => {
      logger.info(`Disconnected from ${config.host}`);
      this.updateStatusBar(false);
    });

    connection.on('error', (error) => {
      logger.error(`Connection error on ${config.host}`, error);
      vscode.window.showErrorMessage(`StackerFTP Error: ${error.message}`);
    });

    // Connect
    await connection.connect();
    this.connections.set(key, connection);
    this.activeConnectionKey = key;

    return connection;
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
      }
    } else {
      // Disconnect all
      for (const [key, connection] of this.connections) {
        await connection.disconnect();
      }
      this.connections.clear();
      this.activeConnectionKey = undefined;
    }
    this.updateStatusBar(false);
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
