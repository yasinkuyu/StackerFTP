/**
 * StackerFTP - Commit Upload Panel
 *
 * A dedicated window that lists the files touched by commits, ready to upload.
 * The user picks the commit(s), the server and the files; nothing is sent until
 * "Upload" is pressed.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { configManager } from '../core/config';
import { getTargetConfig } from '../core/target';
import { connectionManager } from '../core/connection-manager';
import { createGitIntegration, GitCommit } from '../core/git-integration';
import { getIgnorePatterns } from '../core/sync-engine';
import { getLocalRoot, matchesPattern, getLocalRelativePath, normalizeRemotePath, sanitizeRelativePath } from '../utils/helpers';
import { FTPConfig } from '../types';
import { logger } from '../utils/logger';

export interface CommitUploadJob { config: FTPConfig; localPaths: string[] }
export type CommitUploadFn = (workspaceRoot: string, jobs: CommitUploadJob[]) => Promise<void>;

interface ServerEntry {
  config: FTPConfig;
  label: string;
  detail: string;
  isTarget: boolean;
  onCommit: boolean;
  /** Files of the chosen commits that belong to this server (its context, minus its ignore list) */
  files: FileEntry[];
  skippedInfo: string;
}

interface FileEntry {
  path: string;
  protected?: boolean;
  unselected?: boolean;
  remote: string;
  ctx: string;
  rel: string;
  absolutePath: string;
  status: string;
}

export class CommitUploadPanel {
  private static panel?: CommitUploadPanel;

  private readonly webviewPanel: vscode.WebviewPanel;
  private commits: GitCommit[] = [];
  private servers: ServerEntry[] = [];
  private selectedHashes: string[] = [];
  private defaultEnabled = new Set<number>();
  private refreshToken = 0;

