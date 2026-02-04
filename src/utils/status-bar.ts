/**
 * StackerFTP - Status Bar Notifier
 * Centralized status bar notifications instead of toast messages
 */

import * as vscode from 'vscode';
import { logger } from './logger';

type NotificationType = 'info' | 'success' | 'warning' | 'error' | 'progress';

interface QueuedMessage {
  text: string;
  type: NotificationType;
  duration: number;
}

class StatusBarNotifier {
  private static instance: StatusBarNotifier;
  private statusBarItem: vscode.StatusBarItem;
  private messageQueue: QueuedMessage[] = [];
  private isProcessing = false;
  private defaultText = '';
  private currentTimeout: NodeJS.Timeout | undefined;
  private progressItems: Map<string, vscode.StatusBarItem> = new Map();

  private constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99 // Slightly lower priority than connection status bar
    );
    this.statusBarItem.name = 'StackerFTP Notifications';
    this.statusBarItem.command = 'stackerftp.showOutput';
  }

  static getInstance(): StatusBarNotifier {
    if (!StatusBarNotifier.instance) {
      StatusBarNotifier.instance = new StatusBarNotifier();
    }
    return StatusBarNotifier.instance;
  }

  private getIcon(type: NotificationType): string {
    switch (type) {
      case 'success': return '$(check)';
      case 'warning': return '$(warning)';
      case 'error': return '$(error)';
      case 'progress': return '$(sync~spin)';
      case 'info':
      default: return '$(info)';
    }
  }

  private getColor(type: NotificationType): vscode.ThemeColor | undefined {
    switch (type) {
      case 'success': return new vscode.ThemeColor('terminal.ansiGreen');
      case 'warning': return new vscode.ThemeColor('editorWarning.foreground');
      case 'error': return new vscode.ThemeColor('editorError.foreground');
      default: return undefined;
    }
  }

  /**
   * Show a message in the status bar
   * @param message The message to display
   * @param type The type of notification
   * @param duration How long to show (ms), 0 = until next message
   * @param logToOutput Whether to also log to output channel
   */
  notify(
    message: string,
    type: NotificationType = 'info',
    duration: number = 3000,
    logToOutput: boolean = true
  ): void {
    // Log to output channel
    if (logToOutput) {
      switch (type) {
        case 'error':
          logger.error(message);
          break;
        case 'warning':
          logger.warn(message);
          break;
        default:
          logger.info(message);
      }
    }

    // Add to queue
    this.messageQueue.push({ text: message, type, duration });
    this.processQueue();
  }

  private processQueue(): void {
    if (this.isProcessing || this.messageQueue.length === 0) return;

    this.isProcessing = true;
    const msg = this.messageQueue.shift()!;

    this.showMessage(msg.text, msg.type);

    if (msg.duration > 0) {
      this.currentTimeout = setTimeout(() => {
        this.isProcessing = false;
        if (this.messageQueue.length > 0) {
          this.processQueue();
        } else {
          this.hideTemporary();
        }
      }, msg.duration);
    } else {
      this.isProcessing = false;
    }
  }

  private showMessage(text: string, type: NotificationType): void {
    const icon = this.getIcon(type);
    this.statusBarItem.text = `${icon} ${text}`;
    this.statusBarItem.color = this.getColor(type);
    this.statusBarItem.tooltip = `Click to open StackerFTP Output\n${text}`;
    this.statusBarItem.show();
  }

  private hideTemporary(): void {
    if (this.defaultText) {
      this.statusBarItem.text = this.defaultText;
    } else {
      this.statusBarItem.hide();
    }
  }

  /**
   * Quick notification methods
   */
  info(message: string, duration: number = 3000): void {
    this.notify(message, 'info', duration);
  }

  success(message: string, duration: number = 3000): void {
    this.notify(message, 'success', duration);
  }

  warn(message: string, duration: number = 4000): void {
    this.notify(message, 'warning', duration);
  }

  /**
   * Show error - critical errors still show as toast
   */
  error(message: string, showToast: boolean = false): void {
    this.notify(message, 'error', 5000);
    if (showToast) {
      vscode.window.showErrorMessage(message);
    }
  }

  /**
   * Start a progress indicator
   * @param id Unique identifier for this progress
   * @param message Initial message
   * @returns Update and complete functions
   */
  startProgress(id: string, message: string): {
    update: (msg: string) => void;
    complete: (msg?: string) => void;
    fail: (msg: string) => void;
  } {
    // Clear any existing progress with same id
    this.stopProgress(id);

    const progressItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      98
    );
    progressItem.name = `StackerFTP Progress: ${id}`;
    progressItem.text = `$(sync~spin) ${message}`;
    progressItem.tooltip = message;
    progressItem.command = 'stackerftp.showOutput';
    progressItem.show();

    this.progressItems.set(id, progressItem);
    logger.info(`[Progress] ${message}`);

    return {
      update: (msg: string) => {
        const item = this.progressItems.get(id);
        if (item) {
          item.text = `$(sync~spin) ${msg}`;
          item.tooltip = msg;
          logger.info(`[Progress] ${msg}`);
        }
      },
      complete: (msg?: string) => {
        this.stopProgress(id);
        if (msg) {
          this.success(msg, 2000);
        }
      },
      fail: (msg: string) => {
        this.stopProgress(id);
        this.error(msg);
      }
    };
  }

  private stopProgress(id: string): void {
    const item = this.progressItems.get(id);
    if (item) {
      item.dispose();
      this.progressItems.delete(id);
    }
  }

  /**
   * Show file transfer progress in status bar
   */
  showFileProgress(fileName: string, current: number, total: number): void {
    const progress = total > 0 ? Math.round((current / total) * 100) : 0;
    const shortName = fileName.length > 30
      ? '...' + fileName.slice(-27)
      : fileName;

    this.statusBarItem.text = `$(cloud-upload) ${shortName} (${current}/${total})`;
    this.statusBarItem.tooltip = `Uploading: ${fileName}\n${current} of ${total} files (${progress}%)`;
    this.statusBarItem.show();
  }

  /**
   * Stream file names during folder upload/download
   */
  streamFileName(operation: 'upload' | 'download', fileName: string): void {
    const icon = operation === 'upload' ? '$(cloud-upload)' : '$(cloud-download)';
    const shortName = fileName.length > 40
      ? '...' + fileName.slice(-37)
      : fileName;

    this.statusBarItem.text = `${icon} ${shortName}`;
    this.statusBarItem.tooltip = `${operation === 'upload' ? 'Uploading' : 'Downloading'}: ${fileName}`;
    this.statusBarItem.show();

    // Log to output
    logger.info(`[${operation.toUpperCase()}] ${fileName}`);
  }

  dispose(): void {
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
    }
    this.statusBarItem.dispose();
    for (const item of this.progressItems.values()) {
      item.dispose();
    }
    this.progressItems.clear();
  }
}

export const statusBar = StatusBarNotifier.getInstance();
