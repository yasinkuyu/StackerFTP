/**
 * StackerFTP - Configuration Manager
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FTPConfig, RemoteFsConfig } from '../types';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';

const CONFIG_FILE_NAME = 'sftp.json';
const CONFIG_DIR = '.vscode';

export class ConfigManager {
  private static instance: ConfigManager;
  private configs: Map<string, FTPConfig[]> = new Map();
  private currentProfile: Map<string, string> = new Map();

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  getConfigPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, CONFIG_DIR, CONFIG_FILE_NAME);
  }

  async loadConfig(workspaceRoot: string): Promise<FTPConfig[]> {
    const configPath = this.getConfigPath(workspaceRoot);
    const configUri = vscode.Uri.file(configPath);

    try {
      // Check if file exists using VS Code's FS API
      try {
        await vscode.workspace.fs.stat(configUri);
      } catch {
        logger.info(`Config file not found: ${configPath}`);
        return [];
      }

      const contentUint8 = await vscode.workspace.fs.readFile(configUri);
      const content = new TextDecoder().decode(contentUint8);

      // Clean comments from JSON (simple regex approach for common // and /* */)
      const cleanJson = content
        .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => (g ? "" : m))
        .trim();

      if (!cleanJson) {
        logger.warn('Configuration file is empty');
        return [];
      }

      let parsed;
      try {
        parsed = JSON.parse(cleanJson);
      } catch (e) {
        logger.error(`JSON Parse Error in ${configPath}: ${e}`);
        statusBar.error(`Config Error: Invalid JSON in sftp.json`, true);
        throw e;
      }

      // Handle both single config and array of configs
      const configs: FTPConfig[] = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);

      // Resolve Remote-FS references and set defaults
      const configsWithDefaults = configs.filter(c => c && typeof c === 'object').map(config => {
        // Remote-FS Integration: resolve remote reference from user settings
        const resolvedConfig = this.resolveRemoteFsConfig(config);
        const vsConfig = vscode.workspace.getConfiguration('stackerftp');

        return {
          uploadOnSave: false,
          syncMode: 'update' as const,
          connTimeout: 10000,
          keepalive: 10000,
          passive: true,
          secure: false,
          autoReconnect: vsConfig.get<boolean>('autoReconnect', true),
          ...resolvedConfig,
          port: config.port || (resolvedConfig.protocol === 'sftp' ? 22 : 21),
        };
      });

      this.configs.set(workspaceRoot, configsWithDefaults);
      logger.info(`Loaded ${configsWithDefaults.length} configuration(s) from ${configPath}`);

      return configsWithDefaults;
    } catch (error) {
      logger.error('Failed to load configuration', error);
      // Don't throw here to prevent blocking view loading, just return empty and log
      return this.configs.get(workspaceRoot) || [];
    }
  }

  async saveConfig(workspaceRoot: string, configs: FTPConfig[]): Promise<void> {
    const configPath = this.getConfigPath(workspaceRoot);
    const configDir = path.dirname(configPath);

    try {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      const content = JSON.stringify(configs.length === 1 ? configs[0] : configs, null, 2);
      fs.writeFileSync(configPath, content, 'utf-8');

      this.configs.set(workspaceRoot, configs);
      logger.info(`Saved configuration to ${configPath}`);
    } catch (error) {
      logger.error('Failed to save configuration', error);
      throw new Error(`Failed to save SFTP config: ${error}`);
    }
  }

  async createDefaultConfig(workspaceRoot: string): Promise<void> {
    const defaultConfig: FTPConfig = {
      name: 'My Server',
      host: 'example.com',
      protocol: 'sftp',
      port: 22,
      username: 'username',
      remotePath: '/var/www/html',
      uploadOnSave: false
    };

    await this.saveConfig(workspaceRoot, [defaultConfig]);

    // Open the config file
    const configPath = this.getConfigPath(workspaceRoot);
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);

    vscode.window.showInformationMessage(
      'StackerFTP: Configuration file created. Please update it with your server details.',
      'Got it'
    );
  }

  getConfigs(workspaceRoot: string): FTPConfig[] {
    return this.configs.get(workspaceRoot) || [];
  }

  getActiveConfig(workspaceRoot: string): FTPConfig | undefined {
    const configs = this.getConfigs(workspaceRoot);
    if (configs.length === 0) return undefined;

    if (configs.length === 1) return configs[0];

    // Multiple configs - check for profile
    const profile = this.currentProfile.get(workspaceRoot);
    if (profile) {
      const configWithProfile = configs.find(c =>
        c.profiles && c.profiles[profile]
      );
      if (configWithProfile) {
        return this.mergeWithProfile(configWithProfile, profile);
      }
    }

    // Return first config or default profile
    const firstConfig = configs[0];
    if (firstConfig.defaultProfile && firstConfig.profiles) {
      return this.mergeWithProfile(firstConfig, firstConfig.defaultProfile);
    }

    return firstConfig;
  }

  private mergeWithProfile(config: FTPConfig, profileName: string): FTPConfig {
    const profile = config.profiles?.[profileName];
    if (!profile) return config;

    return {
      ...config,
      ...profile,
      profiles: config.profiles,
      defaultProfile: config.defaultProfile
    };
  }

  /**
   * Remote-FS Integration: Resolve remote reference from user settings
   * If config has "remote": "myserver", it will look for the remote definition
   * in user settings under "stackerftp.remotes.myserver"
   */
  private resolveRemoteFsConfig(config: FTPConfig): FTPConfig {
    if (!config.remote) {
      return config;
    }

    const remoteName = config.remote;
    const vsConfig = vscode.workspace.getConfiguration('stackerftp');
    const remotes = vsConfig.get<{ [key: string]: RemoteFsConfig }>('remotes') || {};

    const remoteConfig = remotes[remoteName];
    if (!remoteConfig) {
      logger.warn(`Remote-FS: Remote "${remoteName}" not found in user settings. Add it to "stackerftp.remotes.${remoteName}" in settings.json`);
      return config;
    }

    logger.info(`Remote-FS: Resolved remote "${remoteName}" from user settings`);

    // Merge remote config with local config (local overrides remote)
    return {
      ...remoteConfig,
      ...config,
      // Ensure host comes from remote if not specified locally
      host: config.host || remoteConfig.host,
      username: config.username || remoteConfig.username || '',
      protocol: config.protocol || remoteConfig.protocol || 'sftp',
      remotePath: config.remotePath || remoteConfig.remotePath || '/',
      name: config.name || remoteConfig.name || remoteName
    };
  }

  /**
   * Get all available remotes from user settings
   */
  getAvailableRemotes(): { name: string; config: RemoteFsConfig }[] {
    const vsConfig = vscode.workspace.getConfiguration('stackerftp');
    const remotes = vsConfig.get<{ [key: string]: RemoteFsConfig }>('remotes') || {};

    return Object.entries(remotes).map(([name, config]) => ({
      name,
      config
    }));
  }

  setProfile(workspaceRoot: string, profileName: string): void {
    this.currentProfile.set(workspaceRoot, profileName);
    logger.info(`Switched to profile: ${profileName}`);
  }

  getCurrentProfile(workspaceRoot: string): string | undefined {
    return this.currentProfile.get(workspaceRoot);
  }

  getAvailableProfiles(workspaceRoot: string): string[] {
    const configs = this.getConfigs(workspaceRoot);
    const profiles = new Set<string>();

    configs.forEach(config => {
      if (config.profiles) {
        Object.keys(config.profiles).forEach(p => profiles.add(p));
      }
    });

    return Array.from(profiles);
  }

  configExists(workspaceRoot: string): boolean {
    const configPath = this.getConfigPath(workspaceRoot);
    return fs.existsSync(configPath);
  }

  watchConfig(workspaceRoot: string, callback: () => void): vscode.FileSystemWatcher {
    const configPath = this.getConfigPath(workspaceRoot);
    const pattern = new vscode.RelativePattern(workspaceRoot, path.join(CONFIG_DIR, CONFIG_FILE_NAME));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange(() => {
      logger.info('Configuration file changed, reloading...');
      this.loadConfig(workspaceRoot).then(callback);
    });

    watcher.onDidCreate(() => {
      logger.info('Configuration file created, loading...');
      this.loadConfig(workspaceRoot).then(callback);
    });

    watcher.onDidDelete(() => {
      logger.info('Configuration file deleted, clearing...');
      this.configs.delete(workspaceRoot);
      callback();
    });

    return watcher;
  }
}

export const configManager = ConfigManager.getInstance();
