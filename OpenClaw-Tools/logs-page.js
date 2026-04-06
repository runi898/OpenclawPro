(function initOpenClawLogsPage(global) {
    const LOGS_LIVE_UPDATE_KEY = 'openclaw.logs.liveUpdateEnabled';

    async function renderLogsPage(container, deps = {}) {
        const { escapeHtml = (value) => String(value ?? '') } = deps;

        if (window.__openclawLogTimer) {
            clearInterval(window.__openclawLogTimer);
            window.__openclawLogTimer = null;
        }

        const serviceTabs = [
            { key: 'gateway', label: 'Gateway 日志' },
            { key: 'gateway-err', label: 'Gateway 错误' },
            { key: 'guardian', label: '守护进程' },
            { key: 'guardian-backup', label: '备份日志' },
            { key: 'config-audit', label: '配置审计' },
            { key: 'session', label: 'Agent 会话' }
        ];

        container.innerHTML = `
            <div style="padding:24px 28px;height:100%;display:flex;flex-direction:column;box-sizing:border-box">
                <h2 class="page-title">日志查看</h2>
                <p class="page-desc">查看 OpenClaw 服务日志、配置审计日志和 Agent 会话记录。</p>
                <div id="lgTabBar" style="display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 18px"></div>
                <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
                    <div id="lgSessionControls" style="display:none;gap:10px;flex-wrap:wrap;align-items:center">
                        <select id="lgAgentSelect" style="padding:8px 12px;background:#1f2430;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eef2f8;font-size:13px;cursor:pointer;min-width:140px">
                            <option value="">选择 Agent</option>
                        </select>
                        <select id="lgFileSelect" style="padding:8px 12px;background:#1f2430;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eef2f8;font-size:13px;cursor:pointer;min-width:240px">
                            <option value="">选择日志文件</option>
                        </select>
                    </div>
                    <input id="lgSearchInput" placeholder="搜索日志..." style="flex:1;min-width:220px;padding:10px 14px;background:#1f2430;border:1px solid rgba(255,255,255,0.08);border-radius:12px;color:#eef2f8;font-size:13px;box-sizing:border-box">
                    <button id="lgRefreshBtn" style="padding:9px 14px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#d7dce5;cursor:pointer;font-size:13px">刷新</button>
                    <label style="display:flex;align-items:center;gap:8px;color:#d7dce5;font-size:13px;cursor:pointer;white-space:nowrap">
                        <input id="lgLiveUpdate" type="checkbox">
                        实时更新
                    </label>
                    <label style="display:flex;align-items:center;gap:8px;color:#d7dce5;font-size:13px;cursor:pointer;white-space:nowrap">
                        <input id="lgAutoScroll" type="checkbox" checked>
                        自动滚动
                    </label>
                </div>
                <div style="font-size:12px;color:#8f98ab;margin-bottom:6px" id="lgStatus">正在加载日志...</div>
                <div style="font-size:12px;color:#8f98ab;margin-bottom:10px;word-break:break-all" id="lgSource"></div>
                <div id="lgContent" style="flex:1;background:#141823;border-radius:18px;padding:16px 18px;overflow-y:auto;font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.8;color:#d7dce5;white-space:pre-wrap;word-break:break-word;border:1px solid rgba(255,255,255,0.06)"></div>
            </div>
        `;

        const tabBar = container.querySelector('#lgTabBar');
        const agentSelect = container.querySelector('#lgAgentSelect');
        const fileSelect = container.querySelector('#lgFileSelect');
        const sessionControls = container.querySelector('#lgSessionControls');
        const searchInput = container.querySelector('#lgSearchInput');
        const refreshBtn = container.querySelector('#lgRefreshBtn');
        const liveUpdate = container.querySelector('#lgLiveUpdate');
        const autoScroll = container.querySelector('#lgAutoScroll');
        const content = container.querySelector('#lgContent');
        const statusEl = container.querySelector('#lgStatus');
        const sourceEl = container.querySelector('#lgSource');
        const logsShell = container.firstElementChild;
        const logsToolbar = searchInput?.parentElement;

        if (logsShell) {
            logsShell.classList.add('ops-page-shell', 'ops-page-shell-wide', 'logs-page-shell');
            logsShell.removeAttribute('style');
        }
        if (logsToolbar) {
            logsToolbar.classList.add('ops-toolbar', 'logs-toolbar');
            logsToolbar.removeAttribute('style');
        }
        if (sessionControls) sessionControls.classList.add('ops-inline-group');
        if (agentSelect) agentSelect.classList.add('ops-control');
        if (fileSelect) fileSelect.classList.add('ops-control');
        if (searchInput) searchInput.classList.add('ops-control', 'ops-search-control');
        if (refreshBtn) refreshBtn.classList.add('ops-btn', 'ops-btn-secondary');
        if (liveUpdate?.parentElement) liveUpdate.parentElement.classList.add('ops-toggle');
        if (autoScroll?.parentElement) autoScroll.parentElement.classList.add('ops-toggle');
        if (statusEl) statusEl.classList.add('ops-status-text');
        if (sourceEl) sourceEl.classList.add('ops-status-text');
        if (content) content.classList.add('ops-log-surface');

        const state = {
            activeTab: 'gateway',
            renderedText: '',
            loading: false,
            agentsLoaded: false
        };

        let liveUpdateEnabled = false;
        try {
            liveUpdateEnabled = localStorage.getItem(LOGS_LIVE_UPDATE_KEY) === '1';
        } catch (_) {}
        if (liveUpdate) liveUpdate.checked = liveUpdateEnabled;

        tabBar.innerHTML = serviceTabs.map((tab) => `
            <button
                class="lgTabBtn"
                data-tab="${escapeHtml(tab.key)}"
                style="padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);color:#aab3c5;cursor:pointer;font-size:13px"
            >${escapeHtml(tab.label)}</button>
        `).join('');

        function emptyMessage(label) {
            return `${label || '当前日志'} 暂无内容。\n\n已检查 ~/.openclaw/logs 和 ~/.openclaw 根目录下的对应文件。`;
        }

        function setStatus(message, color = '#8f98ab') {
            if (!statusEl) return;
            statusEl.textContent = message || '';
            statusEl.style.color = color;
        }

        function setSourceText(message, color = '#8f98ab') {
            if (!sourceEl) return;
            sourceEl.textContent = message || '';
            sourceEl.style.color = color;
        }

        function renderChrome() {
            tabBar.querySelectorAll('.lgTabBtn').forEach((btn) => {
                const active = btn.dataset.tab === state.activeTab;
                btn.classList.toggle('is-active', active);
            });
            if (sessionControls) {
                sessionControls.style.display = state.activeTab === 'session' ? 'flex' : 'none';
            }
        }

        function formatSessionLog(raw) {
            const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
            return lines.map((line) => {
                try {
                    const entry = JSON.parse(line);
                    const role = String(entry.role || entry.type || 'event');
                    const text = entry.content || entry.text || entry.message || entry.data || entry;
                    const stamp = entry.timestamp || entry.created_at || entry.time || '';
                    const header = stamp ? `${stamp} [${role}]` : `[${role}]`;
                    return `${header}\n${typeof text === 'string' ? text : JSON.stringify(text, null, 2)}\n${'-'.repeat(72)}`;
                } catch (_) {
                    return line;
                }
            }).join('\n');
        }

        function applySearchAndRender() {
            const keyword = String(searchInput?.value || '').trim().toLowerCase();
            let text = state.renderedText || '';

            if (keyword) {
                const matched = text
                    .split(/\r?\n/)
                    .filter((line) => line.toLowerCase().includes(keyword));
                text = matched.length ? matched.join('\n') : `没有找到包含 “${searchInput.value.trim()}” 的日志内容。`;
            }

            content.textContent = text || '暂无日志内容。';
            if (autoScroll?.checked) {
                content.scrollTop = content.scrollHeight;
            }
        }

        async function ensureAgentsLoaded() {
            try {
                const agents = await window.api.listAgents();
                agentSelect.innerHTML = agents.length
                    ? agents.map((agent) => `<option value="${escapeHtml(agent)}">${escapeHtml(agent)}</option>`).join('')
                    : '<option value="">没有可用 Agent</option>';
                state.agentsLoaded = true;
            } catch (error) {
                agentSelect.innerHTML = '<option value="">加载 Agent 失败</option>';
                setStatus(`加载 Agent 失败: ${error?.message || error}`, '#ff6188');
            }
        }

        async function loadSessionFiles() {
            const agentName = String(agentSelect?.value || '').trim();
            if (!agentName) {
                fileSelect.innerHTML = '<option value="">没有可选日志</option>';
                return false;
            }

            try {
                const files = await window.api.listLogFiles(agentName);
                if (!files.length) {
                    fileSelect.innerHTML = '<option value="">没有会话日志</option>';
                    return false;
                }

                const previous = fileSelect.value;
                fileSelect.innerHTML = files.map((file) => `
                    <option value="${escapeHtml(file.path)}">${escapeHtml(file.name)} (${escapeHtml(new Date(file.mtime).toLocaleString('zh-CN'))})</option>
                `).join('');

                if (previous && files.some((file) => file.path === previous)) {
                    fileSelect.value = previous;
                }

                return true;
            } catch (error) {
                fileSelect.innerHTML = '<option value="">读取日志列表失败</option>';
                setStatus(`读取日志列表失败: ${error?.message || error}`, '#ff6188');
                return false;
            }
        }

        async function loadSessionLog() {
            if (!state.agentsLoaded) await ensureAgentsLoaded();

            const hasFiles = await loadSessionFiles();
            if (!hasFiles || !fileSelect.value) {
                state.renderedText = '当前 Agent 暂无会话日志。';
                setStatus('没有可读取的会话日志', '#fc9867');
                setSourceText('');
                applySearchAndRender();
                return;
            }

            const raw = await window.api.readLogFile(fileSelect.value, 400);
            state.renderedText = raw && raw.trim() ? formatSessionLog(raw) : '会话日志为空。';
            setStatus(`已加载 ${fileSelect.options[fileSelect.selectedIndex]?.text || '会话日志'}`, '#8f98ab');
            setSourceText(`当前会话文件：${fileSelect.value || '未知'}`);
            applySearchAndRender();
        }

        async function loadServiceLog() {
            const active = serviceTabs.find((tab) => tab.key === state.activeTab);
            let raw = '';

            if (state.activeTab === 'gateway') {
                const gatewayLog = await window.api.readGatewayLogDetails?.(400);
                raw = String(gatewayLog?.text || '');
                if (gatewayLog?.path) {
                    setSourceText(`当前活跃日志文件：${gatewayLog.path}`);
                } else {
                    setSourceText('当前活跃日志文件：未获取到');
                }
            } else {
                raw = await window.api.readServiceLog(state.activeTab, 400);
                setSourceText('');
            }

            state.renderedText = raw && raw.trim()
                ? raw
                : emptyMessage(active?.label);
            setStatus(`已加载 ${active?.label || '日志'}`, '#8f98ab');
            applySearchAndRender();
        }

        async function refreshActiveLog(reason = 'refresh') {
            if (state.loading) return;
            state.loading = true;
            setStatus(reason === 'refresh' ? '正在刷新日志...' : '正在加载日志...', '#8f98ab');

            try {
                if (state.activeTab === 'session') {
                    await loadSessionLog();
                } else {
                    await loadServiceLog();
                }
            } catch (error) {
                state.renderedText = `日志加载失败: ${error?.message || error}`;
                setStatus(`日志加载失败: ${error?.message || error}`, '#ff6188');
                applySearchAndRender();
            } finally {
                state.loading = false;
            }
        }

        function syncAutoTimer() {
            if (window.__openclawLogTimer) {
                clearInterval(window.__openclawLogTimer);
                window.__openclawLogTimer = null;
            }

            if (!liveUpdate?.checked) return;

            window.__openclawLogTimer = setInterval(() => {
                if (!document.body.contains(container)) {
                    clearInterval(window.__openclawLogTimer);
                    window.__openclawLogTimer = null;
                    return;
                }
                refreshActiveLog();
            }, 3000);
        }

        tabBar.querySelectorAll('.lgTabBtn').forEach((btn) => {
            btn.onclick = async () => {
                state.activeTab = btn.dataset.tab;
                renderChrome();
                await refreshActiveLog('load');
            };
        });

        agentSelect.onchange = async () => {
            if (state.activeTab !== 'session') return;
            await refreshActiveLog('load');
        };

        fileSelect.onchange = async () => {
            if (state.activeTab !== 'session') return;
            await loadSessionLog();
        };

        searchInput.oninput = () => applySearchAndRender();
        refreshBtn.onclick = () => refreshActiveLog();

        if (liveUpdate) {
            liveUpdate.onchange = () => {
                try {
                    localStorage.setItem(LOGS_LIVE_UPDATE_KEY, liveUpdate.checked ? '1' : '0');
                } catch (_) {}
                syncAutoTimer();
                setStatus(
                    liveUpdate.checked
                        ? '已开启实时更新，每 3 秒自动刷新一次。'
                        : '已关闭实时更新，现在需要手动刷新。',
                    liveUpdate.checked ? '#8f98ab' : '#fc9867'
                );
            };
        }

        autoScroll.onchange = () => {
            applySearchAndRender();
        };

        renderChrome();
        syncAutoTimer();
        await refreshActiveLog('load');
    }

    global.__openclawLogsPage = {
        renderLogsPage
    };
})(window);
