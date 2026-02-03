/**
 * StackerFTP - Git Integration
 * 
 * Git repository integration - detecting changed files
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

export interface GitChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked';
  absolutePath: string;
}

export class GitIntegration {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Check if it's a Git repository
   */
  isGitRepository(): boolean {
    const gitDir = path.join(this.workspaceRoot, '.git');
    return fs.existsSync(gitDir);
  }

  /**
   * Get changed files (staged + unstaged)
   */
  async getChangedFiles(): Promise<GitChangedFile[]> {
    if (!this.isGitRepository()) {
      logger.warn('Not a git repository');
      return [];
    }

    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      if (!gitExtension) {
        logger.warn('Git extension not found');
        return this.getChangedFilesFromCLI();
      }

      const git = gitExtension.exports.getAPI(1);
      const repo = git.repositories.find((r: any) =>
        r.rootUri.fsPath === this.workspaceRoot
      );

      if (!repo) {
        logger.warn('Git repository not found in VS Code');
        return this.getChangedFilesFromCLI();
      }

      const changedFiles: GitChangedFile[] = [];

      // Working tree changes (unstaged)
      for (const change of repo.state.workingTreeChanges) {
        changedFiles.push({
          path: change.uri.fsPath,
          status: this.mapGitStatus(change.status),
          absolutePath: change.uri.fsPath
        });
      }

      // Index changes (staged)
      for (const change of repo.state.indexChanges) {
        // Avoid duplicates
        if (!changedFiles.find(f => f.path === change.uri.fsPath)) {
          changedFiles.push({
            path: change.uri.fsPath,
            status: this.mapGitStatus(change.status),
            absolutePath: change.uri.fsPath
          });
        }
      }

      return changedFiles;
    } catch (error: any) {
      logger.error('Failed to get changed files from Git API', error);
      return this.getChangedFilesFromCLI();
    }
  }

  /**
   * Get only staged files
   */
  async getStagedFiles(): Promise<GitChangedFile[]> {
    if (!this.isGitRepository()) {
      return [];
    }

    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      if (!gitExtension) {
        return [];
      }

      const git = gitExtension.exports.getAPI(1);
      const repo = git.repositories.find((r: any) =>
        r.rootUri.fsPath === this.workspaceRoot
      );

      if (!repo) {
        return [];
      }

      const stagedFiles: GitChangedFile[] = [];

      for (const change of repo.state.indexChanges) {
        stagedFiles.push({
          path: change.uri.fsPath,
          status: this.mapGitStatus(change.status),
          absolutePath: change.uri.fsPath
        });
      }

      return stagedFiles;
    } catch (error: any) {
      logger.error('Failed to get staged files', error);
      return [];
    }
  }

  /**
   * Get changed files via CLI (fallback)
   */
  private async getChangedFilesFromCLI(): Promise<GitChangedFile[]> {
    return new Promise((resolve) => {
      const { exec } = require('child_process');

      exec(
        'git status --porcelain',
        { cwd: this.workspaceRoot },
        (error: any, stdout: string) => {
          if (error) {
            logger.error('Git CLI error', error);
            resolve([]);
            return;
          }

          const files: GitChangedFile[] = [];
          const lines = stdout.trim().split('\n').filter(Boolean);

          for (const line of lines) {
            const status = line.substring(0, 2).trim();
            const filePath = line.substring(3);
            const absolutePath = path.join(this.workspaceRoot, filePath);

            files.push({
              path: filePath,
              status: this.mapStatusCode(status),
              absolutePath
            });
          }

          resolve(files);
        }
      );
    });
  }

  /**
   * Map VS Code Git status
   */
  private mapGitStatus(status: number): GitChangedFile['status'] {
    // VS Code Git Status enum values
    switch (status) {
      case 0: return 'modified';    // Modified
      case 1: return 'added';       // Added
      case 2: return 'deleted';     // Deleted
      case 3: return 'renamed';     // Renamed
      case 4: return 'copied';      // Copied
      case 5: return 'modified';    // Modified (both)
      case 6: return 'added';       // Added by us
      case 7: return 'untracked';   // Untracked
      default: return 'modified';
    }
  }

  /**
   * Map Git porcelain status code
   */
  private mapStatusCode(code: string): GitChangedFile['status'] {
    switch (code) {
      case 'M': return 'modified';
      case 'A': return 'added';
      case 'D': return 'deleted';
      case 'R': return 'renamed';
      case 'C': return 'copied';
      case '??': return 'untracked';
      case 'MM': return 'modified';
      case 'AM': return 'added';
      default: return 'modified';
    }
  }

  /**
   * Filter uploadable files (excluding deleted)
   */
  filterUploadable(files: GitChangedFile[]): GitChangedFile[] {
    return files.filter(f =>
      f.status !== 'deleted' &&
      fs.existsSync(f.absolutePath) &&
      fs.statSync(f.absolutePath).isFile()
    );
  }
}

export function createGitIntegration(workspaceRoot: string): GitIntegration {
  return new GitIntegration(workspaceRoot);
}
