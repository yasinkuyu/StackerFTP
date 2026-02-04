/**
 * StackerFTP - SFTP Connection Implementation
 */

import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'ssh2';
import { BaseConnection } from './connection';
import { FileEntry, FTPConfig } from '../types';
import { logger } from '../utils/logger';
import { normalizeRemotePath } from '../utils/helpers';

export class SFTPConnection extends BaseConnection {
  private client: Client | null = null;
  private sftp: any = null;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client = new Client();
      
      const connectConfig: any = {
        host: this.config.host,
        port: this.config.port || 22,
        username: this.config.username,
        readyTimeout: this.config.connTimeout || 20000,
        keepaliveInterval: this.config.keepalive || 10000
      };

      if (this.config.privateKeyPath) {
        try {
          connectConfig.privateKey = fs.readFileSync(this.config.privateKeyPath);
          if (this.config.passphrase) {
            connectConfig.passphrase = this.config.passphrase;
          }
        } catch (error) {
          reject(new Error(`Failed to load private key: ${error}`));
          return;
        }
      } else if (this.config.password) {
        connectConfig.password = this.config.password;
      }

      this.client.on('ready', () => {
        logger.info(`SSH connected to ${this.config.host}:${this.config.port}`);
        
        this.client!.sftp((err, sftp) => {
          if (err) {
            reject(err);
            return;
          }
          
          this.sftp = sftp;
          this._connected = true;
          this.emit('connected');
          resolve();
        });
      });

      this.client.on('error', (err) => {
        logger.error('SSH connection error', err);
        this.emit('error', err);
        reject(err);
      });

      this.client.on('close', () => {
        logger.info('SSH connection closed');
        this._connected = false;
        this.sftp = null;
        this.emit('disconnected');
      });

