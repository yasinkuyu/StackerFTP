/**
 * StackerFTP - Helper Utilities
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FilePermissions, FileEntry } from '../types';

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}

export function formatDate(date: Date | string | number): string {
  const d = new Date(date);
  return d.toLocaleString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

export function parsePermissions(mode: number): FilePermissions {
  const toBool = (val: number) => (val & mode) !== 0;

  return {
    mode,
    user: {
      read: toBool(0o400),
      write: toBool(0o200),
      execute: toBool(0o100)
    },
    group: {
      read: toBool(0o040),
      write: toBool(0o020),
      execute: toBool(0o010)
    },
    others: {
      read: toBool(0o004),
      write: toBool(0o002),
      execute: toBool(0o001)
    }
  };
}

export function formatPermissions(perm: FilePermissions | number): string {
  const mode = typeof perm === 'number' ? perm : perm.mode;
  const chars = ['r', 'w', 'x'];
  let result = '';

  for (let i = 8; i >= 0; i--) {
    const bit = (mode >> i) & 1;
    const charIndex = 2 - (i % 3);
    result += bit ? chars[charIndex] : '-';
    if (i % 3 === 0 && i > 0) result += '';
  }

  return result;
}

export function parsePermissionString(permString: string): number {
  let mode = 0;
  const parts = permString.match(/[rwx-]{3}/g) || [];

  const permMap: { [key: string]: number } = {
    'r': 4, 'w': 2, 'x': 1, '-': 0
  };

  parts.forEach((part, index) => {
    const shift = (2 - index) * 3;
    for (const char of part) {
      mode |= (permMap[char] || 0) << shift;
    }
  });

  return mode;
}

export function calculateChecksum(filePath: string, algorithm: string = 'md5'): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash(algorithm);
      const stream = fs.createReadStream(filePath);

      stream.on('error', reject);
      stream.on('data', (chunk) => {
        try {
          hash.update(chunk);
        } catch (err) {
          reject(err);
        }
      });
      stream.on('end', () => {
        try {
          resolve(hash.digest('hex'));
        } catch (err) {
          reject(err);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

export function calculateChecksumBuffer(buffer: Buffer, algorithm: string = 'md5'): string {
  return crypto.createHash(algorithm).update(buffer).digest('hex');
}

export function isHiddenFile(fileName: string): boolean {
  return fileName.startsWith('.') && fileName !== '.' && fileName !== '..';
}

export function normalizeRemotePath(remotePath: string): string {
  return remotePath.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function sanitizeRelativePath(relativePath: string): string {
  // Path traversal kontrolü
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized.includes('\\..\\')) {
    throw new Error(`Invalid path: path traversal detected in "${relativePath}"`);
  }
  // Absolute path kontrolü
  if (path.isAbsolute(normalized)) {
    throw new Error(`Invalid path: absolute paths are not allowed "${relativePath}"`);
  }
  return normalized;
}

export function joinRemotePath(...parts: string[]): string {
  return normalizeRemotePath(parts.join('/'));
}

export function getRelativePath(from: string, to: string): string {
  const fromParts = normalizeRemotePath(from).split('/').filter(Boolean);
  const toParts = normalizeRemotePath(to).split('/').filter(Boolean);

  let commonIndex = 0;
  while (commonIndex < fromParts.length &&
    commonIndex < toParts.length &&
    fromParts[commonIndex] === toParts[commonIndex]) {
    commonIndex++;
  }

  const upCount = fromParts.length - commonIndex;
  const result = [...Array(upCount).fill('..'), ...toParts.slice(commonIndex)];

  return result.join('/') || '.';
}

export function matchesPattern(filePath: string, patterns: string[]): boolean {
  // Ensure patterns is an array to prevent iteration errors on strings/objects
  const patternList = Array.isArray(patterns) ? patterns : [patterns].filter(p => typeof p === 'string');

  for (const pattern of patternList) {
    const regex = new RegExp(
      '^' + pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '___DOUBLESTAR___')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.')
        .replace(/___DOUBLESTAR___/g, '.*') + '$'
    );
    if (regex.test(filePath)) return true;
  }
  return false;
}

export function getFileIcon(fileName: string, isDirectory: boolean): string {
  if (isDirectory) return '$(folder)';

  const ext = path.extname(fileName).toLowerCase();
  const iconMap: { [key: string]: string } = {
    '.js': '$(file-code)',
    '.ts': '$(file-code)',
    '.jsx': '$(file-code)',
    '.tsx': '$(file-code)',
    '.html': '$(file-code)',
    '.css': '$(file-code)',
    '.scss': '$(file-code)',
    '.less': '$(file-code)',
    '.json': '$(file-json)',
    '.md': '$(file-text)',
    '.txt': '$(file-text)',
    '.pdf': '$(file-pdf)',
    '.zip': '$(file-zip)',
    '.tar': '$(file-zip)',
    '.gz': '$(file-zip)',
    '.rar': '$(file-zip)',
    '.jpg': '$(file-media)',
    '.jpeg': '$(file-media)',
    '.png': '$(file-media)',
    '.gif': '$(file-media)',
    '.svg': '$(file-media)',
    '.mp3': '$(file-media)',
    '.mp4': '$(file-media)',
    '.avi': '$(file-media)',
    '.mov': '$(file-media)',
    '.php': '$(file-code)',
    '.py': '$(file-code)',
    '.rb': '$(file-code)',
    '.java': '$(file-code)',
    '.c': '$(file-code)',
    '.cpp': '$(file-code)',
    '.h': '$(file-code)',
    '.go': '$(file-code)',
    '.rs': '$(file-code)',
    '.sql': '$(database)',
    '.xml': '$(file-code)',
    '.yml': '$(file-code)',
    '.yaml': '$(file-code)',
    '.sh': '$(terminal)',
    '.bat': '$(terminal)',
    '.ps1': '$(terminal)',
    '.log': '$(output)',
    '.gitignore': '$(git-commit)',
    '.env': '$(key)',
    '.dockerfile': '$(package)',
    '.vue': '$(file-code)',
    '.svelte': '$(file-code)'
  };

  return iconMap[ext] || '$(file)';
}

export function sortFileEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => {
    // Directories first
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    // Then alphabetical
    return a.name.localeCompare(b.name);
  });
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

export function safeJsonStringify(obj: any, indent: number = 2): string {
  const cache = new Set();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (cache.has(value)) {
        return '[Circular]';
      }
      cache.add(value);
    }
    return value;
  }, indent);
}

export function deepClone<T>(obj: T): T {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (e) {
    // Fallback for circular structures
    return JSON.parse(safeJsonStringify(obj));
  }
}

export function mergeConfig(base: any, override: any): any {
  const result = { ...base };
  for (const key in override) {
    if (override[key] !== undefined && override[key] !== null) {
      result[key] = override[key];
    }
  }
  return result;
}

// Binary file extensions that should not be opened as text
export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.tiff', '.tif', '.raw', '.cr2', '.nef', '.heic', '.heif',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz', '.lz', '.lzma', '.cab', '.iso', '.dmg', '.pkg', '.deb', '.rpm',
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj', '.class', '.pyc', '.pyo', '.wasm',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.m4a', '.m4v', '.ogg', '.ogv', '.wav', '.flac', '.aac',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.psd', '.ai', '.sketch', '.fig', '.xd', '.eps', '.indd',
  '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb', '.dbf',
  '.bin', '.dat', '.data', '.dump', '.img', '.rom', '.sav',
  '.cer', '.crt', '.der', '.p12', '.pfx', '.pem', '.key',
  '.swf', '.fla', '.blend', '.fbx', '.max', '.maya', '.unity', '.unitypackage'
]);

export const SYSTEM_PATTERNS = [
  '__MACOSX',
  '.DS_Store',
  'Thumbs.db',
  '.git',
  '.svn'
];

export function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export function isSystemFile(filePath: string): boolean {
  return SYSTEM_PATTERNS.some(pattern => filePath.includes(pattern));
}
