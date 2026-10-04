/**
 * StackerFTP - Compare View (native TreeView)
 *
 * Shows the differences between the local project (or a folder) and the
 * target server. Uses the sync engine's scan and rules, so Compare and Sync
 * always agree. Native UI: theme colors, file icon theme, view progress bar,
 * keyboard navigation and accessibility come from VS Code itself.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { connectionManager } from '../core/connection-manager';
import { BaseConnection } from '../core/connection';
import { resolveTargetConfig } from '../core/target';
import { transferManager } from '../core/transfer-manager';
import { FileStamp, ScanResult, getTimeTolerance, isSameFile, scanBothSides } from '../core/sync-engine';
import { runSync } from '../commands/sync';
import { FTPConfig } from '../types';
import { formatFileSize, getLocalRelativePath, getLocalRoot, normalizeRemotePath, sanitizeRelativePath } from '../utils/helpers';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';

const VIEW_ID = 'stackerftp.compareView';
const URI_SCHEME = 'stackerftp-compare';

type CompareStatus = 'localOnly' | 'remoteOnly' | 'modified';
type CompareFilter = 'all' | CompareStatus;

interface CompareEntry {
  rel: string;
  status: CompareStatus;
  local?: FileStamp;
  remote?: FileStamp;
  newer?: 'local' | 'remote';
}

interface CompareSession {
  workspaceRoot: string;
  localRoot: string;
  remoteRoot: string;
  config: FTPConfig;
  entries: Map<string, CompareEntry>;
  checked: number;
}

const STATUS_LABEL: Record<CompareStatus, string> = {
  localOnly: 'Only local',
  remoteOnly: 'Only remote',
  modified: 'Modified'
};

/** Theme colors so the view follows every color theme (incl. high contrast) */
const STATUS_DECORATION: Record<CompareStatus, { badge: string; color: string }> = {
  localOnly: { badge: 'L', color: 'gitDecoration.untrackedResourceForeground' },
  remoteOnly: { badge: 'R', color: 'gitDecoration.submoduleResourceForeground' },
  modified: { badge: 'M', color: 'gitDecoration.modifiedResourceForeground' }
};

function formatStamp(stamp?: FileStamp): string {
  if (!stamp) return '—';
  return `${formatFileSize(stamp.size)} • ${new Date(stamp.mtime).toLocaleString()}`;
}

