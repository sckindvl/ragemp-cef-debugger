const state = {
    config: null,
    targets: [],
    openSessions: new Map(),
    activeSessionTitle: null,
    pollingInterval: null,
    isConfigured: false
};

class SessionData {
    constructor(title, id, webSocketDebuggerUrl) {
        this.title = title;
        this.id = id;
        this.webSocketDebuggerUrl = webSocketDebuggerUrl;
        this.status = 'connected';
        this.reconnectStartTime = null;
        this.reconnectTimeout = 60000;
        this.lastSeenTime = Date.now();
    }
}

async function init() {
    await loadConfig();

    if (state.config && state.config.cefDebuggingPort) {
        state.isConfigured = true;

        document.getElementById('port-number').textContent = state.config.cefDebuggingPort;

        startPolling();
    }
}

async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        state.config = data;
    } catch (err) {
        console.error('Failed to load config:', err);
        showNotification('Failed to load configuration', 'error');
    }
}

function startPolling() {
    fetchTargets();

    state.pollingInterval = setInterval(() => {
        fetchTargets();
    }, 5000);
}

function stopPolling() {
    if (state.pollingInterval) {
        clearInterval(state.pollingInterval);
        state.pollingInterval = null;
    }
}

async function fetchTargets() {
    try {
        const response = await fetch('/api/cef-targets');
        const data = await response.json();

        if (data.success) {
            state.targets = data.targets;
            updateConnectionStatus(true);
            updateTargetList();
            checkOpenSessions();
        } else {
            updateConnectionStatus(false);
            console.error('Failed to fetch targets:', data.error);
        }
    } catch (err) {
        updateConnectionStatus(false);
        console.error('Failed to fetch targets:', err);
    }
}

function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('connection-status');
    const dotEl = statusEl.querySelector('.status-dot');
    const textEl = statusEl.querySelector('span:last-child');

    if (connected) {
        dotEl.className = 'status-dot status-connected';
        textEl.textContent = 'Connected';
    } else {
        dotEl.className = 'status-dot status-disconnected';
        textEl.textContent = 'Disconnected';
    }
}

