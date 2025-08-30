// 移除 titlebar 滑动隐藏逻辑
let AppState = { data: { groups: [], tags: [], shares: [] }, ui: { selectedGroupId: null, selectedEntryId: null, entrySearchTerm: '', activeTab: 'notes', selectedTags: new Set(), isSidebarVisible: true, isEditorFocused: false, lastLocalEditAt: 0, hasRemoteUpdateConflict: false, isApplyingRemoteUpdate: false, isTitleFocused: false, lastTitleEditAt: 0, lastSavedAt: 0, collapsedVolumes: new Set(), editingVolumeId: null, editingVolumeTitle: '' } };
let easyMDE = null; let debounceTimer = null; let sortableInstance = null;
let touchStartX = null, touchStartY = null;

function setViewportHeightVar() {
    const vv = window.visualViewport;
    const height = vv && vv.height ? vv.height : window.innerHeight;
    const vh = height * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
}
function refreshEditorSize() { if (easyMDE?.codemirror) easyMDE.codemirror.refresh(); }
function countChars(text) { return (text || '').replace(/\s/g, '').length; }

// Utility helpers (single source): escape HTML/attributes/JS
function escHtml(str = '') {
    return String(str).replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[ch]);
}
function escAttr(str = '') { return escHtml(str); }
function escJs(str = '') {
    return String(str).replace(/[\\'"\n\r\u2028\u2029]/g, ch => ({
        "\\": "\\\\",
        "'": "\\'",
        '"': '\\"',
        "\n": "\\n",
        "\r": "\\r",
        "\u2028": "\\u2028",
        "\u2029": "\\u2029",
    }[ch] || ch));
}

// 简易 Markdown 转纯文本与摘要
function markdownToText(md = '') {
    const s = String(md)
        .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
        .replace(/`[^`]*`/g, ' ') // inline code
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
        .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1') // links -> text
        .replace(/^\s{0,3}(#{1,6})\s+/gm, '') // headings
        .replace(/^\s{0,3}[-*+]\s+/gm, '') // bullets
        .replace(/^\s{0,3}\d+\.\s+/gm, '') // ordered
        .replace(/[*_~>#]/g, ' ') // md syntax
        .replace(/\r?\n+/g, ' ') // newlines
        .replace(/\s{2,}/g, ' ')
        .trim();
    return s;
}
function getEntrySnippet(md = '', maxLen = 140) {
    const text = markdownToText(md);
    if (!text) return '';
    return text.length > maxLen ? text.slice(0, maxLen).trim() + '…' : text;
}

// 顶栏测量
let topbarHeight = 0;
function measureTopbarHeight() {
    const el = document.getElementById('main-topbar'); if (!el) return;
    const prev = { hidden: document.body.classList.contains('topbar-hidden'), height: el.style.height, transition: el.style.transition };
    if (prev.hidden) document.body.classList.remove('topbar-hidden');
    el.style.transition = 'none'; el.style.height = 'auto';
    const h = Math.ceil(el.getBoundingClientRect().height) || 56;
    el.style.height = prev.height; el.style.transition = prev.transition;
    if (prev.hidden) document.body.classList.add('topbar-hidden');
    if (h !== topbarHeight) { topbarHeight = h; document.documentElement.style.setProperty('--topbar-h', `${h}px`); }
}

// 顶栏滑动隐藏功能已移除（保留空函数以兼容旧调用）
function setHeaderHidden() { }
function attachEditorScrollListener() { }
function detachEditorScrollListener() { }

// ============================
// 应用逻辑（原内联脚本）
// ============================
const DOM = { sidebar: document.getElementById('sidebar'), notesSidebarContent: document.getElementById('notes-sidebar-content'), filesSidebarContent: document.getElementById('files-sidebar-content'), welcomeScreen: document.getElementById('welcome-screen'), entryListView: document.getElementById('entry-list-view'), editorView: document.getElementById('editor-view'), tabBtnNotes: document.getElementById('tab-btn-notes'), tabBtnFiles: document.getElementById('tab-btn-files'), newGroupModal: document.getElementById('new-group-modal'), sidebarBackdrop: document.getElementById('sidebar-backdrop'), newVolumeModal: document.getElementById('new-volume-modal'), confirmModal: document.getElementById('confirm-modal') };
let ws;
let queuedOps = [];
let online = true;
let myClientId = null;
let amHost = false;
let onlineClientIds = new Set();

function tryLoadOffline() {
    if (!window.__isElectron || !window.lanOffline) return false;
    const cached = window.lanOffline.getData(window.__serverHost, window.__serverPort);
    if (cached) {
        AppState.data = cached;
        queuedOps = window.lanOffline.getQueue(window.__serverHost, window.__serverPort) || [];
        render();
        return true;
    }
    return false;
}

function persistOffline() {
    if (!window.__isElectron || !window.lanOffline) return;
    try { window.lanOffline.saveData(window.__serverHost, window.__serverPort, AppState.data); } catch { }
}

function queueOp(type, payload) {
    if (!window.__isElectron || !window.lanOffline) return;
    window.lanOffline.pushOp(window.__serverHost, window.__serverPort, { type, payload, ts: Date.now() });
}

async function flushQueue() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!window.__isElectron || !window.lanOffline) return;
    const q = window.lanOffline.getQueue(window.__serverHost, window.__serverPort) || [];
    if (!q.length) return;
    // Send in order
    for (const op of q) {
        try { ws.send(JSON.stringify({ type: op.type, payload: op.payload })); }
        catch (e) { console.warn('Failed to send queued op', e); break; }
    }
    // Clear after attempt; server's full_sync will overwrite
    window.lanOffline.clearQueue(window.__serverHost, window.__serverPort);
}

function connect() {
    try { ws?.close?.(); } catch { }
    const host = (window.__overrideServerHost || window.__serverHost);
    const port = (window.__overrideServerPort || window.__serverPort);
    const proto = (port === 443 || window.location.protocol === 'https:') ? 'wss' : 'ws';
    const url = `${proto}://${host}:${port}`;
    ws = new WebSocket(url);
    ws.onopen = () => { console.log('Connected'); online = true; flushQueue(); };
    ws.onclose = () => { online = false; if (!tryLoadOffline()) setTimeout(connect, 3000); else setTimeout(connect, 5000); };
    ws.onerror = (e) => { console.error(e); };
    ws.onmessage = (ev) => { handleWebSocketMessage(ev); if (window.__isElectron) persistOffline(); };
}
function handleWebSocketMessage(event) {
    const message = JSON.parse(event.data);
    if (message.type === 'you') {
        myClientId = message?.payload?.clientId || null;
        amHost = !!message?.payload?.isHost;
        onlineClientIds = new Set(message?.payload?.onlineClientIds || []);
        if (AppState.ui.activeTab === 'files') { renderFileSidebar(); tryAutoRunPendingDownloads(); }
        return;
    }
    if (message.type === 'clients_changed') {
        onlineClientIds = new Set(message?.payload?.onlineClientIds || []);
        if (AppState.ui.activeTab === 'files') { renderFileSidebar(); tryAutoRunPendingDownloads(); }
        return;
    }
    if (message.type === 'full_sync') {
        const { selectedGroupId, selectedEntryId } = AppState.ui;
        const oldData = AppState.data;
        AppState.data = message.payload;

        // 如果当前所在组被其他端删除：返回组选择视图并提示
        if (selectedGroupId && !(AppState.data.groups || []).some(g => g.id === selectedGroupId)) {
            AppState.ui.selectedGroupId = null;
            AppState.ui.selectedEntryId = null;
            render();
            // 顶部提示条
            try {
                const actionsEl = document.getElementById('topbar-actions');
                if (actionsEl) {
                    const tip = document.createElement('div');
                    tip.className = 'ml-2 px-2 py-0.5 rounded text-xs bg-slate-600 text-slate-100';
                    tip.textContent = '该组已在另一端删除';
                    actionsEl.appendChild(tip);
                    setTimeout(() => tip.remove(), 3000);
                }
            } catch { }
            return;
        }

        // 如果当前正在编辑的条目被远端删除（或所属组被删除），则所有端返回到条目列表
        if (easyMDE && selectedGroupId && selectedEntryId) {
            const newEntry = AppState.data.groups.find(g => g.id === selectedGroupId)?.entries.find(e => e.id === selectedEntryId);
            if (!newEntry) {
                try { easyMDE.toTextArea(); } catch { }
                easyMDE = null;
                AppState.ui.selectedEntryId = null;
                AppState.ui.isEditorFocused = false;
                AppState.ui.isTitleFocused = false;
                AppState.ui.hasRemoteUpdateConflict = false;
                render();
                return;
            }

            // 条目仍存在，按原逻辑处理内容与标题同步
            const cm = easyMDE.codemirror;
            const prevVal = easyMDE.value();
            // 自动应用远端更新：若最近未输入则直接应用，同时保留光标与滚动
            if (newEntry.content !== prevVal) {
                const recentlyEdited = Date.now() - (AppState.ui.lastLocalEditAt || 0) < 900;
                if (!recentlyEdited) {
                    const sel = cm.listSelections();
                    const scrollInfo = cm.getScrollInfo();
                    AppState.ui.isApplyingRemoteUpdate = true;
                    easyMDE.value(newEntry.content);
                    cm.setSelections(sel);
                    cm.scrollTo(scrollInfo.left, scrollInfo.top);
                    AppState.ui.isApplyingRemoteUpdate = false;
                }
            }

            // 标题：若最近未编辑则直接覆盖输入框值
            const titleInput = document.getElementById('entry-title-input');
            if (titleInput && newEntry.title !== titleInput.value) {
                const titleRecentlyEdited = Date.now() - (AppState.ui.lastTitleEditAt || 0) < 800;
                if (!titleRecentlyEdited && !AppState.ui.isTitleFocused) {
                    const start = titleInput.selectionStart;
                    const end = titleInput.selectionEnd;
                    titleInput.value = newEntry.title || '';
                    try { titleInput.setSelectionRange(start, end); } catch { }
                }
            }

            AppState.ui.hasRemoteUpdateConflict = false;
            render(true);
            requestAnimationFrame(refreshEditorSize);
        } else {
            render();
        }
        if (AppState.ui.activeTab === 'files') tryAutoRunPendingDownloads();
    } else if (message.type === 'files_updated' && AppState.ui.activeTab === 'files') { renderFileSidebar(); }
}
function sendMessage(type, payload) {
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, payload }));
    } else {
        // Offline: queue and apply optimistic change
        queueOp(type, payload);
    }
}

