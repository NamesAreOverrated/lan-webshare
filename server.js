// server.js (Redesign Final Version)
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

// Allow running as a module (controlled by Electron) or standalone (npm start)
let app, server, wss;
let currentPort = null;
let started = false;

// Paths can be overridden via environment variables to place data under Electron userData
let DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json');
let UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
let data = { groups: [], tags: [] };

function normalizeData(d) {
    return {
        groups: Array.isArray(d?.groups) ? d.groups : [],
        tags: Array.isArray(d?.tags) ? d.tags : [],
    };
}

// --- helper: volumes migration & utils ---
function ensureVolumesForGroup(group) {
    // Ensure group.volumes exists and entryIds linked
    group.entries = Array.isArray(group.entries) ? group.entries : [];
    group.volumes = Array.isArray(group.volumes) ? group.volumes : null;
    if (!group.volumes || group.volumes.length === 0) {
        const defaultVol = { id: uuidv4(), title: '默认分组', entryIds: group.entries.map(e => e.id) };
        group.volumes = [defaultVol];
    } else {
        // Make sure every entry id is present in some volume; if not, append to first
        const allIds = new Set(group.entries.map(e => e.id));
        const covered = new Set(group.volumes.flatMap(v => v.entryIds || []));
        const missing = [...allIds].filter(id => !covered.has(id));
        if (missing.length) {
            group.volumes[0].entryIds = Array.isArray(group.volumes[0].entryIds) ? group.volumes[0].entryIds : [];
            group.volumes[0].entryIds.unshift(...missing);
        }
        // Clean up any ids that no longer exist
        group.volumes.forEach(v => {
            v.entryIds = (v.entryIds || []).filter(id => allIds.has(id));
        });
    }
}
function findEntry(group, entryId) {
    return (group.entries || []).find(e => e.id === entryId);
}
function findVolumeContaining(group, entryId) {
    return (group.volumes || []).find(v => Array.isArray(v.entryIds) && v.entryIds.includes(entryId));
}

// --- 数据管理 ---
async function loadData() {
    try {
        const fileContent = await fs.readFile(DB_PATH, 'utf8');
        const parsed = JSON.parse(fileContent);
        data = normalizeData(parsed);
    } catch (error) {
        console.error('无法加载 db.json，将创建新文件。', error.message);
        data = normalizeData({});
        await saveData();
    }
    // migrate groups to ensure volumes present
    (data.groups || []).forEach(g => ensureVolumesForGroup(g));
    await saveData();
}

async function saveData() {
    try {
        await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) { console.error('无法保存数据:', error); }
}

