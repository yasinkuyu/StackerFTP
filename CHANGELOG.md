# Changelog

All notable changes to the "StackerFTP" extension will be documented in this file.

## [1.0.5] - 2026-02-06

### Added
- **Atomic Uploads**: Implemented atomic upload logic for SFTP to prevent partial file uploads and ensure data integrity.
- **Unit Testing**: Integrated Vitest for robust unit testing of core components.
- **Fork Compatibility**: Added metadata keywords and explicit README mentions for Cursor, Antigravity, Windsurf, VSCodium, Trae, and PearAI.
- **Improved Symlinks**: Enhanced symlink display in Remote Explorer to show target paths more clearly.

### Changed
- **Maintenance**: Minor bug fixes and performance improvements in Remote Explorer.
- **Package Management**: Improved `.gitignore` and `package-lock.json` handling for better environment consistency.

## [1.0.4] - 2026-02-05

### Fixed
- **Connection Modal**: Fixed bug where selecting a primary connection caused others to disappear.
- **Connection Sync**: Fixed issue where sidebar connections list wasn't updating when activating a connection in the modal.
- **Webview Sync**: Fixed connection status synchronization in the Connections webview.
- **Remote Terminal**: Fixed logical error in "Open Remote Terminal" to ensure correct connection usage.
- **Command Visibility**: Ensure SFTP commands are hidden for FTP/FTPS connections.
- **TransferManager**: Fixed connection reuse bug and potential data corruption issues.

### Added
- **Transfer Queue Panel**: Implemented FileZilla-style Transfer Queue panel below the tree view.
- **Tree View Commands**: Added commands to toggle hidden files and sort files in the Remote Explorer.
- **Status Bar**: Added transfer indicator to status bar.

## [1.0.3] - 2026-02-05

### Added
- Transfer Queue TreeView panel with status bar integration
- Transfer count indicator in status bar with click-to-view functionality
- Large file warning (5MB+) with download option
- Improved symlink handling with broken symlink detection
- Binary file detection improvements

### Fixed
- **Connect/Disconnect button visibility bug**: Fixed regex pattern that caused both buttons to appear simultaneously
- **Remote Explorer server list**: Now always shows ALL configured servers (both connected and disconnected)
- **Connection state sync**: Remote Explorer and Connections panel now stay in sync when connecting/disconnecting
- **Connections webview icons**: Removed manual CSS overrides and fixed URI path to use official VS Code codicon assets, ensuring 100% visual consistency
- Replaced custom PNG icons with native VS Code codicons (`$(plug)` and `$(debug-disconnect)`)
- Improved error messages for file operations (ENOENT, EPERM, timeout, etc.)
- Better handling of special file types (sockets, symlinks)

### Changed
- Status bar now shows active transfer count with spinning icon
- Unified icon usage across Remote Explorer and Connections panel

---

## [1.0.2] - 2026-02-05
### Fixed
- Fixed README claims to match actual codebase implementation
- Clarified that Web Master Tools (chmod, checksum, etc.) are SFTP-only
- Fixed visibility of SFTP-only context menu commands on FTP connections

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
 