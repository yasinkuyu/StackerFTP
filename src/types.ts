/**
 * StackerFTP - Type Definitions
 */

export type Protocol = 'ftp' | 'ftps' | 'sftp';

export interface HopConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface FTPConfig {
  name?: string;
  host: string;
  port?: number;
  protocol: Protocol;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  remotePath: string;
  localPath?: string;
  uploadOnSave?: boolean;
  downloadOnOpen?: boolean;
  remoteExplorerOrder?: 'name' | 'size' | 'date' | 'type';
  syncMode?: 'update' | 'full';
  ignore?: string[];
  watcher?: {
    files: string;
    autoUpload: boolean;
    autoDelete: boolean;
  };
  profiles?: { [key: string]: Partial<FTPConfig> };
  defaultProfile?: string;
  connTimeout?: number;
  keepalive?: number;
  secure?: boolean | 'control' | 'implicit';
  secureOptions?: any;
  passive?: boolean;
  hop?: HopConfig | HopConfig[];
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifyTime: Date;
  accessTime?: Date;
  rights?: {
    user: string;
    group: string;
    other: string;
  };
  owner?: string | number;
  group?: string | number;
  path: string;
}

export interface TransferItem {
  id: string;
  localPath: string;
  remotePath: string;
  direction: 'upload' | 'download';
  status: 'pending' | 'transferring' | 'completed' | 'error' | 'cancelled';
  progress: number;
  size: number;
  transferred: number;
  error?: string;
  startTime?: Date;
  endTime?: Date;
}

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deleted: string[];
  failed: { path: string; error: string }[];
  skipped: string[];
}

export interface ConnectionStatus {
  connected: boolean;
  host?: string;
  protocol?: Protocol;
  currentPath?: string;
  error?: string;
}

export interface FilePermissions {
  mode: number;
  user: { read: boolean; write: boolean; execute: boolean };
  group: { read: boolean; write: boolean; execute: boolean };
  others: { read: boolean; write: boolean; execute: boolean };
}

export interface ChecksumResult {
  algorithm: 'md5' | 'sha1' | 'sha256' | 'sha512';
  local?: string;
  remote?: string;
  match?: boolean;
}

export interface SearchResult {
  file: string;
  path: string;
  line: number;
  column: number;
  content: string;
}

export interface FileInfo {
  path: string;
  name: string;
  size: number;
  sizeFormatted: string;
  modified: Date;
  modifiedFormatted: string;
  permissions: string;
  owner: string;
  group: string;
  mimeType?: string;
  checksum?: ChecksumResult;
}

export interface BackupInfo {
  name: string;
  path: string;
  created: Date;
  size: number;
}

export interface WebMasterSettings {
  enableBackupBeforeUpload: boolean;
  backupRetentionDays: number;
  autoCalculateChecksum: boolean;
  defaultChecksumAlgorithm: 'md5' | 'sha1' | 'sha256';
  enableFilePermissionsCheck: boolean;
  showHiddenFiles: boolean;
}