// --- Server factory ---
function createServerInstance() {
    app = express();
    server = http.createServer(app);
    wss = new WebSocket.Server({ server });

    // --- 中间件与文件上传 ---
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Referrer-Policy', 'no-referrer');
        // CORS for Electron/mobile clients
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });
    if (!fsSync.existsSync(UPLOADS_DIR)) { fsSync.mkdirSync(UPLOADS_DIR, { recursive: true }); }
    // Do NOT expose web UI anymore
    app.use('/uploads', express.static(UPLOADS_DIR));
    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOADS_DIR),
        filename: (req, file, cb) => {
            const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            cb(null, `${Date.now()}-${originalName}`);
        }
    });
    const upload = multer({ storage });

    // --- WebSocket 核心逻辑 ---
    function broadcast(message) {
        // 向所有客户端（包括触发方）广播，保持本地 UI 立即同步
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
    }

    wss.on('connection', ws => {
        ws.id = uuidv4(); // 为每个连接分配唯一ID
        ws.send(JSON.stringify({ type: 'full_sync', payload: data }));

        ws.on('message', async rawMessage => {
            try {
                const message = JSON.parse(rawMessage);
                const { type, payload } = message;
                let group, entry;

                switch (type) {
                    case 'create_group':
                        const now_cg = new Date().toISOString();
                        const newGroup = { id: uuidv4(), title: payload.title, tags: payload.tags || [], entries: [], volumes: [], createdAt: now_cg, updatedAt: now_cg };
                        // initialize default volume
                        newGroup.volumes.push({ id: uuidv4(), title: '默认分组', entryIds: [] });
                        data.groups.push(newGroup);
                        (payload.tags || []).forEach(tag => !data.tags.includes(tag) && data.tags.push(tag));
                        break;
                    case 'create_entry': {
                        group = data.groups.find(g => g.id === payload.groupId);
                        if (group) {
                            const now = new Date().toISOString();
                            const newEntry = { id: uuidv4(), title: "新条目", content: "# 新条目\n\n开始写作...", createdAt: now, updatedAt: now };
                            group.entries.unshift(newEntry);
                            // determine target volume
                            ensureVolumesForGroup(group);
                            // remove from any volume first (avoid duplication introduced by ensure)
                            group.volumes.forEach(v => v.entryIds = (v.entryIds || []).filter(id => id !== newEntry.id));
                            const volId = payload.volumeId || group.volumes[0].id;
                            const vol = group.volumes.find(v => v.id === volId) || group.volumes[0];
                            vol.entryIds = Array.isArray(vol.entryIds) ? vol.entryIds : [];
                            // place at front
                            vol.entryIds.unshift(newEntry.id);
                            group.updatedAt = now;
                        }
                        break;
                    }
                    case 'update_entry':
                        group = data.groups.find(g => g.id === payload.groupId);
                        if (group) {
                            entry = group.entries.find(e => e.id === payload.entryId);
                            if (entry) {
                                const now = new Date().toISOString();
                                const incoming = payload.updatedAt || now;
                                const prev = entry.updatedAt || '1970-01-01T00:00:00.000Z';
                                if (new Date(incoming) >= new Date(prev)) {
                                    entry.title = payload.title;
                                    entry.content = payload.content;
                                    entry.updatedAt = incoming;
                                    group.updatedAt = incoming;
                                }
                            }
                        }
                        break;
                    case 'delete_entry':
                        group = data.groups.find(g => g.id === payload.groupId);
                        if (group) {
                            // remove from entries
                            group.entries = group.entries.filter(e => e.id !== payload.entryId);
                            // remove from all volumes
                            ensureVolumesForGroup(group);
                            group.volumes.forEach(v => v.entryIds = (v.entryIds || []).filter(id => id !== payload.entryId));
                            group.updatedAt = new Date().toISOString();
                        }
                        break;
                    case 'update_group':
                        group = data.groups.find(g => g.id === payload.id);
                        if (group) {
                            const now = new Date().toISOString();
                            const incoming = payload.updatedAt || now;
                            const prev = group.updatedAt || group.createdAt || '1970-01-01T00:00:00.000Z';
                            if (new Date(incoming) >= new Date(prev)) {
                                group.title = payload.title;
                                group.tags = payload.tags || [];
                                group.updatedAt = incoming;
                                (payload.tags || []).forEach(tag => !data.tags.includes(tag) && data.tags.push(tag));
                            }
                        }
                        break;
                    case 'delete_group':
                        const groupToDelete = data.groups.find(g => g.id === payload.id);
                        if (groupToDelete) {
                            data.groups = data.groups.filter(g => g.id !== payload.id);
                            // 清理不再使用的标签
                            const allRemainingTags = new Set(data.groups.flatMap(g => g.tags || []));
                            data.tags = data.tags.filter(tag => allRemainingTags.has(tag));
                        }
                        break;
                    // 【新增】处理克隆条目的逻辑
                    case 'clone_entry': {
                        group = data.groups.find(g => g.id === payload.groupId);
                        const originalEntry = group?.entries.find(e => e.id === payload.entryId);
                        if (group && originalEntry) {
                            const now = new Date().toISOString();
                            const newEntry = {
                                id: uuidv4(),
                                title: `${originalEntry.title} (副本)`,
                                content: originalEntry.content,
                                createdAt: now,
                                updatedAt: now,
                            };
                            group.entries.push(newEntry);
                            // Insert into same volume right after original
                            ensureVolumesForGroup(group);
                            const vol = findVolumeContaining(group, payload.entryId) || group.volumes[0];
                            const idx = vol.entryIds.indexOf(payload.entryId);
                            vol.entryIds.splice(idx + 1, 0, newEntry.id);
                            group.updatedAt = now;
                        }
                        break;
                    }

                    // 【调整】条目拖拽排序：限定在指定卷内
                    case 'reorder_entries': {
                        group = data.groups.find(g => g.id === payload.groupId);
                        if (group) {
                            ensureVolumesForGroup(group);
                            const vol = group.volumes.find(v => v.id === payload.volumeId);
                            if (vol) {
                                const entrySet = new Set(vol.entryIds);
                                const newOrdered = (payload.newOrder || []).filter(id => entrySet.has(id));
                                if (newOrdered.length === vol.entryIds.length) {
                                    vol.entryIds = newOrdered;
                                    group.updatedAt = new Date().toISOString();
                                }
                            }
                        }
                        break;
                    }

                    // 【新增】在指定条目之前/之后插入新条目（保持在同一卷）
                    case 'insert_entry': {
                        group = data.groups.find(g => g.id === payload.groupId);
                        if (group) {
                            ensureVolumesForGroup(group);
                            const vol = findVolumeContaining(group, payload.anchorEntryId) || group.volumes[0];
                            const anchorIndex = vol.entryIds.findIndex(id => id === payload.anchorEntryId);
                            if (anchorIndex !== -1) {
                                const now = new Date().toISOString();
                                const newEntry = { id: uuidv4(), title: "新条目", content: "# 新条目\n\n开始写作...", createdAt: now, updatedAt: now };
                                group.entries.push(newEntry);
                                const insertIndex = payload.position === 'before' ? anchorIndex : anchorIndex + 1;
                                vol.entryIds.splice(insertIndex, 0, newEntry.id);
                                group.updatedAt = now;
                            }
                        }
                        break;
                    }

                    // 【新增】卷（volume）管理
                    case 'create_volume': {
                        group = data.groups.find(g => g.id === payload.groupId);
                        if (group) {
                            ensureVolumesForGroup(group);
                            const vol = { id: uuidv4(), title: payload.title || '新分组', entryIds: [] };
                            group.volumes.push(vol);
                            group.updatedAt = new Date().toISOString();
                        }
                        break;
                    }
                    case 'update_volume': {
                        group = data.groups.find(g => g.id === payload.groupId);
                        if (group) {
                            const vol = (group.volumes || []).find(v => v.id === payload.volumeId);
                            if (vol) {
                                vol.title = payload.title || vol.title;
                                group.updatedAt = new Date().toISOString();
                            }
                        }
                        break;
                    }
                    case 'delete_volume': {
                        group = data.groups.find(g => g.id === payload.groupId);
                        if (group) {
                            ensureVolumesForGroup(group);
                            const vols = group.volumes;
                            const idx = vols.findIndex(v => v.id === payload.volumeId);
                            if (idx !== -1) {
                                // move entries to first available volume (not the one being deleted)
                                const targetIdx = idx === 0 ? (vols.length > 1 ? 1 : -1) : 0;
                                if (targetIdx === -1) {
                                    // create a default volume to hold remaining entries
                                    vols.push({ id: uuidv4(), title: '默认分组', entryIds: [] });
                                }
                                const toVol = vols[targetIdx === -1 ? vols.length - 1 : targetIdx];
                                toVol.entryIds = [...(vols[idx].entryIds || []), ...(toVol.entryIds || [])];
                                vols.splice(idx, 1);
                                group.updatedAt = new Date().toISOString();
                            }
                        }
                        break;
                    }
                    case 'reorder_volumes': {
                        group = data.groups.find(g => g.id === payload.groupId);
                        if (group) {
                            ensureVolumesForGroup(group);
                            const idSet = new Set(group.volumes.map(v => v.id));
                            const newOrdered = (payload.newOrder || []).filter(id => idSet.has(id));
                            if (newOrdered.length === group.volumes.length) {
                                const map = new Map(group.volumes.map(v => [v.id, v]));
                                group.volumes = newOrdered.map(id => map.get(id));
                                group.updatedAt = new Date().toISOString();
                            }
                        }
                        break;
                    }
                    case 'move_entry': {
                        group = data.groups.find(g => g.id === payload.groupId);
                        if (group) {
                            ensureVolumesForGroup(group);
                            const fromVol = (group.volumes || []).find(v => v.id === payload.fromVolumeId);
                            const toVol = (group.volumes || []).find(v => v.id === payload.toVolumeId);
                            const eid = payload.entryId;
                            if (fromVol && toVol && fromVol.entryIds.includes(eid)) {
                                fromVol.entryIds = fromVol.entryIds.filter(id => id !== eid);
                                const toIds = toVol.entryIds || [];
                                const insertIndex = typeof payload.toIndex === 'number' && payload.toIndex >= 0 ? Math.min(payload.toIndex, toIds.length) : toIds.length;
                                toIds.splice(insertIndex, 0, eid);
                                toVol.entryIds = toIds;
                                group.updatedAt = new Date().toISOString();
                            }
                        }
                        break;
                    }
                }

                await saveData();
                broadcast({ type: 'full_sync', payload: data }); // 广播最新数据给所有客户端
            } catch (e) {
                console.error("处理WebSocket消息时出错:", e);
            }
        });
    });

    // --- HTTP 路由 ---
    app.post('/upload', upload.single('file'), (req, res) => {
        broadcast({ type: 'files_updated' });
        res.json({ ok: true, file: req.file?.filename || null });
    });
    // Health/status route (no UI exposure)
    app.get('/', (req, res) => {
        res.json({ ok: true, service: 'lan-webshare', ws: true });
    });
    app.get('/files', async (req, res) => {
        try {
            const files = await fs.readdir(UPLOADS_DIR);
            res.json(files.sort((a, b) => b.localeCompare(a)));
        } catch { res.status(500).json([]); }
    });
    app.get('/export', (req, res) => {
        const { groupId } = req.query;
        const group = data.groups.find(g => g.id === groupId);
        if (!group) { return res.status(404).send('Group not found'); }
        ensureVolumesForGroup(group);
        // export by volumes order then entries within volume order
        const entryById = new Map((group.entries || []).map(e => [e.id, e]));
        const parts = [];
        group.volumes.forEach(vol => {
            parts.push(`## ${vol.title}`);
            (vol.entryIds || []).forEach(id => {
                const entry = entryById.get(id);
                if (entry) {
                    parts.push(`# ${entry.title}`);
                    parts.push('');
                    parts.push(entry.content || '');
                    parts.push('');
                    parts.push('---');
                    parts.push('');
                }
            });
        });
        const content = parts.join('\n');
        const fileName = `${group.title.replace(/[\/\\?%*:|"<>]/g, '-')}.md`;
        res.setHeader('Content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        res.setHeader('Content-type', 'text/markdown; charset=utf-8');
        res.send(content);
    });

    return { app, server, wss, broadcast };
}

