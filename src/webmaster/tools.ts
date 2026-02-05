/**
 * StackerFTP - Web Master Tools
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BaseConnection } from '../core/connection';
import { FileEntry, ChecksumResult, SearchResult, FileInfo } from '../types';
import { formatFileSize, formatDate, formatPermissions, calculateChecksum } from '../utils/helpers';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';

export class WebMasterTools {
  
  // ==================== Permission Management ====================
  
  async changePermissions(
    connection: BaseConnection,
    remotePath: string,
    mode: number | string
  ): Promise<void> {
    try {
      await connection.chmod(remotePath, mode);
      logger.info(`Changed permissions of ${remotePath} to ${mode}`);
    } catch (error: any) {
      logger.error(`Failed to change permissions for ${remotePath}`, error);
      throw error;
    }
  }

  async showChmodDialog(connection: BaseConnection, entry: FileEntry): Promise<void> {
    const currentMode = entry.rights 
      ? parseInt(entry.rights.user + entry.rights.group + entry.rights.other, 8)
      : 644;

    const modeString = await vscode.window.showInputBox({
      prompt: `Enter new permissions for ${entry.name}`,
      value: currentMode.toString(8),
      placeHolder: 'e.g., 755 or 644',
      validateInput: (value) => {
        if (!/^[0-7]{3,4}$/.test(value)) {
          return 'Please enter a valid octal permission (e.g., 755)';
        }
        return null;
      }
    });

    if (!modeString) return;

    try {
      await this.changePermissions(connection, entry.path, parseInt(modeString, 8));
      statusBar.success(`Permissions changed for ${entry.name} to ${modeString}`);
    } catch (error: any) {
      statusBar.error(`Failed to change permissions: ${error.message}`);
    }
  }

  // ==================== Checksum Tools ====================

  async calculateRemoteChecksum(
    connection: BaseConnection,
    remotePath: string,
    algorithm: 'md5' | 'sha1' | 'sha256' | 'sha512' = 'md5'
  ): Promise<string> {
    try {
      // Try to use remote command
      const result = await connection.exec(`md5sum "${remotePath}" || shasum -a 256 "${remotePath}"`);
      
      if (result.code === 0) {
        const match = result.stdout.match(/^([a-f0-9]+)/);
        if (match) return match[1];
      }
    } catch {
      // Fallback: download and calculate locally
    }

    // Fallback: download to temp and calculate
    const tempPath = path.join(require('os').tmpdir(), `stackerftp-checksum-${Date.now()}`);
    try {
      await connection.download(remotePath, tempPath);
      const checksum = await calculateChecksum(tempPath, algorithm);
      fs.unlinkSync(tempPath);
      return checksum;
    } catch (error) {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw error;
    }
  }

  async compareChecksums(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    algorithm: 'md5' | 'sha1' | 'sha256' = 'md5'
  ): Promise<ChecksumResult> {
    const localChecksum = await calculateChecksum(localPath, algorithm);
    const remoteChecksum = await this.calculateRemoteChecksum(connection, remotePath, algorithm);

    return {
      algorithm,
      local: localChecksum,
      remote: remoteChecksum,
      match: localChecksum === remoteChecksum
    };
  }

  async showChecksumResult(result: ChecksumResult, fileName: string): Promise<void> {
    const items = [
      `Algorithm: ${result.algorithm.toUpperCase()}`,
      `Local:  ${result.local}`,
      `Remote: ${result.remote}`,
      ``,
      `Status: ${result.match ? '$(check) MATCH' : '$(x) DIFFERENT'}`
    ];

    const selection = await vscode.window.showQuickPick(items, {
      title: `Checksum - ${fileName}`,
      canPickMany: false
    });

    if (selection === `Local:  ${result.local}` || selection === `Remote: ${result.remote}`) {
      await vscode.env.clipboard.writeText(selection.split(':')[1].trim());
      statusBar.success('Checksum copied to clipboard');
    }
  }

  // ==================== File Information ====================

  async getFileInfo(connection: BaseConnection, entry: FileEntry): Promise<FileInfo> {
    let checksum: ChecksumResult | undefined;
    
    if (entry.type === 'file') {
      try {
        const remoteChecksum = await this.calculateRemoteChecksum(connection, entry.path, 'md5');
        checksum = {
          algorithm: 'md5',
          remote: remoteChecksum
        };
      } catch {
        // Ignore checksum errors
      }
    }

    return {
      path: entry.path,
      name: entry.name,
      size: entry.size,
      sizeFormatted: formatFileSize(entry.size),
      modified: entry.modifyTime,
      modifiedFormatted: formatDate(entry.modifyTime),
      permissions: entry.rights 
        ? formatPermissions(parseInt(entry.rights.user + entry.rights.group + entry.rights.other, 8))
        : 'N/A',
      owner: String(entry.owner || 'N/A'),
      group: String(entry.group || 'N/A'),
      checksum
    };
  }

  async showFileInfo(info: FileInfo): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'stackerftpFileInfo',
      `File Info: ${info.name}`,
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: var(--vscode-font-family); padding: 20px; }
          h1 { font-size: 1.5em; margin-bottom: 20px; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
          td:first-child { font-weight: bold; width: 150px; }
          .checksum { font-family: monospace; font-size: 0.9em; }
        </style>
      </head>
      <body>
        <h1>$(file) ${info.name}</h1>
        <table>
          <tr><td>Path</td><td>${info.path}</td></tr>
          <tr><td>Size</td><td>${info.sizeFormatted}</td></tr>
          <tr><td>Modified</td><td>${info.modifiedFormatted}</td></tr>
          <tr><td>Permissions</td><td>${info.permissions}</td></tr>
          <tr><td>Owner</td><td>${info.owner}</td></tr>
          <tr><td>Group</td><td>${info.group}</td></tr>
          ${info.checksum ? `
          <tr><td>Checksum (MD5)</td><td class="checksum">${info.checksum.remote}</td></tr>
          ` : ''}
        </table>
      </body>
      </html>
    `;
  }

  // ==================== Search Tools ====================

  async searchInRemoteFiles(
    connection: BaseConnection,
    remotePath: string,
    pattern: string,
    filePattern?: string
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    try {
      // Try using grep on remote server
      const fileFilter = filePattern ? `--include="${filePattern}"` : '';
      const grepCmd = `grep -rn ${fileFilter} "${pattern}" "${remotePath}" 2>/dev/null || echo ""`;
      
      const result = await connection.exec(grepCmd);
      
      if (result.code === 0 && result.stdout) {
        const lines = result.stdout.split('\n').filter(l => l.trim());
        
        for (const line of lines) {
          const match = line.match(/^(.+):(\d+):(.*)$/);
          if (match) {
            results.push({
              file: path.basename(match[1]),
              path: match[1],
              line: parseInt(match[2]),
              column: 0,
              content: match[3].trim()
            });
          }
        }
      }
    } catch (error) {
      logger.warn('Remote grep failed, falling back to local search', error);
      // Fallback would require downloading files
    }

    return results;
  }

  async showSearchResults(results: SearchResult[]): Promise<void> {
    if (results.length === 0) {
      statusBar.success('No results found');
      return;
    }

    const items = results.map(r => ({
      label: `$(file) ${r.file}:${r.line}`,
      description: r.content.substring(0, 60),
      detail: r.path,
      result: r
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: `Search Results (${results.length} found)`,
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (selected) {
      // TODO: Implement opening remote file at specific line
      logger.info(`Selected search result: ${selected.result.path}:${selected.result.line}`);
    }
  }

  // ==================== Backup Tools ====================

  async createBackup(
    connection: BaseConnection,
    remotePath: string,
    backupName?: string
  ): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = backupName || `backup-${timestamp}`;
    const backupPath = `${remotePath}.${name}.bak`;

    try {
      await connection.exec(`cp -r "${remotePath}" "${backupPath}"`);
      logger.info(`Backup created: ${backupPath}`);
      return backupPath;
    } catch (error: any) {
      logger.error('Backup creation failed', error);
      throw new Error(`Failed to create backup: ${error.message}`);
    }
  }

  // ==================== Folder Comparison ====================

  async compareFolders(
    connection: BaseConnection,
    localPath: string,
    remotePath: string
  ): Promise<{ onlyLocal: string[]; onlyRemote: string[]; different: string[] }> {
    const result = {
      onlyLocal: [] as string[],
      onlyRemote: [] as string[],
      different: [] as string[]
    };

    // Get local files
    const localFiles = new Map<string, { size: number; mtime: number }>();
    const traverseLocal = (dir: string, baseDir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);
        
        if (entry.isDirectory()) {
          traverseLocal(fullPath, baseDir);
        } else {
          const stats = fs.statSync(fullPath);
          localFiles.set(relativePath.replace(/\\/g, '/'), {
            size: stats.size,
            mtime: stats.mtime.getTime()
          });
        }
      }
    };
    traverseLocal(localPath, localPath);

    // Get remote files
    const remoteFiles = new Map<string, { size: number; mtime: number }>();
    const traverseRemote = async (dir: string, baseDir: string) => {
      const entries = await connection.list(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name).replace(/\\/g, '/');
        const relativePath = fullPath.substring(baseDir.length).replace(/^\//, '');
        
        if (entry.type === 'directory') {
          await traverseRemote(fullPath, baseDir);
        } else {
          remoteFiles.set(relativePath, {
            size: entry.size,
            mtime: entry.modifyTime.getTime()
          });
        }
      }
    };
    await traverseRemote(remotePath, remotePath);

    // Compare
    for (const [file, info] of localFiles) {
      const remoteInfo = remoteFiles.get(file);
      if (!remoteInfo) {
        result.onlyLocal.push(file);
      } else if (remoteInfo.size !== info.size) {
        result.different.push(file);
      }
    }

    for (const [file] of remoteFiles) {
      if (!localFiles.has(file)) {
        result.onlyRemote.push(file);
      }
    }

    return result;
  }

  // ==================== Find and Replace ====================

  private escapeForSed(str: string): string {
    // Escape special sed characters
    return str
      .replace(/\\/g, '\\\\')
      .replace(/\//g, '\\/')
      .replace(/&/g, '\\&')
      .replace(/"/g, '\\"')
      .replace(/'/g, "'\"'\"'")
      .replace(/\n/g, '\\n')
      .replace(/;/g, '\\;')
      .replace(/\|/g, '\\|')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
      .replace(/\*/g, '\\*')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');
  }

  async findAndReplace(
    connection: BaseConnection,
    remotePath: string,
    find: string,
    replace: string,
    filePattern?: string
  ): Promise<{ success: number; failed: number; files: string[] }> {
    const result = { success: 0, failed: 0, files: [] as string[] };

    try {
      // Try using sed on remote server
      const findPattern = this.escapeForSed(find);
      const replacePattern = this.escapeForSed(replace);
      
      const fileFilter = filePattern || '*';
      const sedCmd = `find "${remotePath}" -name "${fileFilter}" -type f -exec sed -i 's/${findPattern}/${replacePattern}/g' {} + 2>&1`;
      
      const execResult = await connection.exec(sedCmd);
      
      if (execResult.code === 0) {
        // Get list of affected files
        const listCmd = `find "${remotePath}" -name "${fileFilter}" -type f -exec grep -l "${findPattern}" {} + 2>/dev/null || echo ""`;
        const listResult = await connection.exec(listCmd);
        
        if (listResult.code === 0 && listResult.stdout) {
          result.files = listResult.stdout.split('\n').filter(f => f.trim());
          result.success = result.files.length;
        }
      } else {
        result.failed = 1;
        logger.error('Find and replace failed', execResult.stderr);
      }
    } catch (error: any) {
      result.failed = 1;
      logger.error('Find and replace error', error);
    }

    return result;
  }

  async showFindAndReplaceDialog(connection: BaseConnection, remotePath: string): Promise<void> {
    // Get find pattern
    const find = await vscode.window.showInputBox({
      title: 'Find and Replace',
      prompt: 'Enter the text to find',
      placeHolder: 'search text',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value?.trim()) return 'Search text is required';
        return null;
      }
    });

    if (!find) return;

    // Get replace text
    const replace = await vscode.window.showInputBox({
      title: 'Find and Replace',
      prompt: `Replace "${find}" with:`,
      placeHolder: 'replacement text (leave empty to delete)',
      ignoreFocusOut: true
    });

    if (replace === undefined) return;

    // Get file pattern
    const filePattern = await vscode.window.showInputBox({
      title: 'File Pattern',
      prompt: 'Optional: Specify file pattern (e.g., *.php, *.js)',
      placeHolder: '* (all files)',
      value: '*',
      ignoreFocusOut: true
    });

    // Confirm
    const confirm = await vscode.window.showWarningMessage(
      `Replace all occurrences of "${find}" with "${replace}" in ${filePattern || '*'}?`,
      { modal: true },
      'Replace', 'Cancel'
    );

    if (confirm !== 'Replace') return;

    // Execute
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Finding and replacing...',
      cancellable: false
    }, async () => {
      const result = await this.findAndReplace(connection, remotePath, find, replace, filePattern || undefined);
      
      if (result.success > 0) {
        statusBar.success(`Replaced ${result.success} occurrence(s) in ${result.files.length} file(s)`);
      } else if (result.failed > 0) {
        statusBar.error('Find and replace failed');
      } else {
        statusBar.success('No matches found');
      }
    });
  }

  // ==================== Cache Management ====================

  async purgeRemoteCache(connection: BaseConnection, remotePath: string): Promise<void> {
    const cachePaths = [
      'var/cache',
      'cache',
      'storage/cache',
      'bootstrap/cache',
      'wp-content/cache',
      'temp',
      'tmp'
    ];

    const results: string[] = [];

    for (const cachePath of cachePaths) {
      const fullPath = `${remotePath}/${cachePath}`;
      try {
        const result = await connection.exec(`rm -rf "${fullPath}"/* 2>/dev/null && echo "OK" || echo "FAIL"`);
        if (result.stdout.includes('OK')) {
          results.push(cachePath);
        }
      } catch {
        // Ignore errors for non-existent paths
      }
    }

    if (results.length > 0) {
      statusBar.success(`Purged ${results.length} cache directory/directories`);
      logger.info(`Purged caches: ${results.join(', ')}`);
    } else {
      statusBar.warn('No cache directories found to purge');
    }
  }
}

export const webMasterTools = new WebMasterTools();
