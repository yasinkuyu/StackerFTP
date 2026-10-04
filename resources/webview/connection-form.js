const vscode = acquireVsCodeApi();

// Elements
const connectionList = document.getElementById('connectionList');
const loadingOverlay = document.getElementById('loadingOverlay');
const emptyState = document.getElementById('emptyState');
const connectionForm = document.getElementById('connectionForm');
const formTitle = document.getElementById('formTitle');
const sftpAuthSection = document.getElementById('sftpAuthSection');
const ftpsOptions = document.getElementById('ftpsOptions');
const keyAuthContent = document.getElementById('keyAuthContent');
const formMessage = document.getElementById('formMessage');

// Inputs
const inputName = document.getElementById('inputName');
const inputHost = document.getElementById('inputHost');
const inputPort = document.getElementById('inputPort');
const inputUsername = document.getElementById('inputUsername');
const inputPassword = document.getElementById('inputPassword');
const inputPrivateKey = document.getElementById('inputPrivateKey');
const inputPassphrase = document.getElementById('inputPassphrase');
const inputRemotePath = document.getElementById('inputRemotePath');
const inputUploadOnSave = document.getElementById('inputUploadOnSave');
const inputSecureMode = document.getElementById('inputSecureMode');
const inputAllowSelfSigned = document.getElementById('inputAllowSelfSigned');

// Advanced inputs
const advancedContent = document.getElementById('advancedContent');
const inputContext = document.getElementById('inputContext');
const inputSyncMode = document.getElementById('inputSyncMode');
const inputDownloadOnOpen = document.getElementById('inputDownloadOnOpen');
const inputWatcherEnabled = document.getElementById('inputWatcherEnabled');
const watcherOptions = document.getElementById('watcherOptions');
const inputWatcherFiles = document.getElementById('inputWatcherFiles');
const inputWatcherAutoUpload = document.getElementById('inputWatcherAutoUpload');
const inputWatcherAutoDelete = document.getElementById('inputWatcherAutoDelete');
const inputIgnore = document.getElementById('inputIgnore');
const inputConnTimeout = document.getElementById('inputConnTimeout');
const inputKeepalive = document.getElementById('inputKeepalive');
const keepaliveRow = document.getElementById('keepaliveRow');
const inputAutoReconnect = document.getElementById('inputAutoReconnect');
const hopSection = document.getElementById('hopSection');
const hopList = document.getElementById('hopList');
const inputExplorerOrder = document.getElementById('inputExplorerOrder');
const inputDefaultProfile = document.getElementById('inputDefaultProfile');
const profilesHint = document.getElementById('profilesHint');

// State
let configs = [];
let editingIndex = null;
let selectedProtocol = 'sftp';
let showForm = false;
let hops = [];

// Load initial state from cache for instant display
const previousState = vscode.getState();
if (previousState && previousState.configs) {
    configs = previousState.configs;
    renderConnections();
    loadingOverlay.classList.add('hidden');
    connectionList.classList.remove('hidden');
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown')) {
        document.querySelectorAll('.dropdown-menu.show').forEach(menu => {
            menu.classList.remove('show');
        });
    }
});

// Protocol tabs
document.querySelectorAll('.protocol-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.protocol-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        selectedProtocol = tab.dataset.protocol;
        updateFormForProtocol();
    });
});

function updateFormForProtocol() {
    const isSftp = selectedProtocol === 'sftp';
    sftpAuthSection.classList.toggle('hidden', !isSftp);
    ftpsOptions.classList.toggle('hidden', selectedProtocol !== 'ftps');
    // Keepalive and jump hosts are SSH features
    keepaliveRow.classList.toggle('hidden', !isSftp);
    keepaliveRow.parentElement.classList.toggle('single', !isSftp);
    hopSection.classList.toggle('hidden', !isSftp);
    if (!inputPort.value || inputPort.value === '22' || inputPort.value === '21' || inputPort.value === '990') {
        inputPort.placeholder = selectedProtocol === 'sftp' ? '22' : '21';
    }
}

// Toggle key auth section
document.getElementById('toggleKeyAuth').addEventListener('click', () => {
    keyAuthContent.classList.toggle('open');
    document.getElementById('toggleKeyAuth').querySelector('span').textContent =
        keyAuthContent.classList.contains('open') ? '▼' : '▶';
});

