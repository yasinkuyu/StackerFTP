/**
 * StackerFTP - Logger Utility
 */

import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  details?: any;
}

class Logger {
  private outputChannel: vscode.OutputChannel;
  private logs: LogEntry[] = [];
  private maxLogs = 1000;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('StackerFTP');
  }

  private formatMessage(entry: LogEntry): string {
    const time = entry.timestamp.toISOString();
    const level = entry.level.toUpperCase().padEnd(5);
    return `[${time}] [${level}] ${entry.message}`;
  }

  private addLog(entry: LogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    
    const formatted = this.formatMessage(entry);
    this.outputChannel.appendLine(formatted);
    
    if (entry.details) {
      this.outputChannel.appendLine(JSON.stringify(entry.details, null, 2));
    }
  }

  debug(message: string, details?: any): void {
    this.addLog({ timestamp: new Date(), level: 'debug', message, details });
  }

  info(message: string, details?: any): void {
    this.addLog({ timestamp: new Date(), level: 'info', message, details });
  }

  warn(message: string, details?: any): void {
    this.addLog({ timestamp: new Date(), level: 'warn', message, details });
  }

  error(message: string, error?: any): void {
    let details = error;
    if (error instanceof Error) {
      details = {
        message: error.message,
        stack: error.stack,
        name: error.name
      };
    }
    this.addLog({ timestamp: new Date(), level: 'error', message, details });
  }

  show(): void {
    this.outputChannel.show();
  }

  clear(): void {
    this.logs = [];
    this.outputChannel.clear();
  }

  getLogs(level?: LogLevel): LogEntry[] {
    if (level) {
      return this.logs.filter(log => log.level === level);
    }
    return [...this.logs];
  }

  getRecentLogs(count: number = 50): LogEntry[] {
    return this.logs.slice(-count);
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}

export const logger = new Logger();
