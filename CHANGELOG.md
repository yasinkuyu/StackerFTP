# Changelog

All notable changes to the "StackerFTP" extension will be documented in this file.

## [1.1.9] - 2026-02-15

### Added
- **Lightning-Fast Parallel Transfers**: Removed operation queue bottleneck - files now download/upload in true parallel, utilizing full concurrency settings.
- **Folder Upload/Download Fix**: Fixed workspace root detection - now correctly identifies selected folder's workspace instead of always using first workspace.

### Fixed
- **Parallel Transfer Performance**: Both SFTP and FTP connections now bypass sequential enqueue, enabling concurrent file transfers at maximum speed.
- **Workspace Detection**: Upload Folder and Download Folder commands now correctly resolve the selected folder's workspace.

## [1.1.8] - 2026-02-15
### Added
- **Interactive Collision Resolution**: Added a modal dialog when a directory/file çakışması (collision) is detected during both single and batch transfers.
- **Unified Transfer Queue**: Folder downloads and uploads are now fully integrated into the global transfer queue.
- **Concurrent Transfers**: Improved transfer speed by processing queue items in parallel (configurable via `transferConcurrency` setting).
- **Universal Collision Detection**: Collision prompts now trigger for both files and directories, ensuring nothing is overwritten without permission.
- **Zero-Latency Metadata**: Transfer queue now reuses scan data to eliminate redundant network checks, providing near-instant starts for bulk transfers.
- **Parallel Directory Scanning**: Major speed boost in the "Scanning" phase by traversing multiple subdirectories concurrently.
- **High-Throughput SFTP**: Tuned SFTP `fastPut`/`fastGet` with 256KB chunks and 128-parallel requests for maximum transfer speed.
- **Scanning Phase Status**: Added real-time scanning feedback to the status bar during directory traversal.
- **UI Stability**: Debounced queue updates to prevent status bar flickering and provide a professional transfer experience.
- **Batch Processing**: Optimized directory traversal for large folders to ensure stability and low memory usage.

### Fixed
- **Queue Deadlock Fix**: Resolved a hang where multiple concurrent transfers hitting collisions would block the entire queue. Serialized collision prompts to ensure a smooth user experience.
- **Single File Collision Support**: Extended collision resolution to single file downloads and uploads (previously only batch).
- **Tree View Directory Download**: Fixed "Failure" error when downloading folders from the Remote Explorer tree. The command now correctly identifies directories and uses recursive download logic.
- **Improved Error Handing**: Added remote-side directory checks to prevent SFTP stream errors when a directory is treated as a file.

## [1.1.7] - 2026-02-15
### Fixed
- **Directory Collision**: Resolved `EISDIR: illegal operation on a directory` error when downloading folders where a local directory exists at a remote file's target path.
- **Symlink Downloads**: Fixed issue where remote symlinks-to-directories were downloaded as files; they are now correctly created as local directories.
- **Transfer Safety**: Added defensive checks to SFTP and FTP download methods to prevent filesystem errors during concurrent or conflicting transfers.

## [1.1.6] - 2026-02-12
### Optimized
- **Performance**: Bundled extension with `esbuild`, reducing VSIX size from ~15MB to **1.4MB** and improving activation speed.
- **Dependency Management**: Optimized `.vscodeignore` and moved critical assets (codicons) to production dependencies to ensure reliable UI rendering in bundled environments.
- **Dynamic Imports**: Replaced all dynamic `require` calls with static `import`s for better bundler compatibility.

### Fixed
- **UI Icons**: Fixed missing connection icons in the sidebar by correcting Codicon class usage and asset packaging.
- **Binary Detection**: Improved binary detection logic and added a whitelist for common text extensions (PHP, JS, SQL, etc.) to prevent incorrect "Binary file" warnings.
- **Cache Synchronization**: Fixed a bug where remote previews showed stale content; added automatic cache invalidation after successful file uploads.
- **Activation Reliability**: Fixed silent activation failures by ensuring all `ssh2` sub-dependencies are correctly included in the VSIX.

