# StackerFTP - Advanced FTP/SFTP Client for VS Code

A professional-grade FTP/SFTP client extension for Visual Studio Code and all its forks (Cursor, Antigravity, etc.) with comprehensive file management capabilities.

![StackerFTP](resources/icon.png)

## Features

### 🔌 Multi-Protocol Support
- **SFTP** (SSH File Transfer Protocol) - Port 22 - Encrypted & Secure
- **FTP** (Standard File Transfer Protocol) - Port 21 - Basic/Unencrypted
- **FTPS** (FTP over SSL/TLS) - Port 21 - Secure with certificates
- **Quick Protocol Switch**: Change protocols without re-entering credentials
- **Upload on Save**: Automatically upload files when saved
- **Download on Open**: Automatically download files when opened from remote
- **Connection Profiles**: Switch between multiple server configurations
- **Multi-Connection Support**: Connect to multiple servers simultaneously
- **Connection Hopping**: Connect through intermediate servers (jump hosts)
- **File Watcher**: Monitor local files for changes and auto-upload

### 📁 File Management
- **Full File Operations**: Upload, download, delete, rename, duplicate files and folders
- **Recursive Operations**: Upload/download entire directory trees
- **File Details**: View file size, permissions, and modification date
- **File Icons**: Native VS Code file type icons
- **Hidden Files**: Option to show/hide hidden files (dotfiles)
- **Remote-to-Remote Transfer**: Copy files between different remote servers
- **Edit in Local**: Edit remote files in a temp directory with auto-upload on save

### 🔄 Sync Features
- **Bi-directional Sync**: Sync local → remote, remote → local, or both directions
- **Sync to All Profiles**: Upload to multiple server profiles at once
- **Upload Changed Files**: Upload only files changed in git

### 🛠️ Web Master Tools
- **Permission Management**: Change file permissions (chmod)
- **Checksum Verification**: Calculate and compare MD5, SHA1, SHA256 checksums
- **File Information**: Detailed file metadata display
- **Remote Search**: Search content within remote files
- **Backup Creation**: Create backups of remote files/directories
- **Folder Comparison**: Compare local and remote folders
- **Search & Replace**: Find and replace text across remote files
- **Cache Purge**: Clear common cache directories on remote server

### 👨‍💻 Developer Features
- **Diff View**: Compare local and remote file versions
- **Compare Remotes**: Compare files between different remote servers
- **Remote Terminal**: Open SSH terminal to remote server (SFTP only)
- **Transfer Queue**: Monitor and manage active transfers
- **Progress Indicators**: Visual feedback for all operations
- **Logging**: Comprehensive logging for debugging
- **Git Integration**: Upload only git-changed files

## Installation

### From VSIX (Manual)
1. Download the latest `.vsix` file from [releases](https://github.com/yasinkuyu/stackerftp/releases)
2. Open VS Code
3. Go to Extensions view (Ctrl+Shift+X)
4. Click "..." (More Actions) → "Install from VSIX..."
5. Select the downloaded `.vsix` file

### From Marketplace (Coming Soon)
```
Search for "StackerFTP" in the Extensions marketplace
```

## Quick Start

### 1. Configure Connection

#### Option A: New Connection Button (Recommended)
1. Open a workspace folder in VS Code
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
  "secure": true,
  "username": "user",
  "password": "pass",
  "remotePath": "/public_html"
}
```

### Connection Hopping (Jump Host)
```json
{
  "name": "Behind Firewall",
  "host": "internal-server.local",
  "protocol": "sftp",
  "username": "user",
  "privateKeyPath": "~/.ssh/id_rsa",
  "remotePath": "/home/user",
  "hop": {
    "host": "jump-host.example.com",
    "username": "jump-user",
    "privateKeyPath": "~/.ssh/id_rsa"
  }
}
```

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
  "localPath": "./src",
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
| `localPath` | string | "./" | Local directory path |
| `uploadOnSave` | boolean | false | Auto-upload on file save |
| `downloadOnOpen` | boolean | false | Auto-download when opening from remote |
| `syncMode` | string | "update" | Sync mode: "update" or "full" |
| `ignore` | array | [] | Glob patterns to ignore |
| `watcher` | object | - | File watcher configuration |
| `profiles` | object | - | Multiple server profiles |
| `defaultProfile` | string | - | Default profile to use |
| `hop` | object/array | - | Jump host configuration |
| `connTimeout` | number | 10000 | Connection timeout in ms |
| `keepalive` | number | 10000 | Keepalive interval in ms |
| `passive` | boolean | true | Use passive mode for FTP |
| `secure` | boolean | false | Use TLS for FTPS |

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
| `stackerftp.confirmSync` | boolean | true | Confirm before syncing directories |
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
- Email: support@stackerftp.com

---

**Enjoy using StackerFTP!** 🚀
