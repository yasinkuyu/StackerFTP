# StackerFTP - Advanced FTP/SFTP Client for VS Code

A professional-grade FTP/SFTP client extension for Visual Studio Code and all its forks (Cursor, Antigravity, etc.) with comprehensive file management capabilities and web master tools.

![StackerFTP](resources/icon.png)

## Features

### 🔌 Multi-Protocol Support
- **SFTP** (SSH File Transfer Protocol) - Port 22 - Encrypted & Secure
- **FTP** (Standard File Transfer Protocol) - Port 21 - Basic/Unencrypted
- **FTPS** (FTP over SSL/TLS) - Port 21 - Secure with certificates
- **Connection Wizard**: Step-by-step setup with visual protocol selection
- **Quick Protocol Switch**: Change protocols without re-entering credentials
- **Bi-directional Sync**: Sync local → remote, remote → local, or both directions
- **Upload on Save**: Automatically upload files when saved
- **Connection Profiles**: Switch between multiple server configurations
- **Connection Hopping**: Connect through intermediate servers (jump hosts)
- **File Watcher**: Monitor local files for changes

### File Management
- **Full File Operations**: Upload, download, delete, rename, duplicate files and folders
- **Recursive Operations**: Upload/download entire directory trees
- **Drag & Drop**: Drag files between local and remote
- **Multi-select**: Select and operate on multiple files at once
- **File Icons**: Native VS Code file type icons
- **Hidden Files**: Option to show/hide hidden files (dotfiles)

### Web Master Tools
- **Permission Management**: Change file permissions (chmod) with visual interface
- **Checksum Verification**: Calculate and compare MD5, SHA1, SHA256 checksums
- **File Information**: Detailed file metadata display
- **Remote Search**: Search content within remote files using grep
- **Backup Creation**: Create backups of remote files/directories
- **Folder Comparison**: Compare local and remote folders
- **Cache Purge**: Clear common cache directories on remote server

### Developer Features
- **Diff View**: Compare local and remote file versions
- **Remote Terminal**: Open SSH terminal to remote server (SFTP only)
- **Transfer Queue**: Monitor and manage active transfers
- **Progress Indicators**: Visual feedback for all operations
- **Logging**: Comprehensive logging for debugging

## Installation

### From VSIX (Manual)
1. Download the latest `.vsix` file from [releases](https://github.com/yourusername/stackerftp/releases)
2. Open VS Code
3. Go to Extensions view (Ctrl+Shift+X)
4. Click "..." (More Actions) → "Install from VSIX..."
5. Select the downloaded `.vsix` file

### From Marketplace (Coming Soon)
```
Search for "StackerFTP" in the Extensions marketplace
```

## Quick Start

### 1. Configure Connection (3 Ways)

#### Option A: Connection Wizard (Recommended)
1. Open a workspace folder in VS Code
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
3. Type "SFTP: New Connection (Wizard)" and press Enter
4. Follow the step-by-step wizard:
   - **Step 1**: Select Protocol (SFTP/FTP/FTPS)
   - **Step 2**: Name your connection
   - **Step 3**: Enter host and port
   - **Step 4**: Enter credentials (Password or SSH Key)
   - **Step 5**: Set remote path
   - **Step 6**: Choose additional options

#### Option B: Quick Connect
1. Press `Ctrl+Shift+P`
2. Type "SFTP: Quick Connect"
3. Select or create a connection

#### Option C: Manual Config (JSON)
1. Press `Ctrl+Shift+P`
2. Type "SFTP: Config"
3. Select "Open Config File"
4. Edit the configuration file:

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
1. Press `Ctrl+Shift+P`
2. Type "SFTP: Connect"
3. Or click the cloud icon in the Remote Explorer panel

### 3. Transfer Files
- **Upload**: Right-click a local file → "Upload"
- **Download**: Right-click a remote file → "Download"
- **Sync**: Right-click a folder → "Sync Local → Remote" or "Sync Remote → Local"

## Configuration Options

### Basic Configuration
```json
{
  "name": "Production Server",
  "host": "server.example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "root",
  "privateKeyPath": "~/.ssh/id_rsa",
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
  "secure": true,
  "username": "user",
  "password": "pass",
  "passive": true,
  "remotePath": "/public_html"
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
  "syncMode": "update",
  "ignore": [
    ".git",
    ".DS_Store",
    "node_modules",
    "*.log"
  ],
  "watcher": {
    "files": "dist/**/*",
    "autoUpload": true,
    "autoDelete": false
  },
  "connTimeout": 10000,
  "keepalive": 10000
}
```

## Keyboard Shortcuts

| Command | Windows/Linux | Mac |
|---------|---------------|-----|
| Upload Current File | `Ctrl+Shift+U` | `Cmd+Shift+U` |
| Download | `Ctrl+Shift+D` | `Cmd+Shift+D` |
| Sync to Remote | `Ctrl+Shift+Alt+U` | `Cmd+Shift+Alt+U` |
| Sync to Local | `Ctrl+Shift+Alt+D` | `Cmd+Shift+Alt+D` |

## Settings

Open VS Code settings and search for "StackerFTP":

- `stackerftp.showHiddenFiles`: Show hidden files in remote explorer
- `stackerftp.confirmDelete`: Confirm before deleting remote files
- `stackerftp.confirmSync`: Confirm before syncing directories
- `stackerftp.autoRefresh`: Auto refresh remote explorer after operations
- `stackerftp.transferConcurrency`: Number of concurrent file transfers
- `stackerftp.showWebMasterTools`: Show web master tools in context menu

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
2. Select "Change Permissions (chmod)"
3. Enter the new permission (e.g., 755, 644)

### Calculate Checksum
1. Right-click a remote file
2. Select "Calculate Checksum"
3. Choose algorithm (MD5, SHA1, SHA256)
4. Compare with local file or copy to clipboard

### Search in Remote Files
1. Press `Ctrl+Shift+P`
2. Type "Search in Remote Files"
3. Enter search pattern
4. Results will show file path, line number, and content

### Create Backup
1. Right-click a remote file/folder
2. Select "Create Backup"
3. Optionally specify backup name
4. Backup will be created as `filename.backup-name.bak`

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

- GitHub Issues: [github.com/yourusername/stackerftp/issues](https://github.com/yourusername/stackerftp/issues)
- Email: support@stackerftp.com

---

**Enjoy using StackerFTP!** 🚀