  private constructor(
    private readonly workspaceRoot: string,
    private readonly upload: CommitUploadFn
  ) {
    this.webviewPanel = vscode.window.createWebviewPanel(
      'stackerftp.commitUpload',
      'Upload Commit Files',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.webviewPanel.onDidDispose(() => {
      if (CommitUploadPanel.panel === this) CommitUploadPanel.panel = undefined;
    });
    this.webviewPanel.webview.onDidReceiveMessage(msg => this.onMessage(msg));
    this.webviewPanel.webview.html = this.getHtml();
  }

  /** Open (or reuse) the panel with the given commit pre-selected (default: latest commit) */
  static async show(workspaceRoot: string, upload: CommitUploadFn, hash?: string): Promise<void> {
    const git = createGitIntegration(workspaceRoot);
    if (!git.isGitRepository()) {
      vscode.window.showErrorMessage('StackerFTP: Not a Git repository');
      return;
    }

    await configManager.loadConfig(workspaceRoot);
    if (configManager.getConfigs(workspaceRoot).length === 0) {
      vscode.window.showErrorMessage('StackerFTP: No SFTP configurations found');
      return;
    }

    const instance = CommitUploadPanel.panel && CommitUploadPanel.panel.workspaceRoot === workspaceRoot
      ? CommitUploadPanel.panel
      : new CommitUploadPanel(workspaceRoot, upload);
    if (CommitUploadPanel.panel && CommitUploadPanel.panel !== instance) CommitUploadPanel.panel.webviewPanel.dispose();
    CommitUploadPanel.panel = instance;
    instance.webviewPanel.reveal(undefined, false);
    await instance.load(hash);
  }

  private async load(hash?: string): Promise<void> {
    const git = createGitIntegration(this.workspaceRoot);
    this.commits = await git.getRecentCommits(50);
    if (this.commits.length === 0) {
      this.post({ type: 'error', message: 'No commits found' });
      return;
    }
    this.selectedHashes = [hash && this.commits.some(c => c.hash === hash) ? hash : this.commits[0].hash];

    const current = getTargetConfig(this.workspaceRoot);
    const currentResolved = current ? configManager.withProfile(this.workspaceRoot, current) : undefined;
    this.servers = configManager.getConfigs(this.workspaceRoot).map(raw => {
      const config = configManager.withProfile(this.workspaceRoot, raw);
      return {
        config,
        label: config.name || config.host,
        detail: `${config.protocol.toUpperCase()} • ${config.username}@${config.host}:${config.remotePath}`,
        isTarget: !!currentResolved && connectionManager.isSameTarget(currentResolved, config),
        onCommit: !!config.uploadOnCommit,
        files: [],
        skippedInfo: ''
      };
    });
    await this.refreshFiles();
  }

  private async refreshFiles(): Promise<void> {
    const token = ++this.refreshToken;
    this.post({ type: 'loading' });

    let error: string | undefined;
    let changed: Awaited<ReturnType<ReturnType<typeof createGitIntegration>['getFilesForCommits']>> = [];
    try {
      changed = this.selectedHashes.length > 0
        ? await createGitIntegration(this.workspaceRoot).getFilesForCommits(this.selectedHashes)
        : [];
    } catch (e: any) {
      error = `Could not read commit files: ${e.message}`;
      logger.error('Commit upload: failed to read commit files', e);
    }
    if (token !== this.refreshToken) return; // a newer refresh superseded this one

    // Routing: a file belongs to the server whose context (local folder) contains it. When several
    // contexts contain it, the deepest one wins (app_landing/dist beats the project root), so a
    // commit spanning several folders splits across servers on its own. Servers with the same
    // context tie and both keep the file; the user decides. The ignore list is applied afterwards
    // and never re-routes a file to another server.
    const roots = this.servers.map(s => getLocalRoot(this.workspaceRoot, s.config));
    const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
    const protectedPatterns = vscode.workspace.getConfiguration('stackerftp')
      .get<string[]>('commitUploadProtected', ['config', '.env*', '*.server.php', '*.pem', '*.key', 'id_rsa*']);
    const unselectedPatterns = vscode.workspace.getConfiguration('stackerftp')
      .get<string[]>('commitUploadUnselected', ['AGENTS.md']);
    const tied = new Set<number>();
    this.servers.forEach(s => { s.files = []; });
    const skipped = this.servers.map(() => ({ deleted: 0, missing: 0, ignored: 0, outside: 0, moreSpecific: 0 }));

    for (const f of changed) {
      const candidates = roots.map((r, i) => (inside(f.absolutePath, r) ? i : -1)).filter(i => i >= 0);
      const deepest = Math.max(...candidates.map(i => roots[i].length), -1);
      const owners = candidates.filter(i => roots[i].length === deepest);
      if (owners.length > 1) owners.forEach(i => tied.add(i));

      this.servers.forEach((server, i) => {
        const sk = skipped[i];
        if (f.status === 'deleted') { sk.deleted++; return; }
        if (!fs.existsSync(f.absolutePath) || !fs.statSync(f.absolutePath).isFile()) { sk.missing++; return; }
        if (!candidates.includes(i)) { sk.outside++; return; }
        if (!owners.includes(i)) { sk.moreSpecific++; return; }
        const rel = path.relative(roots[i], f.absolutePath).split(path.sep).join('/');
        if (matchesPattern(rel, getIgnorePatterns(server.config))) { sk.ignored++; return; }
        const shown = path.relative(this.workspaceRoot, f.absolutePath).split(path.sep).join('/');
        server.files.push({
          path: shown,
          absolutePath: f.absolutePath,
          status: f.status,
          protected: matchesPattern(shown, protectedPatterns),
          unselected: matchesPattern(shown, unselectedPatterns),
          ctx: path.relative(this.workspaceRoot, roots[i]).split(path.sep).join('/'),
          rel: path.relative(roots[i], f.absolutePath).split(path.sep).join('/'),
          remote: normalizeRemotePath(path.join(server.config.remotePath, sanitizeRelativePath(getLocalRelativePath(this.workspaceRoot, f.absolutePath, server.config))))
        });
      });
    }

    this.servers.forEach((server, i) => {
      const sk = skipped[i];
      server.files.sort((a, b) => a.path.localeCompare(b.path));
      server.skippedInfo = [
        sk.deleted ? `${sk.deleted} deleted (never removed remotely)` : '',
        sk.ignored ? `${sk.ignored} ignored` : '',
        sk.moreSpecific ? `${sk.moreSpecific} go to a more specific server` : '',
        sk.outside ? `${sk.outside} outside this server's folder` : '',
        sk.missing ? `${sk.missing} no longer on disk` : ''
      ].filter(Boolean).join(', ');
    });

    // Switched on by default: every server whose files are unambiguous. Servers sharing a folder
    // (a tie) stay off unless flagged uploadOnCommit or, failing that, the current target.
    const withFiles = this.servers.map((s, i) => ({ s, i })).filter(x => x.s.files.length > 0);
    const tiedFlagged = withFiles.some(x => tied.has(x.i) && x.s.onCommit);
    this.defaultEnabled = new Set(withFiles
      .filter(x => !tied.has(x.i) || x.s.onCommit || (!tiedFlagged && x.s.isTarget))
      .map(x => x.i));

    this.post({
      type: 'state',
      error,
      commits: this.commits.map(c => ({ ...c, checked: this.selectedHashes.includes(c.hash) })),
      servers: this.servers.map((s, i) => ({
        label: s.label,
        detail: s.detail,
        isTarget: s.isTarget,
        onCommit: s.onCommit,
        enabled: this.defaultEnabled.has(i),
        skippedInfo: s.skippedInfo,
        files: s.files.map((f, j) => ({
          id: j,
          path: f.path,
          status: f.status,
          protected: !!f.protected,
          unselected: !!f.unselected,
          remote: f.remote,
          ctx: f.ctx,
          rel: f.rel,
          // Same file also lands on these other servers (overlapping contexts)
          also: this.servers.filter((o, k) => k !== i && o.files.some(of => of.absolutePath === f.absolutePath)).map(o => o.label)
        }))
      }))
    });
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        await this.load(this.selectedHashes[0]);
        break;
      case 'selectCommits':
        if (Array.isArray(msg.hashes)) {
          this.selectedHashes = msg.hashes.filter((h: any) => this.commits.some(c => c.hash === h));
          await this.refreshFiles();
        }
        break;
      case 'upload': {
        // [{ server, ids }]: only servers the user switched on, only files they left checked
        const picks: { server: number; ids: number[] }[] = Array.isArray(msg.picks) ? msg.picks : [];
        const jobs: CommitUploadJob[] = [];
        for (const pick of picks) {
          const server = this.servers[pick.server];
          if (!server || !Array.isArray(pick.ids)) continue;
          const paths = pick.ids.map(id => server.files[id]?.absolutePath).filter((p): p is string => !!p);
          if (paths.length > 0) jobs.push({ config: server.config, localPaths: paths });
        }
        if (jobs.length === 0) return;
        // The review screen in the panel is the confirmation; nothing reaches here without it
        this.post({ type: 'uploading' });
        await this.upload(this.workspaceRoot, jobs);
        this.webviewPanel.dispose();
        break;
      }
      case 'cancel':
        this.webviewPanel.dispose();
        break;
    }
  }

