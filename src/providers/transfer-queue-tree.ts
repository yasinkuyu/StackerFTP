/**
 * StackerFTP - Transfer Queue Tree Provider
 * Native VS Code TreeView for managing file transfers with recursive multi-level folder hierarchy
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { transferManager } from '../core/transfer-manager';
import { TransferItem } from '../types';

function formatBytes(bytes: number): string {
    if (bytes <= 0 || isNaN(bytes)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
    return `${size} ${units[i]}`;
}

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export class TransferFolderTreeItem extends vscode.TreeItem {
    public readonly totalFiles: number;
    public readonly completedFiles: number;
    public readonly skippedFiles: number;
    public readonly errorFiles: number;
    public readonly pendingFiles: number;
    public readonly transferringFiles: number;
    public readonly totalBytes: number;
    public readonly transferredBytes: number;
    public readonly progress: number;
    public readonly status: 'pending' | 'transferring' | 'completed' | 'error';
    public readonly direction: 'upload' | 'download';

    constructor(
        public readonly folderName: string,
        public readonly folderRelPath: string,
        public readonly groupPath: string | undefined,
        public readonly batchId: string | undefined,
        public readonly items: TransferItem[],
        public readonly isRoot: boolean = false,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed,
        public readonly expandVersion: number = 0
    ) {
        super(`📁 ${folderName}`, collapsibleState);

        this.direction = items.length > 0 ? items[0].direction : 'upload';
        this.totalFiles = items.length;
        this.completedFiles = items.filter(i => i.status === 'completed').length;
        this.skippedFiles = items.filter(i => i.status === 'cancelled').length;
        this.errorFiles = items.filter(i => i.status === 'error').length;
        this.pendingFiles = items.filter(i => i.status === 'pending').length;
        this.transferringFiles = items.filter(i => i.status === 'transferring').length;
        this.totalBytes = items.reduce((acc, i) => acc + (i.size || 0), 0);
        this.transferredBytes = items.reduce((acc, i) => acc + (i.transferred || (i.status === 'completed' ? (i.size || 0) : 0)), 0);
        const processedCount = this.completedFiles + this.skippedFiles;
        this.progress = this.totalFiles > 0 ? Math.round((processedCount / this.totalFiles) * 100) : 0;

        if (this.transferringFiles > 0) this.status = 'transferring';
        else if (this.pendingFiles > 0) this.status = 'pending';
        else if (this.errorFiles > 0) this.status = 'error';
        else if (processedCount === this.totalFiles) this.status = 'completed';
        else this.status = 'completed';

        this.id = `folder-${batchId || 'root'}-${folderRelPath || folderName}-v${expandVersion}-${collapsibleState}`;
        this.contextValue = `transfer-group-${this.status}`;
        this.description = this.getDescription();
        this.iconPath = this.getIcon();
        this.tooltip = this.getTooltip();
    }

    private getDescription(): string {
        const dir = this.direction === 'upload' ? '↑' : '↓';
        const sizeStr = this.totalBytes > 0
            ? ` • ${formatBytes(this.transferredBytes)}/${formatBytes(this.totalBytes)}`
            : '';

        switch (this.status) {
            case 'pending':
                return `${dir} Pending (${this.totalFiles} file${this.totalFiles > 1 ? 's' : ''}${sizeStr})`;
            case 'transferring':
                return `${dir} ${this.progress}% (${this.completedFiles}/${this.totalFiles} files${sizeStr})`;
            case 'completed': {
                if (this.skippedFiles > 0) {
                    return `${dir} Done (${this.completedFiles} transferred, ${this.skippedFiles} skipped${sizeStr})`;
                }
                return `${dir} Done (${this.totalFiles}/${this.totalFiles} files${sizeStr})`;
            }
            case 'error':
                return `${dir} Error (${this.errorFiles} failed • ${this.completedFiles}/${this.totalFiles}${sizeStr})`;
            default:
                return `${dir} ${this.progress}%`;
        }
    }

    private getIcon(): vscode.ThemeIcon {
        switch (this.status) {
            case 'pending':
                return new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.gray'));
            case 'transferring':
                return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
            case 'completed':
                return new vscode.ThemeIcon(this.isRoot ? 'check-all' : 'pass-filled', new vscode.ThemeColor('charts.green'));
            case 'error':
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            default:
                return new vscode.ThemeIcon('folder');
        }
    }

    private getTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        const dirLabel = this.direction === 'upload' ? 'Upload Folder' : 'Download Folder';
        md.appendMarkdown(`### 📁 ${this.folderName} (${dirLabel})\n\n`);
        md.appendMarkdown(`- **Status:** ${this.status}\n`);
        md.appendMarkdown(`- **Progress:** ${this.progress}%\n`);
        md.appendMarkdown(`- **Files:** ${this.completedFiles} completed, ${this.skippedFiles} skipped, ${this.transferringFiles} transferring, ${this.pendingFiles} pending`);
        if (this.errorFiles > 0) {
            md.appendMarkdown(`, ${this.errorFiles} failed`);
        }
        md.appendMarkdown(` (Total: ${this.totalFiles})\n`);
        if (this.totalBytes > 0) {
            md.appendMarkdown(`- **Size:** ${formatBytes(this.transferredBytes)} of ${formatBytes(this.totalBytes)}\n`);
        }
        if (this.folderRelPath) {
            md.appendMarkdown(`- **Relative Path:** \`${this.folderRelPath}\`\n`);
        }
        if (this.groupPath) {
            md.appendMarkdown(`- **Root Path:** \`${this.groupPath}\`\n`);
        }
        return md;
    }
}

export class TransferTreeItem extends vscode.TreeItem {
    constructor(
        public readonly transferItem: TransferItem,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        const fileName = path.basename(transferItem.localPath);
        super(fileName, collapsibleState);

        this.id = transferItem.id;
        this.contextValue = `transfer-${transferItem.status}`;
        this.description = this.getDescription();
        this.iconPath = this.getIcon();
        this.tooltip = this.getTooltip();
    }

    private getDescription(): string {
        const direction = this.transferItem.direction === 'upload' ? '↑' : '↓';
        const progress = Math.round(this.transferItem.progress);
        const sizeStr = this.transferItem.size > 0 ? ` (${formatBytes(this.transferItem.size)})` : '';

        switch (this.transferItem.status) {
            case 'pending':
                return `${direction} Pending${sizeStr}`;
            case 'transferring':
                return `${direction} ${progress}%${sizeStr}`;
            case 'completed':
                return `${direction} Done${sizeStr}`;
            case 'cancelled':
                return `${direction} Skipped`;
            case 'error':
                return `${direction} Error`;
            default:
                return direction;
        }
    }

    private getIcon(): vscode.ThemeIcon {
        switch (this.transferItem.status) {
            case 'pending':
                return new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.gray'));
            case 'transferring':
                return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
            case 'completed':
                return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
            case 'cancelled':
                return new vscode.ThemeIcon('debug-step-over', new vscode.ThemeColor('charts.gray'));
            case 'error':
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            default:
                return new vscode.ThemeIcon('file');
        }
    }

    private getTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${path.basename(this.transferItem.localPath)}**\n\n`);
        md.appendMarkdown(`- Direction: ${this.transferItem.direction === 'upload' ? 'Upload' : 'Download'}\n`);
        md.appendMarkdown(`- Status: ${this.transferItem.status}\n`);
        md.appendMarkdown(`- Progress: ${Math.round(this.transferItem.progress)}%\n`);
        if (this.transferItem.size > 0) {
            md.appendMarkdown(`- Size: ${formatBytes(this.transferItem.size)}\n`);
        }
        md.appendMarkdown(`- Local: \`${this.transferItem.localPath}\`\n`);
        md.appendMarkdown(`- Remote: \`${this.transferItem.remotePath}\`\n`);
        if (this.transferItem.error) {
            md.appendMarkdown(`\n⚠️ Error: ${this.transferItem.error}`);
        }
        return md;
    }
}

export type TransferQueueItem = TransferFolderTreeItem | TransferTreeItem;

export class TransferQueueTreeProvider implements vscode.TreeDataProvider<TransferQueueItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<TransferQueueItem | undefined | null | void> = new vscode.EventEmitter<TransferQueueItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TransferQueueItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private disposables: vscode.Disposable[] = [];
    private treeView: vscode.TreeView<TransferQueueItem>;
    private expandMode: 'collapsed' | 'expanded' = 'collapsed';
    private expandVersion = 0;

    constructor() {
        // Create tree view
        this.treeView = vscode.window.createTreeView('stackerftp.transferQueue', {
            treeDataProvider: this,
            showCollapseAll: false,
            canSelectMany: true
        });

        // Listen to transfer manager events
        transferManager.on('queueUpdate', () => this.refresh());
        transferManager.on('transferStart', () => this.refresh());
        transferManager.on('transferComplete', () => this.refresh());
        transferManager.on('transferProgress', () => this.refresh());

        this.disposables.push(this.treeView);
        vscode.commands.executeCommand('setContext', 'stackerftp:transferQueueExpanded', false);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    toggleExpand(): void {
        if (this.expandMode === 'expanded') {
            this.collapseAll();
        } else {
            this.expandAll();
        }
    }

    expandAll(): void {
        this.expandMode = 'expanded';
        this.expandVersion++;
        vscode.commands.executeCommand('setContext', 'stackerftp:transferQueueExpanded', true);
        this.refresh();
    }

    collapseAll(): void {
        this.expandMode = 'collapsed';
        this.expandVersion++;
        vscode.commands.executeCommand('setContext', 'stackerftp:transferQueueExpanded', false);
        this.refresh();
    }

    getTreeItem(element: TransferQueueItem): vscode.TreeItem {
        return element;
    }

    private getCollapsibleState(): vscode.TreeItemCollapsibleState {
        return this.expandMode === 'expanded'
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed;
    }

    getChildren(element?: TransferQueueItem): Thenable<TransferQueueItem[]> {
        if (element instanceof TransferTreeItem) {
            return Promise.resolve([]);
        }

        if (element instanceof TransferFolderTreeItem) {
            // Expand this folder to list immediate subfolders and files
            return Promise.resolve(this.getFolderChildren(element));
        }

        // Root Level
        const queue = transferManager.getQueue();
        const currentItem = transferManager.getCurrentItem();

        const allItems: TransferItem[] = [];
        if (currentItem && !queue.find(q => q.id === currentItem.id)) {
            allItems.push(currentItem);
        }
        allItems.push(...queue);

        if (allItems.length === 0) {
            return Promise.resolve([]);
        }

        // Group all items by batchId or by parent root folder
        const batchMap = new Map<string, { groupName: string; groupPath?: string; items: TransferItem[] }>();
        const standaloneItems: TransferItem[] = [];

        for (const item of allItems) {
            if (item.batchId) {
                let batch = batchMap.get(item.batchId);
                if (!batch) {
                    batch = {
                        groupName: item.groupName || path.basename(item.groupPath || path.dirname(item.localPath)),
                        groupPath: item.groupPath,
                        items: []
                    };
                    batchMap.set(item.batchId, batch);
                }
                batch.items.push(item);
            } else {
                standaloneItems.push(item);
            }
        }

        const rootItems: TransferQueueItem[] = [];
        const state = this.getCollapsibleState();

        // Add root batch folders
        for (const [batchId, batch] of batchMap.entries()) {
            rootItems.push(
                new TransferFolderTreeItem(batch.groupName, '', batch.groupPath, batchId, batch.items, true, state, this.expandVersion)
            );
        }

        // Handle standalone items: if multiple items share directory, group by directory
        const folderMap = new Map<string, TransferItem[]>();
        for (const item of standaloneItems) {
            const dir = path.dirname(item.localPath);
            let list = folderMap.get(dir);
            if (!list) {
                list = [];
                folderMap.set(dir, list);
            }
            list.push(item);
        }

        for (const [dir, items] of folderMap.entries()) {
            if (items.length > 1) {
                rootItems.push(
                    new TransferFolderTreeItem(
                        path.basename(dir) || dir,
                        '',
                        dir,
                        `dir-${dir}`,
                        items,
                        true,
                        state,
                        this.expandVersion
                    )
                );
            } else {
                rootItems.push(new TransferTreeItem(items[0], vscode.TreeItemCollapsibleState.None));
            }
        }

        return Promise.resolve(rootItems);
    }

    /**
     * Compute immediate sub-folders and files inside a folder node
     */
    private getFolderChildren(folderItem: TransferFolderTreeItem): TransferQueueItem[] {
        const rootPath = folderItem.groupPath;
        const currentRelPrefix = folderItem.folderRelPath ? normalizePath(folderItem.folderRelPath) : '';

        const subfolderMap = new Map<string, TransferItem[]>();
        const directFiles: TransferItem[] = [];

        for (const item of folderItem.items) {
            let relFromRoot = '';
            if (rootPath) {
                const rel = path.relative(rootPath, item.localPath);
                relFromRoot = normalizePath(rel);
            } else {
                relFromRoot = normalizePath(item.localPath);
            }

            // Calculate path relative to current folder
            let relFromCurrent = relFromRoot;
            if (currentRelPrefix) {
                if (relFromRoot.startsWith(currentRelPrefix + '/')) {
                    relFromCurrent = relFromRoot.substring(currentRelPrefix.length + 1);
                } else if (relFromRoot === currentRelPrefix) {
                    relFromCurrent = path.basename(relFromRoot);
                }
            }

            const parts = relFromCurrent.split('/').filter(Boolean);

            if (parts.length <= 1) {
                // Direct file inside this folder
                directFiles.push(item);
            } else {
                // Belongs to an immediate subfolder
                const immediateSubfolder = parts[0];
                let subList = subfolderMap.get(immediateSubfolder);
                if (!subList) {
                    subList = [];
                    subfolderMap.set(immediateSubfolder, subList);
                }
                subList.push(item);
            }
        }

        const result: TransferQueueItem[] = [];
        const state = this.getCollapsibleState();

        // 1. Add subfolders (sorted alphabetically)
        const sortedSubfolderNames = Array.from(subfolderMap.keys()).sort((a, b) => a.localeCompare(b));
        for (const subName of sortedSubfolderNames) {
            const subItems = subfolderMap.get(subName)!;
            const subRelPath = currentRelPrefix ? `${currentRelPrefix}/${subName}` : subName;
            result.push(
                new TransferFolderTreeItem(subName, subRelPath, rootPath, folderItem.batchId, subItems, false, state, this.expandVersion)
            );
        }

        // 2. Add direct files (sorted alphabetically)
        directFiles.sort((a, b) => path.basename(a.localPath).localeCompare(path.basename(b.localPath)));
        for (const fileItem of directFiles) {
            result.push(new TransferTreeItem(fileItem, vscode.TreeItemCollapsibleState.None));
        }

        return result;
    }

    getParent(): vscode.ProviderResult<TransferQueueItem> {
        return null;
    }

    /**
     * Cancel a specific transfer item or folder tree
     */
    cancelItem(item: TransferQueueItem): void {
        if (item instanceof TransferFolderTreeItem) {
            for (const file of item.items) {
                transferManager.cancelItem(file.id);
            }
            if (item.batchId && item.isRoot) {
                transferManager.cancelBatch(item.batchId);
            }
        } else if (item instanceof TransferTreeItem) {
            transferManager.cancelItem(item.transferItem.id);
        }
        this.refresh();
    }

    /**
     * Clear all completed/error items
     */
    clearCompleted(): void {
        transferManager.clearCompleted();
        this.refresh();
    }

    /**
     * Update the Activity Bar badge for the transfer queue
     */
    updateBadge(count: number): void {
        this.treeView.badge = count > 0 ? { value: count, tooltip: `${count} active transfer${count > 1 ? 's' : ''}` } : undefined;
    }

    /**
     * Show/reveal the transfer queue panel
     */
    reveal(): void {
        this.treeView.reveal(undefined as any, { focus: true });
    }

    /**
     * Get number of active transfers
     */
    getActiveCount(): number {
        return transferManager.getActiveCount();
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this._onDidChangeTreeData.dispose();
    }
}