## [1.1.5] - 2026-02-11

### Fixed
- **Missing Command Error**: Fixed critical "command not found" error for `stackerftp.tree.openFile` and other tree commands in the Native TreeView.
- **Registration Alignment**: Ensured all commands defined in `package.json` are correctly registered in the extension activation cycle.
- **Native Explorer Reliability**: Improved handler logic for tree items to ensure configurations are passed accurately.

## [1.1.4] - 2026-02-11

### Fixed
- Fixed "Converting circular structure to JSON" error when interacting with files in Remote Explorer.
- Optimized TreeItem serialization by removing internal connection references.
- Enhanced logger with safe JSON serialization for circular structures.

## [1.1.3] - 2026-02-11

### Fixed
- **Marketplace Build Fix**: Fixed critical issue where the extension failed to load when installed from Marketplace (missing dependencies).
- **Package Optimization**: Reduced VSIX size from 42MB to 1.3MB by excluding cache files.
- **Reliability**: Refactored resource loading to use native VS Code FileSystem API.

## [1.1.2] - 2026-02-11

### Fixed
- **Platform Integrity**: Switched to `vscode.workspace.fs` for secure file access across all environments.
- **Config Support**: Added support for JSON with comments (JSONC) in `sftp.json`.
- **Webview Handshake**: Implemented ready-handshake to eliminate race conditions during panel initialization.
- **Remote Explorer**: Optimized icon rendering and ensured loading indicators are always dismissed precisely.

## [1.1.1] - 2026-02-11

### Fixed
- **Connection Panel**: Fixed issue where the panel would get stuck on loading due to missing CSP and JavaScript errors during initial setup.
- **Remote Explorer**: Fixed stuck loading indicator when refreshing the explorer or opening connection nodes.
- **UI Stability**: Added safety checks for connection configurations to prevent frontend crashes.

## [1.1.0] - 2026-02-06

### Fixed
- **Config Sync**: Added automatic refresh and deletion detection for `sftp.json` configuration file. Manual deletions from the explorer now accurately reflect in the connections list.

### Refactored
- **Webview Optimization**: Extracted all inline HTML, CSS, and JavaScript from the connection form provider into separate modular files (`resources/webview/`), improving maintainability and reducing the main provider's size by ~1000 lines.

### Changed
- **Status Bar**: Consolidated status bar items. Transfer notifications are now non-persistent and use the standard `$(output)` icon for cleaner UI.

## [1.0.8] - 2026-02-06

### Added
- **Connection Hopping**: Support for Jump hosts in SFTP connections.
- **Auto Reconnect**: Automatic reconnection with backoff retry for dropped connections.
- **Checksum Compare**: Ability to compare remote file checksums with local files.
- **MIME Type**: File Info panel now displays MIME types for remote files.
- **Search Navigation**: Navigate directly to search results in remote files.
- **Support for FTP/FTPS**: "Compare Checksum" and other WebMaster tools are now available for FTP/FTPS.
- **Unit Tests**: Added automated unit tests for core functionality.

### Fixed
- **Activation Fix**: Commands now register correctly even when opening the extension without a workspace.
- **Security & Validation**: Removed non-essential files to resolve Marketplace security warnings and manifest errors.
- **Package Size**: Significantly reduced extension size by optimized packaging (from 24MB to ~900KB).
- **Download Prompt**: Large files now show a clear download prompt instead of hung previews.

### Changed
- **Performance**: Improved responsiveness through asynchronous file operations.
- **Documentation**: Updated README with new features and protocol alignment.

## [1.0.7] - 2026-02-06

### Fixed
- **Package Size**: Optimized extension package by excluding unnecessary cache files, reducing size from 24MB to ~2MB.

## [1.0.6] - 2026-02-06

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
 
