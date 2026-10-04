/**
 * StackerFTP - Target Connection Resolver
 *
 * Single source of truth for "which server does this workspace operation go to".
 * Resolution order:
 *   1. Only one connection configured  -> that connection
 *   2. Session-selected target         -> remembered choice (ConfigManager)
 *   3. Connected primary connection    -> connection shown in the status bar
 *   4. Otherwise ambiguous             -> interactive callers ask once and remember,
 *                                         background callers (upload on save, watcher) skip
 */

import * as vscode from 'vscode';
import { configManager } from './config';
import { connectionManager } from './connection-manager';
import { BaseConnection } from './connection';
import { FTPConfig } from '../types';
import { statusBar } from '../utils/status-bar';

/**
 * Non-interactive resolution. Returns undefined when nothing is configured or
 * when multiple connections exist and the user has not chosen one yet.
 */
export function getTargetConfig(workspaceRoot: string): FTPConfig | undefined {
  const configs = configManager.getConfigs(workspaceRoot);
  if (configs.length === 0) return undefined;
  if (configs.length === 1) return configManager.getActiveConfig(workspaceRoot);

  const selected = configManager.getSelectedConfig(workspaceRoot);
  if (selected) return selected;

  const primary = connectionManager.getPrimaryConfig();
  if (primary && configs.some(c => connectionManager.isSameTarget(configManager.withProfile(workspaceRoot, c), primary))) {
    return primary;
  }

  return undefined;
}

/**
 * Let the user choose the target connection. The choice is remembered for the session.
 */
export async function pickTargetConfig(workspaceRoot: string, operation?: string): Promise<FTPConfig | undefined> {
  const configs = configManager.getConfigs(workspaceRoot);
  if (configs.length === 0) {
    statusBar.error('No SFTP configuration found', true);
    return undefined;
  }

  const current = getTargetConfig(workspaceRoot);
  const items = configs.map(raw => {
    const config = configManager.withProfile(workspaceRoot, raw);
    const isConnected = connectionManager.isConnected(config);
    const isCurrent = !!current && connectionManager.isSameTarget(current, config);
    const icon = isCurrent ? '$(target)' : isConnected ? '$(pass-filled)' : '$(circle-large-outline)';
    return {
      label: `${icon} ${config.name || config.host}`,
      description: `${config.protocol?.toUpperCase()} • ${config.username}@${config.host}:${config.remotePath}`,
      detail: [isCurrent ? 'Current target' : undefined, isConnected ? 'Connected' : 'Disconnected - will connect on use']
        .filter(Boolean).join(' • '),
      raw
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    title: operation ? `${operation} - Select Target Connection` : 'Select Target Connection',
    placeHolder: 'Choose the server for transfers (remembered for this session)',
    ignoreFocusOut: true
  });
  if (!selected) return undefined;

  configManager.setSelectedConfig(workspaceRoot, selected.raw);
  const config = configManager.withProfile(workspaceRoot, selected.raw);
  statusBar.info(`Target: ${config.name || config.host}`);
  return config;
}

/**
 * Interactive resolution for user-triggered commands: asks once when ambiguous.
 */
export async function resolveTargetConfig(workspaceRoot: string, operation?: string): Promise<FTPConfig | undefined> {
  if (configManager.getConfigs(workspaceRoot).length === 0 && configManager.configExists(workspaceRoot)) {
    await configManager.loadConfig(workspaceRoot);
  }

  if (configManager.getConfigs(workspaceRoot).length === 0) {
    statusBar.error('No SFTP configuration found', true);
    return undefined;
  }

  const config = getTargetConfig(workspaceRoot);
  if (!config) return pickTargetConfig(workspaceRoot, operation);

  // Implicit choice (primary connection) becomes the remembered target
  if (configManager.getConfigs(workspaceRoot).length > 1 && !configManager.getSelectedConfig(workspaceRoot)) {
    configManager.setSelectedConfig(workspaceRoot, config);
  }
  return config;
}

/**
 * Resolve the target and make sure it is connected. Keeps the primary
 * connection in sync with the target so the status bar shows where transfers go.
 */
export async function resolveTarget(
  workspaceRoot: string,
  operation?: string
): Promise<{ config: FTPConfig; connection: BaseConnection } | undefined> {
  const config = await resolveTargetConfig(workspaceRoot, operation);
  if (!config) return undefined;

  const connection = await connectionManager.ensureConnection(config);
  const primary = connectionManager.getPrimaryConfig();
  if (!primary || !connectionManager.isSameTarget(primary, config)) {
    connectionManager.setPrimaryConnection(config);
  }
  return { config, connection };
}