async function startServer(port = (process.env.PORT || 3000), options = {}) {
    if (started) return currentPort;
    if (options.DB_PATH) DB_PATH = options.DB_PATH;
    if (options.UPLOADS_DIR) UPLOADS_DIR = options.UPLOADS_DIR;
    createServerInstance();
    await loadData();
    await new Promise((resolve) => {
        server.listen(port, '0.0.0.0', () => resolve());
    });
    currentPort = server.address().port;
    started = true;
    console.log(`服务器启动成功，监听端口 ${currentPort}`);
    const interfaces = os.networkInterfaces();
    Object.values(interfaces).flat().forEach(iface => {
        if (iface.family === 'IPv4' && !iface.internal) {
            console.log(`  - http://${iface.address}:${currentPort}`);
        }
    });
    return currentPort;
}

async function stopServer() {
    if (!started) return;
    await new Promise((resolve, reject) => {
        try { wss?.clients?.forEach(c => { try { c.close(); } catch { } }); } catch { }
        server.close(err => err ? reject(err) : resolve());
    });
    started = false;
    currentPort = null;
}

module.exports = { startServer, stopServer };

// If run directly, behave like original script
if (require.main === module) {
    startServer().catch(err => {
        console.error('无法启动服务器:', err);
        process.exit(1);
    });
}