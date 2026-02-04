/**
 * StackerFTP - Remote Document Provider
 * 
 * Virtual document provider for viewing remote files without downloading
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';

// Binary file extensions that should not be opened as text
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
  '.exe', '.dll', '.so', '.dylib',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.psd', '.ai', '.sketch',
  '.db', '.sqlite', '.mdb'
]);

// System files/folders that should be skipped
const SYSTEM_PATTERNS = [
  '__MACOSX',
  '.DS_Store',
  'Thumbs.db',
  '.git',
  '.svn'
];

export class RemoteDocumentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'stackerftp-remote';

  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private _cache = new Map<string, string>();
  
  // Store config info in URI query for multi-connection support
  private static _configMap = new Map<string, any>();

  static isBinaryFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
  }

  static isSystemFile(filePath: string): boolean {
    return SYSTEM_PATTERNS.some(pattern => filePath.includes(pattern));
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
      
      // Read file content from remote
      const content = await connection.readFile(remotePath);
      const textContent = content.toString('utf8');

      // Cache the content
      this._cache.set(cacheKey, textContent);

      return textContent;
    } catch (error: any) {
      logger.error('Failed to read remote file', error);
      
      // Provide more helpful error messages
      if (error.message?.includes('550')) {
        return `// Cannot read file: ${path.basename(remotePath)}\n// This may be a special file type (symlink, socket, etc.) that cannot be read directly.`;
      }
      
      return `// Error reading file: ${error.message}`;
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