export class CompareFolderItem extends vscode.TreeItem {
  constructor(public readonly rel: string, name: string, changeCount: number, expanded: boolean) {
    super(name, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `folder:${rel}`;
    this.resourceUri = vscode.Uri.from({ scheme: URI_SCHEME, path: `/${rel}`, query: 'folder' });
    this.iconPath = vscode.ThemeIcon.Folder;
    this.description = `${changeCount} change${changeCount === 1 ? '' : 's'}`;
    this.contextValue = 'compare-folder';
  }
}

export class CompareFileItem extends vscode.TreeItem {
  constructor(public readonly entry: CompareEntry) {
    super(path.posix.basename(entry.rel), vscode.TreeItemCollapsibleState.None);
    this.id = `file:${entry.rel}`;
    this.resourceUri = vscode.Uri.from({ scheme: URI_SCHEME, path: `/${entry.rel}`, query: entry.status });
    this.iconPath = vscode.ThemeIcon.File;
    this.contextValue = `compare-file-${entry.status}`;

    const newer = entry.newer ? ` • ${entry.newer} newer` : '';
    this.description = `${STATUS_LABEL[entry.status]}${newer}`;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${entry.rel}**\n\n`);
    md.appendMarkdown(`- Local: ${formatStamp(entry.local)}\n`);
    md.appendMarkdown(`- Remote: ${formatStamp(entry.remote)}\n`);
    this.tooltip = md;
    this.accessibilityInformation = { label: `${entry.rel}, ${STATUS_LABEL[entry.status]}${newer}` };

    // Default action: diff for modified files, open otherwise
    const command = entry.status === 'modified' ? 'stackerftp.compare.diff'
      : entry.status === 'localOnly' ? 'stackerftp.compare.openLocal' : 'stackerftp.compare.openRemote';
    this.command = { command, title: 'Open', arguments: [this] };
  }
}

type CompareNode = CompareFolderItem | CompareFileItem;

export class CompareTreeProvider implements vscode.TreeDataProvider<CompareNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<CompareNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private readonly treeView: vscode.TreeView<CompareNode>;
  private readonly disposables: vscode.Disposable[] = [];
  private session?: CompareSession;
  private filter: CompareFilter = 'all';
  private busy = false;

  constructor() {
    this.treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.treeView,
      vscode.window.registerFileDecorationProvider(this),
      ...this.registerCommands()
    );
    this.updateContext();
  }

  // ==================== TreeDataProvider ====================

  getTreeItem(element: CompareNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CompareNode): CompareNode[] {
    if (!this.session || element instanceof CompareFileItem) return [];

    const prefix = element ? `${element.rel}/` : '';
    const folders = new Map<string, number>();
    const files: CompareFileItem[] = [];

    for (const entry of this.visibleEntries()) {
      if (!entry.rel.startsWith(prefix)) continue;
      const rest = entry.rel.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        files.push(new CompareFileItem(entry));
      } else {
        const name = rest.slice(0, slash);
        folders.set(name, (folders.get(name) || 0) + 1);
      }
    }

    // Small result sets are expanded so changes are visible immediately
    const expand = this.visibleEntries().length <= 50;
    const folderItems = Array.from(folders.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => new CompareFolderItem(`${prefix}${name}`, name, count, expand));
    files.sort((a, b) => a.entry.rel.localeCompare(b.entry.rel));
    return [...folderItems, ...files];
  }

  getParent(element: CompareNode): CompareNode | undefined {
    const rel = element instanceof CompareFileItem ? element.entry.rel : element.rel;
    const parent = path.posix.dirname(rel);
    if (parent === '.' || !parent) return undefined;
    const count = this.visibleEntries().filter(e => e.rel.startsWith(`${parent}/`)).length;
    return new CompareFolderItem(parent, path.posix.basename(parent), count, false);
  }

  // ==================== FileDecorationProvider ====================

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== URI_SCHEME) return undefined;
    const status = uri.query as CompareStatus;
    const deco = STATUS_DECORATION[status];
    if (!deco) return undefined;
    return new vscode.FileDecoration(deco.badge, STATUS_LABEL[status], new vscode.ThemeColor(deco.color));
  }

  // ==================== Compare ====================

  /** Compare the project (or the given local folder) with the target server */
  async compare(localFolder?: string): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.find(f =>
      !localFolder || localFolder === f.uri.fsPath || localFolder.startsWith(f.uri.fsPath + path.sep)
    )?.uri.fsPath;
    if (!workspaceRoot) {
      statusBar.error('Open a workspace folder to compare');
      return;
    }

    const config = await resolveTargetConfig(workspaceRoot, 'Compare');
    if (!config) return;

    const projectRoot = getLocalRoot(workspaceRoot, config);
    const localRoot = localFolder || projectRoot;
    let remoteRoot = normalizeRemotePath(config.remotePath);
    if (localRoot !== projectRoot) {
      const rel = sanitizeRelativePath(getLocalRelativePath(workspaceRoot, localRoot, config)).replace(/\\/g, '/');
      remoteRoot = normalizeRemotePath(path.posix.join(config.remotePath, rel));
    }

    this.session = { workspaceRoot, localRoot, remoteRoot, config, entries: new Map(), checked: 0 };
    this.filter = 'all';
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.rescan();
  }

  private async rescan(): Promise<void> {
    const session = this.session;
    if (!session || this.busy) return;

    await this.withBusy('Scanning local and remote files…', async () => {
      try {
        const connection = await connectionManager.ensureConnection(session.config);
        const scan = await scanBothSides(connection, session.config, session.localRoot, session.remoteRoot,
          message => { this.treeView.message = message; });
        session.entries = this.classify(scan, session.config);
        session.checked = new Set([...scan.local.keys(), ...scan.remote.keys()]).size;
      } catch (error: any) {
        logger.error('Compare failed', error);
        vscode.window.showErrorMessage(`StackerFTP: Compare failed – ${error.message}`, 'Retry').then(choice => {
          if (choice === 'Retry') this.rescan();
        });
      }
    });
  }

  private classify(scan: ScanResult, config: FTPConfig): Map<string, CompareEntry> {
    const tol = getTimeTolerance(config);
    const entries = new Map<string, CompareEntry>();
    for (const [rel, local] of scan.local) {
      const remote = scan.remote.get(rel);
      if (!remote) {
        entries.set(rel, { rel, status: 'localOnly', local });
      } else if (!isSameFile(local, remote, tol)) {
        const newer = local.mtime > remote.mtime + tol ? 'local' : remote.mtime > local.mtime + tol ? 'remote' : undefined;
        entries.set(rel, { rel, status: 'modified', local, remote, newer });
      }
    }
    for (const [rel, remote] of scan.remote) {
      if (!scan.local.has(rel)) entries.set(rel, { rel, status: 'remoteOnly', remote });
    }
    return entries;
  }

  private visibleEntries(): CompareEntry[] {
    if (!this.session) return [];
    const all = Array.from(this.session.entries.values());
    return this.filter === 'all' ? all : all.filter(e => e.status === this.filter);
  }

  /** Native busy state: progress bar on the view + message, actions disabled */
  private async withBusy<T>(message: string, task: () => Promise<T>): Promise<T | undefined> {
    this.busy = true;
    this.treeView.message = message;
    this.updateContext();
    try {
      return await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, task);
    } finally {
      this.busy = false;
      this.refreshView();
    }
  }

  private refreshView(): void {
    this._onDidChangeTreeData.fire();
    this._onDidChangeFileDecorations.fire(undefined);
    this.updateContext();

    const s = this.session;
    if (!s) {
      this.treeView.message = undefined;
      this.treeView.description = undefined;
      this.treeView.badge = undefined;
      return;
    }

    const all = Array.from(s.entries.values());
    const count = (status: CompareStatus) => all.filter(e => e.status === status).length;
    this.treeView.description = `${s.config.name || s.config.host} • ${s.remoteRoot}`;
    this.treeView.badge = all.length > 0 ? { value: all.length, tooltip: `${all.length} difference(s)` } : undefined;

    if (this.busy) return;
    if (all.length === 0) {
      this.treeView.message = `In sync – ${s.checked} file(s) checked, no differences.`;
    } else {
      const summary = `${count('modified')} modified, ${count('localOnly')} only local, ${count('remoteOnly')} only remote`;
      this.treeView.message = this.filter === 'all'
        ? summary
        : `Filter: ${STATUS_LABEL[this.filter as CompareStatus]} (${this.visibleEntries().length} of ${all.length}) – ${summary}`;
    }
  }

  private updateContext(): void {
    vscode.commands.executeCommand('setContext', 'stackerftp.compareActive', !!this.session);
    vscode.commands.executeCommand('setContext', 'stackerftp.compareBusy', this.busy);
    vscode.commands.executeCommand('setContext', 'stackerftp.compareFiltered', this.filter !== 'all');
  }

  // ==================== Actions ====================

  private localPathOf(rel: string): string {
    return path.join(this.session!.localRoot, ...rel.split('/'));
  }

  private remotePathOf(rel: string): string {
    return normalizeRemotePath(path.posix.join(this.session!.remoteRoot, rel));
  }

  private async connection(): Promise<BaseConnection> {
    return connectionManager.ensureConnection(this.session!.config);
  }

  /** Remote copy in a stable temp location (re-downloaded each time) */
  private async downloadToTemp(rel: string): Promise<string> {
    const s = this.session!;
    const hash = crypto.createHash('md5').update(`${s.config.host}:${s.remoteRoot}`).digest('hex').slice(0, 8);
    const target = path.join(os.tmpdir(), 'stackerftp-compare', hash, ...rel.split('/'));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const connection = await this.connection();
    await connection.download(this.remotePathOf(rel), target);
    return target;
  }

  private async diff(item: CompareFileItem): Promise<void> {
    if (!this.session) return;
    const rel = item.entry.rel;
    await this.withBusy(`Downloading ${path.posix.basename(rel)} for diff…`, async () => {
      try {
        const remoteCopy = await this.downloadToTemp(rel);
        const name = path.posix.basename(rel);
        await vscode.commands.executeCommand('vscode.diff',
          vscode.Uri.file(remoteCopy),
          vscode.Uri.file(this.localPathOf(rel)),
          `${name} (Remote ↔ Local)`,
          { preview: true });
      } catch (error: any) {
        vscode.window.showErrorMessage(`StackerFTP: Diff failed – ${error.message}`);
      }
    });
  }

  private async openRemote(item: CompareFileItem): Promise<void> {
    if (!this.session) return;
    await this.withBusy(`Downloading ${path.posix.basename(item.entry.rel)}…`, async () => {
      try {
        const copy = await this.downloadToTemp(item.entry.rel);
        await vscode.window.showTextDocument(vscode.Uri.file(copy), { preview: true });
      } catch (error: any) {
        vscode.window.showErrorMessage(`StackerFTP: Could not open remote file – ${error.message}`);
      }
    });
  }

  private async transfer(items: CompareFileItem[], direction: 'upload' | 'download'): Promise<void> {
    const s = this.session;
    if (!s || items.length === 0) return;

    const label = items.length === 1 ? path.posix.basename(items[0].entry.rel) : `${items.length} files`;
    await this.withBusy(`${direction === 'upload' ? 'Uploading' : 'Downloading'} ${label}…`, async () => {
      let connection: BaseConnection;
      try {
        connection = await this.connection();
      } catch (error: any) {
        vscode.window.showErrorMessage(`StackerFTP: Connection failed – ${error.message}`);
        return;
      }
      transferManager.resetBatchCollision();
      await Promise.all(items.map(async ({ entry }) => {
        try {
          // Explicit user action on a known difference: overwrite without asking again
          if (direction === 'upload') {
            await transferManager.uploadFile(connection, this.localPathOf(entry.rel), this.remotePathOf(entry.rel), s.config,
              { targetExists: false, size: entry.local?.size, sourceMtime: entry.local?.mtime });
          } else {
            await transferManager.downloadFile(connection, this.remotePathOf(entry.rel), this.localPathOf(entry.rel), s.config,
              { targetExists: false, targetType: 'file', size: entry.remote?.size, sourceMtime: entry.remote?.mtime });
          }
          s.entries.delete(entry.rel); // Both sides are now identical
        } catch {
          // Reported by the transfer error reporter
        }
      }));
    });
  }

  private async sync(direction: 'toRemote' | 'toLocal', folder?: CompareFolderItem): Promise<void> {
    const s = this.session;
    if (!s) return;
    const target = folder ? this.localPathOf(folder.rel) : s.localRoot;
    const result = await runSync(direction, vscode.Uri.file(target), { workspaceRoot: s.workspaceRoot, config: s.config });
    if (result) await this.rescan();
  }

  private async pickFilter(): Promise<void> {
    if (!this.session) return;
    const all = Array.from(this.session.entries.values());
    const items: (vscode.QuickPickItem & { value: CompareFilter })[] = [
      { label: 'All differences', description: String(all.length), value: 'all' },
      ...(['modified', 'localOnly', 'remoteOnly'] as CompareStatus[]).map(status => ({
        label: STATUS_LABEL[status],
        description: String(all.filter(e => e.status === status).length),
        value: status
      }))
    ];
    const picked = await vscode.window.showQuickPick(items.map(i => ({ ...i, picked: i.value === this.filter })), {
      title: 'Compare – Show'
    });
    if (!picked) return;
    this.filter = picked.value;
    this.refreshView();
  }

  private async exportResults(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const format = await vscode.window.showQuickPick(['CSV', 'JSON'], { title: 'Export comparison as' });
    if (!format) return;

    const ext = format.toLowerCase();
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(s.workspaceRoot, `compare-${Date.now()}.${ext}`)),
      filters: { [format]: [ext] }
    });
    if (!uri) return;

    const entries = Array.from(s.entries.values()).sort((a, b) => a.rel.localeCompare(b.rel));
    let content: string;
    if (ext === 'json') {
      content = JSON.stringify({
        server: `${s.config.username}@${s.config.host}`,
        localRoot: s.localRoot,
        remoteRoot: s.remoteRoot,
        exportedAt: new Date().toISOString(),
        entries
      }, null, 2);
    } else {
      const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      content = ['Status,Path,Local Size,Local Modified,Remote Size,Remote Modified', ...entries.map(e => [
        STATUS_LABEL[e.status], e.rel,
        e.local?.size, e.local ? new Date(e.local.mtime).toISOString() : '',
        e.remote?.size, e.remote ? new Date(e.remote.mtime).toISOString() : ''
      ].map(q).join(','))].join('\n');
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(`StackerFTP: Exported ${entries.length} difference(s)`, 'Open').then(choice => {
      if (choice === 'Open') vscode.window.showTextDocument(uri);
    });
  }

  private clear(): void {
    this.session = undefined;
    this.filter = 'all';
    this.refreshView();
  }

  /** Selected file items (multi-select aware), expanded from folders */
  private selection(item?: CompareNode, selected?: CompareNode[]): CompareFileItem[] {
    const nodes = selected && selected.length > 0 ? selected : (item ? [item] : []);
    const result = new Map<string, CompareFileItem>();
    for (const node of nodes) {
      if (node instanceof CompareFileItem) {
        result.set(node.entry.rel, node);
      } else if (node instanceof CompareFolderItem) {
        for (const e of this.visibleEntries()) {
          if (e.rel.startsWith(`${node.rel}/`)) result.set(e.rel, new CompareFileItem(e));
        }
      }
    }
    return Array.from(result.values());
  }

  private registerCommands(): vscode.Disposable[] {
    const guard = <A extends unknown[]>(fn: (...args: A) => unknown) => (...args: A) => {
      if (this.busy) {
        vscode.window.setStatusBarMessage('$(sync~spin) Compare is busy…', 2000);
        return;
      }
      return fn(...args);
    };
    const r = vscode.commands.registerCommand;
    return [
      r('stackerftp.compare.refresh', guard(() => this.rescan())),
      r('stackerftp.compare.filter', guard(() => this.pickFilter())),
      r('stackerftp.compare.clearFilter', () => { this.filter = 'all'; this.refreshView(); }),
      r('stackerftp.compare.export', guard(() => this.exportResults())),
      r('stackerftp.compare.close', () => this.clear()),
      r('stackerftp.compare.syncToRemote', guard((item?: CompareNode) =>
        this.sync('toRemote', item instanceof CompareFolderItem ? item : undefined))),
      r('stackerftp.compare.syncToLocal', guard((item?: CompareNode) =>
        this.sync('toLocal', item instanceof CompareFolderItem ? item : undefined))),
      r('stackerftp.compare.diff', guard((item: CompareFileItem) => this.diff(item))),
      r('stackerftp.compare.openRemote', guard((item: CompareFileItem) => this.openRemote(item))),
      r('stackerftp.compare.openLocal', (item: CompareFileItem) =>
        vscode.window.showTextDocument(vscode.Uri.file(this.localPathOf(item.entry.rel)), { preview: true })),
      r('stackerftp.compare.revealLocal', (item: CompareNode) => {
        const rel = item instanceof CompareFileItem ? item.entry.rel : item.rel;
        vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(this.localPathOf(rel)));
      }),
      r('stackerftp.compare.upload', guard((item?: CompareNode, selected?: CompareNode[]) =>
        this.transfer(this.selection(item, selected).filter(i => i.entry.status !== 'remoteOnly'), 'upload'))),
      r('stackerftp.compare.download', guard((item?: CompareNode, selected?: CompareNode[]) =>
        this.transfer(this.selection(item, selected).filter(i => i.entry.status !== 'localOnly'), 'download')))
    ];
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this._onDidChangeTreeData.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}

let instance: CompareTreeProvider | undefined;

export function registerCompareView(context: vscode.ExtensionContext): CompareTreeProvider {
  instance = new CompareTreeProvider();
  context.subscriptions.push(instance);
  return instance;
}

export function getCompareView(): CompareTreeProvider | undefined {
  return instance;
}
