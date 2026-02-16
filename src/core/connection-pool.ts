/**
 * StackerFTP - Connection Pool
 *
 * Manages a pool of connections per server for parallel transfers.
 * Primary connection (used by explorer/stat) remains separate.
 */

import { BaseConnection } from './connection';
import { SFTPConnection } from './sftp-connection';
import { FTPConnection } from './ftp-connection';
import { FTPConfig } from '../types';
import { logger } from '../utils/logger';

interface PoolEntry {
  connection: BaseConnection;
  inUse: boolean;
  lastUsed: number;
}

interface ServerPool {
  entries: PoolEntry[];
  config: FTPConfig;
}

const IDLE_TIMEOUT_MS = 60_000;
const MAX_POOL_SIZE = 5;

export class ConnectionPool {
  private pools: Map<string, ServerPool> = new Map();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startIdleCleanup();
  }

  private getKey(config: FTPConfig): string {
    const port = config.port || (config.protocol === 'sftp' ? 22 : 21);
    return `${config.name || config.host}:${port}-${config.username}`;
  }

  private createConnection(config: FTPConfig): BaseConnection {
    switch (config.protocol) {
      case 'sftp':
        return new SFTPConnection(config);
      case 'ftp':
      case 'ftps':
        return new FTPConnection(config);
      default:
        throw new Error(`Unsupported protocol: ${config.protocol}`);
    }
  }

  /**
   * Acquire a pooled connection for transfers.
   * Returns an existing idle connection or creates a new one up to poolSize.
   */
  async acquire(config: FTPConfig, poolSize?: number): Promise<BaseConnection> {
    const key = this.getKey(config);
    const maxSize = Math.min(poolSize || MAX_POOL_SIZE, MAX_POOL_SIZE);

    let pool = this.pools.get(key);
    if (!pool) {
      pool = { entries: [], config };
      this.pools.set(key, pool);
    }

    // Try to find an idle connection
    for (const entry of pool.entries) {
      if (!entry.inUse && entry.connection.connected) {
        entry.inUse = true;
        entry.lastUsed = Date.now();
        logger.debug(`Pool: reusing connection for ${config.host} (${pool.entries.length} in pool)`);
        return entry.connection;
      }
    }

    // Remove disconnected entries
    pool.entries = pool.entries.filter(e => e.connection.connected || e.inUse);

    // Create new connection if under limit
    if (pool.entries.length < maxSize) {
      const connection = this.createConnection(config);
      try {
        await connection.connect();
        const entry: PoolEntry = {
          connection,
          inUse: true,
          lastUsed: Date.now()
        };
        pool.entries.push(entry);
        logger.debug(`Pool: new connection for ${config.host} (${pool.entries.length}/${maxSize})`);
        return connection;
      } catch (error) {
        logger.error(`Pool: failed to create connection for ${config.host}`, error);
        throw error;
      }
    }

    // All connections busy - wait for one to become available
    logger.debug(`Pool: all ${maxSize} connections busy for ${config.host}, waiting...`);
    return this.waitForAvailable(pool, config);
  }

  /**
   * Release a connection back to the pool.
   */
  release(config: FTPConfig, connection: BaseConnection): void {
    const key = this.getKey(config);
    const pool = this.pools.get(key);
    if (!pool) return;

    for (let i = 0; i < pool.entries.length; i++) {
      const entry = pool.entries[i];
      if (entry.connection === connection) {
        if (!connection.connected) {
          // Dead connection - remove from pool immediately
          pool.entries.splice(i, 1);
          logger.debug(`Pool: removed dead connection for ${config.host}`);
        } else {
          entry.inUse = false;
          entry.lastUsed = Date.now();
          logger.debug(`Pool: released connection for ${config.host}`);
        }
        return;
      }
    }
  }

  /**
   * Drain all pooled connections for a server (used on disconnect).
   */
  async drain(config: FTPConfig): Promise<void> {
    const key = this.getKey(config);
    const pool = this.pools.get(key);
    if (!pool) return;

    const disconnectPromises = pool.entries.map(async (entry) => {
      try {
        if (entry.connection.connected) {
          await entry.connection.disconnect();
        }
      } catch (error) {
        logger.debug(`Pool: error draining connection for ${config.host}`, error);
      }
    });

    await Promise.all(disconnectPromises);
    this.pools.delete(key);
    logger.debug(`Pool: drained all connections for ${config.host}`);
  }

  /**
   * Drain all pools (used on full disconnect).
   */
  async drainAll(): Promise<void> {
    const drainPromises: Promise<void>[] = [];
    for (const [, pool] of this.pools) {
      drainPromises.push(this.drain(pool.config));
    }
    await Promise.all(drainPromises);
  }

  private waitForAvailable(pool: ServerPool, config: FTPConfig): Promise<BaseConnection> {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        for (const entry of pool.entries) {
          if (!entry.inUse && entry.connection.connected) {
            clearInterval(checkInterval);
            clearTimeout(timeoutId);
            entry.inUse = true;
            entry.lastUsed = Date.now();
            resolve(entry.connection);
            return;
          }
        }
      }, 50);

      // Timeout after 30s
      const timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error(`Pool: timeout waiting for available connection to ${config.host}`));
      }, 30_000);
    });
  }

  private startIdleCleanup(): void {
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [, pool] of this.pools) {
        // Keep at least one idle connection, close the rest if idle too long
        const idleEntries = pool.entries.filter(e => !e.inUse && e.connection.connected);
        if (idleEntries.length <= 1) continue;

        for (let i = 1; i < idleEntries.length; i++) {
          const entry = idleEntries[i];
          if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
            entry.connection.disconnect().catch(() => {});
            const idx = pool.entries.indexOf(entry);
            if (idx !== -1) pool.entries.splice(idx, 1);
            logger.debug(`Pool: closed idle connection for ${pool.config.host}`);
          }
        }
      }
    }, 30_000);
  }

  dispose(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.drainAll().catch(() => {});
  }
}

export const connectionPool = new ConnectionPool();