function render(skipEditorRecreation = false) { renderLayout(); renderTopBar(); renderSidebar(); renderMainContent(skipEditorRecreation); }
function renderLayout() {
    const { isSidebarVisible } = AppState.ui; const mainContent = document.getElementById('main-content');
    const isDesktop = window.innerWidth >= 1024;
    // Sidebar slide in/out for all sizes
    DOM.sidebar.classList.toggle('-translate-x-full', !isSidebarVisible);
    DOM.sidebar.classList.toggle('translate-x-0', isSidebarVisible);
    // Reserve left space only on desktop
    mainContent.style.marginLeft = isDesktop && isSidebarVisible ? '24rem' : '0px';
    // Backdrop for mobile
    if (!isDesktop) {
        DOM.sidebarBackdrop.classList.toggle('opacity-100', isSidebarVisible);
        DOM.sidebarBackdrop.classList.toggle('pointer-events-auto', isSidebarVisible);
        DOM.sidebarBackdrop.classList.toggle('opacity-0', !isSidebarVisible);
        DOM.sidebarBackdrop.classList.toggle('pointer-events-none', !isSidebarVisible);
    } else {
        DOM.sidebarBackdrop.classList.add('opacity-0', 'pointer-events-none');
        DOM.sidebarBackdrop.classList.remove('opacity-100', 'pointer-events-auto');
    }
    requestAnimationFrame(refreshEditorSize);
}
function renderTopBar() {
    const groupEl = document.getElementById('topbar-group');
    const entryEl = document.getElementById('topbar-entry');
    const sepEl = document.getElementById('topbar-sep');
    const actionsEl = document.getElementById('topbar-actions');
    const { activeTab, selectedGroupId, selectedEntryId } = AppState.ui;

    actionsEl.innerHTML = '';

    if (activeTab === 'files') {
        groupEl.textContent = '文件';
        entryEl.innerHTML = '';
        sepEl.style.display = 'none';
        // 渲染结束后测量高度
        requestAnimationFrame(measureTopbarHeight);
        return;
    }
    // Show online/offline badge in actions
    const badge = document.createElement('span');
    badge.className = `px-2 py-0.5 rounded text-xs ${online ? 'bg-green-600 text-white' : 'bg-slate-600 text-slate-200'}`;
    badge.textContent = online ? '在线' : '离线';
    actionsEl.appendChild(badge);
    let groupTitle = '欢迎';
    let entryTitle = '';
    let group = null;
    let entry = null;
    if (selectedGroupId) {
        group = AppState.data.groups.find(g => g.id === selectedGroupId);
        if (group) {
            groupTitle = group.title || '未命名组';
            if (selectedEntryId) {
                entry = (group.entries || []).find(e => e.id === selectedEntryId);
                if (entry) entryTitle = entry.title || '未命名条目';
            }
        }
    }
    groupEl.textContent = groupTitle;

    if (entryTitle) {
        sepEl.style.display = '';
        const existingInput = document.getElementById('entry-title-input');
        if (existingInput) {
            const recentlyEdited = Date.now() - (AppState.ui.lastTitleEditAt || 0) < 1000;
            if (!AppState.ui.isTitleFocused && !recentlyEdited && existingInput.value !== entryTitle) {
                const start = existingInput.selectionStart;
                const end = existingInput.selectionEnd;
                existingInput.value = entryTitle;
                try { existingInput.setSelectionRange(start, end); } catch { }
            }
        } else {
            entryEl.innerHTML = `<input id="entry-title-input" value="${escAttr(entryTitle)}" class="bg-transparent border border-slate-600/60 focus:border-indigo-500 rounded px-2 py-1 text-sm w-[60vw] sm:w-[40vw] max-w-md outline-none" oninput="handleTitleChange()" onfocus="onTitleFocus()" onblur="onTitleBlur()">`;
        }
        // 右侧动作：仅保留返回列表与删除（去掉“新建”按钮）`
        actionsEl.innerHTML = `
            <button id="topbar-back-btn" type="button" onclick="goBackToList()" aria-label="返回列表" class="tb-btn hover:bg-slate-700 text-slate-200 border border-slate-700">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                <span class="hidden sm:inline label">返回</span>
            </button>
            <button onclick="deleteEntry()" aria-label="删除" class="tb-btn bg-red-600/80 hover:bg-red-600 text-white">
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd"></path></svg>
                <span class="hidden sm:inline label">删除</span>
            </button>`;
        // 保障按钮事件可靠绑定
        const backBtn = document.getElementById('topbar-back-btn');
        if (backBtn && !backBtn._bound) {
            backBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                goBackToList();
            }, { passive: false });
            backBtn._bound = true;
        }
    } else {
        entryEl.innerHTML = '';
        sepEl.style.display = 'none';
        // 在组列表视图（选中组但未选中条目）保留导出与卷操作
        if (group) {
            const baseUrl = `http://${(window.__overrideServerHost || window.__serverHost)}:${(window.__overrideServerPort || window.__serverPort)}`;
            actionsEl.innerHTML = `
                <div class="flex items-center gap-2">
                <a href="${baseUrl}/export?groupId=${encodeURIComponent(group.id)}" class="p-2 rounded-md bg-green-600 hover:bg-green-700 text-white font-semibold flex items-center gap-2">
                        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"></path></svg>
                        <span class="hidden sm:inline">导出</span>
                    </a>
                    <button onclick="showNewVolumeModal('${group.id}')" class="tb-btn border border-slate-700">+ 卷</button>
                </div>`;
        }
    }
    // 渲染结束后测量高度（下一帧确保 DOM 完成）
    requestAnimationFrame(measureTopbarHeight);
}
function renderSidebar() {
    const { activeTab } = AppState.ui;
    DOM.tabBtnNotes.className = `flex-1 py-2 text-center font-semibold transition-colors ${activeTab === 'notes' ? 'border-b-2 border-indigo-400 text-white' : 'text-slate-400 hover:text-white'}`;
    DOM.tabBtnFiles.className = `flex-1 py-2 text-center font-semibold transition-colors ${activeTab === 'files' ? 'border-b-2 border-indigo-400 text-white' : 'text-slate-400 hover:text-white'}`;
    DOM.notesSidebarContent.style.display = activeTab === 'notes' ? 'flex' : 'none'; DOM.filesSidebarContent.style.display = activeTab === 'files' ? 'flex' : 'none';
    if (activeTab === 'notes') renderNoteSidebar(); else renderFileSidebar();
}
function renderNoteSidebar() { DOM.notesSidebarContent.innerHTML = `<button onclick="showNewGroupModal()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-md mb-6 transition-all flex items-center justify-center gap-2"><svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"></path></svg>新建文字组</button><div id="tag-filter-container-inner" class="mb-4"></div><div id="group-list-inner" class="flex-grow space-y-2"></div>`; renderTagFilters(); renderGroupList(); }
function renderFileSidebar() {
    const canUpload = online && !!myClientId;
    DOM.filesSidebarContent.innerHTML = `
        <div class="mb-4">
            <input id="share-upload-file" type="file" ${canUpload ? '' : 'disabled'}
                class="block w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-100 file:text-indigo-700 hover:file:bg-indigo-200 mb-2 cursor-pointer disabled:opacity-50"/>
            <button type="button" onclick="uploadShare()" ${canUpload ? '' : 'disabled'}
                class="w-full bg-green-600 hover:bg-green-700 disabled:bg-slate-600 disabled:hover:bg-slate-600 text-white font-bold py-2 px-4 rounded-md transition-all">提交提供传输的文件</button>
            <p class="text-xs text-slate-400 mt-1">${online ? (myClientId ? (amHost ? '主机端：可移除任何分享' : '客户端：可移除自己分享，其他端在线时可下载') : '等待识别客户端…') : '离线：无法上传，可移除（排队）和标记下载待连接'}</p>
        </div>
        <div class="flex-grow">
            <h3 class="text-lg font-semibold mb-2 border-b border-slate-700 pb-1">当前分享</h3>
            <ul id="share-list-inner" class="space-y-2 mt-2"></ul>
        </div>`;
    renderShareList();
}

