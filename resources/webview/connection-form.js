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
const inputSecure = document.getElementById('inputSecure');

// State
let configs = [];
let editingIndex = null;
let selectedProtocol = 'sftp';
let showForm = false;

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
    sftpAuthSection.classList.toggle('hidden', selectedProtocol !== 'sftp');
    ftpsOptions.classList.toggle('hidden', selectedProtocol !== 'ftps');
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
    inputSecure.checked = false;
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
    inputSecure.checked = config.secure || false;

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
        secure: inputSecure.checked
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
        const protocolIconClass = config.protocol === 'sftp' ? 'codicon-lock' : 'codicon-folder';
        const statusClass = config.connected ? 'status-connected' : '';

        item.innerHTML = `
      <div class="connection-icon ${statusClass}">
        <span class="codicon ${protocolIconClass}"></span>
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
