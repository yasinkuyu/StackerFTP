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

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error: any, stdout: string) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
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
   * Most recent commits on the current branch, newest first
   */
  async getRecentCommits(limit = 30): Promise<GitCommit[]> {
    try {
      const out = await runGit(this.workspaceRoot, [
        'log', `-n${limit}`, '--date=short', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad'
      ]);
      return out.split('\n').filter(Boolean).map(line => {
        const [hash, shortHash, subject, author, date] = line.split('\x1f');
        return { hash, shortHash, subject, author, date };
      });
    } catch (error: any) {
      logger.error('Failed to read git log', error);
      return [];
    }
  }

  /**
   * Files touched by the given commits. Commits are applied oldest first, so a file's
   * final status is the one from the newest commit that touched it. A renamed file
   * counts as the old path deleted plus the new path added.
   */
  async getFilesForCommits(hashes: string[]): Promise<GitChangedFile[]> {
    const order = await runGit(this.workspaceRoot, ['rev-list', '--no-walk=sorted', '--reverse', ...hashes]);
    const ordered = order.split('\n').filter(Boolean);
    const byPath = new Map<string, GitChangedFile>();
    // diff-tree paths are relative to the repository root, which may sit above the workspace
    const repoRoot = (await runGit(this.workspaceRoot, ['rev-parse', '--show-toplevel'])).trim();

    for (const hash of ordered) {
      // -z: NUL separated, paths are never quoted; --root covers the first commit
      const out = await runGit(this.workspaceRoot, [
        'diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '-M', '--root', hash
      ]);
      const parts = out.split('\0').filter(Boolean);
      for (let i = 0; i < parts.length;) {
        const code = parts[i++];
        const kind = code[0];
        if (kind === 'R' || kind === 'C') {
          const from = parts[i++];
          const to = parts[i++];
          if (kind === 'R') this.record(byPath, repoRoot, from, 'deleted');
          this.record(byPath, repoRoot, to, 'added');
        } else {
          const file = parts[i++];
          this.record(byPath, repoRoot, file, kind === 'D' ? 'deleted' : kind === 'A' ? 'added' : 'modified');
        }
      }
    }
    return [...byPath.values()];
  }

  private record(map: Map<string, GitChangedFile>, repoRoot: string, relPath: string, status: GitChangedFile['status']): void {
    const prev = map.get(relPath);
    // Added then modified in a later commit is still new relative to the range
    const merged = prev && prev.status === 'added' && status === 'modified' ? 'added' : status;
    map.set(relPath, { path: relPath, status: merged, absolutePath: path.join(repoRoot, relPath) });
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