// Toggle advanced section
function setAdvancedOpen(open) {
    advancedContent.classList.toggle('open', open);
    document.getElementById('toggleAdvanced').querySelector('span').textContent = open ? '▼' : '▶';
}
document.getElementById('toggleAdvanced').addEventListener('click', () => {
    setAdvancedOpen(!advancedContent.classList.contains('open'));
});

inputWatcherEnabled.addEventListener('change', () => {
    watcherOptions.classList.toggle('hidden', !inputWatcherEnabled.checked);
});

document.getElementById('btnBrowseContext').addEventListener('click', () => {
    vscode.postMessage({ type: 'browseContext' });
});
document.getElementById('btnManageProfiles').addEventListener('click', () => {
    vscode.postMessage({ type: 'manageProfiles' });
});
document.getElementById('btnOpenJson').addEventListener('click', () => {
    vscode.postMessage({ type: 'openJson' });
});

// Jump hosts editor
function renderHops() {
    hopList.innerHTML = '';
    hops.forEach((hop, i) => {
        const item = document.createElement('div');
        item.className = 'hop-item';
        item.innerHTML = `
      <div class="hop-item-header">
        <span>Hop ${i + 1}</span>
        <button type="button" class="btn-icon" data-remove title="Remove"><span class="codicon codicon-close"></span></button>
      </div>
      <div class="form-row form-row-inline">
        <input type="text" class="form-input" data-field="host" placeholder="bastion.example.com">
        <input type="number" class="form-input" data-field="port" placeholder="22">
      </div>
      <div class="form-row">
        <input type="text" class="form-input" data-field="username" placeholder="Username">
      </div>
      <div class="form-row">
        <input type="text" class="form-input" data-field="privateKeyPath" placeholder="Private key path (optional)">
      </div>
      <div class="form-row">
        <input type="password" class="form-input" data-field="password" placeholder="Password (optional)">
      </div>`;
        item.querySelectorAll('[data-field]').forEach(input => {
            input.value = hop[input.dataset.field] || '';
            input.addEventListener('input', () => { hops[i][input.dataset.field] = input.value; });
        });
        item.querySelector('[data-remove]').addEventListener('click', () => {
            hops.splice(i, 1);
            renderHops();
        });
        hopList.appendChild(item);
    });
}
document.getElementById('btnAddHop').addEventListener('click', () => {
    hops.push({ host: '', port: '', username: '', privateKeyPath: '', password: '' });
    renderHops();
});

function setProfiles(config) {
    const names = Object.keys((config && config.profiles) || {});
    inputDefaultProfile.innerHTML = '<option value="">None</option>' +
        names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    inputDefaultProfile.value = (config && config.defaultProfile && names.includes(config.defaultProfile)) ? config.defaultProfile : '';
    inputDefaultProfile.disabled = names.length === 0;
    profilesHint.textContent = names.length
        ? `${names.length} profile(s): ${names.join(', ')}`
        : 'No profiles yet. Profiles override settings per environment (e.g. dev / prod).';
}

// Header buttons
document.getElementById('btnHeaderNew').addEventListener('click', showNewForm);
document.getElementById('btnHeaderRefresh').addEventListener('click', () => {
    loadingOverlay.classList.remove('hidden');
    vscode.postMessage({ type: 'loadConfigs' });
});

// New connection button
const btnFirstConnection = document.getElementById('btnFirstConnection');
if (btnFirstConnection) {
    btnFirstConnection.addEventListener('click', showNewForm);
}

function showNewForm() {
    editingIndex = null;
    formTitle.textContent = 'New Connection';
    clearForm();
    connectionForm.classList.remove('hidden');
    connectionList.classList.add('hidden');
    loadingOverlay.classList.add('hidden');
    showForm = true;
    vscode.postMessage({ type: 'showForm' });
}

window.showNewForm = showNewForm;

