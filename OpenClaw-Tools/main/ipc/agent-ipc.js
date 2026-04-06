function registerAgentIpcHandlers(deps = {}) {
    const {
        ipcMain,
        fs,
        path,
        readOpenClawConfigSync,
        writeOpenClawConfigSync,
        mergeAgentIds,
        resolveAgentFilePath,
        normalizeAgentName,
        getAgentWorkspacePath,
        ensureAgentWorkspaceFiles,
        ensureDirectory,
        getAgentRootPath,
        resolveAbsolute,
        ensureAgentMetadataFiles,
        replaceRootPrefix,
        buildRuntimeModelCatalog
    } = deps;

    function removeDirectoryIfExists(targetPath) {
        const resolved = String(targetPath || '').trim();
        if (!resolved || !fs.existsSync(resolved)) return;
        fs.rmSync(resolved, {
            recursive: true,
            force: true,
            maxRetries: 4,
            retryDelay: 150
        });
    }

    function getAgentEntry(config = {}, agentId = '') {
        const safeId = normalizeAgentName(agentId || '');
        const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
        return list.find((item) => normalizeAgentName(item?.id || '') === safeId) || null;
    }

    function getCollaborationPath(config = {}, agentId = 'main') {
        const safeId = normalizeAgentName(agentId || 'main');
        const entry = getAgentEntry(config, safeId);
        const agentDir = String(entry?.agentDir || '').trim() || path.join(getAgentRootPath(safeId), 'agent');
        return path.join(agentDir, 'collaboration.json');
    }

    function buildModelCatalog(config = {}, agentId = 'main') {
        if (typeof buildRuntimeModelCatalog !== 'function') {
            return { providers: [], options: [] };
        }
        const runtimeCatalog = buildRuntimeModelCatalog(config, agentId) || { providers: [] };
        const options = [];
        const seen = new Set();
        (runtimeCatalog.providers || []).forEach((provider) => {
            const providerKey = String(provider?.key || '').trim();
            (provider?.models || []).forEach((model) => {
                const rawId = typeof model === 'string' ? model : model?.id;
                const modelId = String(rawId || '').trim();
                if (!providerKey || !modelId) return;
                const value = modelId.startsWith(`${providerKey}/`)
                    ? modelId
                    : `${providerKey}/${modelId}`;
                if (seen.has(value)) return;
                seen.add(value);
                options.push({
                    value,
                    modelId
                });
            });
        });
        return { providers: runtimeCatalog.providers || [], options };
    }

    function normalizeConfiguredModelValue(rawValue = '', modelCatalog = {}, fallbackValue = '') {
        const requested = String(rawValue || '').trim();
        const fallback = String(fallbackValue || '').trim();
        const options = Array.isArray(modelCatalog?.options) ? modelCatalog.options : [];
        if (!options.length) return requested || fallback;

        const byValue = new Map();
        const byModelId = new Map();
        const byShortModelId = new Map();
        options.forEach((option) => {
            const value = String(option?.value || '').trim();
            const modelId = String(option?.modelId || '').trim();
            if (!value) return;
            byValue.set(value.toLowerCase(), value);
            if (!modelId) return;
            const modelKey = modelId.toLowerCase();
            const modelMatches = byModelId.get(modelKey) || [];
            modelMatches.push(value);
            byModelId.set(modelKey, modelMatches);
            const shortKey = modelId.includes('/') ? modelId.split('/').pop() : modelId;
            const shortMatches = byShortModelId.get(String(shortKey || '').trim().toLowerCase()) || [];
            shortMatches.push(value);
            byShortModelId.set(String(shortKey || '').trim().toLowerCase(), shortMatches);
        });

        const resolveCandidate = (candidate = '') => {
            const normalized = String(candidate || '').trim();
            if (!normalized) return '';
            const exact = byValue.get(normalized.toLowerCase());
            if (exact) return exact;
            const exactModelMatches = byModelId.get(normalized.toLowerCase()) || [];
            if (exactModelMatches.length === 1) return exactModelMatches[0];
            const suffix = normalized.includes('/') ? normalized.split('/').pop() : normalized;
            const suffixMatches = byShortModelId.get(String(suffix || '').trim().toLowerCase()) || [];
            return suffixMatches.length === 1 ? suffixMatches[0] : '';
        };

        return resolveCandidate(requested) || resolveCandidate(fallback) || '';
    }

    function scrubDeletedAgentFromCollaborations(config = {}, deletedAgentId = '') {
        const safeDeletedId = normalizeAgentName(deletedAgentId || '');
        if (!safeDeletedId) return;
        const candidateIds = Array.from(new Set(['main'].concat(mergeAgentIds(config) || [])))
            .map((id) => {
                try {
                    return normalizeAgentName(id || '');
                } catch (_) {
                    return '';
                }
            })
            .filter(Boolean)
            .filter((id) => id !== safeDeletedId);

        candidateIds.forEach((agentId) => {
            try {
                const collaborationPath = getCollaborationPath(config, agentId);
                if (!fs.existsSync(collaborationPath)) return;
                const collaboration = JSON.parse(fs.readFileSync(collaborationPath, 'utf8'));
                let changed = false;

                if (Array.isArray(collaboration?.topology?.childAgentIds)) {
                    const nextChildIds = collaboration.topology.childAgentIds.filter((childId) => {
                        try {
                            return normalizeAgentName(childId || '') !== safeDeletedId;
                        } catch (_) {
                            return true;
                        }
                    });
                    if (nextChildIds.length !== collaboration.topology.childAgentIds.length) {
                        collaboration.topology.childAgentIds = nextChildIds;
                        changed = true;
                    }
                }

                if (collaboration?.agents && typeof collaboration.agents === 'object' && collaboration.agents[safeDeletedId]) {
                    delete collaboration.agents[safeDeletedId];
                    changed = true;
                }

                if (changed) {
                    collaboration.updatedAt = new Date().toISOString();
                    ensureDirectory(path.dirname(collaborationPath));
                    fs.writeFileSync(collaborationPath, JSON.stringify(collaboration, null, 2), 'utf8');
                }
            } catch (error) {
                console.warn('[Agent] Failed to scrub collaboration reference:', error.message);
            }
        });
    }

    ipcMain.handle('list-agents', () => {
        try {
            const config = readOpenClawConfigSync();
            return mergeAgentIds(config);
        } catch (error) {
            console.error('[Agent] List failed:', error.message);
            return ['main'];
        }
    });

    ipcMain.handle('read-agent-file', (_, agentName, fileName) => {
        try {
            const config = readOpenClawConfigSync();
            const targetPath = resolveAgentFilePath(config, agentName, fileName);
            if (!fs.existsSync(targetPath)) return null;
            return fs.readFileSync(targetPath, 'utf8');
        } catch (error) {
            console.error('[Agent] Read file failed:', error.message);
            return null;
        }
    });

    ipcMain.handle('write-agent-file', (_, agentName, fileName, content) => {
        try {
            const config = readOpenClawConfigSync();
            const normalizedAgent = normalizeAgentName(agentName);
            const workspacePath = getAgentWorkspacePath(config, normalizedAgent);
            ensureAgentWorkspaceFiles(normalizedAgent, workspacePath, normalizedAgent);

            const targetPath = resolveAgentFilePath(config, normalizedAgent, fileName);
            ensureDirectory(path.dirname(targetPath));
            fs.writeFileSync(targetPath, String(content ?? ''), 'utf8');
            return { ok: true, path: targetPath };
        } catch (error) {
            console.error('[Agent] Write file failed:', error.message);
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('create-agent', (_, payload) => {
        try {
            const request = typeof payload === 'string' ? { id: payload } : (payload || {});
            const config = readOpenClawConfigSync();
            const id = normalizeAgentName(request.id);
            const displayName = String(request.name || id).trim() || id;
            const modelCatalog = buildModelCatalog(config, id || 'main');
            const defaultModel = normalizeConfiguredModelValue(
                config?.agents?.defaults?.model?.primary || '',
                modelCatalog,
                modelCatalog?.options?.[0]?.value || ''
            );
            const model = request.model
                ? normalizeConfiguredModelValue(request.model, modelCatalog, defaultModel)
                : defaultModel;

            if (mergeAgentIds(config).includes(id)) {
                throw new Error(`Agent "${id}" already exists`);
            }
            if (id === 'main') {
                throw new Error('不能重复创建默认 Agent');
            }

            const agentRoot = getAgentRootPath(id);
            const workspacePath = request.workspace
                ? resolveAbsolute(request.workspace)
                : path.join(agentRoot, 'workspace');
            const agentDir = path.join(agentRoot, 'agent');
            const sessionsDir = path.join(agentRoot, 'sessions');

            ensureDirectory(agentRoot);
            ensureDirectory(agentDir);
            ensureDirectory(sessionsDir);
            ensureAgentWorkspaceFiles(id, workspacePath, displayName);

            if (!config.agents || typeof config.agents !== 'object') config.agents = {};
            if (!Array.isArray(config.agents.list)) config.agents.list = [];

            config.agents.list.push({
                id,
                name: displayName,
                model,
                workspace: workspacePath,
                agentDir
            });

            writeOpenClawConfigSync(config);
            ensureAgentMetadataFiles(config, id);

            return {
                ok: true,
                id,
                workspace: workspacePath,
                agentDir
            };
        } catch (error) {
            console.error('[Agent] Create failed:', error.message);
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('delete-agent', (_, agentName) => {
        try {
            const id = normalizeAgentName(agentName);
            if (id === 'main') {
                throw new Error('不能删除默认 Agent');
            }

            const config = readOpenClawConfigSync();
            scrubDeletedAgentFromCollaborations(config, id);

            if (Array.isArray(config?.agents?.list)) {
                config.agents.list = config.agents.list.filter(item => normalizeAgentName(item?.id || '') !== id);
            }

            if (config?.agents?.profiles && typeof config.agents.profiles === 'object') {
                delete config.agents.profiles[id];
            }

            if (Array.isArray(config?.bindings)) {
                config.bindings = config.bindings.filter(binding => normalizeAgentName(binding?.agentId || 'main') !== id);
            }

            writeOpenClawConfigSync(config);

            const agentRoot = getAgentRootPath(id);
            if (fs.existsSync(agentRoot)) {
                removeDirectoryIfExists(agentRoot);
            }

            if (fs.existsSync(agentRoot)) {
                throw new Error(`Agent directory still exists: ${agentRoot}`);
            }

            return { ok: true, removedRoot: agentRoot };
        } catch (error) {
            console.error('[Agent] Delete failed:', error.message);
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle('rename-agent', (_, payload) => {
        try {
            const oldName = normalizeAgentName(payload?.oldName);
            const newName = normalizeAgentName(payload?.newName);

            if (oldName === 'main') {
                throw new Error('默认 Agent 不支持重命名');
            }
            if (oldName === newName) {
                return { ok: true, id: newName };
            }

            const config = readOpenClawConfigSync();
            if (mergeAgentIds(config).includes(newName)) {
                throw new Error(`Agent "${newName}" already exists`);
            }

            const oldRoot = getAgentRootPath(oldName);
            const newRoot = getAgentRootPath(newName);
            if (fs.existsSync(oldRoot)) {
                ensureDirectory(path.dirname(newRoot));
                fs.renameSync(oldRoot, newRoot);
            }

            if (!config.agents || typeof config.agents !== 'object') config.agents = {};
            if (!Array.isArray(config.agents.list)) config.agents.list = [];

            let entry = config.agents.list.find(item => normalizeAgentName(item?.id || '') === oldName);
            if (!entry) {
                entry = {
                    id: oldName,
                    name: oldName,
                    workspace: path.join(oldRoot, 'workspace'),
                    agentDir: path.join(oldRoot, 'agent')
                };
                config.agents.list.push(entry);
            }

            entry.id = newName;
            if (!entry.name || entry.name === oldName) {
                entry.name = newName;
            }
            if (entry.workspace) {
                entry.workspace = replaceRootPrefix(entry.workspace, oldRoot, newRoot);
            } else {
                entry.workspace = path.join(newRoot, 'workspace');
            }
            if (entry.agentDir) {
                entry.agentDir = replaceRootPrefix(entry.agentDir, oldRoot, newRoot);
            } else {
                entry.agentDir = path.join(newRoot, 'agent');
            }

            if (config?.agents?.profiles && typeof config.agents.profiles === 'object' && config.agents.profiles[oldName]) {
                config.agents.profiles[newName] = config.agents.profiles[oldName];
                delete config.agents.profiles[oldName];
            }

            if (Array.isArray(config?.bindings)) {
                config.bindings = config.bindings.map(binding => {
                    if (normalizeAgentName(binding?.agentId || 'main') !== oldName) {
                        return binding;
                    }
                    return { ...binding, agentId: newName };
                });
            }

            writeOpenClawConfigSync(config);
            return { ok: true, id: newName };
        } catch (error) {
            console.error('[Agent] Rename failed:', error.message);
            return { ok: false, error: error.message };
        }
    });
}

module.exports = {
    registerAgentIpcHandlers
};