function renderShareList() {
    const el = document.getElementById('share-list-inner');
    if (!el) return;
    const shares = (AppState?.data?.shares || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!shares.length) { el.innerHTML = '<li class="text-sm text-slate-500">暂无分享</li>'; return; }
    const isOnline = online;
    const host = (window.__overrideServerHost || window.__serverHost);
    const port = (window.__overrideServerPort || window.__serverPort);
    const baseUrl = `http://${host}:${port}`;
    const pending = getPendingDownloads();
    el.innerHTML = shares.map(s => {
        const ownerOnline = onlineClientIds.has(s.ownerId);
        const mine = myClientId && s.ownerId === myClientId;
        const canRemove = amHost || mine;
        const canDownload = ownerOnline || amHost;
        const pendingThis = pending.has(s.id) && !canDownload;
        const sizeStr = formatBytes(s.size || 0);
        const timeStr = new Date(s.createdAt).toLocaleString();
        const downloadHref = `${baseUrl}/shares/${encodeURIComponent(s.id)}/download`;
        return `
            <li class="bg-slate-700/50 p-2 rounded-md hover:bg-slate-700 flex items-center gap-2">
                <div class="flex-grow min-w-0">
                    <div class="text-sm truncate">${escHtml(s.name || '未知文件')} <span class="text-xs text-slate-400">· ${sizeStr}</span></div>
                    <div class="text-xs text-slate-400">${timeStr} · 拥有者${mine ? '（你）' : ''} · ${ownerOnline ? '<span class="text-green-400">在线</span>' : '<span class="text-slate-400">离线</span>'}</div>
                    ${pendingThis ? '<div class="text-xs text-indigo-300">已加入下载队列，等待对方上线…</div>' : ''}
                </div>
                ${canDownload ? `<a href="${downloadHref}" class="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-sm">下载</a>` : `<button onclick="queuePendingDownload('${s.id}')" class="px-2 py-1 rounded bg-slate-600 text-slate-200 text-sm">排队下载</button>`}
                ${canRemove ? `<button onclick="removeShare('${s.id}')" class="px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white text-sm">移除分享</button>` : ''}
            </li>`;
    }).join('');
}

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v.toFixed(v >= 100 || i === 0 ? 0 : 1)) + ' ' + units[i];
}

