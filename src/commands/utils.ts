import * as vscode from 'vscode';
import { statusBar } from '../utils/status-bar';

export function getWorkspaceRoot(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    statusBar.error('No workspace folder open');
    return undefined;
  }
  return workspaceFolders[0].uri.fsPath;
}