      this.client.connect(connectConfig);
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.end();
      this.client = null;
      this.sftp = null;
      this._connected = false;
    }
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    return this.enqueue(() => this._list(remotePath));
  }

  private _list(remotePath: string): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      if (!this.sftp) {
        reject(new Error('Not connected'));
        return;
      }

      this.sftp.readdir(remotePath, async (err: any, list: any[]) => {
        if (err) {
          reject(err);
          return;
        }

        const entries: FileEntry[] = [];
        
        for (const item of list) {
          try {
            const attrs = item.attrs;
            const isSymlink = attrs.isSymbolicLink();
            const entryPath = normalizeRemotePath(path.join(remotePath, item.filename));
            
            let type: 'file' | 'directory' | 'symlink' = 'file';
            let isSymlinkToDirectory = false;
            
            if (attrs.isDirectory()) {
              type = 'directory';
            } else if (isSymlink) {
              type = 'symlink';
              // For symlinks, try to determine if they point to a directory
              try {
                const targetStat = await this._statFollowLink(entryPath);
                if (targetStat && targetStat.type === 'directory') {
                  isSymlinkToDirectory = true;
                }
              } catch {
                // If we can't stat the target, treat as file
              }
            }
            
            entries.push({
              name: item.filename,
              type,
              size: attrs.size || 0,
              modifyTime: new Date((attrs.mtime || 0) * 1000),
              accessTime: new Date((attrs.atime || 0) * 1000),
              rights: {
                user: ((attrs.mode >> 6) & 7).toString(8),
                group: ((attrs.mode >> 3) & 7).toString(8),
                other: (attrs.mode & 7).toString(8)
              },
              owner: attrs.uid,
              group: attrs.gid,
              path: entryPath,
              isSymlinkToDirectory
            });
          } catch (itemErr) {
            // Skip problematic entries
            logger.warn(`Skipping problematic entry: ${item.filename}`, itemErr);
          }
        }

        resolve(entries);
      });
    });
  }

  private _statFollowLink(remotePath: string): Promise<FileEntry | null> {
    return new Promise((resolve) => {
      if (!this.sftp) {
        resolve(null);
        return;
      }

      // Use stat instead of lstat to follow symlinks
      this.sftp.stat(remotePath, (err: any, stats: any) => {
        if (err) {
          resolve(null);
          return;
        }

        resolve({
          name: path.basename(remotePath),
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.size || 0,
          modifyTime: new Date((stats.mtime || 0) * 1000),
          path: remotePath
        });
      });
    });
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    return this.enqueue(() => this._download(remotePath, localPath));
  }

  private _download(remotePath: string, localPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.sftp) {
        reject(new Error('Not connected'));
        return;
      }

      this.emit('transferStart', { direction: 'download', remotePath, localPath });

      // Ensure directory exists
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }

      const readStream = this.sftp.createReadStream(remotePath);
      const writeStream = fs.createWriteStream(localPath);
      
      let transferred = 0;
      
      readStream.on('data', (chunk: string | Buffer) => {
        transferred += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        this.emitProgress(path.basename(remotePath), transferred, 0);
      });

      readStream.on('error', reject);
      writeStream.on('error', reject);
      
      writeStream.on('close', () => {
        this.emit('transferComplete', { direction: 'download', remotePath, localPath });
        resolve();
      });

      readStream.pipe(writeStream);
    });
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    return this.enqueue(() => this._upload(localPath, remotePath));
  }

  private _upload(localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.sftp) {
        reject(new Error('Not connected'));
        return;
      }

      this.emit('transferStart', { direction: 'upload', localPath, remotePath });

      const stats = fs.statSync(localPath);
      const totalSize = stats.size;
      let transferred = 0;

      const readStream = fs.createReadStream(localPath);
      const writeStream = this.sftp.createWriteStream(remotePath);

      readStream.on('data', (chunk: string | Buffer) => {
        transferred += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        this.emitProgress(path.basename(localPath), transferred, totalSize);
      });

      readStream.on('error', reject);
      writeStream.on('error', reject);
      
      writeStream.on('close', () => {
        this.emit('transferComplete', { direction: 'upload', localPath, remotePath });
        resolve();
      });

      readStream.pipe(writeStream);
    });
  }

  async delete(remotePath: string): Promise<void> {
    return this.enqueue(() => this._delete(remotePath));
  }

  private _delete(remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.sftp) {
        reject(new Error('Not connected'));
        return;
      }

      this.sftp.unlink(remotePath, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async mkdir(remotePath: string): Promise<void> {
    return this.enqueue(() => this._mkdir(remotePath));
  }

  private _mkdir(remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.sftp) {
        reject(new Error('Not connected'));
        return;
      }

      this.sftp.mkdir(remotePath, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async rmdir(remotePath: string, recursive = false): Promise<void> {
    return this.enqueue(() => this._rmdir(remotePath, recursive));
  }

  private async _rmdir(remotePath: string, recursive = false): Promise<void> {
    if (!this.sftp || !this.client) {
      throw new Error('Not connected');
    }

    // Safety checks - prevent deletion of critical paths
    const normalizedPath = normalizeRemotePath(remotePath);
    const dangerousPaths = ['/', '/home', '/root', '/var', '/etc', '/usr', '/bin', '/sbin', '/lib', '/opt', '/tmp'];
    
    if (dangerousPaths.includes(normalizedPath) || normalizedPath === '') {
      throw new Error(`Cannot delete critical system path: ${remotePath}`);
    }

    if (recursive) {
      // Use SSH exec with rm -rf for ultra-fast deletion
      // Escape path properly to prevent command injection
      const escapedPath = remotePath.replace(/'/g, "'\\''");
      try {
        await this._execCommand(`rm -rf '${escapedPath}'`);
        return;
      } catch (error) {
        // Fallback to SFTP-based deletion if SSH exec fails
        logger.warn('SSH rm -rf failed, falling back to SFTP deletion', error);
        await this._rmdirFallback(remotePath);
        return;
      }
    }

    return new Promise((resolve, reject) => {
      this.sftp!.rmdir(remotePath, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Execute SSH command for fast operations
  private _execCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('Not connected'));
        return;
      }

      this.client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(new Error(stderr || `Command failed with code ${code}`));
          }
        });
      });
    });
  }

  // Fallback SFTP-based recursive deletion
  private async _rmdirFallback(remotePath: string): Promise<void> {
    const entries = await this._list(remotePath);
    
    // Separate files and directories
    const files = entries.filter(e => e.type !== 'directory');
    const dirs = entries.filter(e => e.type === 'directory');
    
    // Delete files in parallel (batch of 10)
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(batch.map(entry => {
        const entryPath = normalizeRemotePath(path.join(remotePath, entry.name));
        return this._delete(entryPath).catch(() => {});
      }));
    }
    
    // Delete subdirectories in parallel (batch of 5)
    for (let i = 0; i < dirs.length; i += 5) {
      const batch = dirs.slice(i, i + 5);
      await Promise.all(batch.map(entry => {
        const entryPath = normalizeRemotePath(path.join(remotePath, entry.name));
        return this._rmdirFallback(entryPath).catch(() => {});
      }));
    }

    // Finally remove the empty directory
    return new Promise((resolve, reject) => {
      this.sftp!.rmdir(remotePath, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.enqueue(() => this._rename(oldPath, newPath));
  }

  private _rename(oldPath: string, newPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.sftp) {
        reject(new Error('Not connected'));
        return;
      }

      this.sftp.rename(oldPath, newPath, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.stat(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  async stat(remotePath: string): Promise<FileEntry | null> {
    return this.enqueue(() => this._stat(remotePath));
  }

  private _stat(remotePath: string): Promise<FileEntry | null> {
    return new Promise((resolve, reject) => {
      if (!this.sftp) {
        reject(new Error('Not connected'));
        return;
      }

      this.sftp.stat(remotePath, (err: any, stats: any) => {
        if (err) {
          if (err.code === 2) {
            resolve(null);
          } else {
            reject(err);
          }
          return;
        }

        const fileName = path.basename(remotePath);
        resolve({
          name: fileName,
          type: stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file',
          size: stats.size,
          modifyTime: new Date(stats.mtime * 1000),
          accessTime: new Date(stats.atime * 1000),
          rights: {
            user: ((stats.mode >> 6) & 7).toString(8),
            group: ((stats.mode >> 3) & 7).toString(8),
            other: (stats.mode & 7).toString(8)
          },
          owner: stats.uid,
          group: stats.gid,
          path: remotePath
        });
      });
    });
  }

  async chmod(remotePath: string, mode: number | string): Promise<void> {
    return this.enqueue(() => this._chmod(remotePath, mode));
  }

  private _chmod(remotePath: string, mode: number | string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.sftp) {
        reject(new Error('Not connected'));
        return;
      }

      const modeNum = typeof mode === 'string' ? parseInt(mode, 8) : mode;
      
      this.sftp.chmod(remotePath, modeNum, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async readFile(remotePath: string): Promise<Buffer> {
    return this.enqueue(() => this._readFile(remotePath));
  }

  private _readFile(remotePath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.sftp) {
        reject(new Error('Not connected'));
        return;
      }

      this.sftp.readFile(remotePath, (err: any, data: Buffer) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  async writeFile(remotePath: string, content: Buffer | string): Promise<void> {
    return this.enqueue(() => this._writeFile(remotePath, content));
  }

  private _writeFile(remotePath: string, content: Buffer | string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.sftp) {
        reject(new Error('Not connected'));
        return;
      }

      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
      
      this.sftp.writeFile(remotePath, buffer, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.enqueue(() => this._exec(command));
  }

  private _exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('Not connected'));
        return;
      }

      this.client.exec(command, (err: any, stream: any) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code: number) => {
          resolve({ stdout, stderr, code });
        });

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });
  }
}
