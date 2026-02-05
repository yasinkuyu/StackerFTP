/**
 * StackerFTP - Connection Hopping (Jump Host) Support
 *  
 * Enables connections through intermediate SSH servers (hop/bastion hosts)
 * local -> hop -> target
 */

import * as vscode from 'vscode';
import { Client } from 'ssh2';
import { FTPConfig, HopConfig } from '../types';
import { logger } from '../utils/logger';

export class ConnectionHopping {

  /**
   * Create a connection through a hop (jump host)
   */
  async connectThroughHop(targetConfig: FTPConfig): Promise<Client> {
    if (!targetConfig.hop) {
      throw new Error('No hop configuration provided');
    }

    const hops = Array.isArray(targetConfig.hop) ? targetConfig.hop : [targetConfig.hop];

    logger.info(`Connecting through ${hops.length} hop(s)`);

    // Start with first hop (direct connection)
    let currentClient = await this.createSSHConnection({
      host: targetConfig.host,
      port: targetConfig.port || 22,
      username: targetConfig.username,
      password: targetConfig.password,
      privateKeyPath: targetConfig.privateKeyPath,
      passphrase: targetConfig.passphrase
    });

    // Chain through additional hops
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      logger.info(`Connecting to hop ${i + 1}: ${hop.host}`);

      // Forward connection through current client to next hop
      currentClient = await this.forwardThroughClient(currentClient, hop);
    }

    return currentClient;
  }

  private createSSHConnection(config: HopConfig): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();

      const connectConfig: any = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: 20000
      };

      if (config.privateKeyPath) {
        try {
          const fs = require('fs');
          connectConfig.privateKey = fs.readFileSync(config.privateKeyPath);
          if (config.passphrase) {
            connectConfig.passphrase = config.passphrase;
          }
        } catch (error) {
          reject(new Error(`Failed to load private key: ${error}`));
          return;
        }
      } else if (config.password) {
        connectConfig.password = config.password;
      }

      client.on('ready', () => {
        resolve(client);
      });

      client.on('error', (err) => {
        reject(err);
      });

      client.connect(connectConfig);
    });
  }

  private forwardThroughClient(client: Client, target: HopConfig): Promise<Client> {
    return new Promise((resolve, reject) => {
      // Create a socket forward to the target through the current client
      client.forwardOut('127.0.0.1', 0, target.host, target.port || 22, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        // Create new client connection through the forwarded stream
        const newClient = new Client();

        const connectConfig: any = {
          sock: stream,
          username: target.username,
          readyTimeout: 20000
        };

        if (target.privateKeyPath) {
          try {
            const fs = require('fs');
            connectConfig.privateKey = fs.readFileSync(target.privateKeyPath);
            if (target.passphrase) {
              connectConfig.passphrase = target.passphrase;
            }
          } catch (error) {
            reject(new Error(`Failed to load private key for hop: ${error}`));
            return;
          }
        } else if (target.password) {
          connectConfig.password = target.password;
        }

        newClient.on('ready', () => {
          resolve(newClient);
        });

        newClient.on('error', (err) => {
          reject(err);
        });

        newClient.connect(connectConfig);
      });
    });
  }

  /**
   * Setup connection hopping configuration through UI
   */
  static async configureHopping(): Promise<FTPConfig['hop'] | undefined> {
    const hops: HopConfig[] = [];
    let addMore = true;

    while (addMore) {
      const hopConfig = await this.configureSingleHop(hops.length + 1);
      if (!hopConfig) {
        break;
      }

      hops.push(hopConfig);

      const choice = await vscode.window.showQuickPick(
        ['Add another hop', 'Done'],
        { placeHolder: 'Would you like to add another hop?' }
      );

      addMore = choice === 'Add another hop';
    }

    if (hops.length === 0) {
      return undefined;
    }

    return hops.length === 1 ? hops[0] : hops;
  }

  private static async configureSingleHop(hopNumber: number): Promise<HopConfig | undefined> {
    // Host
    const host = await vscode.window.showInputBox({
      title: `Hop ${hopNumber} - Host`,
      placeHolder: 'hop-server.example.com',
      prompt: 'Enter the hop server hostname or IP',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value?.trim()) return 'Host is required';
        return null;
      }
    });

    if (!host) return undefined;

    // Port
    const portStr = await vscode.window.showInputBox({
      title: `Hop ${hopNumber} - Port`,
      value: '22',
      prompt: 'Enter the SSH port',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const port = parseInt(value || '22');
        if (isNaN(port) || port < 1 || port > 65535) {
          return 'Please enter a valid port (1-65535)';
        }
        return null;
      }
    });

    if (portStr === undefined) return undefined;

    // Username
    const username = await vscode.window.showInputBox({
      title: `Hop ${hopNumber} - Username`,
      placeHolder: 'username',
      prompt: 'Enter the username for the hop server',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value?.trim()) return 'Username is required';
        return null;
      }
    });

    if (!username) return undefined;

    // Authentication method
    const authMethod = await vscode.window.showQuickPick(
      [
        { label: 'Password', value: 'password' },
        { label: 'Private Key', value: 'key' }
      ],
      {
        title: `Hop ${hopNumber} - Authentication`,
        placeHolder: 'Select authentication method'
      }
    );

    if (!authMethod) return undefined;

    let password: string | undefined;
    let privateKeyPath: string | undefined;
    let passphrase: string | undefined;

    if (authMethod.value === 'password') {
      password = await vscode.window.showInputBox({
        title: `Hop ${hopNumber} - Password`,
        prompt: 'Enter the password (optional)',
        password: true,
        ignoreFocusOut: true
      });
    } else {
      const keyFiles = await vscode.window.showOpenDialog({
        title: `Hop ${hopNumber} - Select Private Key`,
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          'Key Files': ['pem', 'key', 'ppk'],
          'All Files': ['*']
        }
      });

      if (!keyFiles || keyFiles.length === 0) return undefined;
      privateKeyPath = keyFiles[0].fsPath;

      const hasPassphrase = await vscode.window.showQuickPick(
        ['Yes', 'No'],
        {
          title: 'Does your key have a passphrase?',
          placeHolder: 'Select Yes if your private key is encrypted'
        }
      );

      if (hasPassphrase === 'Yes') {
        passphrase = await vscode.window.showInputBox({
          title: 'Passphrase',
          prompt: 'Enter the passphrase for your private key',
          password: true,
          ignoreFocusOut: true
        });
      }
    }

    return {
      host: host.trim(),
      port: parseInt(portStr || '22'),
      username: username.trim(),
      password,
      privateKeyPath,
      passphrase
    };
  }
}

export const connectionHopping = new ConnectionHopping();
