# StackerFTP - Advanced FTP/SFTP Client for VS Code

A professional-grade FTP/SFTP client extension for Visual Studio Code and all its forks (Cursor, Antigravity, etc.) with comprehensive file management capabilities.

![StackerFTP](https://github.com/yasinkuyu/StackerFTP/raw/main/resources/icon.png)

## Features

### 🔌 Multi-Protocol Support
- **SFTP** (SSH File Transfer Protocol) - Port 22 - Encrypted & Secure
- **FTP** (Standard File Transfer Protocol) - Port 21 - Basic/Unencrypted
- **FTPS** (FTP over SSL/TLS) - Port 21 - Secure with certificates
- **Quick Protocol Switch**: Change protocols without re-entering credentials
- **Upload on Save**: Automatically upload files when saved
- **Download on Open**: Save files opened from the Remote Explorer into your project
- **Connection Profiles**: Switch between multiple server configurations
- **Multi-Connection Support**: Connect to multiple servers simultaneously
- **Target Connection Selection**: With several connections, choose once where transfers go – no more silent uploads to the first server
- **Connection Hopping**: Connect through intermediate (jump) servers
- **File Watcher**: Monitor local files for changes and auto-upload
- **Advanced Settings Form**: Manage every connection setting from the Connections panel, with (?) help tooltips and examples

### 📁 File Management
- **Full File Operations**: Upload, download, delete, rename, duplicate files and folders
- **Recursive Operations**: Upload/download entire directory trees
- **File Details**: View file size, permissions, and modification date
- **File Icons**: Native VS Code file type icons
- **Hidden Files**: Option to show/hide hidden files (dotfiles)
- **Remote-to-Remote Transfer**: Copy files between different remote servers
- **Edit in Local**: Edit remote files in a temp directory with auto-upload on save

### 🔄 Sync & Compare
- **Sync with Preview**: Sync local → remote, remote → local, or both – only changed files, reviewed before anything is transferred or deleted
- **Compare Folders**: See modified / only-local / only-remote files side by side with the server, diff them and fix differences one by one
- **Upload to Multiple Servers**: Deploy the same files to staging and production in one step, or to all servers
- **Preserve Timestamps**: Transferred files keep their modification time, so change detection stays accurate
- **Upload Changed Files**: Upload only files changed in git

### 🛠️ Web Master Tools (SFTP Only)
- **Permission Management**: Change file permissions (chmod)
- **Checksum Verification**: Calculate and compare MD5, SHA1, SHA256 checksums
- **File Information**: Detailed file metadata display
- **Remote Search**: Search content within remote files
- **Backup Creation**: Create backups of remote files/directories
- **Folder Comparison**: Compare local and remote folders (split-view panel)
- **Quick Search**: Ultra-fast file search by name in new tab (parallel traversal, wildcard patterns)
- **Search & Replace**: Find and replace text across remote files
- **Cache Purge**: Clear common cache directories on remote server

### 👨‍💻 Developer Features
- **Diff View**: Compare local and remote file versions
- **Compare Remotes**: Compare files between different remote servers
- **Remote Terminal**: Open an SSH terminal in the project's remote folder – uses your private key and jump hosts (SFTP only)
- **Transfer Queue**: Monitor and manage active transfers
- **Clear Error Reporting**: Failed transfers show the reason, a notification with Retry, full details on click, and a persistent "X failed" indicator
- **Progress Indicators**: Visual feedback for all operations
- **Logging**: Comprehensive logging for debugging
- **Git Integration**: Upload only git-changed files

## 🎯 Compatibility

StackerFTP is designed to work seamlessly with Visual Studio Code and all its major forks and alternative marketplaces.

- **Supported IDEs**: VS Code, Cursor, Antigravity, Windsurf, VSCodium, PearAI, Trae and more.
- **Marketplaces**: Available on the official [VS Code Marketplace](https://marketplace.visualstudio.com/) and [Open VSX Registry](https://open-vsx.org/).


## Installation

### From VSIX (Manual)
1. Download the latest `.vsix` file from [releases](https://github.com/yasinkuyu/stackerftp/releases)
2. Open VS Code or your IDE (Cursor, Windsurf, Antigravity, etc.)
3. Go to Extensions view (Ctrl+Shift+X)
4. Click "..." (More Actions) → "Install from VSIX..."
5. Select the downloaded `.vsix` file

### From Marketplace
1. Open VS Code or your IDE (Cursor, Windsurf, Antigravity, etc.)
2. Go to Extensions view (Ctrl+Shift+X)
3. Search for "StackerFTP"
4. Click **Install**

## Quick Start

### 1. Configure Connection

#### Option A: New Connection Button (Recommended)
1. Open a workspace folder in your IDE
2. Click StackerFTP icon in the sidebar
3. Click the "+" button in the Connections header
4. Fill in your connection details

#### Option B: Quick Connect
1. Press `Ctrl+Shift+P`
2. Type "SFTP: Quick Connect"
3. Select or create a connection

#### Option C: Manual Config (JSON)
1. Create `.vscode/sftp.json` in your workspace
2. Edit the configuration file:

```json
{
  "name": "My Server",
  "host": "example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "username",
  "password": "password",
  "remotePath": "/var/www/html",
  "uploadOnSave": false
}
```

### 2. Connect
1. Click on a connection in the Connections panel
2. Click the play button to connect
3. Or right-click and select "Connect"

### 3. Transfer Files
- **Upload**: Right-click a local file → "Upload to Remote"
- **Download**: Right-click a remote file → "Download"
- **Sync**: Right-click a folder → "Sync Local → Remote" or "Sync Remote → Local"
- **Edit**: Double-click a remote file to edit locally with auto-upload on save

## Working with Multiple Servers

When more than one connection is configured, StackerFTP asks **once** which server to use and remembers your choice. All transfers, Upload on Save, the file watcher and the status bar use that **target connection**.

- **Change the target**: `StackerFTP: Select Target Connection`, or click the connection name in the status bar.
- **How long it is remembered**: `stackerftp.rememberTargetConnection`
  - `session` (default) – until you disconnect from it or reload the window
  - `workspace` – kept across reloads and restarts
- **Upload on Save / File Watcher** never guess: if no target is chosen yet, nothing is uploaded in the background.

### Upload to multiple servers
Right-click files or folders (or use the editor context menu) → **StackerFTP** →
- **Upload to Multiple Servers…** – pick servers, e.g. staging + production. The selection is remembered for next time.
- **Upload to All Servers** – every configured connection, after a confirmation.

A per-server summary shows what was uploaded, skipped or failed.

## Sync

`SFTP: Sync Local → Remote`, `SFTP: Sync Remote → Local` and `SFTP: Sync Both Directions` (also on folders in the Explorer) work in three steps:

1. **Scan** both sides (ignored folders are skipped entirely).
2. **Preview** only the changes, grouped as *Upload*, *Download* and *Delete*. Uncheck anything you don't want. Conflicts – e.g. the server copy is newer than yours – are shown with ⚠ and are **not** selected by default.
3. **Apply** the selection through the Transfer Queue.

| | Local → Remote | Remote → Local | Both |
|---|---|---|---|
| New / changed files | uploaded | downloaded | newer side wins |
| Files missing on the source side | deleted on the server only with `"syncMode": "full"` | moved to trash only with `"syncMode": "full"` | never deleted |

Deletions always need an extra confirmation. `.git` and `.vscode/sftp.json` are never transferred. Turn the preview off with `stackerftp.confirmSync: false` to apply the recommended changes directly.

## Compare

Run **Compare with Remote** from the Command Palette (whole project), or right-click a folder (that folder) or a file (diff). The **Compare Folders** panel shows local and remote side by side:

- Colors follow your theme: modified, only local, only remote (high contrast themes get a clear marker instead of tinted rows).
- Hover a file for actions: **⇆** diff, **↑** upload, **↓** download, reveal.
- Toolbar: search, filters (All / Only Local / Only Remote / Different), **Export** (CSV/JSON), **⇧ Sync to Remote**, **⇩ Sync to Local** (with preview) and **↻ Refresh**.
- A progress bar at the top shows while comparing, transferring or preparing a diff.

Compare and Sync use the same ignore rules and change detection.

## When a Transfer Fails

- The Transfer Queue shows the reason next to the file, e.g. `↑ Error: Permission denied`.
- After the run, a notification offers **Show Details**, **Retry** and **Show Queue**.
- Click a failed item for the full error, server, local and remote path – with **Retry**, **Copy Error** and **Show Log**.
- The status bar shows a red **X failed** indicator until the failures are retried or cleared.

## Configuration Options

### Basic Configuration
```json
{
  "name": "My Server",
  "host": "server.example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "root",
  "password": "password",
  "remotePath": "/var/www/html",
  "uploadOnSave": true
}
```

### SSH Key Authentication
```json
{
  "name": "Production Server",
  "host": "server.example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "root",
  "privateKeyPath": "~/.ssh/id_rsa",
  "passphrase": "optional-key-passphrase",
  "remotePath": "/var/www/production",
  "uploadOnSave": true
}
```

### Profile Configuration
```json
{
  "name": "Multi-Environment",
  "username": "developer",
  "password": "password",
  "remotePath": "/app",
  "profiles": {
    "dev": {
      "host": "dev.example.com",
      "uploadOnSave": true
    },
    "staging": {
      "host": "staging.example.com"
    },
    "production": {
      "host": "prod.example.com",
      "uploadOnSave": false
    }
  },
  "defaultProfile": "dev"
}
```

### FTP/FTPS Configuration
```json
{
  "name": "FTP Server",
  "host": "ftp.example.com",
  "protocol": "ftp",
  "port": 21,
  "username": "user",
  "password": "pass",
  "passive": true,
  "remotePath": "/public_html"
}
```

### FTPS (Secure FTP) Configuration
```json
{
  "name": "FTPS Server",
  "host": "ftp.example.com",
  "protocol": "ftps",
  "port": 21,
  "username": "user",
  "password": "pass",
  "remotePath": "/public_html"
}
```

`"protocol": "ftps"` always uses TLS (explicit, port 21). For implicit TLS (usually port 990) set `"secure": "implicit"`. For self-signed certificates on servers you trust, add `"secureOptions": { "rejectUnauthorized": false }`.

### File Watcher Configuration
```json
{
  "name": "Watch Mode",
  "host": "server.example.com",
  "protocol": "sftp",
  "username": "user",
  "password": "pass",
  "remotePath": "/var/www",
  "watcher": {
    "files": "dist/**/*",
    "autoUpload": true,
    "autoDelete": false
  }
}
```

### Advanced Configuration
```json
{
  "name": "Advanced Config",
  "host": "server.example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "user",
  "privateKeyPath": "~/.ssh/id_rsa",
  "passphrase": "key-passphrase",
  "remotePath": "/home/user/project",
  "context": "src",
  "uploadOnSave": true,
  "downloadOnOpen": false,
  "syncMode": "update",
  "ignore": [
    ".git",
    ".DS_Store",
    "node_modules",
    "*.log"
  ],
  "connTimeout": 10000,
  "keepalive": 10000
}
```

### All Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | string | - | Connection display name |
| `host` | string | - | Server hostname or IP |
| `port` | number | 22/21 | Server port |
| `protocol` | string | "sftp" | Protocol: "sftp", "ftp", or "ftps" |
| `username` | string | - | Username for authentication |
| `password` | string | - | Password for authentication |
| `privateKeyPath` | string | - | Path to SSH private key |
| `passphrase` | string | - | Passphrase for encrypted private key |
| `remotePath` | string | "/" | Remote directory path |
| `context` | string | workspace root | Local folder mapped to `remotePath`: relative to the workspace, absolute, or `~/...` |
| `localPath` | string | - | Alias of `context` (vscode-sftp style); `context` wins if both are set |
| `uploadOnSave` | boolean | false | Auto-upload on file save |
| `downloadOnOpen` | boolean | false | Save files opened from the Remote Explorer into the project |
| `syncMode` | string | "update" | "update" (never deletes) or "full" (sync also deletes files missing on the source side, after confirmation) |
| `ignore` | array | node_modules, .vscode, … | Patterns never transferred. `.git` and `.vscode/sftp.json` are always ignored |
| `watcher` | object | - | File watcher configuration |
| `profiles` | object | - | Multiple server profiles |
| `defaultProfile` | string | - | Default profile to use |
| `hop` | object/array | - | Jump host configuration |
| `connTimeout` | number | 10000 | Connection timeout in ms |
| `keepalive` | number | 10000 | Keepalive interval in ms |
| `autoReconnect` | boolean | true | Reconnect when the connection drops unexpectedly |
| `remoteExplorerOrder` | string | "name" | Remote Explorer sort: "name", "size", "date" or "type" |
| `secure` | boolean / "implicit" | true for ftps | TLS mode for FTPS |
| `secureOptions` | object | - | TLS options, e.g. `{ "rejectUnauthorized": false }` |

## Keyboard Shortcuts

| Command | Windows/Linux | Mac |
|---------|---------------|-----|
| Upload Current File | `Ctrl+Shift+U` | `Cmd+Shift+U` |
| Download | `Ctrl+Shift+D` | `Cmd+Shift+D` |
| Sync to Remote | `Ctrl+Shift+Alt+U` | `Cmd+Shift+Alt+U` |
| Sync to Local | `Ctrl+Shift+Alt+D` | `Cmd+Shift+Alt+D` |

## VS Code Settings

Open VS Code settings and search for "StackerFTP":

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `stackerftp.showHiddenFiles` | boolean | false | Show hidden files in remote explorer |
| `stackerftp.confirmDelete` | boolean | true | Confirm before deleting remote files |
| `stackerftp.confirmSync` | boolean | true | Show the sync preview before applying changes |
| `stackerftp.rememberTargetConnection` | string | "session" | Remember the target connection for the "session" or the "workspace" |
| `stackerftp.rememberMultiTargets` | boolean | true | Pre-select the servers last used with "Upload to Multiple Servers" |
| `stackerftp.preserveTimestamps` | boolean | true | Keep modification times on transferred files |
| `stackerftp.autoRefresh` | boolean | true | Auto refresh remote explorer after operations |
| `stackerftp.transferConcurrency` | number | 4 | Number of concurrent file transfers |
| `stackerftp.showWebMasterTools` | boolean | true | Show web master tools in context menu |

## Supported Protocols

| Protocol | Port | Encryption | Authentication | Use Case |
|----------|------|------------|----------------|----------|
| **SFTP** | 22 | SSH (Strong) | Password / SSH Key | Production servers, sensitive data |
| **FTP** | 21 | None | Password | Local networks, legacy systems |
| **FTPS** | 21 | TLS/SSL | Password / Certificate | Secure FTP without SSH |

### Protocol Selection Guide

**Choose SFTP when:**
- ✅ You have SSH access to the server
- ✅ Security is a priority
- ✅ Transferring sensitive data
- ✅ Working with production servers
- ✅ Need remote terminal access

**Choose FTP when:**
- ✅ Local development environment
- ✅ Legacy server without SSH
- ✅ Quick testing (not for production)
- ✅ Behind secure VPN/firewall

**Choose FTPS when:**
- ✅ FTP server with SSL/TLS support
- ✅ Need encrypted FTP without SSH
- ✅ Shared hosting environments
- ✅ Certificate-based authentication

### Switching Protocols
Already configured a connection but want to change the protocol?
1. Press `Ctrl+Shift+P`
2. Type "SFTP: Switch Protocol"
3. Select the connection
4. Choose new protocol

Your settings (host, username, etc.) will be preserved!

## Web Master Tools

### Change Permissions (chmod)
1. Right-click a remote file/folder
2. Select "Permissions (chmod)"
3. Enter the new permission (e.g., 755, 644)

### Calculate Checksum
1. Right-click a remote file
2. Select "Checksum"
3. Choose algorithm (MD5, SHA1, SHA256)
4. Compare with local file or copy to clipboard

### Search in Remote Files
1. Press `Ctrl+Shift+P`
2. Type "Search in Remote"
3. Enter search pattern
4. Results will show file path, line number, and content

### Create Backup
1. Right-click a remote file/folder
2. Select "Backup"
3. Optionally specify backup name
4. Backup will be created with timestamp

### Purge Cache
1. Press `Ctrl+Shift+P`
2. Type "Purge Remote Cache"
3. Common cache directories will be cleared

## Troubleshooting

### Connection Issues
1. Check your firewall settings
2. Verify server address and credentials
3. For SFTP: Ensure SSH is enabled on the server
4. For FTPS: Check if server requires explicit or implicit TLS

### Upload/Download Fails
1. Check file permissions on remote server
2. Verify disk space on remote server
3. Check transfer logs: `Ctrl+Shift+P` → "SFTP: View Logs"

### Performance Issues
1. Reduce transfer concurrency in settings
2. Use passive mode for FTP behind NAT
3. Enable compression for SFTP connections

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

StackerFTP is inspired by the excellent [vscode-sftp](https://github.com/Natizyskunk/vscode-sftp) extension by Natizyskunk, which was originally forked from liximomo's SFTP plugin.

## Support

- GitHub Issues: [github.com/yasinkuyu/stackerftp/issues](https://github.com/yasinkuyu/stackerftp/issues)

---

**Enjoy using StackerFTP!** 🚀