function uploadShare() {
    const input = document.getElementById('share-upload-file');
    if (!input || !input.files || !input.files[0]) return;
    if (!online || !myClientId) { alert('当前离线，无法上传。可在离线时移除分享或排队下载。'); return; }
    const file = input.files[0];
    const host = (window.__overrideServerHost || window.__serverHost);
    const port = (window.__overrideServerPort || window.__serverPort);
    const baseUrl = `http://${host}:${port}`;
    const fd = new FormData();
    fd.append('file', file);
    fetch(`${baseUrl}/shares/upload?clientId=${encodeURIComponent(myClientId)}`, { method: 'POST', body: fd })
        .then(r => r.json())
        .then(() => { input.value = ''; /* full_sync will refresh */ })
        .catch(() => { alert('上传失败'); });
}

function removeShare(shareId) {
    // 优先通过 WebSocket（可离线排队）
    sendMessage('remove_share', { shareId });
    // 乐观更新
    AppState.data.shares = (AppState.data.shares || []).filter(s => s.id !== shareId);
    renderShareList();
}

function getPendingDownloads() {
    try {
        const raw = localStorage.getItem('lan.pendingDownloads') || '[]';
        return new Set(JSON.parse(raw));
    } catch { return new Set(); }
}
function setPendingDownloads(set) {
    try { localStorage.setItem('lan.pendingDownloads', JSON.stringify(Array.from(set))); } catch { }
}
function queuePendingDownload(shareId) {
    const set = getPendingDownloads();
    set.add(shareId);
    setPendingDownloads(set);
    renderShareList();
}
function tryAutoRunPendingDownloads() {
    const set = getPendingDownloads();
    if (!set.size) return;
    const host = (window.__overrideServerHost || window.__serverHost);
    const port = (window.__overrideServerPort || window.__serverPort);
    const baseUrl = `http://${host}:${port}`;
    let changed = false;
    (AppState?.data?.shares || []).forEach(s => {
        if (set.has(s.id) && (onlineClientIds.has(s.ownerId) || amHost)) {
            // trigger download
            const a = document.createElement('a');
            a.href = `${baseUrl}/shares/${encodeURIComponent(s.id)}/download`;
            a.download = s.name || '';
            document.body.appendChild(a);
            a.click();
            a.remove();
            set.delete(s.id);
            changed = true;
        }
    });
    if (changed) setPendingDownloads(set);
}
function renderTagFilters() {
    const el = document.getElementById('tag-filter-container-inner');
    el.innerHTML = AppState.data.tags.length > 0 ? `
        <h3 class="text-sm font-semibold text-slate-400 mb-2">标签过滤</h3>
        <div class="flex flex-wrap gap-2">
            ${AppState.data.tags.map(tag => `
                <button onclick=\"toggleTagFilter('${escJs(tag)}')\" class=\"px-2.5 py-1 text-xs rounded-full transition-all ${AppState.ui.selectedTags.has(tag) ? 'bg-indigo-500 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}\">${escHtml(tag)}</button>
            `).join('')}
        </div>` : '';
}
function renderGroupList() {
    const el = document.getElementById('group-list-inner');
    const filteredGroups = AppState.data.groups
        .filter(g => AppState.ui.selectedTags.size === 0 || (g.tags || []).some(tag => AppState.ui.selectedTags.has(tag)))
        .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

    el.innerHTML = filteredGroups.map(group => {
        const entries = group.entries || [];
        const totalChars = entries.reduce((sum, e) => sum + countChars(e.content || ''), 0);
        return `
            <div onclick="selectGroup('${group.id}')" class="p-3 rounded-lg cursor-pointer transition-colors group relative ${group.id === AppState.ui.selectedGroupId ? 'bg-indigo-500/20' : 'hover:bg-slate-700/50'}">
                <div class="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onclick="event.stopPropagation(); showEditGroupModal('${group.id}')" class="p-1 rounded-md bg-slate-600 hover:bg-slate-500 text-white">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.5L17.5 2.5z"></path></svg>
                    </button>
                    <button onclick="event.stopPropagation(); deleteGroup('${group.id}')" class="p-1 rounded-md bg-red-600 hover:bg-red-500 text-white">
                        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd"></path></svg>
                    </button>
                </div>
                <h3 class="font-semibold truncate pr-16">${escHtml(group.title)}</h3>
                <div class="text-xs text-slate-400 mt-1">${entries.length} 条目 · 总字数: ${totalChars}</div>
            </div>`;
    }).join('') || `<p class="text-sm text-slate-500 text-center p-4">没有文字组。</p>`;
}
function renderMainContent(skipEditorRecreation = false) {
    const { selectedGroupId, selectedEntryId } = AppState.ui;
    DOM.welcomeScreen.style.display = 'none'; DOM.entryListView.style.display = 'none'; DOM.editorView.style.display = 'none';
    if (selectedGroupId && selectedEntryId) {
        DOM.editorView.style.display = 'flex';
        if (!skipEditorRecreation) {
            renderEditor();
        }
        requestAnimationFrame(() => { refreshEditorSize(); });
    } else if (selectedGroupId) {
        DOM.entryListView.style.display = 'flex';
        renderEntryList();
    } else {
        DOM.welcomeScreen.style.display = 'flex';
        renderWelcomeScreen();
    }
}
function renderWelcomeScreen() { DOM.welcomeScreen.innerHTML = `<div class="text-slate-500"><h2 class="text-3xl font-semibold">欢迎</h2><p class="mt-2">从侧边栏选择或新建一个项目开始。</p></div>`; }
function renderEntryList() {
    const group = AppState.data.groups.find(g => g.id === AppState.ui.selectedGroupId);
    if (!group) { renderWelcomeScreen(); return; }
    // Capture current scroll position of the entry list scroller (was using a removed node id)
    const scrollerBefore = document.getElementById('entry-scroller');
    const prevScrollTop = scrollerBefore ? scrollerBefore.scrollTop : 0;

    const searchTerm = AppState.ui.entrySearchTerm.toLowerCase();

    // 确保卷结构存在
    const volumes = Array.isArray(group.volumes) ? group.volumes : [];
    const entryMap = new Map((group.entries || []).map(e => [e.id, e]));

    // 过滤：仅按标题过滤条目展示，但不改变卷结构
    const volumeCards = volumes.map(vol => {
        const isCollapsed = AppState.ui.collapsedVolumes.has(vol.id);
        const entryIds = (vol.entryIds || []).filter(id => {
            const e = entryMap.get(id);
            return e && e.title.toLowerCase().includes(searchTerm);
        });
        const entriesHTML = entryIds.map(id => {
            const entry = entryMap.get(id);
            return `
                <div data-id="${entry.id}" class="bg-slate-800/50 p-3 rounded-lg flex items-center gap-3 group">
                    <div class="handle cursor-grab text-slate-500 hover:text-white"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg></div>
                    <div class="flex-grow cursor-pointer" onclick="selectEntry('${group.id}', '${entry.id}')">
                        <h3 class="font-semibold text-lg truncate group-hover:text-indigo-400 transition-colors">${escHtml(entry.title)}</h3>
                        <p class="preview-snippet">${escHtml(getEntrySnippet(entry.content || ''))}</p>
                        <p class="text-sm text-slate-400 mt-1">最后更新: ${new Date(entry.updatedAt).toLocaleString()} · 字数: ${(entry.content || '').replace(/\s/g, '').length}</p>
                    </div>
                    <div class="flex items-center gap-1">
                        <button onclick="cloneEntry('${group.id}','${entry.id}','${vol.id}')" title="克隆条目" class="p-2 rounded-md hover:bg-slate-700 text-slate-400 hover:text-white transition-colors">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                        </button>
                        <button onclick="insertEntry('${group.id}', '${entry.id}', 'before')" title="在上方插入" class="p-2 rounded-md hover:bg-slate-700 text-slate-400 hover:text-white transition-colors">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v14m0-14l-4 4m4-4l4 4"></path></svg>
                        </button>
                        <button onclick="insertEntry('${group.id}', '${entry.id}', 'after')" title="在下方插入" class="p-2 rounded-md hover:bg-slate-700 text-slate-400 hover:text-white transition-colors">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19V5m0 14l4-4m-4 4l-4-4"></path></svg>
                        </button>
                        <button onclick="deleteEntryFromList('${group.id}', '${entry.id}')" title="删除" class="p-2 rounded-md bg-red-600/80 hover:bg-red-600 text-white transition-colors">
                            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd"></path></svg>
                        </button>
                    </div>
                </div>`;
        }).join('');

        return `
            <section class="rounded-lg border border-slate-700 overflow-hidden">
                <header class="flex items-center justify-between px-3 py-2 bg-slate-800/70">
                    <div class="flex items-center gap-2">
                        <button class="tb-btn border border-slate-700" onclick="toggleVolumeCollapse('${vol.id}')" title="展开/收起">
                            <svg class="w-4 h-4 ${isCollapsed ? '' : 'rotate-90'} transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                        </button>
                        ${AppState.ui.editingVolumeId === vol.id
                ? `<div class="flex items-center gap-2">
                                 <input id="vol-edit-input-${vol.id}" class="bg-transparent border border-indigo-500 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" value="${escAttr(AppState.ui.editingVolumeTitle || vol.title)}" oninput="onVolumeTitleInput(this.value)" onkeydown="onVolumeEditKey(event,'${group.id}','${vol.id}')" />
                                 <button class="tb-btn border border-slate-700" onclick="saveEditVolume('${group.id}','${vol.id}')">保存</button>
                                 <button class="tb-btn border border-slate-700" onclick="cancelEditVolume()">取消</button>
                               </div>`
                : `<span class="font-semibold text-slate-200 truncate">${escHtml(vol.title)}</span>`
            }
                    </div>
                    <div class="flex items-center gap-2">
                        ${AppState.ui.editingVolumeId === vol.id ? '' : `<button class="tb-btn border border-slate-700" title="重命名" onclick="startEditVolume('${group.id}','${vol.id}','${escJs(vol.title)}')">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.5L17.5 2.5z"></path></svg>
                        </button>`}
                        <!-- 卷内添加条目移除，改由条目“插入”按钮或空态点击添加 -->
                        <button onclick="deleteVolume('${group.id}','${vol.id}')" class="tb-btn bg-red-600/80 hover:bg-red-600 text-white">删卷</button>
                    </div>
                </header>
                <div class="p-3 ${isCollapsed ? 'hidden' : ''}">
                    <div id="vol-${vol.id}" class="space-y-3" data-volume-id="${vol.id}">${entriesHTML || `<div class=\"text-slate-500 text-center py-6 cursor-pointer hover:text-slate-300\" onclick=\"createNewEntry('${group.id}','${vol.id}')\">暂无条目，点击新建</div>`}</div>
                </div>
            </section>`;
    }).join('');

    // 渲染卷卡片容器与顶部搜索，并为滚动容器添加稳定的 id
    DOM.entryListView.innerHTML = `
        <input oninput="handleSearch(this.value)" value="${escAttr(AppState.ui.entrySearchTerm)}" type="text" placeholder="搜索条目标题..." class="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500">
        <div id="entry-scroller" class="flex flex-col gap-4 overflow-y-auto flex-1">
            <div id="volume-list-container" class="flex flex-col gap-4" data-group-id="${group.id}">${volumeCards || '<p class="text-slate-500 text-center py-8">暂无卷，点击上方“+ 卷”创建。</p>'}</div>
        </div>`;

    // 初始化卷排序与卷内/跨卷条目排序
    initVolumeAndEntrySortables(group.id);

    // 恢复滚动（在下一帧，确保 DOM 完成）
    requestAnimationFrame(() => {
        const scrollerAfter = document.getElementById('entry-scroller');
        if (scrollerAfter) scrollerAfter.scrollTop = prevScrollTop;
    });
}
function renderEditor() {
    const entry = AppState.data.groups.find(g => g.id === AppState.ui.selectedGroupId)?.entries.find(e => e.id === AppState.ui.selectedEntryId);
    if (!entry) { goBackToList(); return; }
    DOM.editorView.innerHTML = `<div class="flex-grow relative overflow-hidden"><textarea id="markdown-editor"></textarea></div>`;
    if (easyMDE) { try { easyMDE.toTextArea(); } catch { } easyMDE = null; }
    easyMDE = new EasyMDE({
        element: document.getElementById('markdown-editor'), initialValue: entry.content, autofocus: true, spellChecker: false,
        // 打开状态栏并自定义条目
        status: [
            {
                className: 'char-count',
                defaultValue: (el) => { el.innerHTML = '字数: 0'; },
                onUpdate: (el) => {
                    const val = easyMDE ? easyMDE.value() : '';
                    el.innerHTML = '字数: ' + countChars(val);
                }
            },
            'lines',
            'cursor',
            {
                className: 'save-info',
                defaultValue: (el) => { el.innerHTML = '未保存'; },
                onUpdate: (el) => {
                    const ts = AppState?.ui?.lastSavedAt || 0;
                    if (!ts) { el.innerHTML = '未保存'; return; }
                    const diff = Date.now() - ts;
                    if (diff < 5000) el.innerHTML = '已保存';
                    else if (diff < 60000) el.innerHTML = Math.round(diff / 1000) + '秒前保存';
                    else if (diff < 3600000) el.innerHTML = Math.round(diff / 60000) + '分钟前保存';
                    else el.innerHTML = new Date(ts).toLocaleTimeString();
                }
            },
            // 去除“检测到远端更新”提示，自动应用
        ],
        // 更新工具栏：移除 side-by-side 与 fullscreen，增加实用按钮和自定义“Tab”键
        toolbar: [
            'bold', 'italic', 'heading', '|',
            'quote', 'code', 'unordered-list', 'ordered-list', 'table', '|',
            'link', 'image', 'horizontal-rule', '|',
            {
                name: 'insert-tab',
                text: 'Tab',
                title: '插入制表符/缩进选中行',
                className: 'insert-tab-btn',
                action: (editor) => {
                    const cm = editor.codemirror;
                    const sels = cm.listSelections();
                    cm.operation(() => {
                        sels.forEach(sel => {
                            const samePos = sel.anchor.line === sel.head.line && sel.anchor.ch === sel.head.ch;
                            if (samePos) {
                                cm.replaceSelection('    ', 'end');
                            } else {
                                const from = Math.min(sel.anchor.line, sel.head.line);
                                const to = Math.max(sel.anchor.line, sel.head.line);
                                for (let ln = from; ln <= to; ln++) {
                                    cm.replaceRange('    ', { line: ln, ch: 0 });
                                }
                            }
                        });
                    });
                    cm.focus();
                }
            },
            '|', 'preview'
        ]
    });
    AppState.ui.hasRemoteUpdateConflict = false;
    easyMDE.codemirror.on('change', () => { if (AppState.ui.isApplyingRemoteUpdate) return; AppState.ui.lastLocalEditAt = Date.now(); clearTimeout(debounceTimer); debounceTimer = setTimeout(saveEntryChanges, 500); if (!online) persistOffline(); });
    easyMDE.codemirror.on('focus', () => { AppState.ui.isEditorFocused = true; });
    easyMDE.codemirror.on('blur', () => { AppState.ui.isEditorFocused = false; });
    requestAnimationFrame(() => { refreshEditorSize(); setTimeout(refreshEditorSize, 120); });
}
async function fetchFiles() {
    const el = document.getElementById('file-list-inner');
    if (!el) return;
    try {
        const baseUrl = `http://${(window.__overrideServerHost || window.__serverHost)}:${(window.__overrideServerPort || window.__serverPort)}`;
        const res = await fetch(`${baseUrl}/files`);
        const files = await res.json();
        el.innerHTML = files.map(file => `<li class="bg-slate-700/50 p-2 rounded-md hover:bg-slate-700"><a href="${baseUrl}/uploads/${encodeURIComponent(file)}" download class="text-indigo-400 hover:underline text-sm truncate block">${escHtml(file)}</a></li>`).join('') || '<li class="text-sm text-slate-500">暂无文件</li>';
    } catch (e) {
        el.innerHTML = '<li class="text-sm text-red-400">无法加载</li>';
    }
}
function initVolumeAndEntrySortables(groupId) {
    // 卷排序
    const volContainer = document.getElementById('volume-list-container');
    if (!volContainer) return;
    const hasFilter = !!(AppState.ui.entrySearchTerm && AppState.ui.entrySearchTerm.trim());
    if (volContainer._volSortable) { volContainer._volSortable.destroy(); }
    volContainer._volSortable = new Sortable(volContainer, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        handle: 'header',
        onEnd: () => {
            const newOrder = Array.from(volContainer.children).map(sec =>
                sec.querySelector('[data-volume-id]')?.getAttribute('data-volume-id') || sec.id.replace('vol-', '')
            ).filter(Boolean);
            sendMessage('reorder_volumes', { groupId, newOrder });
        }
    });

    // 卷内以及跨卷条目排序
    const sections = volContainer.querySelectorAll('[data-volume-id]');
    sections.forEach(sec => {
        if (sec._entrySortable) sec._entrySortable.destroy();
        sec._entrySortable = new Sortable(sec, {
            group: 'entries-' + groupId,
            handle: '.handle',
            animation: 150,
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            // 当搜索过滤生效时，禁用拖拽，避免只对部分可见条目排序导致顺序被覆盖
            disabled: hasFilter,
            onEnd: (evt) => {
                const fromVolId = evt.from.getAttribute('data-volume-id');
                const toVolId = evt.to.getAttribute('data-volume-id');
                const movedId = evt.item.getAttribute('data-id');
                if (fromVolId === toVolId) {
                    const newOrder = Array.from(evt.to.children).map(it => it.getAttribute('data-id')).filter(Boolean);
                    sendMessage('reorder_entries', { groupId, volumeId: toVolId, newOrder });
                } else {
                    const toIndex = evt.newIndex;
                    sendMessage('move_entry', { groupId, fromVolumeId: fromVolId, toVolumeId: toVolId, entryId: movedId, toIndex });
                }
            }
        });
    });
}
function toggleSidebar() { AppState.ui.isSidebarVisible = !AppState.ui.isSidebarVisible; renderLayout(); }
function selectGroup(groupId) { AppState.ui.selectedGroupId = groupId; AppState.ui.selectedEntryId = null; render(); }
function selectEntry(groupId, entryId) { AppState.ui.selectedGroupId = groupId; AppState.ui.selectedEntryId = entryId; render(); }
function changeTab(tabName) { AppState.ui.activeTab = tabName; AppState.ui.selectedGroupId = null; AppState.ui.selectedEntryId = null; render(); }
function createNewEntry(groupId, volumeId) {
    sendMessage('create_entry', { groupId, volumeId });
    // 乐观更新：本地立即插入一个临时条目到对应卷的最前
    const group = AppState.data.groups.find(g => g.id === groupId);
    if (group) {
        const now = new Date().toISOString();
        const tempId = `temp-${Date.now()}`;
        group.entries = group.entries || [];
        group.entries.unshift({ id: tempId, title: '新条目', content: '# 新条目\n\n开始写作...', createdAt: now, updatedAt: now });
        group.updatedAt = now;
        // 维护卷映射
        const vol = (group.volumes || [])[0];
        const targetVol = (group.volumes || []).find(v => v.id === volumeId) || vol;
        targetVol.entryIds = Array.isArray(targetVol.entryIds) ? targetVol.entryIds : [];
        targetVol.entryIds.unshift(tempId);
        // 保持在列表视图
        AppState.ui.selectedEntryId = null;
        render();
    }
}