function updateTargetList() {
    const listEl = document.getElementById('target-list');

    if (!state.targets || state.targets.length === 0) {
        listEl.innerHTML = `
            <div class="text-center text-gray-500 py-8">
                <p>No CEF targets found</p>
                <p class="text-sm mt-2">Make sure RAGE:MP is running with CEF debugging enabled</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = state.targets.map(target => {
        const isOpen = state.openSessions.has(target.title);
        return `
            <div class="flex items-center justify-between p-4 border border-gray-200 rounded-lg mb-2 hover:bg-gray-50 transition">
                <div class="flex-1">
                    <div class="flex items-center gap-2">
                        <h3 class="font-semibold text-gray-900">${escapeHtml(target.title)}</h3>
                        ${isOpen ? '<span class="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded">Open</span>' : ''}
                    </div>
                    <p class="text-sm text-gray-500 mt-1">${escapeHtml(target.url)}</p>
                    <p class="text-xs text-gray-400 mt-1">ID: ${target.id}</p>
                </div>
                <button
                    onclick="openDevTools('${escapeHtml(target.title)}', '${target.id}', '${target.webSocketDebuggerUrl}')"
                    class="px-4 py-2 ${isOpen ? 'bg-gray-300 text-gray-600' : 'bg-blue-600 text-white hover:bg-blue-700'} rounded-lg transition"
                    ${isOpen ? 'disabled' : ''}
                >
                    ${isOpen ? 'Opened' : 'Open DevTools'}
                </button>
            </div>
        `;
    }).join('');
}

function checkOpenSessions() {
    const now = Date.now();

    state.openSessions.forEach((session, title) => {
        const currentTarget = state.targets.find(t => t.title === title);

        if (currentTarget && currentTarget.id === session.id) {
            session.lastSeenTime = now;

            if (session.status === 'reconnecting') {
                session.status = 'connected';
                session.reconnectStartTime = null;
                updateSessionUI(title);
                console.log(`✓ Reconnected to "${title}"`);
            }
        } else if (currentTarget && currentTarget.id !== session.id) {
            console.log(`→ ID changed for "${title}", reconnecting with new ID`);
            session.id = currentTarget.id;
            session.webSocketDebuggerUrl = currentTarget.webSocketDebuggerUrl;
            session.lastSeenTime = now;
            session.status = 'connected';
            session.reconnectStartTime = null;

            updateDevToolsIframe(title, currentTarget.webSocketDebuggerUrl);
            updateSessionUI(title);
        } else {
            if (session.status === 'connected') {
                session.status = 'reconnecting';
                session.reconnectStartTime = now;
                updateSessionUI(title);
                console.log(`⚠ Lost connection to "${title}", attempting to reconnect...`);
            } else if (session.status === 'reconnecting') {
                const reconnectDuration = now - session.reconnectStartTime;

                if (reconnectDuration > session.reconnectTimeout) {
                    console.log(`✕ Reconnect timeout for "${title}", closing session`);
                    closeDevTools(title);
                }
            }
        }
    });
}

function openDevTools(title, id, webSocketDebuggerUrl) {
    if (state.openSessions.has(title)) {
        switchToSession(title);
        return;
    }

    const session = new SessionData(title, id, webSocketDebuggerUrl);
    state.openSessions.set(title, session);

    createDevToolsPanel(title, webSocketDebuggerUrl);
    createTab(title);
    switchToSession(title);

    document.getElementById('tabs-container').classList.remove('hidden');
    document.getElementById('devtools-panels').classList.remove('hidden');

    updateTargetList();

    console.log(`Opened DevTools for "${title}"`);
}

function closeDevTools(title) {
    if (!state.openSessions.has(title)) return;

    state.openSessions.delete(title);

    const panel = document.getElementById(`panel-${title}`);
    if (panel) panel.remove();

    const tab = document.getElementById(`tab-${title}`);
    if (tab) tab.remove();

    if (state.activeSessionTitle === title) {
        const remainingSessions = Array.from(state.openSessions.keys());
        if (remainingSessions.length > 0) {
            switchToSession(remainingSessions[0]);
        } else {
            state.activeSessionTitle = null;
            document.getElementById('tabs-container').classList.add('hidden');
            document.getElementById('devtools-panels').classList.add('hidden');
        }
    }

    updateTargetList();

    console.log(`Closed DevTools for "${title}"`);
}

function createTab(title) {
    const tabsContainer = document.querySelector('#tabs-container > div');

    const tab = document.createElement('div');
    tab.id = `tab-${title}`;
    tab.className = 'tab flex items-center gap-2 px-4 py-2 rounded cursor-pointer';
    tab.innerHTML = `
        <span class="font-medium">${escapeHtml(title)}</span>
        <button onclick="event.stopPropagation(); closeDevTools('${escapeHtml(title)}')" class="ml-2 text-gray-500 hover:text-gray-700">
            ✕
        </button>
    `;

    tab.addEventListener('click', () => switchToSession(title));

    tabsContainer.appendChild(tab);
}

function createDevToolsPanel(title, webSocketDebuggerUrl) {
    const panelsContainer = document.getElementById('devtools-panels');

    const panel = document.createElement('div');
    panel.id = `panel-${title}`;
    panel.className = 'devtools-container hidden';
    panel.innerHTML = `
        <div class="bg-gray-100 px-4 py-2 border-b border-gray-200 flex items-center justify-between">
            <h3 class="font-semibold text-gray-700">${escapeHtml(title)}</h3>
            <button
                onclick="toggleFullscreen('${escapeHtml(title)}')"
                class="fullscreen-btn px-3 py-1 bg-gray-200 hover:bg-gray-300 rounded text-sm text-gray-700 transition"
                title="Toggle Fullscreen"
            >
                ⛶ Fullscreen
            </button>
        </div>
        <iframe
            id="iframe-${title}"
            class="devtools-iframe"
            src="/devtools/inspector.html?ws=${webSocketDebuggerUrl.replace('ws://', '')}"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        ></iframe>
    `;

    panelsContainer.appendChild(panel);
}

function updateDevToolsIframe(title, webSocketDebuggerUrl) {
    const iframe = document.getElementById(`iframe-${title}`);
    if (iframe) {
        iframe.src = `/devtools/inspector.html?ws=${webSocketDebuggerUrl.replace('ws://', '')}`;
    }
}

function switchToSession(title) {
    state.activeSessionTitle = title;

    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    const activeTab = document.getElementById(`tab-${title}`);
    if (activeTab) {
        activeTab.classList.add('active');
    }

    document.querySelectorAll('.devtools-container').forEach(panel => {
        panel.classList.add('hidden');
    });
    const activePanel = document.getElementById(`panel-${title}`);
    if (activePanel) {
        activePanel.classList.remove('hidden');
    }

    updateSessionUI(title);
}

function updateSessionUI(title) {
    const session = state.openSessions.get(title);
    if (!session) return;

    const tab = document.getElementById(`tab-${title}`);
    if (!tab) return;

    tab.classList.remove('reconnecting');

    if (session.status === 'reconnecting') {
        tab.classList.add('reconnecting');
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNotification(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
}

function toggleFullscreen(title) {
    const panel = document.getElementById(`panel-${title}`);
    if (!panel) return;

    const isFullscreen = panel.classList.contains('fullscreen-mode');

    if (isFullscreen) {
        // Exit fullscreen
        panel.classList.remove('fullscreen-mode');
        const button = panel.querySelector('.fullscreen-btn');
        if (button) {
            button.textContent = '⛶ Fullscreen';
        }
    } else {
        // Enter fullscreen
        panel.classList.add('fullscreen-mode');
        const button = panel.querySelector('.fullscreen-btn');
        if (button) {
            button.textContent = '⛶ Exit Fullscreen';
        }
    }
}

window.openDevTools = openDevTools;
window.closeDevTools = closeDevTools;
window.toggleFullscreen = toggleFullscreen;

init();
