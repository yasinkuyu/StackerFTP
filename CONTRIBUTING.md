# Contributing to StackerFTP

Thank you for your interest in contributing to StackerFTP! This document provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites
- Node.js 18.x or higher
- npm 9.x or higher
- VS Code 1.74.0 or higher

### Setup

1. Fork and clone the repository:
```bash
git clone https://github.com/yasinkuyu/stackerftp.git
cd stackerftp
```

2. Install dependencies:
```bash
npm install
```

3. Open in VS Code:
```bash
code .
```

4. Press `F5` to run the extension in a new Extension Development Host window.

## Project Structure

```
stackerftp/
├── src/
│   ├── core/               # Core functionality
│   │   ├── config.ts       # Configuration management
│   │   ├── connection.ts   # Base connection interface
│   │   ├── connection-manager.ts
│   │   ├── ftp-connection.ts
│   │   ├── sftp-connection.ts
│   │   └── transfer-manager.ts
│   ├── providers/          # TreeView providers
│   │   ├── remote-explorer.ts
│   │   └── remote-file.ts
│   ├── commands/           # Command handlers
│   │   └── index.ts
│   ├── webmaster/          # Web master tools
│   │   └── tools.ts
│   ├── utils/              # Utilities
│   │   ├── helpers.ts
│   │   ├── logger.ts
│   │   └── index.ts
│   ├── types.ts            # Type definitions
│   └── extension.ts        # Extension entry point
├── resources/              # Icons and assets
├── package.json            # Extension manifest
└── tsconfig.json          # TypeScript configuration
```

## Development Workflow

### Building
```bash
npm run compile
```

### Watch Mode (for development)
```bash
npm run watch
```

### Linting
```bash
npm run lint
```

### Packaging
```bash
npm run package
```

## Code Style

- Use TypeScript strict mode
- Follow existing code formatting
- Use meaningful variable names
- Add JSDoc comments for public APIs
- Keep functions focused and small

## Testing

### Manual Testing
1. Run the extension with `F5`
2. Test all major features:
   - Connection to different server types
   - File transfers
   - Sync operations
   - Web master tools

### Test Checklist
- [ ] SFTP connection with password
- [ ] SFTP connection with private key
- [ ] FTP connection
- [ ] FTPS connection
- [ ] Upload file
- [ ] Download file
- [ ] Sync to remote
- [ ] Sync to local
- [ ] Delete remote file
- [ ] Create remote folder
- [ ] Rename remote file
- [ ] Chmod operation
- [ ] Checksum calculation
- [ ] File search

## Submitting Changes

### Pull Request Process

1. Create a feature branch:
```bash
git checkout -b feature/my-new-feature
```

2. Make your changes and commit:
```bash
git add .
git commit -m "feat: add new feature"
```

3. Push to your fork:
```bash
git push origin feature/my-new-feature
```

4. Open a Pull Request on GitHub

### Commit Message Format

Follow conventional commits:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting)
- `refactor:` Code refactoring
- `test:` Test changes
- `chore:` Build/process changes

Examples:
```
feat: add drag and drop support
fix: resolve connection timeout issue
docs: update README with new features
```

### PR Checklist

- [ ] Code builds without errors
- [ ] Linting passes
- [ ] Manual testing completed
- [ ] Documentation updated
- [ ] CHANGELOG.md updated
- [ ] Commit messages follow convention

## Reporting Issues

### Bug Reports
Include:
- VS Code version
- Extension version
- Operating system
- Server type (FTP/FTPS/SFTP)
- Steps to reproduce
- Expected behavior
- Actual behavior
- Error messages/logs

### Feature Requests
Include:
- Use case description
- Proposed solution
- Alternative solutions considered
- Additional context

## Code of Conduct

- Be respectful and inclusive
- Welcome newcomers
- Focus on constructive feedback
- Respect different viewpoints

## Questions?

Feel free to:
- Open an issue for questions
- Join discussions in existing issues
- Contact maintainers

Thank you for contributing! 🎉
