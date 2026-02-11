/**
 * StackerFTP - Remote Document Provider
 * 
 * Virtual document provider for viewing remote files without downloading
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { transferManager } from '../core/transfer-manager';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';
import { formatFileSize, isBinaryFile, isSystemFile } from '../utils/helpers';

// Maximum file size for preview (5MB) - larger files should be downloaded
const MAX_PREVIEW_SIZE = 5 * 1024 * 1024;


export class RemoteDocumentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'stackerftp-remote';

  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private _cache = new Map<string, string>();

  constructor() {
    // Invalidate cache when a file is uploaded
    transferManager.on('transferComplete', (item) => {
      if (item.direction === 'upload' && item.status === 'completed') {
        const uri = RemoteDocumentProvider.createUri(item.remotePath);
        this.refresh(uri);
        logger.info(`Remote cache invalidated: ${item.remotePath}`);
      }
    });
  }

  // Store config info in URI query for multi-connection support
  private static _configMap = new Map<string, any>();

  static isBinaryFile(filePath: string): boolean {
    return isBinaryFile(filePath);
  }

  static isSystemFile(filePath: string): boolean {
    return isSystemFile(filePath);
  }

  static setConfigForPath(remotePath: string, config: any): void {
    this._configMap.set(remotePath, config);
  }

  static getConfigForPath(remotePath: string): any {
    return this._configMap.get(remotePath);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cacheKey = uri.toString();

    // Return cached content if available
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey)!;
    }

    const remotePath = uri.path;

    // Check for system files
    if (RemoteDocumentProvider.isSystemFile(remotePath)) {
      return `// System file: ${path.basename(remotePath)}\n// This file cannot be viewed.`;
    }

    // Check for binary files
    if (RemoteDocumentProvider.isBinaryFile(remotePath)) {
      return `// Binary file: ${path.basename(remotePath)}\n// Use "Download" to save this file locally.`;
    }

    try {
      // Try to get config from the map first (for multi-connection support)
      let config = RemoteDocumentProvider.getConfigForPath(remotePath);

      if (!config) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
          return '// No workspace folder open';
        }
        config = configManager.getActiveConfig(workspaceRoot);
      }

      if (!config) {
        return '// No SFTP configuration found';
      }

      const connection = await connectionManager.ensureConnection(config);

      // File size guard to avoid loading large files into memory
      try {
        const stat = await connection.stat(remotePath);
        if (stat?.size !== undefined && stat.size > MAX_PREVIEW_SIZE) {
          return `// File too large to preview: ${path.basename(remotePath)}\n` +
            `// Size: ${formatFileSize(stat.size)} (limit: ${formatFileSize(MAX_PREVIEW_SIZE)})\n` +
            `// Use "Download" to save this file locally.`;
        }
      } catch {
        // If stat fails, continue to attempt readFile for backward compatibility
      }

      // Read file content from remote
      const content = await connection.readFile(remotePath);

      // Check if content is null or undefined
      if (!content) {
        return `// Empty or unreadable file: ${path.basename(remotePath)}\n// This file may be a special type (socket, device, pipe) that cannot be read.`;
      }

      // Check for binary content by looking for null bytes in first 8KB
      // This catches binary files that weren't detected by extension
      // BUT we skip this for known text extensions
      const isKnownText = RemoteDocumentProvider.isBinaryFile(remotePath) === false;
      const checkBuffer = content.slice(0, 8192);
      let nullCount = 0;

      if (!isKnownText) {
        for (let i = 0; i < checkBuffer.length; i++) {
          if (checkBuffer[i] === 0) {
            nullCount++;
            // If more than 1% null bytes, it's likely binary
            if (nullCount > checkBuffer.length * 0.01) {
              return `// Binary file detected: ${path.basename(remotePath)}\n// This file contains binary data and cannot be displayed as text.\n// Use "Download" to save this file locally.`;
            }
          }
        }
      }

      const textContent = content.toString('utf8');

      // Additional check: if the text has too many replacement characters, it's probably binary
      if (!isKnownText) {
        const replacementCharCount = (textContent.match(/\uFFFD/g) || []).length;
        if (replacementCharCount > textContent.length * 0.05) {
          return `// Binary file detected: ${path.basename(remotePath)}\n// This file appears to contain binary data that cannot be displayed as text.\n// Use "Download" to save this file locally.`;
        }
      }

      // Cache the content
      this._cache.set(cacheKey, textContent);

      return textContent;
    } catch (error: any) {
      logger.error('Failed to read remote file', error);

      // Provide more helpful error messages
      const errMsg = error.message || '';
      if (errMsg.includes('550') || errMsg.includes('No such file')) {
        return `// Cannot read file: ${path.basename(remotePath)}\n// File not found or access denied.`;
      } else if (errMsg.includes('ENOENT')) {
        return `// File does not exist: ${path.basename(remotePath)}`;
      } else if (errMsg.includes('EPERM') || errMsg.includes('permission')) {
        return `// Permission denied: ${path.basename(remotePath)}`;
      } else if (errMsg.includes('ETIMEDOUT') || errMsg.includes('timeout')) {
        return `// Connection timeout while reading: ${path.basename(remotePath)}`;
      } else if (errMsg.includes('special file') || errMsg.includes('socket') || errMsg.includes('symlink')) {
        return `// Cannot read file: ${path.basename(remotePath)}\n// This may be a special file type (symlink, socket, etc.) that cannot be read directly.`;
      }

      return `// Error reading file: ${errMsg}`;
    }
  }

  refresh(uri: vscode.Uri): void {
    this._cache.delete(uri.toString());
    this._onDidChange.fire(uri);
  }

  clearCache(): void {
    this._cache.clear();
  }

  static createUri(remotePath: string, label?: string): vscode.Uri {
    return vscode.Uri.parse(`${RemoteDocumentProvider.scheme}:${remotePath}`);
  }
}

export async function openRemoteFile(remotePath: string): Promise<void> {
  const uri = RemoteDocumentProvider.createUri(remotePath);

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      viewColumn: vscode.ViewColumn.Active
    });
  } catch (error: any) {
    statusBar.error(`Failed to open remote file: ${error.message}`);
  }
}