function insertEntry(groupId, anchorEntryId, position) {
    // 发送插入请求到服务器（后端会放在同一卷）
    sendMessage('insert_entry', { groupId, anchorEntryId, position });
    // 乐观更新：本地仅维护 entries 数组，卷的 entryIds 交给后端同步
    const group = AppState.data.groups.find(g => g.id === groupId);
    if (!group) return;
    const idx = (group.entries || []).findIndex(e => e.id === anchorEntryId);
    if (idx === -1) return;
    const now = new Date().toISOString();
    const tempId = `temp-insert-${Date.now()}`;
    const insertIndex = position === 'before' ? idx : idx + 1;
    group.entries.splice(insertIndex, 0, {
        id: tempId,
        title: '新条目',
        content: '# 新条目\n\n开始写作...',
        createdAt: now,
        updatedAt: now,
    });
    group.updatedAt = now;
    render();
}

function toggleInsertMenu(ev, groupId, entryId, volumeId) {
    ev.stopPropagation();
    // 关闭其他已打开的菜单
    document.querySelectorAll('[data-insert-menu]').forEach(m => m.classList.add('hidden'));
    // 打开当前菜单
    const btn = ev.currentTarget;
    const menu = btn.parentElement.querySelector('[data-insert-menu]');
    if (menu) menu.classList.toggle('hidden');
    // 点击外部关闭
    const onDocClick = (e) => {
        if (!btn.parentElement.contains(e.target)) {
            menu?.classList.add('hidden');
            document.removeEventListener('click', onDocClick, true);
        }
    };
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

function cloneEntry(groupId, entryId, volumeId) {
    // 发送克隆请求
    sendMessage('clone_entry', { groupId, entryId });
    // 乐观更新：本地在原条目后插入副本（仅 entries 列表）
    const group = AppState.data.groups.find(g => g.id === groupId);
    if (!group) return;
    const idx = (group.entries || []).findIndex(e => e.id === entryId);
    if (idx === -1) return;
    const original = group.entries[idx];
    const now = new Date().toISOString();
    const copy = {
        id: `temp-clone-${Date.now()}`,
        title: `${original.title} (副本)`,
        content: original.content,
        createdAt: now,
        updatedAt: now,
    };
    group.entries.splice(idx + 1, 0, copy);
    group.updatedAt = now;
    renderEntryList();
}
function deleteEntry() {
    // 从编辑器中删除条目后，立即返回条目列表视图
    if (!AppState.ui.selectedGroupId || !AppState.ui.selectedEntryId) return;
    const group = AppState.data.groups.find(g => g.id === AppState.ui.selectedGroupId);
    const entry = group?.entries.find(e => e.id === AppState.ui.selectedEntryId);
    if (!entry) return;

    showConfirmModal(
        '删除条目',
        `确定要删除条目 “${escHtml(entry.title)}” 吗？此操作不可撤销。`,
        () => {
            const groupId = AppState.ui.selectedGroupId;
            const entryId = AppState.ui.selectedEntryId;
            sendMessage('delete_entry', { groupId, entryId });
            // 乐观更新：本地立即移除该条目
            const group = AppState.data.groups.find(g => g.id === groupId);
            if (group) {
                group.entries = (group.entries || []).filter(e => e.id !== entryId);
                // 同时从所有卷移除
                (group.volumes || []).forEach(v => v.entryIds = (v.entryIds || []).filter(id => id !== entryId));
                group.updatedAt = new Date().toISOString();
            }
            // 立刻退回列表视图，不触发保存
            AppState.ui.selectedEntryId = null;
            render();
        }
    );
}
function deleteEntryFromList(groupId, entryId) {
    const group = AppState.data.groups.find(g => g.id === groupId);
    const entry = group?.entries.find(e => e.id === entryId);
    if (!group || !entry) return;

    showConfirmModal(
        '删除条目',
        `确定要删除条目 “${escHtml(entry.title)}” 吗？此操作不可撤销。`,
        () => {
            sendMessage('delete_entry', { groupId, entryId });
            // 乐观更新：本地立即移除该条目并从卷中清理
            group.entries = (group.entries || []).filter(e => e.id !== entryId);
            (group.volumes || []).forEach(v => v.entryIds = (v.entryIds || []).filter(id => id !== entryId));
            if (AppState.ui.selectedGroupId === groupId && AppState.ui.selectedEntryId === entryId) {
                AppState.ui.selectedEntryId = null;
            }
            group.updatedAt = new Date().toISOString();
            renderEntryList();
        }
    );
}
function saveEntryChanges() {
    if (!easyMDE || !AppState.ui.selectedGroupId || !AppState.ui.selectedEntryId) return;
    const currentContent = easyMDE.value();
    const titleEl = document.getElementById('entry-title-input');
    const currentTitle = titleEl ? titleEl.value : '';
    sendMessage('update_entry', { groupId: AppState.ui.selectedGroupId, entryId: AppState.ui.selectedEntryId, title: currentTitle, content: currentContent, updatedAt: new Date().toISOString() });
    AppState.ui.lastSavedAt = Date.now();
}
function toggleTagFilter(tag) { if (AppState.ui.selectedTags.has(tag)) AppState.ui.selectedTags.delete(tag); else AppState.ui.selectedTags.add(tag); render(); }
function showNewGroupModal() {
    document.getElementById('edit-group-id').value = '';
    document.getElementById('new-group-title').value = '';
    document.getElementById('new-group-tags').value = '';
    document.querySelector('#new-group-modal h2').textContent = '新建文字组';
    document.getElementById('new-group-modal').style.display = 'flex';
}
function showEditGroupModal(groupId) {
    const group = AppState.data.groups.find(g => g.id === groupId);
    if (group) {
        document.getElementById('edit-group-id').value = group.id;
        document.getElementById('new-group-title').value = group.title;
        document.getElementById('new-group-tags').value = (group.tags || []).join(', ');
        document.querySelector('#new-group-modal h2').textContent = '编辑文字组';
        document.getElementById('new-group-modal').style.display = 'flex';
    }
}
function hideNewGroupModal() { document.getElementById('new-group-modal').style.display = 'none'; }
function createOrUpdateGroup() {
    const id = document.getElementById('edit-group-id').value;
    const title = document.getElementById('new-group-title').value.trim();
    const tags = document.getElementById('new-group-tags').value.split(',').map(t => t.trim()).filter(Boolean);
    if (title) {
        if (id) {
            sendMessage('update_group', { id, title, tags, updatedAt: new Date().toISOString() });
        } else {
            // 立即在本地创建分组以实现即时UI更新
            const newGroup = {
                id: `temp-${Date.now()}`, // 临时ID
                title: title,
                tags: tags,
                entries: [],
                volumes: [{ id: `temp-vol-${Date.now()}`, title: '默认分组', entryIds: [] }],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            AppState.data.groups.unshift(newGroup); // 添加到数组开头
            tags.forEach(tag => {
                if (!AppState.data.tags.includes(tag)) {
                    AppState.data.tags.push(tag);
                }
            });
            render(); // 立即重新渲染UI
            sendMessage('create_group', { title, tags });
        }
        hideNewGroupModal();
    }
}
function deleteGroup(id) {
    const group = AppState.data.groups.find(g => g.id === id);
    if (!group) return;

    showConfirmModal(
        '删除文字组',
        `确定要删除文字组 “${escHtml(group.title)}” 及其所有条目吗？此操作不可撤销。`,
        () => {
            // 发送消息到服务器
            sendMessage('delete_group', { id });

            // 从本地状态立即移除，实现即时UI更新
            const groupToDelete = AppState.data.groups.find(g => g.id === id);
            AppState.data.groups = AppState.data.groups.filter(g => g.id !== id);

            // 清理孤立的标签
            if (groupToDelete && groupToDelete.tags) {
                const allRemainingTags = new Set(AppState.data.groups.flatMap(g => g.tags || []));
                AppState.data.tags = AppState.data.tags.filter(tag => allRemainingTags.has(tag));
            }

            if (AppState.ui.selectedGroupId === id) {
                AppState.ui.selectedGroupId = null;
                AppState.ui.selectedEntryId = null;
                // 顶部提示：已删除该组（其他端将同步删除）
                try {
                    const actionsEl = document.getElementById('topbar-actions');
                    if (actionsEl) {
                        const tip = document.createElement('div');
                        tip.className = 'ml-2 px-2 py-0.5 rounded text-xs bg-slate-600 text-slate-100';
                        tip.textContent = '已删除此组（其他端会同步）';
                        actionsEl.appendChild(tip);
                        setTimeout(() => tip.remove(), 3000);
                    }
                } catch { }
            }

            render(); // 立即重新渲染UI
        }
    );
}
function applyRemoteUpdateNow() {
    const { selectedGroupId, selectedEntryId } = AppState.ui;
    if (!easyMDE || !selectedGroupId || !selectedEntryId) return;
    const entry = AppState.data.groups.find(g => g.id === selectedGroupId)?.entries.find(e => e.id === selectedEntryId);
    if (!entry) return;
    const cm = easyMDE.codemirror;
    const sel = cm.listSelections();
    const scrollInfo = cm.getScrollInfo();
    AppState.ui.isApplyingRemoteUpdate = true;
    easyMDE.value(entry.content);
    cm.setSelections(sel);
    cm.scrollTo(scrollInfo.left, scrollInfo.top);
    AppState.ui.isApplyingRemoteUpdate = false;
    AppState.ui.hasRemoteUpdateConflict = false;
    render(true);
}

// --- Modal Helpers ---
function showConfirmModal(title, body, onConfirm, confirmBtnClass = 'bg-red-600 hover:bg-red-700') {
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-body').innerHTML = body;
    const actionBtn = document.getElementById('confirm-modal-action-btn');
    actionBtn.className = `px-4 py-2 rounded-md text-white font-bold transition-all ${confirmBtnClass}`;

    const newActionBtn = actionBtn.cloneNode(true);
    actionBtn.parentNode.replaceChild(newActionBtn, actionBtn);
    newActionBtn.addEventListener('click', () => {
        onConfirm();
        hideConfirmModal();
    }, { once: true });

    DOM.confirmModal.style.display = 'flex';
}
function hideConfirmModal() { DOM.confirmModal.style.display = 'none'; }

function showNewVolumeModal(groupId) {
    document.getElementById('new-volume-group-id').value = groupId;
    document.getElementById('new-volume-title').value = '';
    DOM.newVolumeModal.style.display = 'flex';
    setTimeout(() => document.getElementById('new-volume-title').focus(), 50);
}
function hideNewVolumeModal() { DOM.newVolumeModal.style.display = 'none'; }
function handleCreateVolume() {
    const groupId = document.getElementById('new-volume-group-id').value;
    const title = document.getElementById('new-volume-title').value.trim();
    if (groupId && title) {
        sendMessage('create_volume', { groupId, title });
    }
    hideNewVolumeModal();
}


// --- 卷相关交互 ---
function toggleVolumeCollapse(volumeId) {
    if (AppState.ui.collapsedVolumes.has(volumeId)) AppState.ui.collapsedVolumes.delete(volumeId);
    else AppState.ui.collapsedVolumes.add(volumeId);
    renderEntryList();
}
function createVolume(groupId) { showNewVolumeModal(groupId); }
function renameVolume(groupId, volumeId, title) { if (title && title.trim()) sendMessage('update_volume', { groupId, volumeId, title: title.trim() }); }
function deleteVolume(groupId, volumeId) {
    const group = AppState.data.groups.find(g => g.id === groupId);
    const volume = group?.volumes.find(v => v.id === volumeId);
    if (!volume) return;

    showConfirmModal(
        '删除卷',
        `确定要删除卷 “${escHtml(volume.title)}” 吗？其中的条目将移动到另一个卷。`,
        () => sendMessage('delete_volume', { groupId, volumeId })
    );
}

// 卷名内联编辑
function startEditVolume(groupId, volumeId, currentTitle) {
    AppState.ui.editingVolumeId = volumeId;
    AppState.ui.editingVolumeTitle = currentTitle || '';
    renderEntryList();
    setTimeout(() => {
        const el = document.getElementById('vol-edit-input-' + volumeId);
        if (el) { el.focus(); el.select(); }
    }, 0);
}
function onVolumeTitleInput(val) { AppState.ui.editingVolumeTitle = val; }
function onVolumeEditKey(e, groupId, volumeId) {
    if (e.key === 'Enter') { saveEditVolume(groupId, volumeId); }
    else if (e.key === 'Escape') { cancelEditVolume(); }
}
function saveEditVolume(groupId, volumeId) {
    const t = (AppState.ui.editingVolumeTitle || '').trim();
    if (t) { renameVolume(groupId, volumeId, t); }
    AppState.ui.editingVolumeId = null; AppState.ui.editingVolumeTitle = '';
    renderEntryList();
}
function cancelEditVolume() {
    AppState.ui.editingVolumeId = null; AppState.ui.editingVolumeTitle = '';
    renderEntryList();
}

document.addEventListener('DOMContentLoaded', () => {
    setViewportHeightVar();
    connect();
    // 保持移动端侧边栏初始可见
    AppState.ui.isSidebarVisible = true;
    renderLayout();
    render();
    requestAnimationFrame(measureTopbarHeight);
    // 仅在宽度/方向变化时干预，避免键盘导致的高度变化触发顶栏显示
    const onViewportChanged = () => {
        setViewportHeightVar();
        measureTopbarHeight();
        refreshEditorSize();
    };
    window.addEventListener('resize', onViewportChanged);
    window.addEventListener('orientationchange', onViewportChanged);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportChanged);
        window.visualViewport.addEventListener('scroll', setViewportHeightVar);
    }
    // 点击遮罩关闭侧边栏（移动端）
    document.getElementById('sidebar-backdrop').addEventListener('click', () => {
        if (window.innerWidth < 1024 && AppState.ui.isSidebarVisible) toggleSidebar();
    });
    // 移动端左侧边缘滑动呼出侧边栏
    document.addEventListener('touchstart', (e) => {
        if (!AppState.ui.isSidebarVisible) {
            const x = e.touches[0].clientX; const y = e.touches[0].clientY;
            if (x <= 16) { touchStartX = x; touchStartY = y; } else { touchStartX = null; }
        }
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (touchStartX !== null) {
            const x = e.touches[0].clientX; const y = e.touches[0].clientY;
            const dx = x - touchStartX; const dy = Math.abs(y - touchStartY);
            if (dx > 40 && dy < 30) { toggleSidebar(); touchStartX = null; requestAnimationFrame(refreshEditorSize); }
        }
    }, { passive: true });
    document.addEventListener('touchend', () => { touchStartX = null; }, { passive: true });
});

function handleTitleChange() {
    AppState.ui.lastTitleEditAt = Date.now();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(saveEntryChanges, 500);
}
function onTitleFocus() { AppState.ui.isTitleFocused = true; }
function onTitleBlur() { AppState.ui.isTitleFocused = false; }

function goBackToList() {
    if (easyMDE && AppState.ui.selectedGroupId && AppState.ui.selectedEntryId) {
        saveEntryChanges();
    }
    clearTimeout(debounceTimer);
    debounceTimer = null;
    AppState.ui.isEditorFocused = false;
    AppState.ui.isTitleFocused = false;
    AppState.ui.lastTitleEditAt = 0;
    AppState.ui.hasRemoteUpdateConflict = false;
    if (easyMDE) {
        try { easyMDE.toTextArea(); } catch { } easyMDE = null;
    }
    AppState.ui.selectedEntryId = null;
    render();
}
// 确保可从内联事件访问
window.goBackToList = goBackToList;
window.deleteEntryFromList = deleteEntryFromList;
