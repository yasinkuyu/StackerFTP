/**
 * StackerFTP - Sync command flow: scan → preview → apply
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { connectionManager } from '../core/connection-manager';
import { BaseConnection } from '../core/connection';
import { resolveTargetConfig } from '../core/target';
import {
  SyncAction, SyncDirection, SyncPlan,
  applySyncActions, buildSyncPlan, scanBothSides, scanSingleFile
} from '../core/sync-engine';
import { FTPConfig, SyncResult } from '../types';
import { getLocalRelativePath, getLocalRoot, normalizeRemotePath, sanitizeRelativePath } from '../utils/helpers';
import { statusBar } from '../utils/status-bar';
import { logger } from '../utils/logger';
import { getWorkspaceRoot } from './utils';

const DIRECTION_LABEL: Record<SyncDirection, string> = {
  toRemote: 'Local → Remote',
  toLocal: 'Remote → Local',
  both: 'Local ⇄ Remote'
};

const TYPE_GROUP: Record<SyncAction['type'], string> = {
  upload: 'Upload to remote',
  download: 'Download to local',
  deleteRemote: 'Delete on remote',
  deleteLocal: 'Delete locally (to trash)'
};

function actionIcon(action: SyncAction): string {
  if (action.reason === 'conflict') return '$(warning)';
  switch (action.type) {
    case 'upload': return '$(arrow-up)';
    case 'download': return '$(arrow-down)';
    default: return '$(trash)';
  }
}

export interface RunSyncOptions {
  workspaceRoot?: string;
  config?: FTPConfig;
}

/**
 * Let the user review the plan. Returns the selected actions, or undefined if cancelled.
 * "Open Compare View" switches to the side-by-side compare for the same folder.
 */
