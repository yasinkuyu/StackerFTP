# Changelog

All notable changes to the "StackerFTP" extension will be documented in this file.

## [1.0.1] - 2026-02-05

### Fixed
- Fixed TransferManager connection reuse bug
- Improved Remote Explorer tree view commands

### Added
- Added "Edit Local" button (Remote file editing with auto-save)
- Updated toolbar icons

## [1.0.0] - 2025-02-01

### Added
- Initial release of StackerFTP
- FTP, FTPS, and SFTP protocol support
- Remote Explorer with native VS Code file tree
- Bi-directional file synchronization
- Upload on save functionality
- Connection profiles support
- File manager operations (upload, download, delete, rename, duplicate)
- Recursive directory operations
- Transfer queue with progress indicators
- Web Master Tools:
  - Permission management (chmod)
  - Checksum calculation (MD5, SHA1, SHA256)
  - File information display
  - Remote file search
  - Backup creation
  - Folder comparison
  - Cache purge
- Remote terminal support (SFTP)
- Diff view for local vs remote files
- Comprehensive logging system
- Keyboard shortcuts for common operations
- Multiple configuration profiles
- Connection hopping (jump hosts)
- File watcher for automatic uploads
- Ignore patterns support

### Features
- Native VS Code look and feel
- Works with VS Code and all forks (Cursor, Antigravity, etc.)
- Minimal custom styling
- Fast and efficient file transfers
- Concurrent transfer support
- Auto-refresh after operations
- Hidden files support
- File type icons
- Status bar integration
 