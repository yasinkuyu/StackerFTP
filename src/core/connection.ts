/**
 * StackerFTP - Base Connection Interface
 */

import { EventEmitter } from 'events';
import { FileEntry, FTPConfig, ConnectionStatus, FilePermissions } from '../types';

export interface TransferProgress {
  filename: string;
  transferred: number;
  total: number;
  percentage: number;
}

export type ConnectionEvent = 
  | 'connected' 
  | 'disconnected' 
  | 'error' 
  | 'progress'
  | 'transferStart'
  | 'transferComplete';

// Operation queue item
interface QueueItem<T> {
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export abstract class BaseConnection extends EventEmitter {
  protected config: FTPConfig;
  protected _connected = false;
  protected _currentPath = '';
  
  // Operation queue for sequential execution
  private operationQueue: QueueItem<unknown>[] = [];
  private isProcessingQueue = false;

  constructor(config: FTPConfig) {
    super();
    this.config = config;
    this._currentPath = config.remotePath;
  }
  
  /**
   * Execute operation in queue to prevent concurrent access
   */
  protected async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.operationQueue.push({
        operation,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.processQueue();
    });
  }
  
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      return;
    }
    
    this.isProcessingQueue = true;
    
    while (this.operationQueue.length > 0) {
      const item = this.operationQueue.shift();
      if (item) {
        try {
          const result = await item.operation();
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      }
    }
    
    this.isProcessingQueue = false;
  }

  get connected(): boolean {
    return this._connected;
  }

  get currentPath(): string {
    return this._currentPath;
  }

  getConfig(): FTPConfig {
    return this.config;
  }

  getStatus(): ConnectionStatus {
    return {
      connected: this._connected,
      host: this.config.host,
      protocol: this.config.protocol,
      currentPath: this._currentPath
    };
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract list(remotePath: string): Promise<FileEntry[]>;
  abstract download(remotePath: string, localPath: string): Promise<void>;
  abstract upload(localPath: string, remotePath: string): Promise<void>;
  abstract delete(remotePath: string): Promise<void>;
  abstract mkdir(remotePath: string): Promise<void>;
  abstract rmdir(remotePath: string, recursive?: boolean): Promise<void>;
  abstract rename(oldPath: string, newPath: string): Promise<void>;
  abstract exists(remotePath: string): Promise<boolean>;
  abstract stat(remotePath: string): Promise<FileEntry | null>;
  abstract chmod(remotePath: string, mode: number | string): Promise<void>;
  abstract readFile(remotePath: string): Promise<Buffer>;
  abstract writeFile(remotePath: string, content: Buffer | string): Promise<void>;
  abstract exec(command: string): Promise<{ stdout: string; stderr: string; code: number }>;

  protected emitProgress(filename: string, transferred: number, total: number): void {
    const percentage = total > 0 ? Math.round((transferred / total) * 100) : 0;
    this.emit('progress', { filename, transferred, total, percentage });
  }
}
