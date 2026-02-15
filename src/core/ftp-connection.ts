/**
 * StackerFTP - FTP/FTPS Connection Implementation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { Client, FileInfo } from 'basic-ftp';
import { BaseConnection } from './connection';
import { FileEntry, FTPConfig } from '../types';
import { logger } from '../utils/logger';
import { normalizeRemotePath } from '../utils/helpers';

export class FTPConnection extends BaseConnection {
  private client: Client;

  constructor(config: FTPConfig) {
    super(config);
    this.client = new Client();
    this.client.ftp.verbose = false;
  }

  async connect(): Promise<void> {
    try {
      const secure = this.config.secure === true || this.config.secure === 'implicit';

      await this.client.access({
        host: this.config.host,
        port: this.config.port || 21,
        user: this.config.username,
        password: this.config.password || '',
        secure,
        secureOptions: this.config.secureOptions
      });

      // basic-ftp uses passive mode by default
      // No explicit configuration needed

      this._connected = true;
      this._currentPath = await this.client.pwd();

      logger.info(`FTP${secure ? 'S' : ''} connected to ${this.config.host}:${this.config.port || 21}`);
      this.emit('connected');
    } catch (error) {
      logger.error('FTP connection error', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.client.close();
    this._connected = false;
    this.emit('disconnected');
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    return this.enqueue(async () => {
      try {
        const list = await this.client.list(remotePath);

        const entries: FileEntry[] = [];

        for (const item of list) {
          try {
            // Skip invalid entries
            if (!item.name || item.name === '.' || item.name === '..') {
              continue;
            }

            const user = item.permissions?.user;
            const group = item.permissions?.group;
            const other = item.permissions?.world;
            let type = this.mapFileType(item.type);
            let isSymlinkToDirectory: boolean | undefined = undefined;

            // For symlinks in FTP, try to determine if it's a directory
            // Note: symlink check is done inline to avoid extra queue operations
            if (type === 'symlink') {
              try {
                const symlinkPath = normalizeRemotePath(path.join(remotePath, item.name));
                await this.client.list(symlinkPath);
                isSymlinkToDirectory = true;
              } catch {
                isSymlinkToDirectory = false;
              }
            }

            entries.push({
              name: item.name,
              type,
              size: item.size || 0,
              modifyTime: item.modifiedAt || new Date(),
              rights: {
                user: user !== undefined ? String(user) : '',
                group: group !== undefined ? String(group) : '',
                other: other !== undefined ? String(other) : ''
              },
              path: normalizeRemotePath(path.join(remotePath, item.name)),
              target: item.link || undefined,
              isSymlinkToDirectory
            });
          } catch (itemErr) {
            logger.warn(`Skipping problematic FTP entry: ${item.name}`, itemErr);
          }
        }

        return entries;
      } catch (error) {
        logger.error('FTP list error', error);
        throw error;
      }
    });
  }

  private mapFileType(type: unknown): FileEntry['type'] {
    // basic-ftp uses numeric types: 0 = unknown, 1 = file, 2 = directory, 3 = symlink
    if (typeof type === 'number') {
      switch (type) {
        case 2:
          return 'directory';
        case 3:
          return 'symlink';
        default:
          return 'file';
      }
    }

    switch (type) {
      case 'd':
      case 'directory':
        return 'directory';
      case 'l':
      case 'symlink':
        return 'symlink';
      default:
        return 'file';
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        this.emit('transferStart', { direction: 'download', remotePath, localPath });

        // Ensure directory exists
        const localDir = path.dirname(localPath);
        await fs.promises.mkdir(localDir, { recursive: true });

        // EISDIR safety: check if local path is already a directory
        try {
          const stats = await fs.promises.stat(localPath);
          if (stats.isDirectory()) {
            throw new Error(`Cannot download to ${localPath}: a directory exists at this path.`);
          }
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
        }

        await this.client.downloadTo(localPath, remotePath);

        this.emit('transferComplete', { direction: 'download', remotePath, localPath });
      } catch (error) {
        logger.error('FTP download error', error);
        throw error;
      }
    });
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        this.emit('transferStart', { direction: 'upload', localPath, remotePath });

        // Atomic upload: upload to temp file first, then rename
        // This ensures files are never partially uploaded
        const tempRemotePath = `${remotePath}.stackerftp.tmp`;

        try {
          // Upload to temp file
          await this.client.uploadFrom(localPath, tempRemotePath);

          // Delete existing target file if it exists (rename might fail otherwise)
          try {
            await this.client.remove(remotePath);
          } catch {
            // Target file might not exist - that's OK
          }

          // Rename temp file to target
          await this.client.rename(tempRemotePath, remotePath);
        } catch (uploadError) {
          // Clean up temp file on failure
          try {
            await this.client.remove(tempRemotePath);
          } catch {
            // Ignore cleanup errors
          }
          throw uploadError;
        }

        this.emit('transferComplete', { direction: 'upload', localPath, remotePath });
      } catch (error) {
        logger.error('FTP upload error', error);
        throw error;
      }
    });
  }

  async delete(remotePath: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.client.remove(remotePath);
      } catch (error) {
        logger.error('FTP delete error', error);
        throw error;
      }
    });
  }

  async mkdir(remotePath: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.client.ensureDir(remotePath);
      } catch (error) {
        logger.error('FTP mkdir error', error);
        throw error;
      }
    });
  }

  async rmdir(remotePath: string, recursive = false): Promise<void> {
    return this.enqueue(async () => {
      try {
        // Safety checks - prevent deletion of critical paths
        const normalizedPath = normalizeRemotePath(remotePath);
        const dangerousPaths = ['/', '/home', '/root', '/var', '/etc', '/usr', '/bin', '/sbin', '/lib', '/opt', '/tmp'];

        if (dangerousPaths.includes(normalizedPath) || normalizedPath === '') {
          throw new Error(`Cannot delete critical system path: ${remotePath}`);
        }

        if (recursive) {
          await this.client.removeDir(remotePath);
        } else {
          await this.client.send(`RMD ${remotePath}`);
        }
      } catch (error) {
        logger.error('FTP rmdir error', error);
        throw error;
      }
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.client.rename(oldPath, newPath);
      } catch (error) {
        logger.error('FTP rename error', error);
        throw error;
      }
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        await this.client.size(remotePath);
        return true;
      } catch {
        try {
          await this.client.cd(remotePath);
          return true;
        } catch {
          return false;
        }
      }
    });
  }

  async stat(remotePath: string): Promise<FileEntry | null> {
    return this.enqueue(async () => {
      try {
        const size = await this.client.size(remotePath);
        const fileName = path.basename(remotePath);

        return {
          name: fileName,
          type: 'file',
          size,
          modifyTime: new Date(),
          rights: { user: '', group: '', other: '' },
          path: remotePath
        };
      } catch {
        try {
          await this.client.cd(remotePath);
          return {
            name: path.basename(remotePath),
            type: 'directory',
            size: 0,
            modifyTime: new Date(),
            rights: { user: '', group: '', other: '' },
            path: remotePath
          };
        } catch {
          return null;
        }
      }
    });
  }

  async chmod(remotePath: string, mode: number | string): Promise<void> {
    return this.enqueue(async () => {
      try {
        const modeStr = typeof mode === 'number' ? mode.toString(8) : mode;
        await this.client.send(`SITE CHMOD ${modeStr} ${remotePath}`);
      } catch (error) {
        logger.error('FTP chmod error', error);
        throw error;
      }
    });
  }

  async readFile(remotePath: string): Promise<Buffer> {
    return this.enqueue(async () => {
      const uniqueId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const tempPath = path.join(os.tmpdir(), `stackerftp-${uniqueId}.tmp`);
      try {
        await this.client.downloadTo(tempPath, remotePath);
        return await fs.promises.readFile(tempPath);
      } finally {
        // Her durumda temizle
        try {
          await fs.promises.unlink(tempPath);
        } catch (cleanupError) {
          logger.warn('Failed to cleanup temp file', cleanupError);
        }
      }
    });
  }

  async writeFile(remotePath: string, content: Buffer | string): Promise<void> {
    return this.enqueue(async () => {
      const uniqueId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const tempPath = path.join(os.tmpdir(), `stackerftp-${uniqueId}.tmp`);
      try {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
        await fs.promises.writeFile(tempPath, buffer);
        await this.client.uploadFrom(tempPath, remotePath);
      } finally {
        // Her durumda temizle
        try {
          await fs.promises.unlink(tempPath);
        } catch (cleanupError) {
          logger.warn('Failed to cleanup temp file', cleanupError);
        }
      }
    });
  }

  async exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      // FTP doesn't support remote command execution like SSH
      // Some FTP servers support SITE EXEC, but it's not standard
      throw new Error('Remote command execution is not supported in FTP. Use SFTP instead.');
    } catch (error) {
      throw error;
    }
  }
}