async function previewPlan(plan: SyncPlan, config: FTPConfig, compareTarget?: vscode.Uri): Promise<SyncAction[] | undefined> {
  type Item = vscode.QuickPickItem & { action?: SyncAction };

  const items: Item[] = [];
  for (const type of Object.keys(TYPE_GROUP) as SyncAction['type'][]) {
    const group = plan.actions.filter(a => a.type === type);
    if (group.length === 0) continue;
    items.push({ label: `${TYPE_GROUP[type]} (${group.length})`, kind: vscode.QuickPickItemKind.Separator });
    for (const action of group) {
      items.push({
        label: `${actionIcon(action)} ${action.relativePath}`,
        description: action.note,
        picked: action.recommended,
        action
      });
    }
  }

  const conflicts = plan.actions.filter(a => a.reason === 'conflict').length;
  const qp = vscode.window.createQuickPick<Item>();
  qp.canSelectMany = true;
  qp.ignoreFocusOut = true;
  qp.matchOnDescription = true;
  qp.title = `Sync ${DIRECTION_LABEL[plan.direction]} • ${config.name || config.host}:${plan.remoteRoot}`;
  qp.placeholder = `${plan.actions.length} change(s), ${plan.unchanged} unchanged` +
    (conflicts ? ` • ${conflicts} conflict(s) not selected – review them` : '') +
    ' • Enter to apply selected';
  qp.items = items;
  qp.selectedItems = items.filter(i => i.picked);
  if (compareTarget) {
    qp.buttons = [{ iconPath: new vscode.ThemeIcon('git-compare'), tooltip: 'Open Compare View' }];
  }

  return new Promise(resolve => {
    let done = false;
    const finish = (value: SyncAction[] | undefined) => {
      if (done) return;
      done = true;
      resolve(value);
      qp.dispose();
    };
    qp.onDidAccept(() => finish(qp.selectedItems.map(i => i.action).filter((a): a is SyncAction => !!a)));
    qp.onDidTriggerButton(() => {
      finish(undefined);
      vscode.commands.executeCommand('stackerftp.webmaster.compareFolders', compareTarget);
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

async function confirmDeletes(actions: SyncAction[]): Promise<boolean> {
  const deletes = actions.filter(a => a.type === 'deleteRemote' || a.type === 'deleteLocal');
  if (deletes.length === 0) return true;

  const remote = deletes.filter(a => a.type === 'deleteRemote').length;
  const local = deletes.length - remote;
  const parts = [remote ? `${remote} on the remote server` : '', local ? `${local} locally (moved to trash)` : ''].filter(Boolean);
  const list = deletes.slice(0, 15).map(a => `• ${a.relativePath}`).join('\n') +
    (deletes.length > 15 ? `\n… and ${deletes.length - 15} more` : '');

  const choice = await vscode.window.showWarningMessage(
    `Delete ${deletes.length} file(s): ${parts.join(', ')}?`,
    { modal: true, detail: `${list}\n\nRemote deletions cannot be undone.` },
    'Delete and Sync'
  );
  return choice === 'Delete and Sync';
}

function reportResult(result: SyncResult, total: number): void {
  const parts = [
    result.uploaded.length ? `${result.uploaded.length} uploaded` : '',
    result.downloaded.length ? `${result.downloaded.length} downloaded` : '',
    result.deleted.length ? `${result.deleted.length} deleted` : '',
    result.skipped.length ? `${result.skipped.length} skipped` : ''
  ].filter(Boolean);
  const summary = parts.join(', ') || 'nothing changed';

  if (result.failed.length === 0) {
    statusBar.success(`Sync complete: ${summary}`);
    return;
  }

  // Transfer failures are also listed by the transfer error reporter; deletes are only reported here
  logger.error('Sync failures', result.failed);
  vscode.window.showErrorMessage(
    `StackerFTP: Sync finished with ${result.failed.length}/${total} failure(s) (${summary})`,
    'Show Details'
  ).then(choice => {
    if (choice !== 'Show Details') return;
    const detail = result.failed.slice(0, 30).map(f => `• ${f.path}: ${f.error}`).join('\n') +
      (result.failed.length > 30 ? `\n… and ${result.failed.length - 30} more (see log)` : '');
    vscode.window.showErrorMessage('Sync failures', { modal: true, detail });
  });
}

/**
 * Compare-based sync of the whole project (or the given file/folder) with the target server.
 */
export async function runSync(direction: SyncDirection, uri?: vscode.Uri, options: RunSyncOptions = {}): Promise<SyncResult | undefined> {
  const workspaceRoot = options.workspaceRoot || getWorkspaceRoot(uri);
  if (!workspaceRoot) return undefined;

  const config = options.config || await resolveTargetConfig(workspaceRoot, 'Sync');
  if (!config) return undefined;

  let connection: BaseConnection;
  try {
    connection = await connectionManager.ensureConnection(config);
  } catch (error: any) {
    statusBar.error(`Connection failed: ${error.message}`, true);
    return undefined;
  }

  // Resolve roots (honours "context" and the selected file/folder)
  let localTarget = getLocalRoot(workspaceRoot, config);
  let remoteTarget = normalizeRemotePath(config.remotePath);
  if (uri && uri.fsPath !== workspaceRoot) {
    localTarget = uri.fsPath;
    const rel = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localTarget, config));
    remoteTarget = normalizeRemotePath(path.posix.join(config.remotePath, rel.replace(/\\/g, '/')));
  }

  let isFile = false;
  try {
    isFile = fs.statSync(localTarget).isFile();
  } catch {
    // Missing locally - treat as folder
  }
  const localRoot = isFile ? path.dirname(localTarget) : localTarget;
  const remoteRoot = isFile ? path.posix.dirname(remoteTarget) : remoteTarget;

  // Scan
  let plan: SyncPlan | undefined;
  try {
    plan = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Sync ${DIRECTION_LABEL[direction]}`,
      cancellable: true
    }, async (progress, token) => {
      const scan = isFile
        ? await scanSingleFile(connection, localTarget, remoteTarget)
        : await scanBothSides(connection, config, localRoot, remoteRoot, message => progress.report({ message }), token);
      if (token.isCancellationRequested) return undefined;
      const deleteOrphans = config.syncMode === 'full' && direction !== 'both' && !isFile;
      return buildSyncPlan(scan, config, localRoot, remoteRoot, direction, deleteOrphans);
    });
  } catch (error: any) {
    statusBar.error(`Sync failed while scanning: ${error.message}`, true);
    return undefined;
  }
  if (!plan) return undefined;

  if (plan.actions.length === 0) {
    statusBar.success(`Already in sync (${plan.unchanged} file(s) checked)`);
    return { uploaded: [], downloaded: [], deleted: [], failed: [], skipped: [] };
  }

  const showPreview = vscode.workspace.getConfiguration('stackerftp').get<boolean>('confirmSync', true);
  const selected = showPreview
    ? await previewPlan(plan, config, isFile ? undefined : vscode.Uri.file(localRoot))
    : plan.actions.filter(a => a.recommended);
  if (!selected || selected.length === 0) return undefined;

  if (!await confirmDeletes(selected)) return undefined;

  const label = `Sync ${path.basename(localRoot) || 'project'}`;
  const result = await applySyncActions(connection, config, selected, label);
  reportResult(result, selected.length);
  return result;
}