  private post(message: any): void {
    this.webviewPanel.webview.postMessage(message);
  }

  private getHtml(): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Upload Commit Files</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 16px 80px; }
  h2 { font-size: 1.1em; margin: 16px 0 6px; font-weight: 600; }
  .box { border: 1px solid var(--vscode-panel-border); border-radius: 4px; max-height: 220px; overflow: auto; }
  .row { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; cursor: pointer; }
  .row { user-select: none; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .row .sub { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 0.85em; white-space: nowrap; }
  .tag { font-size: 0.8em; padding: 0 5px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .tag.warn { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-editorWarning-foreground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
  .added { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .modified { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .server { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 10px; }
  .server.off .files { opacity: 0.55; }
  .server.empty { opacity: 0.55; }
  .shead { display: flex; gap: 8px; align-items: baseline; padding: 8px; background: var(--vscode-sideBar-background); cursor: pointer; }
  .shead .name { font-weight: 600; }
  .shead .sub { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .files { max-height: 260px; overflow: auto; }
  .dim { color: var(--vscode-descriptionForeground); }
  .m { color: var(--vscode-terminal-ansiGreen, var(--vscode-gitDecoration-addedResourceForeground)); }
  .m b { font-weight: 700; }
  .row .remote { color: var(--vscode-descriptionForeground); font-size: 0.85em; font-family: var(--vscode-editor-font-family); }
  .row .also { color: var(--vscode-editorWarning-foreground); font-size: 0.85em; }
  .row .path { flex: 1; word-break: break-all; }
  .note { color: var(--vscode-descriptionForeground); margin: 6px 0; font-size: 0.9em; }
  .error { color: var(--vscode-errorForeground); }
  #review { position: fixed; inset: 0; background: var(--vscode-editor-background); display: flex; flex-direction: column; z-index: 10; }
  #review[hidden] { display: none; }
  #review .body { flex: 1; overflow: auto; padding: 0 16px 16px; }
  #review .rs { margin-top: 14px; font-weight: 600; }
  #review .rs .meta { font-weight: normal; color: var(--vscode-descriptionForeground); }
  #review table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  #review td { padding: 3px 8px; vertical-align: top; border-bottom: 1px solid var(--vscode-panel-border); word-break: break-all; }
  #review td.remote { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  #review td.arrow { width: 1.5em; color: var(--vscode-descriptionForeground); }
  #review .warnrow td { background: var(--vscode-inputValidation-warningBackground); }
  .bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 8px; align-items: center; padding: 10px 16px; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
  .bar .spacer { flex: 1; }
  button { padding: 5px 14px; border: 1px solid transparent; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.5; cursor: default; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; margin-right: 10px; }
</style>
</head>
<body>
  <h2>1. Commits</h2>
  <div id="commits" class="box"></div>
  <h2>2. Which file goes where</h2>
  <div class="note">A file goes to the server whose <code>context</code> folder contains it (the deepest folder wins), under that server's <code>remotePath</code>; its <code>ignore</code> list is applied last. Switch a server off to skip it.</div>
  <div id="servers"></div>
  <div id="error" class="error"></div>
  <div id="review" hidden>
    <div class="body">
      <h2>Review before uploading</h2>
      <div class="note">Check every file, server and remote path. Nothing is uploaded until you confirm.</div>
      <div id="reviewList"></div>
    </div>
    <div class="bar">
      <span id="reviewSummary"></span><span class="spacer"></span>
      <button id="back" class="secondary">Back</button>
      <button id="confirm">Confirm &amp; Upload</button>
    </div>
  </div>
  <div class="bar">
    <span id="summary"></span><span class="spacer"></span>
    <button id="cancel" class="secondary">Cancel</button>
    <button id="upload" disabled>Upload</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let state = null;
  const enabled = new Set();     // server index switched on
  const unchecked = new Set();   // "server:fileId" the user took out

  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // Matching part (path relative to the server's context) is green on both sides; what the
  // context and remotePath add around it is dimmed. File name in bold.
  function hl(rel) {
    const i = rel.lastIndexOf('/');
    return '<span class="m">' + esc(rel.slice(0, i + 1)) + '<b>' + esc(rel.slice(i + 1)) + '</b></span>';
  }
  function localHtml(f) { return (f.ctx ? '<span class="dim">' + esc(f.ctx) + '/</span>' : '') + hl(f.rel); }
  function remoteHtml(f) {
    return f.remote.endsWith(f.rel)
      ? '<span class="dim">' + esc(f.remote.slice(0, f.remote.length - f.rel.length)) + '</span>' + hl(f.rel)
      : esc(f.remote);
  }

  function picks() {
    return state.servers.map((s, i) => ({ server: i, ids: s.files.filter(f => !unchecked.has(i + ':' + f.id)).map(f => f.id) }))
      .filter(p => enabled.has(p.server) && p.ids.length > 0);
  }

  function renderSummary() {
    const ps = picks();
    const n = ps.reduce((a, p) => a + p.ids.length, 0);
    const total = state.servers.reduce((a, s) => a + s.files.length, 0);
    let why = '';
    if (n === 0) {
      if (total === 0) why = 'No uploadable files in the selected commits';
      else if (enabled.size === 0) why = 'Switch on a server above to upload';
      else why = 'No file is checked (protected files and AGENTS.md start unchecked)';
    }
    $('summary').textContent = n ? n + ' file' + (n === 1 ? '' : 's') + ' → ' + ps.length + ' server' + (ps.length === 1 ? '' : 's') : why;
    $('upload').disabled = n === 0;
    $('upload').textContent = n ? 'Upload ' + n + ' file' + (n > 1 ? 's' : '') : 'Upload';
  }

  function render() {
    $('error').textContent = state.error || '';
    $('commits').innerHTML = state.commits.map(c =>
      '<label class="row"><input type="checkbox" data-hash="' + esc(c.hash) + '"' + (c.checked ? ' checked' : '') + '>' +
      '<span>' + esc(c.subject) + '</span><span class="sub">' + esc(c.shortHash) + ' · ' + esc(c.author) + ' · ' + esc(c.date) + '</span></label>').join('');
    $('servers').innerHTML = state.servers.map((s, i) => {
      const on = enabled.has(i), has = s.files.length > 0;
      const tags = (s.isTarget ? ' <span class="tag">current target</span>' : '') + (s.onCommit ? ' <span class="tag">uploadOnCommit</span>' : '');
      const rows = has ? s.files.map(f =>
        '<label class="row"><input type="checkbox" data-s="' + i + '" data-f="' + f.id + '"' + (unchecked.has(i + ':' + f.id) ? '' : ' checked') + (on ? '' : ' disabled') + '>' +
        '<span class="path">' + localHtml(f) + '<div class="remote">→ ' + remoteHtml(f) + '</div>' +
        (f.also.length ? '<div class="also">same folder as: ' + esc(f.also.join(', ')) + '</div>' : '') + '</span>' +
        '<span class="sub">' + (f.unselected && !f.protected ? '<span class="tag" title="Not selected by default (stackerftp.commitUploadUnselected). Tick to upload.">off by default</span> ' : '') + (f.protected ? '<span class="tag warn" title="Protected: may overwrite live settings. Tick to upload.">⚠ protected</span> ' : '') + '<span class="tag ' + esc(f.status) + '">' + esc(f.status) + '</span></span></label>').join('')
        : '<div class="row meta">No files of these commits belong to this server</div>';
      return '<div class="server' + (on ? '' : ' off') + (has ? '' : ' empty') + '">' +
        '<label class="shead"><input type="checkbox" data-server="' + i + '"' + (on ? ' checked' : '') + (has ? '' : ' disabled') + '>' +
        '<span class="name">' + esc(s.label) + '</span>' + tags +
        '<span class="sub">' + esc(s.detail) + ' · ' + s.files.length + ' file' + (s.files.length === 1 ? '' : 's') + '</span></label>' +
        '<div class="files">' + rows + '</div>' +
        (s.skippedInfo ? '<div class="note" style="padding:0 8px 6px">Skipped: ' + esc(s.skippedInfo) + '</div>' : '') + '</div>';
    }).join('');
    renderSummary();
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'loading') { $('upload').disabled = true; }
    else if (m.type === 'uploading') { $('upload').disabled = true; $('confirm').textContent = 'Uploading...'; $('upload').textContent = 'Uploading...'; $('cancel').disabled = true; }
    else if (m.type === 'error') { $('error').textContent = m.message; }
    else if (m.type === 'state') {
      state = m;
      enabled.clear(); unchecked.clear();
      m.servers.forEach((s, i) => {
        if (s.enabled) enabled.add(i);
        s.files.forEach(f => { if (f.protected || f.unselected) unchecked.add(i + ':' + f.id); });   // start off until ticked
      });
      render();
    }
  });

  // Shift+click selects a range, like in a file list: the boxes between the last clicked one
  // and this one take the state of this one. Works for commits and for the files of a server.
  let lastCommit = null;
  $('commits').addEventListener('click', e => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.dataset.hash === undefined) return;
    const boxes = [...document.querySelectorAll('#commits input[data-hash]')];
    if (e.shiftKey && lastCommit && lastCommit !== t) {
      const a = boxes.indexOf(lastCommit), b = boxes.indexOf(t);
      boxes.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => { x.checked = t.checked; });
    }
    lastCommit = t;
  });
  let lastFile = null;
  $('servers').addEventListener('click', e => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.dataset.f === undefined) return;
    if (e.shiftKey && lastFile && lastFile !== t && lastFile.dataset.s === t.dataset.s) {
      const boxes = [...document.querySelectorAll('#servers input[data-s="' + t.dataset.s + '"]')];
      const a = boxes.indexOf(lastFile), b = boxes.indexOf(t);
      boxes.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => {
        x.checked = t.checked;
        const k = x.dataset.s + ':' + x.dataset.f;
        t.checked ? unchecked.delete(k) : unchecked.add(k);
      });
    }
    lastFile = t;
  });

  $('commits').addEventListener('change', () => {
    const hashes = [...document.querySelectorAll('#commits input:checked')].map(i => i.dataset.hash);
    vscode.postMessage({ type: 'selectCommits', hashes });
  });
  $('servers').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.server !== undefined) { const i = Number(t.dataset.server); t.checked ? enabled.add(i) : enabled.delete(i); render(); }
    else if (t.dataset.f !== undefined) { const k = t.dataset.s + ':' + t.dataset.f; t.checked ? unchecked.delete(k) : unchecked.add(k); renderSummary(); }
  });
  function openReview() {
    const ps = picks();
    let total = 0, risky = 0;
    $('reviewList').innerHTML = ps.map(p => {
      const srv = state.servers[p.server];
      const files = srv.files.filter(f => p.ids.includes(f.id));
      total += files.length;
      risky += files.filter(f => f.protected).length;
      return '<div class="rs">' + esc(srv.label) + ' <span class="meta">' + esc(srv.detail) + ' · ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '</span></div>' +
        '<table>' + files.map(f =>
          '<tr' + (f.protected ? ' class="warnrow"' : '') + '><td>' + (f.protected ? '⚠ ' : '') + localHtml(f) + '</td><td class="arrow">→</td><td class="remote">' + remoteHtml(f) + '</td></tr>').join('') + '</table>';
    }).join('');
    $('reviewSummary').textContent = total + ' file' + (total === 1 ? '' : 's') + ' → ' + ps.length + ' server' + (ps.length === 1 ? '' : 's') +
      (risky ? ' · ⚠ ' + risky + ' protected (may overwrite live settings)' : '');
    $('review').hidden = false;
  }
  $('upload').addEventListener('click', openReview);
  $('back').addEventListener('click', () => { $('review').hidden = true; });
  $('confirm').addEventListener('click', () => {
    $('confirm').disabled = true; $('back').disabled = true; $('confirm').textContent = 'Uploading...';
    vscode.postMessage({ type: 'upload', picks: picks() });
  });
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