function clearForm() {
    clearFormMessage();
    inputName.value = '';
    inputHost.value = '';
    inputPort.value = '';
    inputUsername.value = '';
    inputPassword.value = '';
    inputPrivateKey.value = '';
    inputPassphrase.value = '';
    inputRemotePath.value = '/';
    inputUploadOnSave.checked = false;
    inputSecureMode.value = 'explicit';
    inputAllowSelfSigned.checked = false;
    inputContext.value = '';
    inputSyncMode.value = 'update';
    inputDownloadOnOpen.checked = false;
    inputWatcherEnabled.checked = false;
    inputWatcherFiles.value = '**/*';
    inputWatcherAutoUpload.checked = true;
    inputWatcherAutoDelete.checked = false;
    watcherOptions.classList.add('hidden');
    inputIgnore.value = '';
    inputConnTimeout.value = '';
    inputKeepalive.value = '';
    inputAutoReconnect.checked = true;
    inputExplorerOrder.value = '';
    hops = [];
    renderHops();
    setProfiles(null);
    setAdvancedOpen(false);
    selectedProtocol = 'sftp';
    document.querySelectorAll('.protocol-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.protocol === 'sftp');
    });
    updateFormForProtocol();
}

function showFormMessage(message, type = 'error') {
    if (!formMessage) return;
    formMessage.textContent = message;
    formMessage.className = 'form-message ' + type;
    formMessage.classList.remove('hidden');
}

function clearFormMessage() {
    if (!formMessage) return;
    formMessage.textContent = '';
    formMessage.className = 'form-message hidden';
}

function loadConfigToForm(config) {
    inputName.value = config.name || '';
    inputHost.value = config.host || '';
    inputPort.value = config.port || '';
    inputUsername.value = config.username || '';
    inputPassword.value = config.password || '';
    inputPrivateKey.value = config.privateKeyPath || '';
    inputPassphrase.value = config.passphrase || '';
    inputRemotePath.value = config.remotePath || '/';
    inputUploadOnSave.checked = config.uploadOnSave || false;
    inputSecureMode.value = config.secure === 'implicit' ? 'implicit' : 'explicit';
    inputAllowSelfSigned.checked = !!(config.secureOptions && config.secureOptions.rejectUnauthorized === false);

    // Advanced
    inputContext.value = config.context || '';
    inputSyncMode.value = config.syncMode === 'full' ? 'full' : 'update';
    inputDownloadOnOpen.checked = !!config.downloadOnOpen;
    const watcher = config.watcher === true
        ? { files: '**/*', autoUpload: true, autoDelete: false }
        : (config.watcher || null);
    inputWatcherEnabled.checked = !!watcher;
    inputWatcherFiles.value = (watcher && watcher.files) || '**/*';
    inputWatcherAutoUpload.checked = watcher ? watcher.autoUpload !== false : true;
    inputWatcherAutoDelete.checked = !!(watcher && watcher.autoDelete);
    watcherOptions.classList.toggle('hidden', !watcher);
    inputIgnore.value = Array.isArray(config.ignore) ? config.ignore.join('\n') : '';
    inputConnTimeout.value = config.connTimeout || '';
    inputKeepalive.value = config.keepalive || '';
    inputAutoReconnect.checked = config.autoReconnect !== false;
    inputExplorerOrder.value = config.remoteExplorerOrder || '';
    hops = (config.hop ? (Array.isArray(config.hop) ? config.hop : [config.hop]) : []).map(h => ({
        host: h.host || '', port: h.port || '', username: h.username || '',
        privateKeyPath: h.privateKeyPath || '', password: h.password || ''
    }));
    renderHops();
    setProfiles(config);

    selectedProtocol = config.protocol || 'sftp';
    document.querySelectorAll('.protocol-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.protocol === selectedProtocol);
    });
    updateFormForProtocol();

    if (config.privateKeyPath) {
        keyAuthContent.classList.add('open');
        document.getElementById('toggleKeyAuth').querySelector('span').textContent = '▼';
    }
}

