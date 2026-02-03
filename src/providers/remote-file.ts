/**
 * StackerFTP - Remote File Tree Item
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { FileEntry } from '../types';
import { formatFileSize, formatDate, getFileIcon, formatPermissions } from '../utils/helpers';

export class RemoteFileItem extends vscode.TreeItem {
  constructor(
    public readonly entry: FileEntry,
    public readonly configName: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(entry.name, collapsibleState);
    
    this.tooltip = this.createTooltip();
    this.description = this.createDescription();
    this.iconPath = this.getIconPath();
    this.contextValue = entry.type;
    this.resourceUri = vscode.Uri.parse(`stackerftp://${entry.path}`);
    
    if (entry.type === 'file') {
      this.command = {
        command: 'stackerftp.openRemoteFile',
        title: 'Open Remote File',
        arguments: [this]
      };
    }
  }

  private createTooltip(): string {
    const lines = [
      `Name: ${this.entry.name}`,
      `Type: ${this.entry.type}`,
      `Path: ${this.entry.path}`
    ];

    if (this.entry.type === 'file') {
      lines.push(`Size: ${formatFileSize(this.entry.size)}`);
    }

    lines.push(`Modified: ${formatDate(this.entry.modifyTime)}`);

    if (this.entry.rights) {
      lines.push(`Permissions: ${formatPermissions(parseInt(this.entry.rights.user + this.entry.rights.group + this.entry.rights.other, 8))}`);
    }

    if (this.entry.owner !== undefined) {
      lines.push(`Owner: ${this.entry.owner}`);
    }

    return lines.join('\n');
  }

  private createDescription(): string {
    if (this.entry.type === 'directory') {
      return '';
    }
    return `${formatFileSize(this.entry.size)}  ${formatDate(this.entry.modifyTime)}`;
  }

  private getIconPath(): vscode.ThemeIcon {
    const iconId = getFileIcon(this.entry.name, this.entry.type === 'directory');
    // Remove $( and ) from icon identifier
    const cleanIcon = iconId.replace(/\$\(([^)]+)\)/, '$1');
    return new vscode.ThemeIcon(cleanIcon);
  }
}

export class RemoteConfigItem extends vscode.TreeItem {
  constructor(
    public readonly configName: string,
    public readonly host: string,
    public readonly protocol: string,
    public readonly connected: boolean
  ) {
    super(configName, vscode.TreeItemCollapsibleState.Collapsed);
    
    this.tooltip = `${configName} (${protocol.toUpperCase()})\nHost: ${host}\nStatus: ${connected ? 'Connected' : 'Disconnected'}`;
    this.description = connected ? '$(debug-start) Connected' : '$(debug-disconnect) Disconnected';
    this.iconPath = new vscode.ThemeIcon(connected ? 'cloud' : 'cloud-upload');
    this.contextValue = 'config';
  }
}

export class RemoteMessageItem extends vscode.TreeItem {
  constructor(message: string, icon: string = 'info') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'message';
  }
}
