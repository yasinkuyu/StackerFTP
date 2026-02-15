import * as vscode from 'vscode';
import * as path from 'path';
import { statusBar } from '../utils/status-bar';

/**
 * Get workspace root for a given URI.
 * If URI is provided, returns the workspace folder containing that URI.
 * Otherwise returns the first workspace folder.
 */
export function getWorkspaceRoot(uri?: vscode.Uri): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    statusBar.error('No workspace folder open');
    return undefined;
  }

  // If URI is provided, find the workspace folder that contains it
  if (uri) {
    const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (wsFolder) {
      return wsFolder.uri.fsPath;
    }
  }

  // Otherwise return the first workspace folder (legacy behavior)
  return workspaceFolders[0].uri.fsPath;
}
