/**
 * StackerFTP - Web Master Tools
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BaseConnection } from '../core/connection';
import { FileEntry, ChecksumResult, SearchResult, FileInfo, FTPConfig, CompareItem, CompareTreeNode, CompareResult } from '../types';
import { formatFileSize, formatDate, formatPermissions, calculateChecksum } from '../utils/helpers';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';
import { lookup as lookupMimeType } from 'mime-types';
import { RemoteDocumentProvider } from '../providers/remote-document-provider';

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

    const mimeType = entry.type === 'directory'
      ? 'inode/directory'
      : (lookupMimeType(entry.name) || undefined);

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
      mimeType: mimeType ? String(mimeType) : undefined,
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
          <tr><td>MIME</td><td>${info.mimeType || 'N/A'}</td></tr>
          ${info.checksum ? `
          <tr><td>Checksum (MD5)</td><td class="checksum">${info.checksum.remote}</td></tr>
          ` : ''}
        </table>
      </body>
      </html>
    `;
  }

  // ==================== Quick Search Tools ====================

  /**
   * Fast file search by name pattern - searches in parallel
   */
  async quickSearchFiles(
    connection: BaseConnection,
    remotePath: string,
    pattern: string,
    options?: {
      maxResults?: number;
      searchPath?: string;
      onProgress?: (message: string) => void;
    }
  ): Promise<{ name: string; path: string; size: number; type: 'file' | 'directory' }[]> {
    const maxResults = options?.maxResults || 100;
    const searchPath = options?.searchPath || remotePath;
    const onProgress = options?.onProgress;

    const results: { name: string; path: string; size: number; type: 'file' | 'directory' }[] = [];
    const patternLower = pattern.toLowerCase();

    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(regexPattern, 'i');

    // Check if pattern matches
    const matches = (name: string): boolean => {
      if (regex.test(name)) return true;
      if (patternLower.includes(name.toLowerCase())) return true;
      return false;
    };

    // Recursive search with parallel processing
    const searchDir = async (dirPath: string, depth: number = 0): Promise<void> => {
      if (results.length >= maxResults) return;

      try {
        const entries = await connection.list(dirPath);

        // Process entries in parallel
        const files = entries.filter(e => e.type === 'file');
        const dirs = entries.filter(e => e.type === 'directory');

        // Check files
        for (const entry of files) {
          if (results.length >= maxResults) return;

          if (matches(entry.name)) {
            results.push({
              name: entry.name,
              path: entry.path,
              size: entry.size,
              type: 'file'
            });
          }
        }

        // Check directories for partial matches (for showing in results)
        for (const entry of dirs) {
          if (matches(entry.name)) {
            results.push({
              name: entry.name,
              path: entry.path,
              size: 0,
              type: 'directory'
            });
          }
        }

        // Recurse into subdirectories in parallel (limited depth to prevent too deep recursion)
        if (depth < 10) {
          await Promise.all(dirs.map(d => searchDir(d.path, depth + 1)));
        }
      } catch (error) {
        // Skip directories we can't access
      }
    };

    onProgress?.(`Searching in ${searchPath}...`);
    await searchDir(searchPath);

    // Sort: directories first, then by name
    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return results.slice(0, maxResults);
  }

  /**
   * Show quick search results in a picker
   */
  async showQuickSearchResults(
    results: { name: string; path: string; size: number; type: 'file' | 'directory' }[],
    config: FTPConfig,
    connection: BaseConnection,
    workspaceRoot: string
  ): Promise<void> {
    if (results.length === 0) {
      statusBar.success('No files found');
      return;
    }

    const items = results.map(r => ({
      label: r.type === 'directory' ? `$(file-directory) ${r.name}` : `$(file) ${r.name}`,
      description: r.type === 'file' ? formatFileSize(r.size) : 'Folder',
      detail: r.path,
      path: r.path,
      type: r.type,
      isDirectory: r.type === 'directory'
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: `Search Results (${results.length} found)`,
      placeHolder: 'Select a file to open or download',
      matchOnDetail: true
    });

    if (!selected) return;

    if (selected.isDirectory) {
      // Navigate to folder in remote explorer
      await vscode.commands.executeCommand('stackerftp.tree.refresh');
      statusBar.success(`Folder: ${selected.path}`);
    } else {
      // Get filename from path
      const fileName = path.basename(selected.path);

      // Offer to open or download
      const choice = await vscode.window.showQuickPick([
        { label: '$(eye) Open', description: 'Open file in editor', value: 'open' },
        { label: '$(arrow-down) Download', description: 'Download to local', value: 'download' }
      ], {
        title: fileName,
        placeHolder: 'What would you like to do?'
      });

      if (!choice) return;

      const localPath = path.join(workspaceRoot, path.relative(config.remotePath, selected.path));
      const localDir = path.dirname(localPath);

      if (choice.value === 'download' || choice.value === 'open') {
        // Ensure local directory exists
        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }

        // Download file
        await connection.download(selected.path, localPath);

        if (choice.value === 'open') {
          const doc = await vscode.workspace.openTextDocument(localPath);
          await vscode.window.showTextDocument(doc);
        } else {
          statusBar.success(`Downloaded: ${fileName}`);
        }
      }
    }
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

  async showSearchResults(results: SearchResult[], config?: FTPConfig): Promise<void> {
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
      try {
        if (config) {
          RemoteDocumentProvider.setConfigForPath(selected.result.path, config);
        }
        const uri = RemoteDocumentProvider.createUri(selected.result.path);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        const line = Math.max(selected.result.line - 1, 0);
        const column = Math.max(selected.result.column || 0, 0);
        const position = new vscode.Position(line, column);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
      } catch (error) {
        logger.warn(`Failed to open search result: ${selected.result.path}`, error);
      }
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

  // Default ignore patterns for folder comparison
  private static readonly DEFAULT_IGNORE_PATTERNS = [
    '.git',
    'node_modules',
    '.DS_Store',
    'Thumbs.db',
    '.vscode',
    '.idea',
    '__pycache__',
    '*.pyc',
    '.env',
    '.env.local'
  ];

  /**
   * Check if a path should be ignored based on patterns
   */
  private shouldIgnore(filePath: string, ignorePatterns: string[]): boolean {
    const fileName = path.basename(filePath);
    for (const pattern of ignorePatterns) {
      if (pattern.startsWith('*.')) {
        // Extension match
        const ext = pattern.slice(1);
        if (fileName.endsWith(ext)) return true;
      } else if (filePath.includes(pattern) || fileName === pattern) {
        return true;
      }
    }
    return false;
  }

  /**
   * Compare folders with performance optimizations
   */
  async compareFolders(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    options?: {
      ignorePatterns?: string[];
      useMtime?: boolean;
      onProgress?: (message: string, increment?: number) => void;
    }
  ): Promise<{
    onlyLocal: CompareItem[];
    onlyRemote: CompareItem[];
    different: CompareItem[];
    tree: CompareTreeNode;
  }> {
    const ignorePatterns = options?.ignorePatterns || WebMasterTools.DEFAULT_IGNORE_PATTERNS;
    const useMtime = options?.useMtime !== false; // Default to true
    const onProgress = options?.onProgress;

    const result = {
      onlyLocal: [] as CompareItem[],
      onlyRemote: [] as CompareItem[],
      different: [] as CompareItem[],
      tree: { name: path.basename(localPath) || '/', children: [], path: '', isDirectory: true } as CompareTreeNode
    };

    onProgress?.('Scanning local files...', 0);

    // Get local files
    const localFiles = new Map<string, { size: number; mtime: number }>();
    const localFolders = new Set<string>();

    const traverseLocal = (dir: string, baseDir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

          if (this.shouldIgnore(relativePath, ignorePatterns)) {
            continue;
          }

          if (entry.isDirectory()) {
            localFolders.add(relativePath);
            traverseLocal(fullPath, baseDir);
          } else {
            try {
              const stats = fs.statSync(fullPath);
              localFiles.set(relativePath, {
                size: stats.size,
                mtime: stats.mtime.getTime()
              });
            } catch (err) {
              // Skip files that can't be stat'd
            }
          }
        }
      } catch (err) {
        // Skip directories that can't be read
      }
    };
    traverseLocal(localPath, localPath);

    onProgress?.('Scanning remote files...', 30);

    // Get remote files with parallel traversal
    const remoteFiles = new Map<string, { size: number; mtime: number }>();
    const remoteFolders = new Set<string>();

    const traverseRemote = async (dir: string, baseDir: string): Promise<void> => {
      try {
        const entries = await connection.list(dir);

        // Process directories in parallel
        const directories = entries.filter(e => e.type === 'directory');
        const files = entries.filter(e => e.type === 'file');

        // Recursively process subdirectories in parallel
        if (directories.length > 0) {
          await Promise.all(
            directories.map(async (entry) => {
              const fullPath = path.join(dir, entry.name).replace(/\\/g, '/');
              const relativePath = fullPath.substring(baseDir.length).replace(/^\//, '');

              if (this.shouldIgnore(relativePath, ignorePatterns)) {
                return;
              }

              remoteFolders.add(relativePath);
              await traverseRemote(fullPath, baseDir);
            })
          );
        }

        // Process files
        for (const entry of files) {
          const fullPath = path.join(dir, entry.name).replace(/\\/g, '/');
          const relativePath = fullPath.substring(baseDir.length).replace(/^\//, '');

          if (this.shouldIgnore(relativePath, ignorePatterns)) {
            continue;
          }

          remoteFiles.set(relativePath, {
            size: entry.size,
            mtime: entry.modifyTime?.getTime() || 0
          });
        }
      } catch (err) {
        // Skip directories that can't be read
      }
    };

    await traverseRemote(remotePath, remotePath);

    onProgress?.('Comparing files...', 70);

    // Compare with size and optional mtime
    for (const [file, localInfo] of localFiles) {
      const remoteInfo = remoteFiles.get(file);
      if (!remoteInfo) {
        result.onlyLocal.push({
          path: file,
          size: localInfo.size,
          mtime: localInfo.mtime,
          side: 'local'
        });
      } else if (useMtime) {
        // Compare both size AND mtime for more accurate comparison
        const sizeDifferent = remoteInfo.size !== localInfo.size;
        // Consider different if size differs OR if mtime differs by more than 2 seconds
        const mtimeDifferent = Math.abs(remoteInfo.mtime - localInfo.mtime) > 2000;

        if (sizeDifferent || mtimeDifferent) {
          result.different.push({
            path: file,
            localSize: localInfo.size,
            remoteSize: remoteInfo.size,
            localMtime: localInfo.mtime,
            remoteMtime: remoteInfo.mtime,
            side: 'different'
          });
        }
      } else {
        // Legacy: size-only comparison
        if (remoteInfo.size !== localInfo.size) {
          result.different.push({
            path: file,
            localSize: localInfo.size,
            remoteSize: remoteInfo.size,
            localMtime: localInfo.mtime,
            remoteMtime: remoteInfo.mtime,
            side: 'different'
          });
        }
      }
    }

    for (const [file, remoteInfo] of remoteFiles) {
      if (!localFiles.has(file)) {
        result.onlyRemote.push({
          path: file,
          size: remoteInfo.size,
          mtime: remoteInfo.mtime,
          side: 'remote'
        });
      }
    }

    // Build tree structure
    onProgress?.('Building tree...', 90);

    const allPaths = new Set<string>();
    for (const item of result.onlyLocal) {
      const parts = item.path.split('/');
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        allPaths.add(current);
      }
    }
    for (const item of result.onlyRemote) {
      const parts = item.path.split('/');
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        allPaths.add(current);
      }
    }
    for (const item of result.different) {
      const parts = item.path.split('/');
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        allPaths.add(current);
      }
    }

    // Build tree from all paths
    const treeMap = new Map<string, CompareTreeNode>();
    treeMap.set('', result.tree);

    // Sort paths to ensure parents are processed first
    const sortedPaths = Array.from(allPaths).sort((a, b) => a.localeCompare(b));

    for (const filePath of sortedPaths) {
      const parentPath = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
      const name = filePath.includes('/') ? filePath.substring(filePath.lastIndexOf('/') + 1) : filePath;
      const isDir = allPaths.has(`${filePath}/`) || localFolders.has(filePath) || remoteFolders.has(filePath);

      const node: CompareTreeNode = {
        name,
        path: filePath,
        isDirectory: isDir,
        children: [],
        localItem: result.onlyLocal.find(i => i.path === filePath) ||
                   result.different.find(i => i.path === filePath),
        remoteItem: result.onlyRemote.find(i => i.path === filePath) ||
                    result.different.find(i => i.path === filePath)
      };

      treeMap.set(filePath, node);

      const parent = treeMap.get(parentPath);
      if (parent) {
        parent.children.push(node);
      }
    }

    // Sort children: directories first, then files, alphabetically
    const sortChildren = (node: CompareTreeNode) => {
      node.children.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortChildren);
    };
    sortChildren(result.tree);

    onProgress?.('Done', 100);

    return result;
  }

  /**
   * Legacy compareFolders for backward compatibility
   */
  async compareFoldersLegacy(
    connection: BaseConnection,
    localPath: string,
    remotePath: string
  ): Promise<{ onlyLocal: string[]; onlyRemote: string[]; different: string[] }> {
    const result = await this.compareFolders(connection, localPath, remotePath);

    return {
      onlyLocal: result.onlyLocal.map(i => i.path),
      onlyRemote: result.onlyRemote.map(i => i.path),
      different: result.different.map(i => i.path)
    };
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
