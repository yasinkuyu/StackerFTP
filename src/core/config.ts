/**
 * StackerFTP - Configuration Manager
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FTPConfig } from '../types';
import { logger } from '../utils/logger';

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
    
    try {
      if (!fs.existsSync(configPath)) {
        return [];
      }

      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      
      // Handle both single config and array of configs
      const configs: FTPConfig[] = Array.isArray(parsed) ? parsed : [parsed];
      
      // Set defaults
      const configsWithDefaults = configs.map(config => ({
        port: config.protocol === 'sftp' ? 22 : 21,
        uploadOnSave: false,
        syncMode: 'update' as const,
        connTimeout: 10000,
        keepalive: 10000,
        passive: true,
        secure: false,
        ...config
      }));

      this.configs.set(workspaceRoot, configsWithDefaults);
      logger.info(`Loaded ${configsWithDefaults.length} configuration(s) from ${configPath}`);
      
      return configsWithDefaults;
    } catch (error) {
      logger.error('Failed to load configuration', error);
      throw new Error(`Failed to load SFTP config: ${error}`);
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
    
    return watcher;
  }
}

export const configManager = ConfigManager.getInstance();
