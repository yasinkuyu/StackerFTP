/**
 * StackerFTP - Transfer Queue Tree Provider
 * Native VS Code TreeView for managing file transfers
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { transferManager } from '../core/transfer-manager';
import { TransferItem } from '../types';

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

        switch (this.transferItem.status) {
            case 'pending':
                return `${direction} Pending`;
            case 'transferring':
                return `${direction} ${progress}%`;
            case 'completed':
                return `${direction} Done`;
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
        md.appendMarkdown(`- Local: \`${this.transferItem.localPath}\`\n`);
        md.appendMarkdown(`- Remote: \`${this.transferItem.remotePath}\`\n`);
        if (this.transferItem.error) {
            md.appendMarkdown(`\n⚠️ Error: ${this.transferItem.error}`);
        }
        return md;
    }
}

export class TransferQueueTreeProvider implements vscode.TreeDataProvider<TransferTreeItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<TransferTreeItem | undefined | null | void> = new vscode.EventEmitter<TransferTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TransferTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private disposables: vscode.Disposable[] = [];
    private treeView: vscode.TreeView<TransferTreeItem>;

    constructor() {
        // Create tree view
        this.treeView = vscode.window.createTreeView('stackerftp.transferQueue', {
            treeDataProvider: this,
            showCollapseAll: false
        });

        // Listen to transfer manager events
        transferManager.on('queueUpdate', () => this.refresh());
        transferManager.on('transferStart', () => this.refresh());
        transferManager.on('transferComplete', () => this.refresh());
        transferManager.on('transferProgress', () => this.refresh());

        this.disposables.push(this.treeView);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TransferTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TransferTreeItem): Thenable<TransferTreeItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        const queue = transferManager.getQueue();
        const currentItem = transferManager.getCurrentItem();

        // Combine current item with queue
        const allItems: TransferItem[] = [];
        if (currentItem && !queue.find(q => q.id === currentItem.id)) {
            allItems.push(currentItem);
        }
        allItems.push(...queue);

        return Promise.resolve(
            allItems.map(item => new TransferTreeItem(item))
        );
    }

    getParent(): vscode.ProviderResult<TransferTreeItem> {
        return null;
    }

    /**
     * Cancel a specific transfer item
     */
    cancelItem(item: TransferTreeItem): void {
        transferManager.cancelItem(item.transferItem.id);
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
     * Show/reveal the transfer queue panel
     */
    reveal(): void {
        this.treeView.reveal(undefined as any, { focus: true });
    }

    /**
     * Get number of active transfers
     */
    getActiveCount(): number {
        const queue = transferManager.getQueue();
        return queue.filter(q => q.status === 'pending' || q.status === 'transferring').length;
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this._onDidChangeTreeData.dispose();
    }
}
