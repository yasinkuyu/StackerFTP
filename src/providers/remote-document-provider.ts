/**
 * StackerFTP - Remote Document Provider
 * 
 * Virtual document provider for viewing remote files without downloading
 */

import * as vscode from 'vscode';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { logger } from '../utils/logger';

export class RemoteDocumentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'stackerftp-remote';

  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private _cache = new Map<string, string>();

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cacheKey = uri.toString();
    
    // Return cached content if available
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey)!;
    }

    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        return '// No workspace folder open';
      }

      const config = configManager.getActiveConfig(workspaceRoot);
      if (!config) {
        return '// No SFTP configuration found';
      }

      const remotePath = uri.path;
      const connection = await connectionManager.ensureConnection(config);
      
      // Read file content from remote
      const content = await connection.readFile(remotePath);
      const textContent = content.toString('utf8');

      // Cache the content
      this._cache.set(cacheKey, textContent);

      return textContent;
    } catch (error: any) {
      logger.error('Failed to read remote file', error);
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
    vscode.window.showErrorMessage(`Failed to open remote file: ${error.message}`);
  }
}