function getFormData() {
    return {
        name: inputName.value.trim() || inputHost.value.trim(),
        host: inputHost.value.trim(),
        port: inputPort.value || (selectedProtocol === 'sftp' ? 22 : 21),
        protocol: selectedProtocol,
        username: inputUsername.value.trim(),
        password: inputPassword.value,
        privateKeyPath: inputPrivateKey.value.trim() || undefined,
        passphrase: inputPassphrase.value || undefined,
        remotePath: inputRemotePath.value.trim() || '/',
        uploadOnSave: inputUploadOnSave.checked,
        secureMode: inputSecureMode.value,
        allowSelfSigned: inputAllowSelfSigned.checked,
        advanced: {
            context: inputContext.value.trim(),
            syncMode: inputSyncMode.value,
            downloadOnOpen: inputDownloadOnOpen.checked,
            watcher: inputWatcherEnabled.checked ? {
                files: inputWatcherFiles.value.trim() || '**/*',
                autoUpload: inputWatcherAutoUpload.checked,
                autoDelete: inputWatcherAutoDelete.checked
            } : null,
            ignore: inputIgnore.value.split('\n').map(l => l.trim()).filter(Boolean),
            connTimeout: parseInt(inputConnTimeout.value, 10) || null,
            keepalive: inputKeepalive.value === '' ? null : parseInt(inputKeepalive.value, 10),
            autoReconnect: inputAutoReconnect.checked,
            hop: hops.filter(h => h.host && h.host.trim()).map(h => ({
                host: h.host.trim(),
                port: parseInt(h.port, 10) || 22,
                username: (h.username || '').trim(),
                privateKeyPath: (h.privateKeyPath || '').trim() || undefined,
                password: h.password || undefined
            })),
            remoteExplorerOrder: inputExplorerOrder.value,
            defaultProfile: inputDefaultProfile.value
        }
    };
}

function validateForm(data) {
    let isValid = true;
    clearFormMessage();
    document.querySelectorAll('.form-input').forEach(input => input.classList.remove('input-error'));
    document.querySelectorAll('.form-input-error-message').forEach(msg => msg.remove());

    const showError = (elementId, message) => {
        const input = document.getElementById(elementId);
        if (input) {
            input.classList.add('input-error');
            const msg = document.createElement('div');
            msg.className = 'form-input-error-message';
            msg.textContent = message;
            input.parentNode.insertBefore(msg, input.nextSibling);
        }
        isValid = false;
    };

    if (!data.host) showError('inputHost', 'Host is required');
    if (!data.username) showError('inputUsername', 'Username is required');
    if (selectedProtocol === 'sftp' && data.advanced.hop.some(h => !h.username)) {
        showFormMessage('Each jump host needs a username.');
        setAdvancedOpen(true);
        return false;
    }

    if (!isValid) showFormMessage('Please fix the highlighted fields before saving.');
    return isValid;
}

// Form actions
document.getElementById('btnCancel').addEventListener('click', () => {
    connectionForm.classList.add('hidden');
    connectionList.classList.remove('hidden');
    showForm = false;
    editingIndex = null;
    vscode.postMessage({ type: 'hideForm' });
});

document.getElementById('btnTest').addEventListener('click', () => {
    const config = getFormData();
    if (!validateForm(config)) return;
    const btn = document.getElementById('btnTest');
    btn.textContent = 'Testing...';
    vscode.postMessage({ type: 'testConnection', config });
});

document.getElementById('btnSave').addEventListener('click', () => {
    const config = getFormData();
    if (!validateForm(config)) return;
    vscode.postMessage({ type: 'saveConfig', config, index: editingIndex });
    showFormMessage('Saving...', 'info');
});

document.getElementById('btnBrowseKey').addEventListener('click', () => {
    vscode.postMessage({ type: 'browsePrivateKey' });
});

