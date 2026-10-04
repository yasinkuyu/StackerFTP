/**
 * StackerFTP - Transfer Error Reporter
 *
 * Makes failed transfers impossible to miss:
 *  - one error notification per queue run (with Show Details / Retry / Show Queue)
 *  - full error details for a failed item (with Retry / Copy Error / Show Log)
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { transferManager } from '../core/transfer-manager';
import { TransferItem } from '../types';

function directionLabel(item: TransferItem): string {
  return item.direction === 'upload' ? 'Upload' : 'Download';
}

function serverLabel(item: TransferItem): string {
  const c = item.config;
  if (!c) return 'unknown';
  const port = c.port ? `:${c.port}` : '';
  return `${c.name ? `${c.name} – ` : ''}${c.username}@${c.host}${port}`;
}

export function formatTransferError(item: TransferItem): string {
  const lines = [
    `Error: ${item.error || 'Unknown error'}`,
    '',
    `Direction: ${directionLabel(item)}`,
    `Server: ${serverLabel(item)}`,
    `Local: ${item.localPath}`,
    `Remote: ${item.remotePath}`
  ];
  if (item.endTime) lines.push(`Time: ${item.endTime.toLocaleString()}`);
  return lines.join('\n');
}

function retry(items: TransferItem[]): void {
  const count = transferManager.retryItems(items.map(i => i.id));
  if (count > 0) {
    vscode.window.setStatusBarMessage(`$(refresh) Retrying ${count} transfer${count > 1 ? 's' : ''}`, 3000);
  }
}

/**
 * Show full details of failed transfers. With several failures, the user picks one first.
 */
export async function showTransferErrorDetails(items: TransferItem[]): Promise<void> {
  const failed = items.filter(i => i.status === 'error');
  if (failed.length === 0) {
    vscode.window.showInformationMessage('StackerFTP: No failed transfers.');
    return;
  }

  let item = failed[0];
  if (failed.length > 1) {
    type Pick = vscode.QuickPickItem & { item?: TransferItem; retryAll?: boolean };
    const picks: Pick[] = [
      { label: `$(refresh) Retry all ${failed.length} failed transfers`, retryAll: true },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...failed.map(i => ({
        label: `$(error) ${path.basename(i.localPath)}`,
        description: i.error || 'Unknown error',
        detail: `${directionLabel(i)} • ${serverLabel(i)} • ${i.remotePath}`,
        item: i
      }))
    ];
    const selected = await vscode.window.showQuickPick(picks, {
      title: `${failed.length} Failed Transfers`,
      placeHolder: 'Select a transfer to see the error details',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!selected) return;
    if (selected.retryAll) {
      retry(failed);
      return;
    }
    if (!selected.item) return;
    item = selected.item;
  }

  const detail = formatTransferError(item);
  const choice = await vscode.window.showErrorMessage(
    `${directionLabel(item)} failed: ${path.basename(item.localPath)}`,
    { modal: true, detail },
    'Retry', 'Copy Error', 'Show Log'
  );

  if (choice === 'Retry') {
    retry([item]);
  } else if (choice === 'Copy Error') {
    await vscode.env.clipboard.writeText(detail);
    vscode.window.setStatusBarMessage('$(copy) Error details copied', 3000);
  } else if (choice === 'Show Log') {
    vscode.commands.executeCommand('stackerftp.viewLogs');
  }
}

/**
 * Collect failures during a queue run and report them once when the run ends.
 */
export function registerTransferErrorNotifications(revealQueue: () => void): vscode.Disposable {
  let runErrors: TransferItem[] = [];

  const onTransferComplete = (item: TransferItem) => {
    if (item?.status === 'error') runErrors.push(item);
  };

  const onQueueComplete = async () => {
    // Items may have been retried/cleared meanwhile - only report what is still failed
    const failed = runErrors.filter(i => i.status === 'error');
    runErrors = [];
    if (failed.length === 0) return;

    const first = failed[0];
    const message = failed.length === 1
      ? `StackerFTP: ${directionLabel(first)} failed – ${path.basename(first.localPath)}: ${first.error || 'Unknown error'}`
      : `StackerFTP: ${failed.length} transfers failed (e.g. ${path.basename(first.localPath)}: ${first.error || 'Unknown error'})`;

    const choice = await vscode.window.showErrorMessage(message, 'Show Details', 'Retry', 'Show Queue');
    if (choice === 'Show Details') {
      await showTransferErrorDetails(failed);
    } else if (choice === 'Retry') {
      retry(failed);
    } else if (choice === 'Show Queue') {
      revealQueue();
    }
  };

  transferManager.on('transferComplete', onTransferComplete);
  transferManager.on('queueComplete', onQueueComplete);

  return new vscode.Disposable(() => {
    transferManager.off('transferComplete', onTransferComplete);
    transferManager.off('queueComplete', onQueueComplete);
  });
}