/**
 * Open the panel whenever a commit is made in a workspace that has at least one
 * connection with "uploadOnCommit": true. Off unless stackerftp.commitUploadPrompt is on.
 */
export function registerCommitWatcher(context: vscode.ExtensionContext, upload: CommitUploadFn): void {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) return;

  const watched = new Set<string>();

  const watch = (repo: any) => {
    const key = repo.rootUri.fsPath;
    if (watched.has(key) || typeof repo.onDidCommit !== 'function') return;
    watched.add(key);
    context.subscriptions.push(repo.onDidCommit(async () => {
      try {
        if (!vscode.workspace.getConfiguration('stackerftp').get<boolean>('commitUploadPrompt', false)) return;
        const folder = vscode.workspace.workspaceFolders?.find(f =>
          key === f.uri.fsPath || key.startsWith(f.uri.fsPath + path.sep) || f.uri.fsPath.startsWith(key + path.sep));
        if (!folder) return;
        const root = folder.uri.fsPath;
        await configManager.loadConfig(root);
        if (!configManager.getConfigs(root).some(c => c.uploadOnCommit)) return;
        // Amend/merge commits fire this too; the panel only lists, nothing uploads without a click
        const head = repo.state?.HEAD?.commit;
        await CommitUploadPanel.show(root, upload, head);
      } catch (error: any) {
        logger.error('Commit upload prompt failed', error);
      }
    }));
  };

  gitExtension.activate().then(ext => {
    const api = ext.getAPI(1);
    api.repositories.forEach(watch);
    context.subscriptions.push(api.onDidOpenRepository(watch));
  }, (e: any) => logger.error('Git extension unavailable for commit watcher', e));
}