// Render connection list
function renderConnections() {
    if (configs.length === 0) {
        emptyState.classList.remove('hidden');
        connectionList.querySelectorAll('.connection-item').forEach(item => item.remove());
        return;
    }

    emptyState.classList.add('hidden');
    connectionList.querySelectorAll('.connection-item').forEach(item => item.remove());

    configs.forEach((config, index) => {
        const item = document.createElement('div');
        item.className = 'connection-item' + (config.connected ? ' connected' : '');
        const protocolIconClass = config.protocol === 'sftp' ? 'codicon-lock' : 'codicon-cloud';
        const statusClass = config.connected ? 'status-connected' : '';

        item.innerHTML = `
      <div class="connection-icon ${statusClass}">
        <i class="codicon ${protocolIconClass}"></i>
      </div>
      <div class="connection-info">
        <div class="connection-name">${escapeHtml(config.name || config.host)}</div>
        <div class="connection-details">${(config.protocol || 'SFTP').toUpperCase()} · ${config.username}@${config.host}</div>
      </div>
      <div class="connection-actions">
        ${config.connected
                ? '<button class="btn-icon btn-disconnect" data-action="disconnect" title="Disconnect"><span class="codicon codicon-debug-disconnect"></span></button>'
                : '<button class="btn-icon btn-connect" data-action="connect" title="Connect"><span class="codicon codicon-plug"></span></button>'
            }
        <div class="dropdown">
          <button class="btn-icon dropdown-toggle" title="More actions"><span class="codicon codicon-ellipsis"></span></button>
          <div class="dropdown-menu">
            <button class="dropdown-item" data-action="edit"><span class="codicon codicon-edit"></span> Edit</button>
            <button class="dropdown-item" data-action="delete"><span class="codicon codicon-trash"></span> Delete</button>
          </div>
        </div>
      </div>
    `;

        const dropdownMenu = item.querySelector('.dropdown-menu');
        item.querySelector('.dropdown-toggle').addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.dropdown-menu.show').forEach(menu => {
                if (menu !== dropdownMenu) menu.classList.remove('show');
            });
            dropdownMenu.classList.toggle('show');
        });

        item.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                dropdownMenu.classList.remove('show');
                if (action === 'connect') vscode.postMessage({ type: 'connect', index });
                else if (action === 'disconnect') vscode.postMessage({ type: 'disconnect', index });
                else if (action === 'edit') {
                    editingIndex = index;
                    formTitle.textContent = 'Edit Connection';
                    loadConfigToForm(config);
                    connectionForm.classList.remove('hidden');
                    connectionList.classList.add('hidden');
                    vscode.postMessage({ type: 'showForm' });
                } else if (action === 'delete') vscode.postMessage({ type: 'deleteConfig', index });
            });
        });

        item.addEventListener('dblclick', () => {
            if (config.connected) vscode.postMessage({ type: 'disconnect', index });
            else vscode.postMessage({ type: 'connect', index });
        });

        connectionList.appendChild(item);
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Message handler
window.addEventListener('message', event => {
    const msg = event.data;
    console.log('StackerFTP: Webview received message', msg.type);

    switch (msg.type) {
        case 'configs':
            configs = msg.configs || [];
            renderConnections();

            // Persist state for instant load next time
            vscode.setState({ configs });

            loadingOverlay.classList.add('hidden');
            if (!showForm) {
                connectionList.classList.remove('hidden');
            }

            if (msg.editing) {
                editingIndex = msg.editing.index;
                formTitle.textContent = 'Edit Connection';
                loadConfigToForm(msg.editing.config);
                connectionForm.classList.remove('hidden');
                connectionList.classList.add('hidden');
            }
            break;

        case 'noWorkspace':
            loadingOverlay.classList.add('hidden');
            connectionList.innerHTML = '<div class="empty-state"><p>Open a folder to manage connections</p></div>';
            connectionList.classList.remove('hidden');
            break;

        case 'triggerNewForm':
            showNewForm();
            break;

        case 'saveSuccess':
            connectionForm.classList.add('hidden');
            connectionList.classList.remove('hidden');
            editingIndex = null;
            clearFormMessage();
            vscode.postMessage({ type: 'hideForm' });
            break;

        case 'saveError':
            showFormMessage(msg.message || 'Failed to save configuration.');
            break;

        case 'testing':
            document.getElementById('btnTest').textContent = 'Testing...';
            document.getElementById('btnTest').disabled = true;
            break;

        case 'testSuccess':
        case 'testError':
            document.getElementById('btnTest').textContent = 'Test';
            document.getElementById('btnTest').disabled = false;
            break;

        case 'privateKeySelected':
            inputPrivateKey.value = msg.path;
            break;

        case 'contextSelected':
            inputContext.value = msg.path;
            break;
    }
});

// Initial load - show loading only if no cache
if (!configs.length) {
    console.log('StackerFTP: Initial load, showing loading overlay');
    loadingOverlay.classList.remove('hidden');
}

// Signal readiness to backend
console.log('StackerFTP: Webview signaling ready');
vscode.postMessage({ type: 'ready' });
vscode.postMessage({ type: 'loadConfigs' });
