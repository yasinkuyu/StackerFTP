# Changelog

All notable changes to the "StackerFTP" extension will be documented in this file.

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

## Future Roadmap

### Planned for v1.1.0
- [ ] SFTP private key agent support
- [ ] Transfer speed limiting
- [ ] Bandwidth usage monitoring
- [ ] Scheduled sync tasks
- [ ] File filtering by date/size
- [ ] Remote file editing with auto-save
- [ ] Multi-root workspace support
- [ ] SFTP keyboard-interactive authentication

### Planned for v1.2.0
- [ ] FTP/SFTP proxy support
- [ ] SOCKS proxy support
- [ ] Transfer compression
- [ ] Resume interrupted transfers
- [ ] Transfer history
- [ ] Remote file preview
- [ ] Drag and drop between panels
- [ ] Quick diff in status bar

### Planned for v2.0.0
- [ ] WebDAV support
- [ ] AWS S3 support
- [ ] Google Cloud Storage support
- [ ] Azure Blob Storage support
- [ ] Git-like version control for remote files
- [ ] Team collaboration features
- [ ] Deployment pipelines
- [ ] CI/CD integration
