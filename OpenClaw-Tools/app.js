document.addEventListener('DOMContentLoaded', () => {
    // --- 鐘舵€佺鐞?---
    let currentPage = 'dashboard';
    let previousPage = '';
    let searchQuery = '';
    const THEME_STORAGE_KEY = 'openclaw.theme.mode';
    const THEME_MODES = new Set(['light', 'dark', 'auto']);
    const SIDEBAR_WIDTH_KEY = 'openclaw.sidebar.width';
    const SIDEBAR_COLLAPSED_KEY = 'openclaw.sidebar.collapsed';
    const SIDEBAR_MIN_WIDTH = 76;
    const SIDEBAR_MAX_WIDTH = 360;
    const SIDEBAR_COMPACT_THRESHOLD = 118;
    
    // --- DOM 鍏冪礌寮曠敤 ---
    const appContainer = document.querySelector('.app-container');
    const sidebar = document.getElementById('appSidebar');
    const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
    const sidebarResizer = document.getElementById('sidebarResizer');
    const viewContainer = document.getElementById('viewContainer');
    const searchInput = document.getElementById('globalSearch');
    const topBarSearch = document.getElementById('topBarSearch');
    const topBarRuntimeControls = document.getElementById('topBarRuntimeControls');
    const navLinks = document.querySelectorAll('.nav-links li');
    let sidebarWidth = 256;
    let sidebarCollapsed = false;
    let sidebarResizeActive = false;
    
    // 缁堢 UI 寮曠敤
    const terminalPanel = document.getElementById('terminalPanel');
    const terminalBody = document.getElementById('terminalBody');
    const closeTerminalBtn = document.getElementById('closeTerminalBtn');
    const killCmdBtn = document.getElementById('killCmdBtn');
    const terminalAutoScrollToggle = document.getElementById('terminalAutoScroll');
    const clearTerminalBtn = document.getElementById('clearTerminalBtn');
    const terminalStatusHint = document.getElementById('terminalStatusHint');
    const terminalEmptyState = document.getElementById('terminalEmptyState');
    let currentExecutingCommandId = null;
    let currentLogOutputDiv = null;
    let focusedSessionId = null;
    const commandSessions = new Map();
    const commandSessionObservers = new Set();
    const DASHBOARD_MODE_KEY = 'openclaw.dashboard.startMode';
    const DASHBOARD_AUTO_LAUNCH_KEY = 'openclaw.dashboard.autoLaunchOnStart';
    const DASHBOARD_REALTIME_LOG_KEY = 'openclaw.dashboard.realtimeLogEnabled';
    let dashboardStartMode = localStorage.getItem(DASHBOARD_MODE_KEY) === 'npm' ? 'npm' : 'official';
    let dashboardAutoLaunchOnStart = localStorage.getItem(DASHBOARD_AUTO_LAUNCH_KEY) === '1';
    let dashboardRealtimeLogEnabled = localStorage.getItem(DASHBOARD_REALTIME_LOG_KEY) === '1';
    let dashboardConfigCache = null;
    let filteredCommandsCacheKey = null;
    let filteredCommandsCache = [];
    let commandsPageRenderKey = '';
    let chatWebviewInitialized = false;
    let chatWebviewInitPromise = null;
    let chatWebviewLastResumeSyncAt = 0;
    let pageRenderTicket = 0;
    const themeButtons = Array.from(document.querySelectorAll('[data-theme-mode]'));
    let themePreference = 'auto';
    let themeAutoTimer = null;
    let topbarRuntimeStatusTimer = null;
    let runtimeAutoLaunchScheduled = false;
    let dashboardAutoStartColdProbePending = true;
    let dashboardLifecycleStatusPollToken = 0;
    let dashboardLifecycleStatusPollTimer = null;
    const dashboardResumeWorkTimers = new Set();
    let pendingDashboardRenderToken = 0;
    let commandsInlineLogRefreshScheduled = false;
    const commandSilentStartTimers = new Map();

    function normalizeThemeMode(mode) {
        return THEME_MODES.has(mode) ? mode : 'auto';
    }

    function clampSidebarWidth(value) {
        const width = Number(value);
        if (!Number.isFinite(width)) return 256;
        return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)));
    }

    function persistSidebarState() {
        try {
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
            localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
        } catch (_) {}
    }

    function applySidebarState(options = {}) {
        if (!appContainer || !sidebarToggleBtn) return;
        const resolvedWidth = clampSidebarWidth(sidebarWidth);
        appContainer.style.setProperty('--sidebar-width', `${sidebarCollapsed ? 0 : resolvedWidth}px`);
        appContainer.classList.toggle('is-sidebar-collapsed', sidebarCollapsed);
        appContainer.classList.toggle('is-sidebar-compact', !sidebarCollapsed && resolvedWidth <= SIDEBAR_COMPACT_THRESHOLD);
        sidebarToggleBtn.textContent = sidebarCollapsed ? '⟩' : '⟨';
        sidebarToggleBtn.setAttribute('aria-expanded', String(!sidebarCollapsed));
        sidebarToggleBtn.setAttribute('aria-label', sidebarCollapsed ? '恢复导航栏' : '折叠导航栏');
        sidebarToggleBtn.title = sidebarCollapsed ? '恢复导航栏' : '折叠导航栏';
        if (sidebarResizer) {
            sidebarResizer.setAttribute('aria-hidden', String(sidebarCollapsed));
        }
        if (options.persist !== false) {
            persistSidebarState();
        }
    }

    function setSidebarCollapsed(nextCollapsed, options = {}) {
        sidebarCollapsed = Boolean(nextCollapsed);
        applySidebarState(options);
    }

    function initSidebarLayout() {
        if (!appContainer || !sidebar || !sidebarToggleBtn) return;
        try {
            sidebarWidth = clampSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY) || 256);
            sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
        } catch (_) {
            sidebarWidth = 256;
            sidebarCollapsed = false;
        }

        applySidebarState({ persist: false });

        sidebarToggleBtn.addEventListener('click', () => {
            setSidebarCollapsed(!sidebarCollapsed);
        });

        if (!sidebarResizer) return;

        const handlePointerMove = (event) => {
            if (!sidebarResizeActive || !appContainer) return;
            const nextWidth = clampSidebarWidth(event.clientX - appContainer.getBoundingClientRect().left);
            sidebarWidth = nextWidth;
            if (sidebarCollapsed) {
                sidebarCollapsed = false;
            }
            appContainer.classList.add('is-sidebar-resizing');
            applySidebarState({ persist: false });
        };

        const stopResize = () => {
            if (!sidebarResizeActive) return;
            sidebarResizeActive = false;
            appContainer?.classList.remove('is-sidebar-resizing');
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', stopResize);
            window.removeEventListener('pointercancel', stopResize);
            persistSidebarState();
        };

        sidebarResizer.addEventListener('pointerdown', (event) => {
            if (window.innerWidth <= 720) return;
            event.preventDefault();
            sidebarResizeActive = true;
            if (sidebarCollapsed) {
                sidebarCollapsed = false;
                applySidebarState({ persist: false });
            }
            appContainer.classList.add('is-sidebar-resizing');
            window.addEventListener('pointermove', handlePointerMove);
            window.addEventListener('pointerup', stopResize);
            window.addEventListener('pointercancel', stopResize);
        });

        sidebarResizer.addEventListener('dblclick', () => {
            if (window.innerWidth <= 720) return;
            sidebarWidth = 256;
            sidebarCollapsed = false;
            applySidebarState();
        });

        window.addEventListener('resize', () => {
            if (window.innerWidth <= 720 && sidebarCollapsed) {
                setSidebarCollapsed(false, { persist: false });
                persistSidebarState();
                return;
            }
            applySidebarState({ persist: false });
        });
    }

    function getAutoThemeMode() {
        const hour = new Date().getHours();
        return hour >= 6 && hour < 18 ? 'light' : 'dark';
    }

    function resolveThemeMode(mode = themePreference) {
        if (mode === 'auto') {
            return getAutoThemeMode();
        }
        return mode;
    }

    function updateThemeControls() {
        themeButtons.forEach((button) => {
            const active = button.getAttribute('data-theme-mode') === themePreference;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    function applyThemeMode(mode, persist = true) {
        themePreference = normalizeThemeMode(mode);
        const resolved = resolveThemeMode(themePreference);
        const root = document.documentElement;
        root.dataset.themeMode = themePreference;
        root.dataset.theme = resolved;
        root.style.colorScheme = resolved;
        document.body.dataset.theme = resolved;
        document.body.dataset.themeMode = themePreference;
        if (persist) {
            try {
                localStorage.setItem(THEME_STORAGE_KEY, themePreference);
            } catch (error) {}
        }
        updateThemeControls();
    }

    function initThemeMode() {
        try {
            const stored = localStorage.getItem(THEME_STORAGE_KEY);
            themePreference = normalizeThemeMode(stored);
        } catch (error) {
            themePreference = 'auto';
        }
        applyThemeMode(themePreference, false);

        themeButtons.forEach((button) => {
            button.addEventListener('click', () => {
                applyThemeMode(button.getAttribute('data-theme-mode') || 'auto');
            });
        });

        if (themeAutoTimer) {
            clearInterval(themeAutoTimer);
        }
        themeAutoTimer = window.setInterval(() => {
            if (themePreference === 'auto') {
                applyThemeMode('auto', false);
            }
        }, 60000);

        window.addEventListener('visibilitychange', () => {
            if (themePreference === 'auto' && document.visibilityState === 'visible') {
                applyThemeMode('auto', false);
            }
        });
    }

    // Spotlight UI 寮曠敤
    const spotlightOverlay = document.getElementById('spotlightOverlay');
    const spotlightInput = document.getElementById('spotlightInput');
    const spotlightResults = document.getElementById('spotlightResults');
    let spotlightSelectedIndex = -1;
    let currentFilteredCommands = [];

    function syncNavState() {
        navLinks.forEach((link) => {
            link.classList.toggle('active', link.getAttribute('data-page') === currentPage);
        });
    }

    function navigateToPage(pageName, options = {}) {
        const nextPage = String(pageName || '').trim();
        const forceRender = options?.force === true;
        if (!nextPage) return;
        if (!forceRender && nextPage === currentPage) return;
        previousPage = currentPage;
        currentPage = nextPage;
        renderPage();
    }

    function setDashboardRealtimeLogEnabled(nextValue) {
        dashboardRealtimeLogEnabled = Boolean(nextValue);
        try {
            localStorage.setItem(DASHBOARD_REALTIME_LOG_KEY, dashboardRealtimeLogEnabled ? '1' : '0');
        } catch (_) {}
        return dashboardRealtimeLogEnabled;
    }

    window.__openclawNavigate = (pageName, options = {}) => navigateToPage(pageName, options);

    function scheduleUiFlush(callback, timeoutMs = 16) {
        let finished = false;
        const run = () => {
            if (finished) return;
            finished = true;
            callback();
        };

        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(run);
        }
        window.setTimeout(run, timeoutMs);
    }

    function scheduleIdleUiWork(callback, options = {}) {
        const timeoutMs = Math.max(0, Number(options?.timeoutMs) || 1000);
        if (typeof window.requestIdleCallback === 'function') {
            return window.requestIdleCallback(() => {
                callback();
            }, { timeout: timeoutMs });
        }
        return window.setTimeout(callback, timeoutMs);
    }

    function hideInactivePageView(pageName) {
        const normalizedPage = String(pageName || '').trim();
        if (!normalizedPage) return;
        const viewEl = document.getElementById(`view-${normalizedPage}`);
        if (!viewEl) return;
        if (normalizedPage === 'chat' && chatWebviewInitialized) {
            parkChatViewOffscreen();
            return;
        }
        viewEl.style.display = 'none';
    }

    function scheduleDeferredPageCleanup(renderTicket) {
        scheduleIdleUiWork(() => {
            if (renderTicket !== pageRenderTicket) return;
            if (currentPage !== 'channels') {
                document.getElementById('view-channels')?.__openclawCleanupChannelsPage?.();
            }
            if (currentPage !== 'agents') {
                document.getElementById('view-agents')?.__openclawCleanupAgentHub?.();
            }
        }, { timeoutMs: 120 });
    }

    function renderDashboardLoadingShell(container) {
        if (!container) return;
        container.innerHTML = `
            <div class="dashboard-shell">
                <div class="db-status-panel" style="min-height:220px;display:flex;align-items:center;justify-content:center;">
                    <div style="display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--text-secondary);text-align:center;">
                        <div class="db-status-title">首页正在准备中</div>
                        <div class="db-status-subtitle">先显示页面框架，运行控制和统计信息会在下一拍补齐。</div>
                    </div>
                </div>
            </div>
        `;
    }

    function cancelPendingDashboardRender() {
        pendingDashboardRenderToken += 1;
    }
    
    // 浜や簰寮忓弬鏁?Modal (Phase 5)
    function getFilteredCommands() {
        const query = searchQuery.toLowerCase();
        if (filteredCommandsCacheKey === query) {
            return filteredCommandsCache;
        }
        filteredCommandsCacheKey = query;
        filteredCommandsCache = commandsDB.filter(cmd => {
            const matchName = cmd.name.toLowerCase().includes(query);
            const matchDesc = cmd.desc.toLowerCase().includes(query);
            const matchTag = cmd.tags.some(t => t.toLowerCase().includes(query));
            return matchName || matchDesc || matchTag;
        });
        return filteredCommandsCache;
    }

    function getCommandsPageItems() { return getVisibleCommandsPageItems(); } /*
        const filteredCommands = getFilteredCommands();
        if (searchQuery) {
            return filteredCommands;
        }
        if (currentCategoryTab !== '閹碘偓閺?') {
            return filteredCommands.filter(c => {
                if (currentCategoryTab === '闁氨鏁?') return !c.tags.some(t => categories.includes(t)) || c.tags.includes('闁氨鏁?');
                return c.tags.includes(currentCategoryTab);
            });
        }
        return filteredCommands;
    */

    function getCommandsPageRenderKey(commands) {
        return JSON.stringify({
            query: searchQuery,
            category: currentCategoryTab,
            ids: commands.map((cmd) => cmd.id)
        });
    }

    function refreshCommandsPage(force = false) {
        const el = document.getElementById('view-commands');
        if (!el) return;
        const nextCommands = getVisibleCommandsPageItems();
        const nextRenderKey = getCommandsPageRenderKey(nextCommands);
        if (!force && commandsPageRenderKey === nextRenderKey) {
            bindExecuteButtons();
            scheduleCommandsInlineLogRefresh();
            return;
        }
        renderCommandListHTML(el, nextCommands);
        commandsPageRenderKey = nextRenderKey;
        bindExecuteButtons();
        scheduleCommandsInlineLogRefresh();
    }

    function getCommandStateView(status) {
        const stateMap = {
            running: { text: '\u8fd0\u884c\u4e2d', className: 'running' },
            success: { text: '\u5df2\u5b8c\u6210', className: 'success' },
            warning: { text: '\u5df2\u7ec8\u6b62', className: 'warning' },
            error: { text: '\u5f02\u5e38\u9000\u51fa', className: 'error' }
        };
        return stateMap[status] || stateMap.error;
    }

    function isInteractiveCommand(commandCode = '') {
        const cleanCmd = String(commandCode || '').trim().toLowerCase();
        return [
            'openclaw onboard',
            'openclaw configure',
            'openclaw channels add',
            'openclaw channels login',
            'openclaw tui',
            'openclaw onboard --install-daemon'
        ].some(prefix => cleanCmd.startsWith(prefix)) || cleanCmd.includes('models auth login');
    }

    function getLatestCommandsInlineLogSession() {
        const sessions = Array.from(commandSessions.values());
        for (let index = sessions.length - 1; index >= 0; index -= 1) {
            const session = sessions[index];
            if (session?.inlineLogScope === 'commands') {
                return session;
            }
        }
        return null;
    }

    function buildCommandsInlineLogMetaText(session) {
        if (!session) return '';
        const timestamp = new Date(session.lastUpdatedAt || session.startedAt || Date.now())
            .toLocaleString('zh-CN', { hour12: false });
        const stateView = getCommandStateView(session.status);
        return `${session.sourceLabel || '\u6307\u4ee4\u5927\u5168'} - ${stateView.text} - ${timestamp}`;
    }

    const commandsInlineDraftState = {
        sessionId: '',
        value: '',
        focused: false,
        surfaceFocused: false
    };

    function captureCommandsInlineDraft(mount) {
        if (!mount) return;
        const outputSurface = mount.querySelector('.command-inline-terminal-surface');
        const sessionId = mount.querySelector('.command-inline-log-card')?.getAttribute('data-session-id') || '';
        if (!sessionId) return;
        if (commandsInlineDraftState.sessionId && commandsInlineDraftState.sessionId !== sessionId) {
            resetCommandsInlineDraft(sessionId);
        }
        commandsInlineDraftState.sessionId = sessionId;
        commandsInlineDraftState.focused = false;
        commandsInlineDraftState.surfaceFocused = document.activeElement === outputSurface;
    }

    function restoreCommandsInlineDraft(mount, session) {
        if (!mount || !session || commandsInlineDraftState.sessionId !== session.id) return;
        if (commandsInlineDraftState.surfaceFocused) {
            mount.querySelector('.command-inline-terminal-surface')?.focus();
        }
    }

    function resetCommandsInlineDraft(sessionId) {
        commandsInlineDraftState.sessionId = sessionId || commandsInlineDraftState.sessionId || '';
        commandsInlineDraftState.value = '';
        commandsInlineDraftState.focused = false;
        commandsInlineDraftState.surfaceFocused = false;
    }

    function getCommandsInlineDraftValue(sessionId = '') {
        const targetSessionId = String(sessionId || '').trim();
        if (!targetSessionId || commandsInlineDraftState.sessionId !== targetSessionId) {
            return '';
        }
        return String(commandsInlineDraftState.value || '');
    }

    function setCommandsInlineDraftValue(sessionId, value, options = {}) {
        const targetSessionId = String(sessionId || '').trim();
        if (!targetSessionId) return;
        commandsInlineDraftState.sessionId = targetSessionId;
        commandsInlineDraftState.value = String(value || '');
        commandsInlineDraftState.focused = false;
        commandsInlineDraftState.surfaceFocused = options.surfaceFocused !== false;
        scheduleCommandsInlineLogRefresh();
    }

    function appendCommandsInlineDraftValue(sessionId, text) {
        const nextValue = `${getCommandsInlineDraftValue(sessionId)}${String(text || '')}`;
        setCommandsInlineDraftValue(sessionId, nextValue);
    }

    function trimCommandsInlineDraftValue(sessionId, mode = 'backspace') {
        const currentValue = getCommandsInlineDraftValue(sessionId);
        if (!currentValue) return false;
        const nextValue = mode === 'delete'
            ? currentValue.slice(1)
            : currentValue.slice(0, -1);
        setCommandsInlineDraftValue(sessionId, nextValue);
        return true;
    }

    function buildCommandsInlineInteractiveHTML(session) {
        if (!session?.interactive) return '';
        const statusText = session.status === 'running'
            ? '\u70b9\u51fb\u65e5\u5fd7\u533a\u540e\u53ef\u76f4\u63a5\u952e\u5165\u6216\u7c98\u8d34\u5185\u5bb9\uff0c\u65b9\u5411\u952e\u3001Enter\u3001Tab\u3001Esc \u4f1a\u76f4\u63a5\u53d1\u5230\u5f53\u524d\u4ea4\u4e92\u4f1a\u8bdd\uff0cCtrl+C \u53ef\u7ec8\u6b62\u3002'
            : '\u4ea4\u4e92\u4f1a\u8bdd\u5df2\u7ed3\u675f\uff0c\u4e0d\u518d\u63a5\u53d7\u65b0\u8f93\u5165\u3002';
        const draftValue = getCommandsInlineDraftValue(session.id);
        const draftMarkup = session.status === 'running'
            ? `<div class="command-inline-draft ${draftValue ? '' : 'is-empty'}">
                <span class="command-inline-draft-label">\u5f85\u53d1\u9001</span>
                <code class="command-inline-draft-value">${draftValue ? escapeHtml(draftValue) : '\u7a7a'}</code>
            </div>`
            : '';
        return `
            <div class="command-inline-interactive ${session.status === 'running' ? '' : 'is-disabled'}">
                <div class="command-inline-interactive-tip ${session.status === 'running' ? '' : 'is-disabled'}">${statusText}</div>
                ${draftMarkup}
            </div>
        `;
    }

    function appendCommandsInlineEcho(sessionId, text, sensitive = false) {
        const renderedText = String(text || '');
        const normalizedText = renderedText.endsWith('\n') ? renderedText : `${renderedText}\n`;
        const message = sensitive ? '> [\u5df2\u53d1\u9001\u654f\u611f\u5185\u5bb9]\n' : normalizedText;
        appendTerminalLog(message, 'sys', sessionId);
    }

    function sendInlineInteractiveRawText(sessionId, value, options = {}) {
        const textValue = String(value || '');
        if (!textValue) return false;
        commandsInlineDraftState.sessionId = sessionId;
        commandsInlineDraftState.surfaceFocused = true;
        commandsInlineDraftState.focused = false;
        if (options.submit === true) {
            if (!window.api?.sendCommandInput) return false;
            window.api.sendCommandInput(sessionId, textValue, true);
            appendCommandsInlineEcho(sessionId, `> ${textValue}`);
            resetCommandsInlineDraft(sessionId);
            scrollCommandsInlineOutputToLatest(true);
            scheduleCommandsInlineLogRefresh();
            focusCommandsInlineTerminalSurface();
            return true;
        }
        appendCommandsInlineDraftValue(sessionId, textValue);
        focusCommandsInlineTerminalSurface();
        return true;
    }

    function sendInlineInteractiveKey(sessionId, key) {
        if (key === 'ctrlc') {
            window.api?.killCommand?.(sessionId);
            resetCommandsInlineDraft(sessionId);
            scheduleCommandsInlineLogRefresh();
            return true;
        }
        if (!window.api?.sendCommandInput) return false;
        if (key === 'enter') {
            const bufferedValue = getCommandsInlineDraftValue(sessionId);
            if (bufferedValue) {
                return sendInlineInteractiveRawText(sessionId, bufferedValue, { submit: true });
            }
            window.api.sendCommandInput(sessionId, '', true);
            appendCommandsInlineEcho(sessionId, '> [ENTER]');
            scrollCommandsInlineOutputToLatest(true);
            commandsInlineDraftState.sessionId = sessionId;
            commandsInlineDraftState.surfaceFocused = true;
            commandsInlineDraftState.focused = false;
            focusCommandsInlineTerminalSurface();
            return true;
        }
        if (key === 'backspace' || key === 'delete') {
            if (trimCommandsInlineDraftValue(sessionId, key)) {
                focusCommandsInlineTerminalSurface();
                return true;
            }
        }
        if (key === 'space') {
            appendCommandsInlineDraftValue(sessionId, ' ');
            focusCommandsInlineTerminalSurface();
            return true;
        }
        const inputMap = {
            up: '\u001B[A',
            down: '\u001B[B',
            left: '\u001B[D',
            right: '\u001B[C',
            tab: '\t',
            esc: '\u001B',
            backspace: '\u0008',
            delete: '\u007F'
        };
        if (!inputMap[key]) return false;
        window.api.sendCommandInput(sessionId, inputMap[key], false);
        scrollCommandsInlineOutputToLatest(true);
        commandsInlineDraftState.sessionId = sessionId;
        commandsInlineDraftState.surfaceFocused = true;
        commandsInlineDraftState.focused = false;
        focusCommandsInlineTerminalSurface();
        return true;
    }

    function bindCommandsInlineInteraction(mount, session) {
        if (!mount || !session?.interactive) return;
        const outputSurface = mount.querySelector('.command-inline-terminal-surface');
        if (!outputSurface) return;

        outputSurface?.addEventListener('keydown', (event) => {
            const keyMap = {
                ArrowUp: 'up',
                ArrowDown: 'down',
                ArrowLeft: 'left',
                ArrowRight: 'right',
                Enter: 'enter',
                Tab: 'tab',
                ' ': 'space',
                Spacebar: 'space',
                Escape: 'esc',
                Backspace: 'backspace',
                Delete: 'delete'
            };
            let mappedKey = keyMap[event.key];
            if ((event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 'c') {
                mappedKey = 'ctrlc';
            }
            const isPlainTextKey = !mappedKey && !event.ctrlKey && !event.metaKey && !event.altKey && String(event.key || '').length === 1;
            if (!mappedKey && !isPlainTextKey) return;
            event.preventDefault();
            event.stopPropagation();
            commandsInlineDraftState.sessionId = session.id;
            commandsInlineDraftState.surfaceFocused = true;
            commandsInlineDraftState.focused = false;
            if (isPlainTextKey) {
                sendInlineInteractiveRawText(session.id, event.key, { submit: false });
                return;
            }
            sendInlineInteractiveKey(session.id, mappedKey);
        });

        outputSurface?.addEventListener('paste', (event) => {
            const pastedText = event.clipboardData?.getData('text') || '';
            if (!pastedText) return;
            event.preventDefault();
            event.stopPropagation();
            commandsInlineDraftState.sessionId = session.id;
            commandsInlineDraftState.surfaceFocused = true;
            commandsInlineDraftState.focused = false;
            sendInlineInteractiveRawText(session.id, pastedText, { submit: false });
        });

        outputSurface?.addEventListener('focus', () => {
            commandsInlineDraftState.sessionId = session.id;
            commandsInlineDraftState.surfaceFocused = true;
            commandsInlineDraftState.focused = false;
        });
    }

    function renderCommandsInlineLog() {
        const mount = document.getElementById('commandsInlineLogMount');
        if (!mount) return;
        captureCommandsInlineDraft(mount);

        const session = getLatestCommandsInlineLogSession();
        if (!session) {
            mount.innerHTML = '';
            mount.style.display = 'none';
            return;
        }

        const stateView = getCommandStateView(session.status);
        mount.style.display = 'block';
        mount.innerHTML = `
            <section class="command-inline-log-card" data-session-id="${escapeHtml(session.id)}">
                <div class="command-inline-log-head">
                    <div>
                        <div class="command-inline-log-title">\u6267\u884c\u65e5\u5fd7 - ${escapeHtml(session.title || session.commandCode || '\u6307\u4ee4\u5927\u5168')}</div>
                        <div class="command-inline-log-meta">${escapeHtml(buildCommandsInlineLogMetaText(session))}</div>
                    </div>
                    <span class="command-session-state ${stateView.className}">${stateView.text}</span>
                </div>
                ${session.interactive ? '' : `<div class="command-inline-log-command">${escapeHtml(session.commandCode || '')}</div>`}
                <pre class="command-inline-log-output ${session.interactive ? 'command-inline-terminal-surface' : ''}" ${session.interactive ? 'tabindex="0"' : ''}></pre>
                ${buildCommandsInlineInteractiveHTML(session)}
            </section>
        `;

        const outputEl = mount.querySelector('.command-inline-log-output');
        if (outputEl) {
            outputEl.textContent = session.logText || '\u7b49\u5f85\u65e5\u5fd7\u8f93\u51fa...';
        }
        restoreCommandsInlineDraft(mount, session);
        bindCommandsInlineInteraction(mount, session);
        scrollCommandsInlineOutputToLatest(true);
    }

    function scheduleCommandsInlineLogRefresh() {
        if (currentPage !== 'commands') return;
        if (commandsInlineLogRefreshScheduled) return;
        commandsInlineLogRefreshScheduled = true;
        scheduleUiFlush(() => {
            commandsInlineLogRefreshScheduled = false;
            if (currentPage !== 'commands') return;
            renderCommandsInlineLog();
        });
    }

    function focusCommandsInlineLog() {
        scheduleUiFlush(() => {
            if (currentPage !== 'commands') return;
            const mount = document.getElementById('commandsInlineLogMount');
            if (!mount) return;
            renderCommandsInlineLog();
            if (mount.style.display === 'none' || !mount.innerHTML.trim()) return;
            mount.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    function focusCommandsInlineTerminalSurface() {
        scheduleUiFlush(() => {
            if (currentPage !== 'commands') return;
            setTimeout(() => {
                if (currentPage !== 'commands') return;
                const surface = document.querySelector('#commandsInlineLogMount .command-inline-terminal-surface');
                if (surface?.focus) {
                    commandsInlineDraftState.surfaceFocused = true;
                    commandsInlineDraftState.focused = false;
                    surface.focus();
                }
            }, 0);
        });
    }

    function scrollCommandsInlineOutputToLatest(force = false) {
        const outputEl = document.querySelector('#commandsInlineLogMount .command-inline-log-output');
        if (!outputEl) return;
        const nearBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 48;
        if (force || nearBottom) {
            outputEl.scrollTop = outputEl.scrollHeight;
        }
    }

    function getRunningCommandsInlineInteractiveSession(exceptId = '') {
        const sessions = Array.from(commandSessions.values());
        for (let index = sessions.length - 1; index >= 0; index -= 1) {
            const session = sessions[index];
            if (!session || session.id === exceptId) continue;
            if (session.inlineLogScope !== 'commands') continue;
            if (!session.interactive) continue;
            if (session.status !== 'running') continue;
            return session;
        }
        return null;
    }

    async function dismissRunningCommandsInlineInteractiveSession(exceptId = '') {
        const activeSession = getRunningCommandsInlineInteractiveSession(exceptId);
        if (!activeSession || !window.api?.killCommand) return;
appendTerminalLog('[指令大全] 已自动退出当前交互会话，准备执行新的命令。\n', 'sys', activeSession.id);
        window.api.killCommand(activeSession.id);
        resetCommandsInlineDraft(activeSession.id);
        await new Promise(resolve => setTimeout(resolve, 180));
    }

    function getVisibleCommandsPageItems() {
        const filteredCommands = getFilteredCommands();
        const defaultCategoryTab = categories[0];
        if (searchQuery) {
            return filteredCommands;
        }
        if (currentCategoryTab === '全部') {
            return filteredCommands;
        }
        if (!categories.includes(currentCategoryTab)) {
            return filteredCommands;
        }
        return filteredCommands.filter(c => {
            if (currentCategoryTab === defaultCategoryTab) {
                return !c.tags.some(t => categories.includes(t)) || c.tags.includes(defaultCategoryTab);
            }
            return c.tags.includes(currentCategoryTab);
        });
    }

    const paramModalOverlay = document.getElementById('paramModalOverlay');
    const paramModalDesc = document.getElementById('paramModalDesc');
    const paramModalInput = document.getElementById('paramModalInput');
    const paramQuickSelectArea = document.getElementById('paramQuickSelectArea');
    const paramQuickTags = document.getElementById('paramQuickTags');
    const paramBtnCancel = document.getElementById('paramBtnCancel');
    const paramBtnConfirm = document.getElementById('paramBtnConfirm');
    
    // 指令大全分类 Tab
    let currentCategoryTab = '全部';
    const categories = ['通用', '配置', '模型', '网关', '通道', '扩展', 'Agent', '聊天命令'];

    // 一次性初始化所有视图容器，避免销毁 WebView
    function initViewsOnce() {
        viewContainer.innerHTML = `
            <div id="view-dashboard" class="page-view" style="display:none; width:100%; height:100%;"></div>
            <div id="view-commands" class="page-view" style="display:none; width:100%; height:100%;"></div>
            <div id="view-models" class="page-view" style="display:none; width:100%; height:100%;overflow-y:auto;"></div>
            <div id="view-channels" class="page-view" style="display:none; width:100%; height:100%;overflow-y:auto;"></div>
            <div id="view-memory" class="page-view" style="display:none; width:100%; height:100%;overflow-y:auto;"></div>
            <div id="view-cron" class="page-view" style="display:none; width:100%; height:100%;overflow-y:auto;"></div>
            <div id="view-usage" class="page-view" style="display:none; width:100%; height:100%;overflow-y:auto;"></div>
            <div id="view-logs" class="page-view" style="display:none; width:100%; height:100%;overflow-y:auto;"></div>
            <div id="view-gateway" class="page-view" style="display:none; width:100%; height:100%;overflow-y:auto;"></div>
            <div id="view-agents" class="page-view" style="display:none; width:100%; height:100%;overflow-y:auto;"></div>
            <div id="view-chat" class="page-view" style="display:none; width:100%; height:100%; padding:0; overflow:hidden;">
                <!-- 占位，稍后动态挂载带有极客安全机制的 WebView -->
            </div>
            <div id="view-settings" class="page-view" style="display:none; width:100%; height:100%;overflow-y:auto;"></div>
        `;
    }


    function renderChatBootstrapShell(kind = 'loading') {
        if (kind === 'error') {
            return `
                <div class="chat-shell-state is-error">
                    <div class="chat-shell-error-title">智能对话初始化失败</div>
                    <div class="chat-shell-detail">请稍后重试，或先检查首页中的网关与聊天服务是否已经启动。</div>
                </div>
            `;
        }

        return `
            <div id="chatBootstrapLoading" class="chat-shell-state">
                <div class="chat-shell-spinner"></div>
                <div class="chat-shell-title">正在初始化智能对话</div>
                <div class="chat-shell-meta">首次进入会先挂载安全 WebView 和会话桥接。</div>
            </div>
        `;
    }

    function renderChatWebviewShell(displayChatUrl, chatUrl, preloadAttr) {
        const safeAttr = (value) => String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        return `
            <div id="webviewLoading" class="chat-shell-state">
                <div class="chat-shell-spinner"></div>
                <div class="chat-shell-title">正在连接智能对话</div>
                <div class="chat-shell-meta"><code>${escapeHtml(displayChatUrl)}</code></div>
            </div>
            <div id="webviewError" class="chat-shell-state is-error" style="display:none;">
                <div class="chat-shell-error-title">无法连接到智能对话服务</div>
                <p class="chat-shell-detail">当前配置地址：<code id="webviewErrorUrl">${safeAttr(displayChatUrl)}</code></p>
                <p id="webviewErrorDetail" class="chat-shell-detail">请确认首页显示网关在线，或者检查 Gateway Token 与端口配置。</p>
                <div class="chat-shell-hint-card">
                    <p class="chat-shell-hint-title">诊断建议</p>
                    <ul class="chat-shell-hint-list">
                        <li>先回到首页确认网关是否在线。</li>
                        <li>如果网关在线但这里仍然空白，通常是 Token 注入失败或聊天前端启动过早。</li>
                        <li>点击“重新尝试连接”后，工具会重新注入 Token 并刷新聊天页。</li>
                    </ul>
                </div>
                <button id="retryWebviewBtn" class="chat-shell-retry-btn">重新尝试连接</button>
            </div>
            <webview id="chatWebview" src="${safeAttr(chatUrl)}" ${preloadAttr} style="display:none; width:100%; height:100%; border:none; border-radius:12px; background-color:#1e1e24;"></webview>
        `;
    }

    async function initWebviewSecured() {
        const chatView = document.getElementById('view-chat');
        if (!chatView) return;
        if (document.getElementById('chatWebview')) {
            chatWebviewInitialized = true;
            return;
        }

        const escapeAttr = (value) => String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        const resolveChatBootstrap = async () => {
            let nextBootstrap = {
                url: 'http://127.0.0.1:18789',
                token: '',
                preloadUrl: ''
            };

            try {
                if (window.api?.getChatBootstrap) {
                    nextBootstrap = {
                        ...nextBootstrap,
                        ...(await window.api.getChatBootstrap())
                    };
                    if (!String(nextBootstrap?.token || '').trim() && window.api?.getOpenClawToken) {
                        nextBootstrap.token = await window.api.getOpenClawToken();
                    }
                } else {
                    let appPath = '';
                    let config = null;
                    if (window.api?.getAppPath) {
                        appPath = await window.api.getAppPath();
                    }
                    if (window.api?.getOpenClawConfig) {
                        config = await window.api.getOpenClawConfig();
                    }
                    if (window.api?.getOpenClawToken) {
                        nextBootstrap.token = await window.api.getOpenClawToken();
                    }

                    const gatewayMode = String(config?.gateway?.mode || '').trim().toLowerCase();
                    const remoteUrl = String(config?.gateway?.remote?.url || '').trim().replace(/\/+$/, '');
                    const gatewayPort = Number.parseInt(String(config?.gateway?.port ?? ''), 10);
                    if (gatewayMode === 'remote' && remoteUrl) {
                        nextBootstrap.url = /^wss?:\/\//i.test(remoteUrl)
                            ? remoteUrl.replace(/^ws/i, 'http')
                            : remoteUrl;
                    } else if (Number.isInteger(gatewayPort) && gatewayPort > 0) {
                        nextBootstrap.url = `http://127.0.0.1:${gatewayPort}`;
                    }

                    if (appPath) {
                        nextBootstrap.preloadUrl = `file:///${appPath.replace(/\\/g, '/')}/webview-preload.js`;
                    }
                }
            } catch (error) {
                console.error('[Chat] Failed to resolve chat bootstrap:', error);
            }

            return nextBootstrap;
        };

        const normalizeChatBootstrap = (sourceBootstrap) => {
            const nextRawChatUrl = String(sourceBootstrap?.url || 'http://127.0.0.1:18789').trim() || 'http://127.0.0.1:18789';
            const nextAuthToken = String(sourceBootstrap?.token || '').trim();
            const nextChatUrl = (() => {
                if (!nextAuthToken) return nextRawChatUrl;
                try {
                    const parsed = new URL(nextRawChatUrl);
                    if (parsed.searchParams.get('token') !== nextAuthToken) {
                        parsed.searchParams.set('token', nextAuthToken);
                    }
                    return parsed.toString();
                } catch (_) {
                    return nextRawChatUrl;
                }
            })();
            const nextPreloadUrl = String(sourceBootstrap?.preloadUrl || '').trim();
            const nextDisplayChatUrl = (() => {
                try {
                    const parsed = new URL(nextChatUrl);
                    if (parsed.searchParams.has('token')) {
                        parsed.searchParams.set('token', '***');
                    }
                    return parsed.toString();
                } catch (_) {
                    return nextChatUrl.replace(/([?&]token=)[^&#]*/i, '$1***');
                }
            })();

            return {
                rawChatUrl: nextRawChatUrl,
                authToken: nextAuthToken,
                chatUrl: nextChatUrl,
                preloadUrl: nextPreloadUrl,
                displayChatUrl: nextDisplayChatUrl
            };
        };

        let bootstrap = await resolveChatBootstrap();
        let { rawChatUrl, authToken, chatUrl, preloadUrl, displayChatUrl } = normalizeChatBootstrap(bootstrap);
        const preloadAttr = preloadUrl ? `preload="${escapeAttr(preloadUrl)}"` : '';

        chatView.innerHTML = `
            <div id="webviewLoading" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#8b8b93; background-color:#1e1e24; border-radius:12px; gap:10px;">
                <div style="width:28px;height:28px;border:3px solid rgba(120,220,232,0.2);border-top-color:#78dce8;border-radius:50%;animation:spin 0.9s linear infinite;"></div>
                <div style="font-size:15px;color:#e7edf7;">正在连接智能对话...</div>
                <div style="font-size:12px;color:#8b8b93;"><code>${escapeAttr(displayChatUrl)}</code></div>
            </div>
            <div id="webviewError" style="display:none; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#8b8b93; background-color:#1e1e24; border-radius:12px;">
                <h2 style="color:#ff6188; margin-bottom: 16px;">无法连接到智能对话服务</h2>
                <p>当前配置地址: <code id="webviewErrorUrl">${escapeAttr(displayChatUrl)}</code></p>
                <p id="webviewErrorDetail" style="margin-top:8px;color:#b8c0d4;font-size:13px;max-width:640px;text-align:center;line-height:1.7;">请先确认首页显示网关在线，或检查 Gateway Token 与端口配置。</p>
                <div style="margin-top: 24px; padding: 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 8px;">
                    <p style="font-size: 0.95rem; font-weight: 600; color: #e0e0e0; margin-bottom: 8px;">诊断建议：</p>
                    <ul style="font-size: 0.85rem; text-align: left; list-style-type: disc; padding-left: 20px; line-height: 1.6;">
                        <li>先到“首页”确认网关状态是否在线。</li>
                        <li>如果网关在线但页面仍然空白，通常是 Token 未注入成功，或 Control UI 初次加载过早。</li>
                        <li>点击“重新尝试连接”后，工具会重新写入 Token 并刷新智能对话页。</li>
                    </ul>
                </div>
                <button id="retryWebviewBtn" style="margin-top: 30px; padding: 10px 20px; background: transparent; border: 1px solid #78dce8; color: #78dce8; font-weight: 600; border-radius: 8px; cursor: pointer; transition: all 0.2s;">重新尝试连接</button>
            </div>
            <webview id="chatWebview" src="${escapeAttr(chatUrl)}" ${preloadAttr} style="display:none; width:100%; height:100%; border:none; border-radius:12px; background-color:#1e1e24;"></webview>
        `;

        chatView.innerHTML = renderChatWebviewShell(displayChatUrl, chatUrl, preloadAttr);

        const webview = document.getElementById('chatWebview');
        const webviewError = document.getElementById('webviewError');
        const webviewLoading = document.getElementById('webviewLoading');
        const webviewErrorUrl = document.getElementById('webviewErrorUrl');
        const webviewErrorDetail = document.getElementById('webviewErrorDetail');
        let retryBtn = document.getElementById('retryWebviewBtn');

        let loadTimer = null;
        let tokenPrimed = false;
        let lastMainFrameFailed = false;
        let lastFailureDetail = '';
        let lastResolvedBootstrapKey = `${chatUrl}::${authToken}`;
        let lastResolvedBootstrapRuntimeKey = `${rawChatUrl}::${preloadUrl}`;
        let chatWebviewReadyOnce = false;
        let chatWebviewExpectingReload = true;
        let chatWebviewSilentRefresh = false;
        let chatGatewayOfflineHint = '';

        const clearLoadTimer = () => {
            if (loadTimer) {
                clearTimeout(loadTimer);
                loadTimer = null;
            }
        };

        const startLoadTimer = () => {
            clearLoadTimer();
            loadTimer = setTimeout(() => {
                setWebviewState('error', `连接 ${chatUrl} 超时，请确认 Gateway 在线且该地址可访问。`);
            }, 12000);
        };

        const setWebviewState = (state, detail = '') => {
            if (webviewLoading) {
                webviewLoading.style.display = state === 'loading' ? 'flex' : 'none';
            }
            if (webviewError) {
                webviewError.style.display = state === 'error' ? 'flex' : 'none';
            }
            if (webview) {
                webview.style.display = state === 'ready' ? 'flex' : 'none';
            }
            if (webviewErrorUrl) {
                webviewErrorUrl.innerText = displayChatUrl;
            }
            if (detail && webviewErrorDetail) {
                webviewErrorDetail.innerText = detail;
            }
        };

        const probeChatGatewayReachability = async () => {
            if (!window.api?.getDashboardGatewayStatus) {
                return { shouldDefer: false, detail: '' };
            }

            try {
                const status = await window.api.getDashboardGatewayStatus({ mode: 'official', fast: true });
                if (status?.online === false && status?.confident === true) {
                    const detail = String(status.detail || status.statusText || '').trim()
                        || `当前无法连接 ${displayChatUrl}`;
                    return {
                        shouldDefer: true,
                        detail
                    };
                }
            } catch (_) {}

            return { shouldDefer: false, detail: '' };
        };

        const buildTokenizedUrl = (candidateUrl = '') => {
            const fallbackUrl = String(candidateUrl || chatUrl || rawChatUrl || '').trim();
            if (!authToken) return fallbackUrl;
            try {
                const parsed = new URL(fallbackUrl);
                if (parsed.searchParams.get('token') !== authToken) {
                    parsed.searchParams.set('token', authToken);
                }
                return parsed.toString();
            } catch (_) {
                return fallbackUrl;
            }
        };

        const applyResolvedBootstrap = (nextBootstrap) => {
            bootstrap = nextBootstrap;
            const normalized = normalizeChatBootstrap(nextBootstrap);
            rawChatUrl = normalized.rawChatUrl;
            authToken = normalized.authToken;
            chatUrl = normalized.chatUrl;
            preloadUrl = normalized.preloadUrl;
            displayChatUrl = normalized.displayChatUrl;
            lastResolvedBootstrapKey = `${chatUrl}::${authToken}`;
            lastResolvedBootstrapRuntimeKey = `${rawChatUrl}::${preloadUrl}`;

            if (preloadUrl) {
                webview.setAttribute('preload', preloadUrl);
            } else {
                webview.removeAttribute('preload');
            }

            if (webviewErrorUrl) {
                webviewErrorUrl.innerText = displayChatUrl;
            }
        };

        const retargetChatWebview = ({ candidateUrl = '', reloadIfSame = false } = {}) => {
            const targetUrl = buildTokenizedUrl(candidateUrl || chatUrl);
            const currentSrc = String(webview.getAttribute('src') || '').trim();

            if (!targetUrl) {
                return false;
            }

            if (currentSrc !== targetUrl) {
                webview.setAttribute('src', targetUrl);
                return true;
            }

            if (reloadIfSame) {
                webview.reload();
                return true;
            }

            return false;
        };

        const deferChatWebviewLoad = (detail = '') => {
            chatGatewayOfflineHint = String(detail || '').trim();
            chatWebviewExpectingReload = false;
            clearLoadTimer();
            if (String(webview.getAttribute('src') || '').trim() !== 'about:blank') {
                webview.setAttribute('src', 'about:blank');
            }
            setWebviewState('error', chatGatewayOfflineHint || `当前无法连接 ${displayChatUrl}`);
            return false;
        };

        const getUrlOrigin = (value = '') => {
            try {
                return new URL(String(value || '').trim()).origin;
            } catch (_) {
                return '';
            }
        };

        const getUrlToken = (value = '') => {
            try {
                return new URL(String(value || '').trim()).searchParams.get('token') || '';
            } catch (_) {
                return '';
            }
        };

        const getUrlPathname = (value = '') => {
            try {
                return new URL(String(value || '').trim()).pathname || '/';
            } catch (_) {
                return '';
            }
        };

        const hasNonTokenSearchParams = (value = '') => {
            try {
                const parsed = new URL(String(value || '').trim());
                for (const key of parsed.searchParams.keys()) {
                    if (String(key || '').trim().toLowerCase() !== 'token') {
                        return true;
                    }
                }
                return false;
            } catch (_) {
                return false;
            }
        };

        const ensureLiveWebviewTokenizedUrl = () => {
            if (!authToken) return false;
            const currentUrl = typeof webview.getURL === 'function'
                ? String(webview.getURL() || '').trim()
                : '';
            const currentSrc = String(webview.getAttribute('src') || '').trim();
            const liveUrl = currentUrl || currentSrc;
            if (!liveUrl || /^chrome-error:\/\//i.test(liveUrl)) {
                return false;
            }

            const expectedOrigin = getUrlOrigin(chatUrl || rawChatUrl);
            const liveOrigin = getUrlOrigin(liveUrl);
            if (!expectedOrigin || !liveOrigin || expectedOrigin !== liveOrigin) {
                return false;
            }

            const expectedPathname = getUrlPathname(chatUrl || rawChatUrl);
            const livePathname = getUrlPathname(liveUrl);
            if (!expectedPathname || !livePathname || expectedPathname !== livePathname) {
                return false;
            }

            if (hasNonTokenSearchParams(liveUrl)) {
                return false;
            }

            if (getUrlToken(liveUrl) === authToken) {
                return false;
            }

            chatWebviewExpectingReload = true;
            chatWebviewSilentRefresh = chatWebviewReadyOnce && !lastMainFrameFailed;
            if (chatWebviewSilentRefresh) {
                clearLoadTimer();
                setWebviewState('ready');
            } else {
                setWebviewState('loading');
                startLoadTimer();
                retryBtn.innerText = '正在连接...';
            }

            return retargetChatWebview({
                candidateUrl: liveUrl,
                reloadIfSame: true
            });
        };

        const primeTokenAndMaybeReload = async () => {
            if (!authToken) return false;
            const currentUrl = typeof webview.getURL === 'function' ? String(webview.getURL() || '') : '';
            if (/^chrome-error:\/\//i.test(currentUrl)) {
                return false;
            }
            const safeToken = JSON.stringify(authToken);
            try {
                const result = await webview.executeJavaScript(`
                    (function() {
                        var token = ${safeToken};
                        var changed = false;
                        var keys = ['openclaw_auth_token', 'auth_token', 'token', 'gateway_token', 'gatewayToken'];
                        [window.localStorage, window.sessionStorage].forEach(function(store) {
                            if (!store) return;
                            keys.forEach(function(key) {
                                try {
                                    if (store.getItem(key) !== token) {
                                        store.setItem(key, token);
                                        changed = true;
                                    }
                                } catch (_) {}
                            });
                        });
                        return { changed: changed };
                    })();
                `, true);

                if (result?.changed && !tokenPrimed) {
                    tokenPrimed = true;
                    startLoadTimer();
                    webview.reload();
                    return true;
                }
            } catch (error) {
                console.error('Webview Autologin Failed:', error);
            }
            return false;
        };

        const refreshChatWebviewConnection = async ({ forceReload = false } = {}) => {
            const latestBootstrap = await resolveChatBootstrap();
            applyResolvedBootstrap(latestBootstrap);
            tokenPrimed = false;
            lastMainFrameFailed = false;
            lastFailureDetail = '';
            chatWebviewExpectingReload = true;
            chatWebviewSilentRefresh = false;
            const reachability = await probeChatGatewayReachability();
            if (reachability.shouldDefer) {
                return deferChatWebviewLoad(reachability.detail);
            }
            setWebviewState('loading');
            startLoadTimer();

            const retargeted = retargetChatWebview({ reloadIfSame: forceReload });
            if (!retargeted && forceReload) {
                webview.reload();
            }
            return true;
        };

        const syncChatWebviewBootstrap = async ({ keepVisible = false } = {}) => {
            const previousBootstrapRuntimeKey = lastResolvedBootstrapRuntimeKey;
            const latestBootstrap = await resolveChatBootstrap();
            applyResolvedBootstrap(latestBootstrap);
            const reachability = await probeChatGatewayReachability();

            const currentSrc = String(webview.getAttribute('src') || '').trim();
            const currentUrl = typeof webview.getURL === 'function'
                ? String(webview.getURL() || '').trim()
                : currentSrc;
            const expectedOrigin = getUrlOrigin(chatUrl || rawChatUrl);
            const currentSrcOrigin = getUrlOrigin(currentSrc);
            const currentUrlOrigin = getUrlOrigin(currentUrl);
            const srcNeedsRepair = !!currentSrc && !!expectedOrigin && currentSrcOrigin !== expectedOrigin;
            const liveUrlNeedsRepair = !!currentUrl && !/^chrome-error:\/\//i.test(currentUrl) && !!expectedOrigin && currentUrlOrigin !== expectedOrigin;
            const bootstrapChanged = previousBootstrapRuntimeKey !== lastResolvedBootstrapRuntimeKey;

            if (reachability.shouldDefer && !chatWebviewReadyOnce) {
                return deferChatWebviewLoad(reachability.detail);
            }

            if (keepVisible && chatWebviewReadyOnce && !lastMainFrameFailed && !bootstrapChanged && !srcNeedsRepair && !liveUrlNeedsRepair) {
                return false;
            }

            if (!currentSrc || /^chrome-error:\/\//i.test(currentUrl) || srcNeedsRepair || liveUrlNeedsRepair || bootstrapChanged) {
                tokenPrimed = false;
                retryBtn.innerText = '正在连接...';
                lastMainFrameFailed = false;
                lastFailureDetail = '';
                chatWebviewExpectingReload = true;
                chatWebviewSilentRefresh = Boolean(keepVisible && chatWebviewReadyOnce);
                if (chatWebviewSilentRefresh) {
                    clearLoadTimer();
                    setWebviewState('ready');
                } else {
                    setWebviewState('loading');
                    startLoadTimer();
                }
                retargetChatWebview({
                    candidateUrl: currentUrl || currentSrc || chatUrl,
                    reloadIfSame: true
                });
                return true;
            }

            return false;
        };

        const resumeChatWebviewView = async () => {
            if (chatWebviewReadyOnce && !lastMainFrameFailed) {
                clearLoadTimer();
                setWebviewState('ready');
            } else if (lastMainFrameFailed) {
                setWebviewState('error', lastFailureDetail || `无法加载 ${chatUrl}`);
            } else {
                setWebviewState('loading');
            }

            const now = Date.now();
            const shouldSync = lastMainFrameFailed
                || !chatWebviewReadyOnce
                || (now - chatWebviewLastResumeSyncAt) > 2500;

            if (!shouldSync) {
                return false;
            }

            chatWebviewLastResumeSyncAt = now;
            return syncChatWebviewBootstrap({
                keepVisible: chatWebviewReadyOnce && !lastMainFrameFailed
            });
        };

        const handleChatNavigation = async (event) => {
            const navigatedUrl = String(event?.url || '').trim();
            if (!navigatedUrl || /^chrome-error:\/\//i.test(navigatedUrl)) {
                return;
            }

            clearLoadTimer();
            if (chatWebviewReadyOnce && !lastMainFrameFailed) {
                setWebviewState('ready');
            }
            if (ensureLiveWebviewTokenizedUrl()) {
                return;
            }
            await primeTokenAndMaybeReload();
        };

        if (retryBtn) {
            retryBtn.addEventListener('click', () => {
                tokenPrimed = false;
                retryBtn.innerText = '正在连接...';
                setWebviewState('loading');
                startLoadTimer();
                webview.reload();
                setTimeout(() => { retryBtn.innerText = '重新尝试连接'; }, 1000);
            });
        }

        if (retryBtn) {
            const reboundRetryBtn = retryBtn.cloneNode(true);
            retryBtn.replaceWith(reboundRetryBtn);
            retryBtn = reboundRetryBtn;
            retryBtn.innerText = '重新尝试连接';
            retryBtn.addEventListener('click', async () => {
                retryBtn.innerText = '正在连接...';
                try {
                    await refreshChatWebviewConnection({ forceReload: true });
                } catch (error) {
                    clearLoadTimer();
                    setWebviewState('error', `重新连接失败: ${error?.message || error}`);
                } finally {
                    setTimeout(() => { retryBtn.innerText = '重新尝试连接'; }, 1000);
                }
            });
        }

        setWebviewState('loading');
        const initialReachability = await probeChatGatewayReachability();
        if (initialReachability.shouldDefer) {
            deferChatWebviewLoad(initialReachability.detail);
            chatWebviewInitialized = true;
            window.__openclawChatWebviewBridge = {
                refresh: refreshChatWebviewConnection,
                sync: syncChatWebviewBootstrap,
                resume: resumeChatWebviewView
            };
            return;
        }
        startLoadTimer();

        webview.addEventListener('did-start-loading', () => {
            lastMainFrameFailed = false;
            lastFailureDetail = '';
            if (chatWebviewExpectingReload || !chatWebviewReadyOnce) {
                if (chatWebviewSilentRefresh && chatWebviewReadyOnce) {
                    clearLoadTimer();
                    setWebviewState('ready');
                } else {
                    setWebviewState('loading');
                    startLoadTimer();
                }
            } else {
                setWebviewState('loading');
                startLoadTimer();
            }
            chatWebviewExpectingReload = false;
        });

        webview.addEventListener('did-fail-load', (e) => {
            if (e.isMainFrame && e.errorCode < 0) {
                lastMainFrameFailed = true;
                lastFailureDetail = `${e.validatedURL || chatUrl} 连接失败: ${e.errorDescription || e.errorCode}`;
                clearLoadTimer();
                setWebviewState('error', lastFailureDetail);
            }
        });

        webview.addEventListener('did-finish-load', async () => {
            const currentUrl = typeof webview.getURL === 'function' ? String(webview.getURL() || '') : '';
            clearLoadTimer();
            if (lastMainFrameFailed || /^chrome-error:\/\//i.test(currentUrl)) {
                setWebviewState('error', lastFailureDetail || `无法加载 ${chatUrl}`);
                return;
            }
            if (ensureLiveWebviewTokenizedUrl()) {
                return;
            }
            const reloaded = await primeTokenAndMaybeReload();
            if (reloaded) return;
            chatWebviewReadyOnce = true;
            chatWebviewSilentRefresh = false;
            setWebviewState('ready');
        });

        webview.addEventListener('render-process-gone', (event) => {
            clearLoadTimer();
            setWebviewState('error', `智能对话渲染进程已退出: ${event.reason || 'unknown'}`);
        });

        webview.addEventListener('did-navigate', handleChatNavigation);
        webview.addEventListener('did-navigate-in-page', handleChatNavigation);

        webview.addEventListener('console-message', (event) => {
            const message = String(event.message || '');
            if (/token_missing|unauthorized|device identity required/i.test(message)) {
                setWebviewState('error', `智能对话鉴权失败: ${message}`);
            }
        });

        webview.addEventListener('ipc-message', (event) => {
            if (event.channel === 'open-spotlight') {
                toggleSpotlight(true);
                spotlightInput.value = '/';
            }
        });

        chatWebviewInitialized = true;
        window.__openclawChatWebviewBridge = {
            refresh: refreshChatWebviewConnection,
            sync: syncChatWebviewBootstrap,
            resume: resumeChatWebviewView
        };

    }

    function parkChatViewOffscreen() {
        const chatView = document.getElementById('view-chat');
        if (!chatView || !chatWebviewInitialized) return;
        chatView.style.display = 'block';
        chatView.style.position = 'absolute';
        chatView.style.inset = '0';
        chatView.style.visibility = 'hidden';
        chatView.style.pointerEvents = 'none';
        chatView.style.opacity = '0';
        chatView.style.transform = 'translate3d(-200vw, 0, 0)';
        chatView.style.zIndex = '-1';
    }

    function activateChatView() {
        const chatView = document.getElementById('view-chat');
        if (!chatView) return;
        chatView.style.display = 'block';
        chatView.style.position = '';
        chatView.style.inset = '';
        chatView.style.visibility = 'visible';
        chatView.style.pointerEvents = 'auto';
        chatView.style.opacity = '1';
        chatView.style.transform = '';
        chatView.style.zIndex = '';
    }

    // --- 椤甸潰璺敱涓庡眬閮ㄦ覆鏌?---
    function renderPage() {
        const renderTicket = ++pageRenderTicket;
        syncNavState();
        viewContainer.dataset.page = currentPage;
        if (currentPage !== 'logs' && window.__openclawLogTimer) {
            clearInterval(window.__openclawLogTimer);
            window.__openclawLogTimer = null;
        }
        if (currentPage !== 'dashboard' && window.__openclawDashboardLogTimer) {
            clearInterval(window.__openclawDashboardLogTimer);
            window.__openclawDashboardLogTimer = null;
        }
        if (currentPage !== 'dashboard' && window.__openclawDashboardStatusTimer) {
            clearInterval(window.__openclawDashboardStatusTimer);
            window.__openclawDashboardStatusTimer = null;
        }
        if (currentPage !== 'dashboard' && window.api?.stopDashboardLogFollow) {
            window.api.stopDashboardLogFollow();
            window.__openclawRefreshDashboardStatus = null;
        }
        if (currentPage !== 'dashboard') {
            cancelPendingDashboardRender();
            clearDashboardLifecycleStatusFollowUp();
            clearDashboardResumeWork();
        }
        if (currentPage !== 'cron') {
            document.getElementById('view-cron')?.__openclawCleanupCronPage?.();
        }
        if (previousPage && previousPage !== currentPage) {
            hideInactivePageView(previousPage);
        }
        scheduleDeferredPageCleanup(renderTicket);

        const runDeferredRender = (pageName, task, options = {}) => {
            const delayMs = Number.isFinite(options?.delayMs) ? Number(options.delayMs) : 0;
            scheduleUiFlush(() => {
                if (renderTicket !== pageRenderTicket) return;
                if (currentPage !== pageName) return;
                task();
            }, delayMs);
        };

        // 鏍规嵁璺敱浠呮洿鏂?鏄剧ず褰撳墠瑙嗗浘
        if (currentPage === 'dashboard') {
            topBarSearch.style.display = 'none';
            const el = document.getElementById('view-dashboard');
            el.style.display = 'block';
            const shouldReuseDashboard = el.dataset.dashboardMounted === '1' && el.dataset.dashboardMode === dashboardStartMode;
            if (!shouldReuseDashboard) {
                renderDashboardLoadingShell(el);
            }
            const dashboardRenderToken = ++pendingDashboardRenderToken;
            if (shouldReuseDashboard) {
                runDeferredRender('dashboard', () => {
                    if (dashboardRenderToken !== pendingDashboardRenderToken) return;
                    if (typeof window.__openclawResumeDashboard === 'function') {
                        window.__openclawResumeDashboard();
                        return;
                    }
                    renderDashboardHTMLV2(el, { renderToken: dashboardRenderToken });
                }, { delayMs: 0 });
            } else {
                runDeferredRender('dashboard', () => {
                    if (dashboardRenderToken !== pendingDashboardRenderToken) return;
                    renderDashboardHTMLV2(el, { renderToken: dashboardRenderToken });
                }, { delayMs: 0 });
            }
        } else if (currentPage === 'commands') {
            topBarSearch.style.display = 'flex';
            const el = document.getElementById('view-commands');
            el.style.display = 'block';
            runDeferredRender('commands', () => {
                refreshCommandsPage();
                return;
                const filteredCommands = getFilteredCommands();
                let tabFiltered = filteredCommands;
                if (searchQuery) {
                    tabFiltered = filteredCommands;
                } else if (currentCategoryTab !== '全部') {
                    tabFiltered = filteredCommands.filter(c => {
                        if (currentCategoryTab === '閫氱敤') return !c.tags.some(t => categories.includes(t)) || c.tags.includes('閫氱敤');
                        return c.tags.includes(currentCategoryTab);
                    });
                }
                const nextRenderKey = JSON.stringify({
                    query: searchQuery,
                    category: currentCategoryTab,
                    ids: tabFiltered.map((cmd) => cmd.id)
                });
                if (commandsPageRenderKey !== nextRenderKey) {
                    renderCommandListHTML(el, tabFiltered);
                    commandsPageRenderKey = nextRenderKey;
                }
                bindExecuteButtons();
            }, { delayMs: 0 });
        } else if (currentPage === 'models') {
            topBarSearch.style.display = 'none';
            const el = document.getElementById('view-models');
            el.style.display = 'block';
            runDeferredRender('models', () => renderModelsPageV2(el), { delayMs: 0 });
        } else if (currentPage === 'channels') {
            topBarSearch.style.display = 'none';
            const el = document.getElementById('view-channels');
            el.style.display = 'block';
            const shouldReuseChannels = el.dataset.channelsMounted === '1' && typeof el.__openclawResumeChannelsPage === 'function';
            runDeferredRender('channels', () => {
                if (shouldReuseChannels) {
                    el.__openclawResumeChannelsPage();
                    return;
                }
                window.OpenClawPanelPages?.renderChannelsPage?.(el);
            }, { delayMs: 0 });
        } else if (currentPage === 'memory') {
            topBarSearch.style.display = 'none';
            const el = document.getElementById('view-memory');
            el.style.display = 'block';
            runDeferredRender('memory', () => window.OpenClawPanelPages?.renderMemoryCenterPage?.(el), { delayMs: 0 });
        } else if (currentPage === 'cron') {
            topBarSearch.style.display = 'none';
            const el = document.getElementById('view-cron');
            el.style.display = 'block';
            const shouldReuseCron = el.dataset.cronMounted === '1' && typeof el.__openclawResumeCronPage === 'function';
            runDeferredRender('cron', () => {
                if (shouldReuseCron) {
                    el.__openclawResumeCronPage();
                    return;
                }
                window.OpenClawPanelPages?.renderCronPage?.(el);
            }, { delayMs: 0 });
        } else if (currentPage === 'usage') {
            topBarSearch.style.display = 'none';
            const el = document.getElementById('view-usage');
            el.style.display = 'block';
            const shouldReuseUsage = el.dataset.usageMounted === '1' && typeof el.__openclawResumeUsagePage === 'function';
            runDeferredRender('usage', () => {
                if (shouldReuseUsage) {
                    el.__openclawResumeUsagePage();
                    return;
                }
                window.OpenClawPanelPages?.renderUsagePage?.(el);
            }, { delayMs: 0 });
        } else if (currentPage === 'logs') {
            topBarSearch.style.display = 'none';
            const el = document.getElementById('view-logs');
            el.style.display = 'block';
            runDeferredRender('logs', () => renderLogsPage(el), { delayMs: 0 });
        } else if (currentPage === 'gateway') {
            topBarSearch.style.display = 'none';
            const el = document.getElementById('view-gateway');
            el.style.display = 'block';
            runDeferredRender('gateway', () => renderGatewayPage(el), { delayMs: 0 });
        } else if (currentPage === 'agents') {
            topBarSearch.style.display = 'none';
            const el = document.getElementById('view-agents');
            el.style.display = 'block';
            runDeferredRender('agents', () => {
                if (window.OpenClawAgentHub?.renderAgentHubPage) {
                    return window.OpenClawAgentHub.renderAgentHubPage(el, {
                        renderSingleAgentManager: renderAgentsPageV2
                    });
                }
                return renderAgentsPageV2(el);
            }, { delayMs: 0 });
        } else if (currentPage === 'chat') {
            topBarSearch.style.display = 'none';
            const el = document.getElementById('view-chat');
            activateChatView();
            if (!chatWebviewInitialized && !chatWebviewInitPromise) {
                el.innerHTML = `
                    <div id="chatBootstrapLoading" style="display:flex;align-items:center;justify-content:center;height:100%;border-radius:12px;background:#1e1e24;color:#8b8b93;font-size:14px;">
                        正在初始化智能对话...
                    </div>
                `;
                el.innerHTML = renderChatBootstrapShell('loading');
                scheduleUiFlush(() => {
                    chatWebviewInitPromise = Promise.resolve()
                        .then(() => initWebviewSecured())
                        .catch((error) => {
                            console.error('[Chat] Lazy init failed:', error);
                            el.innerHTML = `
                                <div style="display:flex;align-items:center;justify-content:center;height:100%;border-radius:12px;background:#1e1e24;color:#ff6188;font-size:14px;">
                                    智能对话初始化失败
                                </div>
                            `;
                            el.innerHTML = renderChatBootstrapShell('error');
                        })
                        .finally(() => {
                            chatWebviewInitPromise = null;
                        });
                }, 1);
            } else if (!chatWebviewInitPromise && window.__openclawChatWebviewBridge?.resume) {
                scheduleUiFlush(() => {
                    Promise.resolve()
                        .then(() => window.__openclawChatWebviewBridge.resume())
                        .catch((error) => console.warn('[Chat] Sync existing webview failed:', error));
                }, 1);
            } else if (!chatWebviewInitPromise && window.__openclawChatWebviewBridge?.sync) {
                scheduleUiFlush(() => {
                    Promise.resolve()
                        .then(() => window.__openclawChatWebviewBridge.sync({ keepVisible: true }))
                        .catch((error) => console.warn('[Chat] Sync existing webview failed:', error));
                }, 1);
            }
        } else if (currentPage === 'settings') {
            topBarSearch.style.display = 'none';
            const el = document.getElementById('view-settings');
            el.style.display = 'block';
            const shouldReuseSettings = el.dataset.settingsMounted === '1' && typeof el.__openclawResumeSettingsPage === 'function';
            runDeferredRender('settings', () => {
                if (shouldReuseSettings) {
                    el.__openclawResumeSettingsPage();
                    return;
                }
                renderSettingsPage(el);
            }, { delayMs: 0 });
        }
    }

    // --- HTML 鐢熸垚缁勮 ---
    function setDashboardMode(mode) {
        dashboardStartMode = mode === 'npm' ? 'npm' : 'official';
        localStorage.setItem(DASHBOARD_MODE_KEY, dashboardStartMode);
        renderPage();
    }

    function setDashboardAutoLaunchOnStart(enabled) {
        dashboardAutoLaunchOnStart = Boolean(enabled);
        const nextChecked = dashboardAutoLaunchOnStart;
        const topbarToggle = document.getElementById('topbarRuntimeAutoLaunch');
        const dashboardToggle = document.getElementById('dbAutoLaunchToggle');
        if (topbarToggle) {
            topbarToggle.checked = nextChecked;
        }
        if (dashboardToggle) {
            dashboardToggle.checked = nextChecked;
        }
    }

    async function persistDashboardAutoLaunchOnStart(enabled) {
        const nextChecked = Boolean(enabled);
        dashboardAutoLaunchOnStart = nextChecked;
        if (nextChecked) {
            localStorage.setItem(DASHBOARD_AUTO_LAUNCH_KEY, '1');
        } else {
            localStorage.removeItem(DASHBOARD_AUTO_LAUNCH_KEY);
        }
        const topbarToggle = document.getElementById('topbarRuntimeAutoLaunch');
        const dashboardToggle = document.getElementById('dbAutoLaunchToggle');
        if (topbarToggle) {
            topbarToggle.checked = nextChecked;
        }
        if (dashboardToggle) {
            dashboardToggle.checked = nextChecked;
        }
        return nextChecked;
    }

    function getDashboardModeMetaV2(mode = dashboardStartMode) {
        if (mode === 'npm') {
            return {
                id: 'npm',
                label: 'npm 启动',
                short: 'NPM',
                desc: '内置 PM2 托管模式。按 OpenClaw-管理.bat 的 PM2 启停、自启和任务查看逻辑执行，但不再依赖桌面批处理文件。'
            };
        }

        return {
            id: 'official',
            label: 'cmd 启动',
            short: 'CLI',
            desc: '直接使用 OpenClaw 官方命令，适合标准 CLI / Gateway 服务模式。'
        };
    }

    function getDashboardActionDefinitionsV2(mode = dashboardStartMode) {
        const modeMeta = getDashboardModeMetaV2(mode);
        const previewByAction = mode === 'npm'
            ? {
                start: 'pm2 start C:\\openclaw-service\\ecosystem.config.js --only openclaw-gateway',
                stop: 'pm2 stop <all OpenClaw apps> && pm2 delete <all OpenClaw apps>',
                restart: 'pm2 stop <all OpenClaw apps> && pm2 delete <all OpenClaw apps> && pm2 start C:\\openclaw-service\\ecosystem.config.js --only openclaw-gateway && pm2 save --force',
                'enable-autostart': 'copy /y C:\\openclaw-service\\OpenClawSilent.vbs "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClawSilent.vbs"',
                'disable-autostart': 'del /f /q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClawSilent.vbs"',
                'list-tasks': 'pm2 list'
            }
            : {
                start: 'openclaw gateway',
                stop: 'openclaw gateway stop',
                restart: 'openclaw gateway restart',
                'enable-autostart': 'openclaw gateway install',
                'disable-autostart': 'openclaw gateway uninstall',
                'list-tasks': 'openclaw gateway status --deep'
            };

        return [
            { id: 'start', title: '启动 OpenClaw', icon: '启动', tone: 'accent', desc: mode === 'npm' ? '先清理所有包含 openclaw 的 PM2 任务，再执行 pm2 start，并回显 PM2 状态和最近日志。' : '按 OpenClaw 官方方式直接运行本地 Gateway。' },
            { id: 'stop', title: '停止 OpenClaw', icon: '停止', tone: 'danger', desc: mode === 'npm' ? '按 BAT 逻辑逐个执行 pm2 stop 和 pm2 delete，清理全部 OpenClaw PM2 任务。' : '按官方方式停止 Gateway 服务。' },
            { id: 'restart', title: '重启 OpenClaw', icon: '重启', tone: 'warning', desc: mode === 'npm' ? '先清理全部 OpenClaw PM2 任务，再重新启动 openclaw-gateway，并执行 pm2 save --force。' : '使用官方 Gateway 重启命令。' },
            { id: 'enable-autostart', title: '启用开机自启', icon: '自启', tone: 'success', desc: mode === 'npm' ? '确保 OpenClawSilent.vbs 存在后复制到系统 Startup 目录，行为与 BAT 一致。' : '安装官方 Gateway 系统服务，实现自动启动。' },
            { id: 'disable-autostart', title: '禁用开机自启', icon: '禁用', tone: 'muted', desc: mode === 'npm' ? '删除 Startup 目录中的 OpenClawSilent.vbs 自启项。' : '卸载官方 Gateway 系统服务。' },
            { id: 'list-tasks', title: '查看运行中的任务', icon: '任务', tone: 'neutral', desc: mode === 'npm' ? '直接执行 pm2 list，查看当前托管的 OpenClaw 任务列表。' : '查看 OpenClaw 当前运行状态与深度探测结果。' }
        ].map((item) => ({
            ...item,
            mode: modeMeta.label,
            previewCommand: previewByAction[item.id]
        }));
    }

    function setTopbarRuntimeStatusHint(statusText = '检测中', detailText = '', options = {}) {
        if (!topBarRuntimeControls) return;
        const statusEl = topBarRuntimeControls.querySelector('#topbarRuntimeStatus');
        const detailEl = topBarRuntimeControls.querySelector('#topbarRuntimeDetail');
        const dotEl = topBarRuntimeControls.querySelector('#topbarRuntimeDot');
        if (!statusEl || !detailEl || !dotEl) return;

        const tone = options.tone || (options.online === true ? 'online' : options.online === false ? 'offline' : 'pending');
        statusEl.textContent = statusText || '检测中';
        detailEl.textContent = detailText || '等待状态刷新...';

        if (tone === 'online') {
            statusEl.style.color = '#20f19a';
            dotEl.style.background = '#20f19a';
            dotEl.style.boxShadow = '0 0 0 6px rgba(32,241,154,0.18)';
            return;
        }
        if (tone === 'offline') {
            statusEl.style.color = '#ff7e9f';
            dotEl.style.background = '#ff7e9f';
            dotEl.style.boxShadow = '0 0 0 6px rgba(255,126,159,0.18)';
            return;
        }
        statusEl.style.color = '#f0c36c';
        dotEl.style.background = '#f0c36c';
        dotEl.style.boxShadow = '0 0 0 6px rgba(240,195,108,0.18)';
    }

    window.__openclawSetTopbarRuntimeHint = setTopbarRuntimeStatusHint;

    async function refreshTopbarRuntimeStatus(options = {}) {
        if (!topBarRuntimeControls || !window.api?.getDashboardGatewayStatus) return;
        const statusEl = topBarRuntimeControls.querySelector('#topbarRuntimeStatus');
        const detailEl = topBarRuntimeControls.querySelector('#topbarRuntimeDetail');
        const dotEl = topBarRuntimeControls.querySelector('#topbarRuntimeDot');
        if (!statusEl || !detailEl || !dotEl) return;

        try {
            const payload = await window.api.getDashboardGatewayStatus({
                mode: dashboardStartMode,
                fast: options.fast !== false
            });
            const online = Boolean(payload?.online);
            const statusText = payload?.statusText || (online ? '在线' : '离线');
            const detail = String(payload?.detail || '').trim();
            statusEl.textContent = statusText;
            detailEl.textContent = detail || '等待状态刷新...';
            statusEl.style.color = online ? '#20f19a' : '#ff7e9f';
            dotEl.style.background = online ? '#20f19a' : '#ff7e9f';
            dotEl.style.boxShadow = online
                ? '0 0 0 6px rgba(32,241,154,0.18)'
                : '0 0 0 6px rgba(255,126,159,0.18)';
        } catch (error) {
            statusEl.textContent = '离线';
            statusEl.style.color = '#ff7e9f';
            detailEl.textContent = error?.message || String(error);
            dotEl.style.background = '#ff7e9f';
            dotEl.style.boxShadow = '0 0 0 6px rgba(255,126,159,0.18)';
        }
    }

    async function hydrateTopbarRuntimeDefinitions() {
        if (!topBarRuntimeControls) return;
        const definitions = typeof window.api?.getDashboardActionDefinitions === 'function'
            ? await window.api.getDashboardActionDefinitions({ mode: dashboardStartMode }).catch(() => null)
            : null;
        const fallback = getDashboardActionDefinitionsV2(dashboardStartMode);
        const actions = Array.isArray(definitions) && definitions.length ? definitions : fallback;

        ['start', 'stop', 'restart'].forEach((actionId) => {
            const button = topBarRuntimeControls.querySelector(`[data-runtime-action="${actionId}"]`);
            const action = actions.find((item) => item?.id === actionId);
            if (!button || !action) return;
            button.setAttribute('data-title', action.title || actionId);
            button.setAttribute('data-preview', action.previewCommand || '');
        });
    }

    function renderTopbarRuntimeControls() {
        if (!topBarRuntimeControls) return;
        const modeMeta = getDashboardModeMetaV2();
        topBarRuntimeControls.innerHTML = `
            <div class="topbar-runtime-shell">
                <div class="topbar-runtime-status">
                    <span id="topbarRuntimeDot" class="topbar-runtime-dot"></span>
                    <div class="topbar-runtime-copy">
                        <span id="topbarRuntimeStatus" class="topbar-runtime-status-text">检测中</span>
                        <span id="topbarRuntimeDetail" class="topbar-runtime-detail">正在刷新网关状态...</span>
                    </div>
                </div>
                <div class="topbar-runtime-mode" id="topbarRuntimeMode">
                    <button id="topbarRuntimeModeToggle" type="button" class="topbar-runtime-mode-btn">${escapeHtml(modeMeta.short)} ▼</button>
                    <div id="topbarRuntimeModeDropdown" class="topbar-runtime-mode-dropdown">
                        <button class="topbar-runtime-mode-option${dashboardStartMode === 'official' ? ' active' : ''}" data-runtime-mode="official" type="button">cmd 启动</button>
                        <button class="topbar-runtime-mode-option${dashboardStartMode === 'npm' ? ' active' : ''}" data-runtime-mode="npm" type="button">npm 启动</button>
                    </div>
                </div>
                <div class="topbar-runtime-actions">
                    <button class="topbar-runtime-btn start" data-runtime-action="start">启动</button>
                    <button class="topbar-runtime-btn stop" data-runtime-action="stop">停止</button>
                    <button class="topbar-runtime-btn restart" data-runtime-action="restart">重启</button>
                </div>
                <label class="topbar-runtime-auto">
                    <input id="topbarRuntimeAutoLaunch" type="checkbox" ${dashboardAutoLaunchOnStart ? 'checked' : ''}>
                    <span>启动软件时自动启动 OpenClaw</span>
                </label>
            </div>
        `;

        const modeWrapper = topBarRuntimeControls.querySelector('#topbarRuntimeMode');
        const modeToggle = topBarRuntimeControls.querySelector('#topbarRuntimeModeToggle');
        const modeDropdown = topBarRuntimeControls.querySelector('#topbarRuntimeModeDropdown');
        const autoLaunchToggle = topBarRuntimeControls.querySelector('#topbarRuntimeAutoLaunch');

        modeToggle?.addEventListener('click', () => {
            modeDropdown?.classList.toggle('open');
        });

        modeDropdown?.querySelectorAll('[data-runtime-mode]').forEach((button) => {
            button.addEventListener('click', () => {
                const nextMode = button.getAttribute('data-runtime-mode') || 'official';
                setDashboardMode(nextMode);
                renderTopbarRuntimeControls();
            });
        });

        topBarRuntimeControls.onclick = (event) => {
            if (!modeWrapper?.contains(event.target)) {
                modeDropdown?.classList.remove('open');
            }
        };

        topBarRuntimeControls.querySelectorAll('[data-runtime-action]').forEach((button) => {
            button.addEventListener('click', () => {
                const actionId = button.getAttribute('data-runtime-action');
                const title = button.getAttribute('data-title') || actionId;
                const previewCommand = button.getAttribute('data-preview') || '';
                executeDashboardAction(button, {
                    id: `topbar-${actionId}-${Date.now()}`,
                    action: actionId,
                    title,
                    previewCommand,
                    mode: dashboardStartMode,
                    sourceLabel: '椤舵爮'
                });
            });
        });

        autoLaunchToggle?.addEventListener('change', (event) => {
            const nextValue = Boolean(event.currentTarget.checked);
            const previousValue = dashboardAutoLaunchOnStart;
            setDashboardAutoLaunchOnStart(nextValue);
            persistDashboardAutoLaunchOnStart(nextValue).catch(() => {
                setDashboardAutoLaunchOnStart(previousValue);
                event.currentTarget.checked = previousValue;
            });
        });

        hydrateTopbarRuntimeDefinitions();
        refreshTopbarRuntimeStatus();
        if (topbarRuntimeStatusTimer) {
            clearInterval(topbarRuntimeStatusTimer);
        }
        topbarRuntimeStatusTimer = window.setInterval(() => {
            refreshTopbarRuntimeStatus();
        }, 20000);
    }

    async function getUsageQuickAccessState() {
        const definitions = typeof window.api?.getDashboardActionDefinitions === 'function'
            ? await window.api.getDashboardActionDefinitions({ mode: dashboardStartMode }).catch(() => null)
            : null;
        const actions = Array.isArray(definitions) && definitions.length ? definitions : getDashboardActionDefinitionsV2(dashboardStartMode);
        const actionMap = new Map(actions.map((item) => [String(item?.id || ''), item]));
        let autoStartEnabled = false;
        try {
            const result = await window.api?.checkAutoStartStatus?.({ mode: dashboardStartMode });
            autoStartEnabled = Boolean(result?.enabled);
        } catch (_) {}

        const nextAutoStartAction = autoStartEnabled ? actionMap.get('disable-autostart') : actionMap.get('enable-autostart');

        return {
            mode: dashboardStartMode,
            autoStartEnabled,
            items: [
                {
                    id: 'autostart',
                    kind: 'dashboard-action',
                    label: '鑷惎',
                    summary: autoStartEnabled ? '???????' : '???????',
                    actionId: nextAutoStartAction?.id || '',
                    title: nextAutoStartAction?.title || '????',
                    previewCommand: nextAutoStartAction?.previewCommand || ''
                },
                {
                    id: 'repair',
                    kind: 'command',
                    label: '修复',
                    summary: '运行 openclaw doctor --fix',
                    command: 'openclaw doctor --fix',
                    title: '修复环境'
                },
                { id: 'settings', kind: 'nav', label: '配置', summary: '系统配置', page: 'settings' },
                { id: 'logs', kind: 'nav', label: '日志', summary: '日志查看', page: 'logs' },
                { id: 'cron', kind: 'nav', label: '任务', summary: '定时任务', page: 'cron' },
                { id: 'chat', kind: 'nav', label: '聊天', summary: '智能对话', page: 'chat' }
            ]
        };
    }

    async function maybeAutoLaunchRuntimeOnAppStart() {
        if (runtimeAutoLaunchScheduled || !dashboardAutoLaunchOnStart) return;
        runtimeAutoLaunchScheduled = true;
        try {
            const definitions = typeof window.api?.getDashboardActionDefinitions === 'function'
                ? await window.api.getDashboardActionDefinitions({ mode: dashboardStartMode }).catch(() => null)
                : null;
            const actions = Array.isArray(definitions) && definitions.length ? definitions : getDashboardActionDefinitionsV2(dashboardStartMode);
            const startAction = actions.find((item) => item?.id === 'start');
            if (!startAction) return;
            executeDashboardAction(null, {
                id: `topbar-start-${Date.now()}`,
                action: 'start',
                title: startAction.title || '启动 OpenClaw',
                previewCommand: startAction.previewCommand || '',
                mode: dashboardStartMode,
                sourceLabel: '顶栏',
                autoReveal: false
            });
        } catch (error) {
            runtimeAutoLaunchScheduled = false;
            console.warn('[Dashboard] Auto-launch on app start failed:', error?.message || error);
        }
    }

    function scheduleDashboardLifecycleStatusFollowUp(mode, options = {}) {
        if (!window.api?.getDashboardGatewayStatus) return;
        const safeMode = mode === 'npm' ? 'npm' : 'official';
        const intervalMs = Math.max(600, Number(options.intervalMs) || 1800);
        const maxAttempts = Math.max(1, Number(options.maxAttempts) || 6);
        const initialDelayMs = Math.max(0, Number(options.initialDelayMs) || 2200);
        clearDashboardLifecycleStatusFollowUp();
        const pollToken = ++dashboardLifecycleStatusPollToken;
        const shouldUseFastProbe = safeMode === 'npm';

        const syncVisibleStatus = () => {
            refreshTopbarRuntimeStatus({ fast: shouldUseFastProbe }).catch(() => {});
            if (currentPage === 'dashboard') {
                window.__openclawRefreshDashboardStatus?.({ fast: shouldUseFastProbe });
            }
        };

        const poll = async (attempt = 0) => {
            if (pollToken !== dashboardLifecycleStatusPollToken) return;
            let online = false;
            try {
                const status = await window.api.getDashboardGatewayStatus({
                    mode: safeMode,
                    fast: shouldUseFastProbe
                });
                online = Boolean(status?.online);
            } catch (_) {}

            if (online || attempt + 1 >= maxAttempts) {
                dashboardLifecycleStatusPollTimer = null;
                syncVisibleStatus();
                return;
            }

            dashboardLifecycleStatusPollTimer = window.setTimeout(() => {
                poll(attempt + 1);
            }, intervalMs);
        };

        dashboardLifecycleStatusPollTimer = window.setTimeout(() => {
            poll(0);
        }, initialDelayMs);
    }

    function clearDashboardLifecycleStatusFollowUp() {
        dashboardLifecycleStatusPollToken += 1;
        if (dashboardLifecycleStatusPollTimer) {
            clearTimeout(dashboardLifecycleStatusPollTimer);
            dashboardLifecycleStatusPollTimer = null;
        }
    }

    function scheduleDashboardResumeTask(callback, delayMs) {
        const timer = window.setTimeout(() => {
            dashboardResumeWorkTimers.delete(timer);
            callback();
        }, delayMs);
        dashboardResumeWorkTimers.add(timer);
        return timer;
    }

    function clearDashboardResumeWork() {
        dashboardResumeWorkTimers.forEach((timer) => clearTimeout(timer));
        dashboardResumeWorkTimers.clear();
    }

    window.__openclawGetUsageQuickAccessState = getUsageQuickAccessState;
    window.__openclawInvokeUsageQuickAction = (item, buttonEl = null) => {
        const safeItem = item && typeof item === 'object' ? item : {};
        if (safeItem.kind === 'nav' && safeItem.page) {
            navigateToPage(safeItem.page);
            return;
        }
        if (safeItem.kind === 'command' && safeItem.command) {
            window.__openclawRunCommand?.(safeItem.command, {
                id: `usage-${safeItem.id || 'command'}-${Date.now()}`,
                title: safeItem.title || safeItem.label || safeItem.command,
                button: buttonEl,
                sourceLabel: '浣跨敤鎯呭喌'
            });
            return;
        }
        if (safeItem.kind === 'dashboard-action' && safeItem.actionId) {
            executeDashboardAction(buttonEl, {
                id: `usage-${safeItem.actionId}-${Date.now()}`,
                action: safeItem.actionId,
                title: safeItem.title || safeItem.label || safeItem.actionId,
                previewCommand: safeItem.previewCommand || '',
                mode: dashboardStartMode,
                sourceLabel: '浣跨敤鎯呭喌'
            });
        }
    };

    function renderDashboardHTMLV2(container, options = {}) {
        const renderToken = Number.isFinite(options?.renderToken) ? Number(options.renderToken) : pendingDashboardRenderToken;
        const isDashboardRenderStale = () => {
            if (!document.body.contains(container)) return true;
            if (currentPage !== 'dashboard') return true;
            return renderToken !== pendingDashboardRenderToken;
        };
        if (window.__openclawDashboardLogTimer) {
            clearInterval(window.__openclawDashboardLogTimer);
            window.__openclawDashboardLogTimer = null;
        }
        if (window.__openclawDashboardStatusTimer) {
            clearInterval(window.__openclawDashboardStatusTimer);
            window.__openclawDashboardStatusTimer = null;
        }
        if (window.api?.stopDashboardLogFollow) {
            window.api.stopDashboardLogFollow();
        }
        container.dataset.dashboardMode = dashboardStartMode;
        container.dataset.dashboardMounted = '0';

        const modeMeta = getDashboardModeMetaV2();
        const allActions = getDashboardActionDefinitionsV2();
        const mainActions = allActions.filter(a => ['start', 'stop', 'restart'].includes(a.id));

        const mainActionMeta = {
            start: { icon: '开', label: '启动', cls: 'db-action-start' },
            stop: { icon: '停', label: '停止', cls: 'db-action-stop' },
            restart: { icon: '重', label: '重启', cls: 'db-action-restart' }
        };
        const mainBtnsHtml = mainActions.map(a => {
            const m = mainActionMeta[a.id] || { icon: '执', label: a.title, cls: '' };
            return `<button class="dashboard-action-btn ${m.cls}" data-action="${escapeHtml(a.id)}" data-title="${escapeHtml(a.title)}" data-preview="${escapeHtml(a.previewCommand)}">${m.label}</button>`;
        }).join('');

        // Quick action cards - 6 items: 自启 / 修复 / 配置 / 日志 / 任务 / 聊天
        const enableAutostart = allActions.find(a => a.id === 'enable-autostart');
        const disableAutostart = allActions.find(a => a.id === 'disable-autostart');

        const quickCards = [
            { type: 'autostart', icon: '启', label: '自启', enableAction: enableAutostart, disableAction: disableAutostart },
            { type: 'fix', icon: '修', label: '修复' },
            { type: 'nav', icon: '配', label: '配置', page: 'settings' },
            { type: 'nav', icon: '志', label: '日志', page: 'logs' },
            { type: 'nav', icon: '任', label: '任务', page: 'cron' },
            { type: 'nav', icon: '聊', label: '聊天', page: 'chat' }
        ];

        const quickCardsHtml = quickCards.map((q, i) => {
            if (q.type === 'autostart' && q.enableAction) {
                return `<button class="db-quick-card db-autostart-off" id="dbAutoStartCard" data-autostart-state="off" data-enable-action="${escapeHtml(q.enableAction.id)}" data-enable-title="${escapeHtml(q.enableAction.title)}" data-enable-preview="${escapeHtml(q.enableAction.previewCommand)}" data-disable-action="${escapeHtml(q.disableAction?.id || '')}" data-disable-title="${escapeHtml(q.disableAction?.title || '')}" data-disable-preview="${escapeHtml(q.disableAction?.previewCommand || '')}"><span class="db-quick-card-icon">${q.icon}</span><span class="db-quick-card-label">${q.label}</span><span class="db-autostart-badge db-autostart-badge-off" id="dbAutoStartBadge">关闭</span></button>`;
            }
            if (q.type === 'fix') {
                return `<button class="db-quick-card" id="dbFixCard"><span class="db-quick-card-icon">${q.icon}</span><span class="db-quick-card-label">${q.label}</span></button>`;
            }
            if (q.type === 'nav') {
                return `<button class="db-quick-card" data-nav-page="${q.page}"><span class="db-quick-card-icon">${q.icon}</span><span class="db-quick-card-label">${q.label}</span></button>`;
            }
            return '';
        }).join('');

        container.innerHTML = `
            <div class="dashboard-shell">
                <div class="db-status-panel">
                    <div class="db-status-indicator">
                        <span id="dbGatewayDot" class="db-status-dot-lg"></span>
                        <div class="db-status-title">OpenClaw <span id="dbGatewayState">检测中...</span></div>
                        <div id="dbGatewayDetail" class="db-status-subtitle">正在检测网关监听状态...</div>
                    </div>
                    <div class="db-stats-row">
                        <div class="db-stat-item">
                            <span class="db-stat-label">端口</span>
                            <span class="db-stat-value" id="dbGatewayPort">--</span>
                        </div>
                        <div class="db-stat-item">
                            <span class="db-stat-label">运行模式</span>
                            <div class="db-mode-switch" id="dashboardModeSwitcher">
                                <button id="dashboardModeToggle" type="button" class="db-mode-btn">
                                    ${escapeHtml(modeMeta.short)} <span class="db-mode-arrow">▼</span>
                                </button>
                                <div class="db-mode-dropdown" id="dashboardModeDropdown">
                                    <button class="db-mode-option${dashboardStartMode === 'official' ? ' active' : ''}" data-mode="official" type="button">
                                        <span>cmd 启动</span>
                                        <small>官方 Gateway CLI / 服务模式</small>
                                    </button>
                                    <button class="db-mode-option${dashboardStartMode === 'npm' ? ' active' : ''}" data-mode="npm" type="button">
                                        <span>npm 启动</span>
                                        <small>内置 PM2 启动管理流程</small>
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div class="db-stat-item">
                            <span class="db-stat-label">运行时长</span>
                            <span class="db-stat-value" id="dbUptimeValue">--</span>
                        </div>
                    </div>
                    <div class="db-stats-row db-stats-inline-row">
                        <a class="db-stat-link" data-nav-page="agents">Agent: <span id="dbAgentCount">检测中</span> 个</a>
                        <span class="db-stat-inline-sep">·</span>
                        <a class="db-stat-link" data-nav-page="models">模型: <span id="dbModelCount">检测中</span> 个</a>
                        <span class="db-stat-inline-sep">·</span>
                        <a class="db-stat-link" data-nav-page="channels">渠道: <span id="dbChannelCount">检测中</span> 个</a>
                    </div>
                    <div class="db-action-group">
                        ${mainBtnsHtml}
                    </div>
                    <label class="db-auto-launch-toggle" for="dbAutoLaunchToggle">
                        <input id="dbAutoLaunchToggle" type="checkbox" ${dashboardAutoLaunchOnStart ? 'checked' : ''}>
                        <span>启动软件时自动启动 OpenClaw</span>
                    </label>
                    <div class="db-auto-launch-hint">未勾选时，打开软件仅检测状态，不自动拉起服务。</div>
                </div>
                <div class="db-quick-grid">
                    ${quickCardsHtml}
                </div>
                <div class="db-log-summary">
                    <div class="db-log-summary-copy">
                        <span class="db-log-header-title">最近日志</span>
                        <span id="dbLogPreview" class="db-log-inline-preview">首页默认只显示运行摘要，完整日志请按需展开查看。</span>
                    </div>
                    <div class="db-log-summary-actions">
                        <label class="db-log-toggle-label db-log-summary-toggle">
                            <input id="dbRealtimeLogToggle" type="checkbox" ${dashboardRealtimeLogEnabled ? 'checked' : ''}>
                            <span>实时日志</span>
                        </label>
                        <span id="dbLogStatus" class="db-log-status-inline"></span>
                        <button id="dbOpenLogsPage" type="button" class="db-quick-btn db-log-tool-btn">打开日志页</button>
                    </div>
                </div>
            </div>
        `;
        scheduleUiFlush(() => {
            if (isDashboardRenderStale()) return;

            const dashboardStatusPanel = container.querySelector('.db-status-panel');
            const dashboardIndicator = container.querySelector('.db-status-indicator');
            const dashboardStatsRows = Array.from(container.querySelectorAll('.db-stats-row'));
            const dashboardActionGroup = container.querySelector('.db-action-group');
            const dashboardAutoLaunchToggle = container.querySelector('.db-auto-launch-toggle');
            const dashboardAutoLaunchHint = container.querySelector('.db-auto-launch-hint');
            const dashboardQuickGrid = container.querySelector('.db-quick-grid');
            const dashboardLogPreview = container.querySelector('#dbLogPreview');
            const dashboardOpenLogsButton = container.querySelector('#dbOpenLogsPage');
            const dashboardRealtimeLogLabel = container.querySelector('.db-log-summary-toggle span');
            const dashboardGatewayState = container.querySelector('#dbGatewayState');
            const dashboardGatewayDetail = container.querySelector('#dbGatewayDetail');
            if (dashboardStatusPanel && dashboardIndicator && dashboardActionGroup && dashboardAutoLaunchToggle && dashboardAutoLaunchHint) {
                const dashboardStatusMain = document.createElement('div');
                dashboardStatusMain.className = 'db-status-main';
                dashboardStatusMain.append(dashboardIndicator, ...dashboardStatsRows);
                const dashboardRuntimePanel = document.createElement('div');
                dashboardRuntimePanel.className = 'db-runtime-panel';
                const dashboardRuntimeCopy = document.createElement('div');
                dashboardRuntimeCopy.className = 'db-runtime-panel-copy';
                dashboardRuntimeCopy.innerHTML = `
                    <div class="db-runtime-panel-eyebrow">Runtime</div>
                    <div class="db-runtime-panel-title">运行控制</div>
                    <div class="db-runtime-panel-desc">保持一个主操作按钮，其余管理动作降为辅助操作。</div>
                `;
                const dashboardRuntimeSecondary = document.createElement('div');
                dashboardRuntimeSecondary.className = 'db-runtime-secondary';
                dashboardRuntimeSecondary.append(dashboardAutoLaunchToggle, dashboardAutoLaunchHint);
                dashboardRuntimePanel.append(dashboardRuntimeCopy, dashboardActionGroup, dashboardRuntimeSecondary);
                dashboardStatusPanel.replaceChildren(dashboardStatusMain, dashboardRuntimePanel);
            }
            if (dashboardQuickGrid) {
                const dashboardSection = document.createElement('section');
                dashboardSection.className = 'db-section';
                dashboardSection.innerHTML = `
                    <div class="db-section-head">
                        <div class="db-section-eyebrow">Workspace</div>
                        <div class="db-section-title">快捷入口</div>
                    </div>
                `;
                dashboardQuickGrid.replaceWith(dashboardSection);
                dashboardSection.append(dashboardQuickGrid);
            }
            const dashboardLogSummary = container.querySelector('.db-log-summary');
            const dashboardLogExpandBtn = container.querySelector('#dbOpenLogsPage');
            if (dashboardLogExpandBtn) {
                dashboardLogExpandBtn.textContent = '展开日志';
                dashboardLogExpandBtn.setAttribute('aria-expanded', 'false');
            }
            if (dashboardLogSummary && !container.querySelector('#dbLogBody')) {
                dashboardLogSummary.insertAdjacentHTML('afterend', `
                    <div id="dbLogBody" class="db-log-body" style="display:none;">
                        <div class="db-log-toolbar">
                            <button id="dbLogReconnect" type="button" class="db-quick-btn db-log-tool-btn">重新连接</button>
                            <label class="db-log-toggle-label">
                                <input id="dbLogAutoScroll" type="checkbox" checked>
                                <span>自动滚动</span>
                            </label>
                        </div>
                        <section class="dashboard-helper-section">
                            <div class="dashboard-tip-desc">展开后会在首页显示更多实时日志；关闭实时日志时会保留最近一次摘要。</div>
                            <pre id="dbLogContent" class="db-log-content">等待 openclaw logs --follow 输出...</pre>
                        </section>
                    </div>
                `);
            }
            container.querySelector('#dbLogReconnect')?.replaceChildren(document.createTextNode('重新连接'));
            const dashboardAutoScrollLabel = container.querySelector('#dbLogAutoScroll')?.nextElementSibling;
            if (dashboardAutoScrollLabel) dashboardAutoScrollLabel.textContent = '自动滚动';
            const dashboardTipDesc = container.querySelector('.dashboard-tip-desc');
            if (dashboardTipDesc) {
                dashboardTipDesc.textContent = '展开后会在首页显示更多实时日志；关闭实时日志时会保留最近一次摘要。';
            }
            const dashboardLogContentNode = container.querySelector('#dbLogContent');
            if (dashboardGatewayState) dashboardGatewayState.textContent = '检测中...';
            if (dashboardGatewayDetail) dashboardGatewayDetail.textContent = '正在检查 Gateway 监听状态...';
            container.querySelector('#dbGatewayPort')?.replaceChildren(document.createTextNode('--'));
            container.querySelector('#dbUptimeValue')?.replaceChildren(document.createTextNode('--'));
            container.querySelector('#dbAgentCount')?.replaceChildren(document.createTextNode('检测中'));
            container.querySelector('#dbModelCount')?.replaceChildren(document.createTextNode('检测中'));
            container.querySelector('#dbChannelCount')?.replaceChildren(document.createTextNode('检测中'));
            dashboardLogPreview?.replaceChildren(document.createTextNode('首页默认只显示运行摘要，完整日志可以按需展开。'));
            dashboardOpenLogsButton?.replaceChildren(document.createTextNode('展开日志'));
            if (dashboardRealtimeLogLabel) dashboardRealtimeLogLabel.textContent = '实时日志';
            container.querySelector('#dbLogReconnect')?.replaceChildren(document.createTextNode('重新连接'));
            const dashboardAutoScrollText = container.querySelector('#dbLogAutoScroll')?.nextElementSibling;
            if (dashboardAutoScrollText) dashboardAutoScrollText.textContent = '自动滚动';
            const dashboardRuntimePanelTitle = container.querySelector('.db-runtime-panel-title');
            if (dashboardRuntimePanelTitle) dashboardRuntimePanelTitle.textContent = '运行控制';
            const dashboardRuntimePanelDesc = container.querySelector('.db-runtime-panel-desc');
            if (dashboardRuntimePanelDesc) dashboardRuntimePanelDesc.textContent = '保持一个主操作按钮，其余管理动作降为辅助操作。';
            container.querySelector('.db-section-title')?.replaceChildren(document.createTextNode('快捷入口'));
            container.querySelector('.dashboard-tip-desc')?.replaceChildren(document.createTextNode('展开后会在首页显示更多实时日志；关闭实时日志时会保留最近一次摘要。'));
            if (dashboardLogContentNode) {
                dashboardLogContentNode.textContent = '等待 openclaw logs --follow 输出...';
            }
            const dashboardFixLabel = container.querySelector('#dbFixCard .db-quick-card-label');
            if (dashboardFixLabel) dashboardFixLabel.textContent = '修复环境';
            const dashboardAutoStartLabel = container.querySelector('#dbAutoStartCard .db-quick-card-label');
            if (dashboardAutoStartLabel) dashboardAutoStartLabel.textContent = '开机自启';
            const dashboardAutoStartBadge = container.querySelector('#dbAutoStartBadge');
            if (dashboardAutoStartBadge) dashboardAutoStartBadge.textContent = '关闭';
            container.querySelector('[data-nav-page="settings"] .db-quick-card-label')?.replaceChildren(document.createTextNode('系统配置'));
            container.querySelector('[data-nav-page="logs"] .db-quick-card-label')?.replaceChildren(document.createTextNode('日志'));
            container.querySelector('[data-nav-page="cron"] .db-quick-card-label')?.replaceChildren(document.createTextNode('定时任务'));
            container.querySelector('[data-nav-page="chat"] .db-quick-card-label')?.replaceChildren(document.createTextNode('智能对话'));

            const modeSwitcher = container.querySelector('#dashboardModeSwitcher');
            const modeToggle = container.querySelector('#dashboardModeToggle');
            const modeDropdown = container.querySelector('#dashboardModeDropdown');
            const gatewayDot = container.querySelector('#dbGatewayDot');
            const gatewayState = container.querySelector('#dbGatewayState');
            const gatewayDetail = container.querySelector('#dbGatewayDetail');
            const realtimeLogToggle = container.querySelector('#dbRealtimeLogToggle');
            const logReconnect = container.querySelector('#dbLogReconnect');
            const logAutoScroll = container.querySelector('#dbLogAutoScroll');
            const logStatus = container.querySelector('#dbLogStatus');
            const logContent = container.querySelector('#dbLogContent');
            const openLogsPage = container.querySelector('#dbOpenLogsPage');
            const dashboardLogState = {
            lines: [],
            trailing: '',
            renderedText: '',
            gatewayLoading: false,
            renderQueued: false,
            forceScrollPending: false,
            lifecycleActionRunning: false,
            lifecycleResumeTimer: null,
            connected: false
        };
            const dashboardLogFollowCommand = 'openclaw logs --follow';
            const dashboardLogEmptyText = `绛夊緟 ${dashboardLogFollowCommand} 杈撳嚭...`;
            const dashboardLogSection = logContent?.closest('section');
            const dashboardLogDesc = dashboardLogSection?.querySelector('.dashboard-tip-desc');
            const dashboardLogSourceCode = Array.from(dashboardLogSection?.querySelectorAll('code') || [])
            .find((node) => {
                const text = (node?.textContent || '').toLowerCase();
                return text.includes('gateway') || text.includes('log');
            });

        if (dashboardLogDesc) {
            dashboardLogDesc.innerHTML = `这里直接显示 <code>${dashboardLogFollowCommand}</code> 的实时输出，方便从首页观察 OpenClaw 的整体运行日志。`;
        }
        if (dashboardLogSourceCode) {
            dashboardLogSourceCode.textContent = dashboardLogFollowCommand;
        }
        if (logContent) {
            logContent.textContent = dashboardLogEmptyText;
        }

        window.__openclawRefreshDashboardStatus = (options = {}) => refreshGatewayStatus(options);

        function clearDashboardLifecycleResumeTimer() {
            if (dashboardLogState.lifecycleResumeTimer) {
                clearTimeout(dashboardLogState.lifecycleResumeTimer);
                dashboardLogState.lifecycleResumeTimer = null;
            }
        }

        function setDashboardLogStatus(message, color = '#8f98ab') {
            if (!logStatus) return;
            logStatus.textContent = message || '';
            logStatus.style.color = color;
        }

        function syncRealtimeLogPreview(message) {
            const previewEl = container.querySelector('#dbLogPreview');
            if (previewEl && message) {
                previewEl.textContent = message;
            }
        }

        function applyDashboardRealtimeLogPreference(options = {}) {
            const resetBuffer = options.resetBuffer !== false;
            if (realtimeLogToggle) {
                realtimeLogToggle.checked = dashboardRealtimeLogEnabled;
            }
            if (!dashboardRealtimeLogEnabled) {
                if (resetBuffer) {
                    dashboardLogState.lines = [];
                    dashboardLogState.trailing = '';
                    dashboardLogState.renderedText = '';
                }
                window.api?.stopDashboardLogFollow?.();
                dashboardLogState.connected = false;
                setDashboardLogStatus('首页未开启实时日志。', '#8f98ab');
                syncRealtimeLogPreview('未勾选实时日志时，首页不会更新日志；可点击右侧按钮展开查看更多日志。');
                if (logContent) {
                    logContent.textContent = '首页未开启实时日志。';
                }
                return false;
            }
            return true;
        }

        function setGatewayIndicator(payload = {}) {
            const online = Boolean(payload.online);
            const statusText = payload.statusText || (online ? '??' : '??');
            const detailText = payload.detail || '?????????????? Gateway?';
            const color = online ? '#00ff88' : '#ff6188';
            const glow = online ? 'rgba(0,255,136,0.18)' : 'rgba(255,97,136,0.18)';
            const suffix = payload.latency && !detailText.includes(payload.latency) ? (' / ' + payload.latency) : '';

            gatewayState.textContent = statusText;
            gatewayState.style.color = color;
            gatewayDot.style.background = color;
            gatewayDot.style.boxShadow = '0 0 0 8px ' + glow;
            gatewayDetail.textContent = String(detailText || '') + String(suffix || '');
            syncDashboardPrimaryAction(online);

            // Extract port from detail text if available
            const portEl = container.querySelector('#dbGatewayPort');
            if (portEl) {
                const portMatch = detailText.match(/\b(\d{4,5})\b/);
                portEl.textContent = portMatch ? portMatch[1] : '--';
            }
        }

        function syncDashboardPrimaryAction(online = false) {
            const startButton = container.querySelector('.dashboard-action-btn[data-action="start"]');
            const stopButton = container.querySelector('.dashboard-action-btn[data-action="stop"]');
            const restartButton = container.querySelector('.dashboard-action-btn[data-action="restart"]');
            [startButton, stopButton, restartButton].filter(Boolean).forEach((button) => {
                button.classList.remove('is-primary', 'is-secondary', 'is-danger-secondary');
            });
            if (online) {
                restartButton?.classList.add('is-primary');
                startButton?.classList.add('is-secondary');
                stopButton?.classList.add('is-secondary', 'is-danger-secondary');
                return;
            }
            startButton?.classList.add('is-primary');
            restartButton?.classList.add('is-secondary');
            stopButton?.classList.add('is-secondary', 'is-danger-secondary');
        }
        syncDashboardPrimaryAction(false);

        function rebuildDashboardLogText() {
            const merged = dashboardLogState.trailing
                ? [...dashboardLogState.lines, dashboardLogState.trailing]
                : dashboardLogState.lines;
            dashboardLogState.renderedText = merged.join('\n').trim();
        }

        function renderDashboardLogText(forceScroll = false) {
            if (!dashboardRealtimeLogEnabled) {
                syncRealtimeLogPreview('????????????????????????????????????');
                if (logContent) {
                    logContent.textContent = '?????????';
                }
                return;
            }
            if (logContent) {
                const oldScrollTop = logContent.scrollTop;
                logContent.textContent = dashboardLogState.renderedText || dashboardLogEmptyText;
                if (forceScroll || logAutoScroll?.checked) {
                    logContent.scrollTop = logContent.scrollHeight;
                } else {
                    logContent.scrollTop = oldScrollTop;
                }
            }
            const previewEl = container.querySelector('#dbLogPreview');
            if (previewEl) {
                const lastLine = dashboardLogState.lines.length > 0
                    ? dashboardLogState.lines[dashboardLogState.lines.length - 1]
                    : (dashboardLogState.trailing || dashboardLogEmptyText);
                previewEl.textContent = lastLine;
            }
        }

        function scheduleDashboardLogRender(forceScroll = false) {
            dashboardLogState.forceScrollPending = dashboardLogState.forceScrollPending || forceScroll;
            if (dashboardLogState.renderQueued) return;
            dashboardLogState.renderQueued = true;
            scheduleUiFlush(() => {
                dashboardLogState.renderQueued = false;
                rebuildDashboardLogText();
                renderDashboardLogText(dashboardLogState.forceScrollPending);
                dashboardLogState.forceScrollPending = false;
            });
        }

        function appendDashboardLogChunk(chunk) {
            if (!chunk) return;
            const normalized = String(chunk).replace(/\r\n/g, '\n');
            const parts = normalized.split('\n');
            parts[0] = String(dashboardLogState.trailing || '') + String(parts[0] || '');
            dashboardLogState.trailing = normalized.endsWith('\n') ? '' : (parts.pop() || '');
            dashboardLogState.lines.push(...parts.filter(Boolean));
            if (dashboardLogState.lines.length > 500) {
                dashboardLogState.lines = dashboardLogState.lines.slice(-500);
            }
            scheduleDashboardLogRender();
        }

        function resetDashboardLogBuffer() {
            dashboardLogState.lines = [];
            dashboardLogState.trailing = '';
            dashboardLogState.renderedText = '';
            scheduleDashboardLogRender(true);
        }

        async function refreshGatewayStatus(options = {}) {
            if (dashboardLogState.gatewayLoading || dashboardLogState.lifecycleActionRunning || !window.api?.getDashboardGatewayStatus) return;
            dashboardLogState.gatewayLoading = true;
            if (!options.silent) {
                gatewayDetail.textContent = '正在检测网关端口监听状态...';
            }

            try {
                const payload = await window.api.getDashboardGatewayStatus({
                    mode: dashboardStartMode,
                    fast: options.fast !== false
                });
                if (!document.body.contains(container) || currentPage !== 'dashboard') return;
                setGatewayIndicator(payload || {});
            } catch (error) {
                setGatewayIndicator({
                    online: false,
                    statusText: '离线',
                    detail: '状态检测失败: ' + String(error?.message || error)
                });
            } finally {
                dashboardLogState.gatewayLoading = false;
            }
        }

        function syncDashboardStatusTimer() {
            if (window.__openclawDashboardStatusTimer) {
                clearInterval(window.__openclawDashboardStatusTimer);
                window.__openclawDashboardStatusTimer = null;
            }

            if (dashboardLogState.lifecycleActionRunning) {
                return;
            }

            window.__openclawDashboardStatusTimer = setInterval(() => {
                if (!document.body.contains(container) || currentPage !== 'dashboard') {
                    clearInterval(window.__openclawDashboardStatusTimer);
                    window.__openclawDashboardStatusTimer = null;
                    return;
                }
                refreshGatewayStatus({ silent: true, fast: true });
            }, 15000);
        }

        function pauseDashboardLifecycleObservers(message = '管理命令执行中，已暂停状态轮询和实时日志...') {
            dashboardLogState.lifecycleActionRunning = true;
            clearDashboardLifecycleResumeTimer();
            if (window.__openclawDashboardStatusTimer) {
                clearInterval(window.__openclawDashboardStatusTimer);
                window.__openclawDashboardStatusTimer = null;
            }
            window.api?.stopDashboardLogFollow?.();
            dashboardLogState.connected = false;
            setDashboardLogStatus(message, '#8f98ab');
        }

        function resumeDashboardLifecycleObservers(options = {}) {
            const delayMs = Math.max(0, Number(options.delayMs) || 900);
            const reconnectLogs = options.reconnectLogs !== false;
            const refreshStatus = options.refreshStatus !== false;

            clearDashboardLifecycleResumeTimer();
            dashboardLogState.lifecycleResumeTimer = setTimeout(() => {
                dashboardLogState.lifecycleResumeTimer = null;
                dashboardLogState.lifecycleActionRunning = false;
                if (!document.body.contains(container) || currentPage !== 'dashboard') {
                    return;
                }
                syncDashboardStatusTimer();
                if (refreshStatus) {
                    refreshGatewayStatus({ silent: true });
                }
                if (reconnectLogs && dashboardRealtimeLogEnabled) {
                    connectDashboardLogs();
                }
            }, delayMs);
        }

        window.__openclawDashboardLifecycleHooks = {
            pause: pauseDashboardLifecycleObservers,
            resume: resumeDashboardLifecycleObservers,
            isPaused: () => Boolean(dashboardLogState.lifecycleActionRunning)
        };

        function reconnectDashboardLog() {
            resetDashboardLogBuffer();
            if (!applyDashboardRealtimeLogPreference()) {
                return;
            }
            if (dashboardLogState.lifecycleActionRunning) {
                setDashboardLogStatus('管理命令执行中，实时日志会在命令结束后自动恢复。', '#8f98ab');
                return;
            }
            if (!window.api?.startDashboardLogFollow) {
                setDashboardLogStatus('当前环境不支持实时日志流。', '#ff6188');
                return;
            }
            setDashboardLogStatus('正在连接 openclaw gateway 的实时日志...');
            window.api.stopDashboardLogFollow?.();
            window.api.startDashboardLogFollow({ mode: dashboardStartMode });
            dashboardLogState.connected = true;
        }

        const connectDashboardLogs = () => {
            resetDashboardLogBuffer();
            if (!applyDashboardRealtimeLogPreference({ resetBuffer: false })) {
                return;
            }
            if (dashboardLogState.lifecycleActionRunning) {
                setDashboardLogStatus('管理命令执行中，实时日志会在命令结束后自动恢复。', '#8f98ab');
                return;
            }
            if (!window.api?.startDashboardLogFollow) {
                setDashboardLogStatus('当前环境不支持实时日志流。', '#ff6188');
                return;
            }
            setDashboardLogStatus('正在连接 ' + dashboardLogFollowCommand + '...');
            window.api.stopDashboardLogFollow?.();
            window.api.startDashboardLogFollow({ mode: dashboardStartMode });
            dashboardLogState.connected = true;
        };

        const disconnectDashboardLogs = (message = '日志已暂停，展开后会重新连接。') => {
            window.api.stopDashboardLogFollow?.();
            dashboardLogState.connected = false;
            setDashboardLogStatus(message, '#8f98ab');
        };

        window.api?.onDashboardLogState?.((payload = {}) => {
            if (!document.body.contains(container) || currentPage !== 'dashboard') return;
            if (payload.resetBuffer) {
                resetDashboardLogBuffer();
            }
            const color = payload.kind === 'error'
                ? '#ff6188'
                : payload.kind === 'success'
                    ? '#00ff88'
                    : '#8f98ab';
            setDashboardLogStatus(payload.message || '', color);
        });

        window.api?.onDashboardLogStream?.((payload = {}) => {
            if (!document.body.contains(container) || currentPage !== 'dashboard') return;
            if (!dashboardRealtimeLogEnabled) return;
            appendDashboardLogChunk(payload.text || '');
        });

        modeToggle?.addEventListener('click', () => {
            modeDropdown?.classList.toggle('open');
        });

        modeDropdown?.querySelectorAll('[data-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                setDashboardMode(btn.getAttribute('data-mode'));
            });
        });

        container.addEventListener('click', (event) => {
            if (!modeSwitcher?.contains(event.target)) {
                modeDropdown?.classList.remove('open');
            }
        });

        container.querySelectorAll('.dashboard-action-btn').forEach(btn => {
            btn.addEventListener('click', (event) => {
                const action = event.currentTarget.getAttribute('data-action');
                const title = event.currentTarget.getAttribute('data-title');
                const previewCommand = event.currentTarget.getAttribute('data-preview');
                executeDashboardAction(event.currentTarget, {
                    id: 'dashboard-' + action + '-' + Date.now(),
                    action,
                    title,
                    previewCommand,
                    mode: dashboardStartMode
                });
            });
        });

        // Navigation quick cards
        container.querySelectorAll('[data-nav-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                navigateToPage(btn.getAttribute('data-nav-page'));
            });
        });

        // Fix card 鈥?openclaw doctor --fix
        const fixCard = container.querySelector('#dbFixCard');
        if (fixCard) {
            fixCard.addEventListener('click', () => {
                const fixCmd = commandsDB.find(c => c.code === 'openclaw doctor') || { id: 'doctor-fix', code: 'openclaw doctor --fix', name: '淇' };
                prepareAndExecuteCommand(fixCard, fixCmd.id, 'openclaw doctor --fix');
            });
        }

        // Autostart toggle card
        const autoStartCard = container.querySelector('#dbAutoStartCard');
        const autoStartBadge = container.querySelector('#dbAutoStartBadge');
        if (autoStartCard) {
            let autoStartProbeTimer = null;
            let autoStartProbeVersion = 0;
            const setAutoStartPending = () => {
                autoStartCard.setAttribute('data-autostart-state', 'pending');
                if (autoStartBadge) {
                    autoStartBadge.textContent = '检测中';
                    autoStartBadge.classList.remove('db-autostart-badge-on', 'db-autostart-badge-off');
                }
            };
            setAutoStartPending();
            const setAutoStartVisual = (isOn) => {
                autoStartCard.classList.toggle('db-autostart-on', isOn);
                autoStartCard.classList.toggle('db-autostart-off', !isOn);
                autoStartCard.setAttribute('data-autostart-state', isOn ? 'on' : 'off');
                if (autoStartBadge) {
                    autoStartBadge.textContent = isOn ? '开启' : '关闭';
                    autoStartBadge.classList.toggle('db-autostart-badge-on', isOn);
                    autoStartBadge.classList.toggle('db-autostart-badge-off', !isOn);
                }
            };
            const checkAutoStart = async (options = {}, version = autoStartProbeVersion) => {
                try {
                    const result = await window.api?.checkAutoStartStatus?.({
                        mode: dashboardStartMode,
                        bypassCache: options?.bypassCache === true
                    });
                    if (version !== autoStartProbeVersion) return;
                    if (result != null) {
                        setAutoStartVisual(Boolean(result?.enabled));
                        return;
                    }
                } catch (_) {}
                if (version !== autoStartProbeVersion) return;
                if (autoStartBadge) {
                    autoStartBadge.textContent = '未知';
                    autoStartBadge.classList.remove('db-autostart-badge-on', 'db-autostart-badge-off');
                }
            };
            const scheduleAutoStartProbe = (options = {}) => {
                if (autoStartProbeTimer) {
                    clearTimeout(autoStartProbeTimer);
                    autoStartProbeTimer = null;
                }
                const nextProbeVersion = ++autoStartProbeVersion;
                const delayMs = Math.max(0, Number(options?.delayMs) || 0);
                if (options?.showPending !== false) {
                    setAutoStartPending();
                }
                autoStartProbeTimer = window.setTimeout(() => {
                    autoStartProbeTimer = null;
                    if (!document.body.contains(container) || currentPage !== 'dashboard') return;
                    checkAutoStart(options, nextProbeVersion);
                }, delayMs);
            };
            window.__openclawRefreshDashboardAutoStart = (options = {}) => scheduleAutoStartProbe(options);
            autoStartCard.addEventListener('click', () => {
                autoStartProbeVersion += 1;
                const isOn = autoStartCard.getAttribute('data-autostart-state') === 'on';
                const actionId = isOn ? autoStartCard.getAttribute('data-disable-action') : autoStartCard.getAttribute('data-enable-action');
                const title = isOn ? autoStartCard.getAttribute('data-disable-title') : autoStartCard.getAttribute('data-enable-title');
                const preview = isOn ? autoStartCard.getAttribute('data-disable-preview') : autoStartCard.getAttribute('data-enable-preview');
                if (actionId) {
                    setAutoStartVisual(!isOn);  // optimistic toggle
                    executeDashboardAction(autoStartCard, {
                        id: 'dashboard-' + actionId + '-' + Date.now(),
                        action: actionId,
                        title,
                        previewCommand: preview,
                        mode: dashboardStartMode
                    });
                }
            });
        }

        // Stats navigation links
        container.querySelectorAll('.db-stat-link[data-nav-page]').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                navigateToPage(link.getAttribute('data-nav-page'));
            });
        });

        const getDashboardAgentCountFromConfig = (config = {}) => {
            const ids = new Set(['main']);
            const configuredAgents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
            configuredAgents.forEach((entry) => {
                const id = String(entry?.id || '').trim();
                if (id) ids.add(id);
            });
            const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
            bindings.forEach((binding) => {
                const agentId = String(binding?.agentId || '').trim();
                if (agentId) ids.add(agentId);
            });
            return ids.size;
        };

        const setDashboardCountsLoading = (text = '检测中') => {
            const agentCountEl = container.querySelector('#dbAgentCount');
            const modelCountEl = container.querySelector('#dbModelCount');
            const channelCountEl = container.querySelector('#dbChannelCount');
            if (agentCountEl) agentCountEl.textContent = text;
            if (modelCountEl) modelCountEl.textContent = text;
            if (channelCountEl) channelCountEl.textContent = text;
        };

        const loadDashboardCounts = async () => {
            setDashboardCountsLoading('检测中');
            try {
                const config = await window.api?.getOpenClawConfig?.().catch(() => null);
                if (!document.body.contains(container) || currentPage !== 'dashboard') return;
                const agentCountEl = container.querySelector('#dbAgentCount');
                const modelCountEl = container.querySelector('#dbModelCount');
                const channelCountEl = container.querySelector('#dbChannelCount');
                dashboardConfigCache = config && typeof config === 'object' ? config : dashboardConfigCache;
                if (!config || typeof config !== 'object') {
                    setDashboardCountsLoading('鈥?');
                    return;
                }
                if (agentCountEl) {
                    agentCountEl.textContent = String(getDashboardAgentCountFromConfig(config));
                }
                const providers = config?.models?.providers || {};
                let modelCount = 0;
                Object.values(providers).forEach((provider) => {
                    modelCount += Array.isArray(provider?.models) ? provider.models.length : 0;
                });
                if (modelCountEl) modelCountEl.textContent = String(modelCount);
                const channels = config?.channels || config?.channel || {};
                const channelCount = Array.isArray(channels) ? channels.length : Object.keys(channels).length;
                if (channelCountEl) channelCountEl.textContent = String(channelCount);
            } catch (e) { /* counts stay as 鈥?*/ }
        };

        const maybeRunDashboardAutoLaunch = () => {
            if (!dashboardAutoLaunchOnStart || window.__openclawDashboardAutoLaunchProcessed) return;
            const startAction = allActions.find((action) => action.id === 'start');
            const startButton = container.querySelector('.dashboard-action-btn[data-action="start"]');
            if (!startAction || !startButton) return;
            window.__openclawDashboardAutoLaunchProcessed = true;
            window.setTimeout(async () => {
                if (!document.body.contains(container) || currentPage !== 'dashboard') return;
                try {
                    const payload = await window.api?.getDashboardGatewayStatus?.({
                        mode: dashboardStartMode,
                        fast: true
                    });
                    if (payload?.online) {
                        return;
                    }
                } catch (_) {}
                executeDashboardAction(startButton, {
                    id: 'dashboard-auto-start-' + Date.now(),
                    action: 'start',
                    title: startAction.title,
                    previewCommand: startAction.previewCommand,
                    mode: dashboardStartMode,
                    autoReveal: false
                });
            }, 500);
        };

        if (logReconnect) {
            logReconnect.onclick = () => connectDashboardLogs();
        }
        if (logAutoScroll) {
            logAutoScroll.onchange = () => renderDashboardLogText();
        }
        if (openLogsPage) {
            openLogsPage.onclick = null;
        }
        if (realtimeLogToggle) {
            realtimeLogToggle.checked = dashboardRealtimeLogEnabled;
            realtimeLogToggle.addEventListener('change', (event) => {
                setDashboardRealtimeLogEnabled(Boolean(event.currentTarget.checked));
                if (dashboardRealtimeLogEnabled) {
                    connectDashboardLogs();
                    return;
                }
        disconnectDashboardLogs('首页未开启实时日志。');
                applyDashboardRealtimeLogPreference();
            });
        }

        const logToggleBtn = container.querySelector('#dbLogToggleBtn') || openLogsPage;
        const logBody = container.querySelector('#dbLogBody');
        const logPreview = container.querySelector('#dbLogPreview');
        const autoLaunchToggle = container.querySelector('#dbAutoLaunchToggle');
        if (logToggleBtn && logBody) {
            const doToggle = () => {
                const isExpanded = logBody.style.display !== 'none';
                logBody.style.display = isExpanded ? 'none' : 'block';
                if (logPreview) logPreview.style.display = isExpanded ? 'block' : 'none';
                logToggleBtn.textContent = isExpanded ? '展开日志' : '收起日志';
                if (openLogsPage) {
                    openLogsPage.textContent = isExpanded ? '展开日志' : '收起日志';
                    openLogsPage.setAttribute('aria-expanded', isExpanded ? 'false' : 'true');
                }
                if (!isExpanded) {
                    renderDashboardLogText(true);
                    if (!dashboardLogState.connected && !dashboardLogState.lifecycleActionRunning) {
                        connectDashboardLogs();
                    }
                } else if (dashboardLogState.connected) {
                    disconnectDashboardLogs();
                }
            };
            logToggleBtn.addEventListener('click', (e) => { e.stopPropagation(); doToggle(); });
            container.querySelector('#dbLogHeaderToggle')?.addEventListener('click', doToggle);
        }

        if (autoLaunchToggle) {
            autoLaunchToggle.checked = dashboardAutoLaunchOnStart;
            autoLaunchToggle.addEventListener('change', (event) => {
                const nextValue = Boolean(event.currentTarget.checked);
                const previousValue = dashboardAutoLaunchOnStart;
                setDashboardAutoLaunchOnStart(nextValue);
                persistDashboardAutoLaunchOnStart(nextValue).catch((error) => {
                    console.error('[Dashboard] Failed to save auto-launch preference:', error?.message || error);
                    setDashboardAutoLaunchOnStart(previousValue);
                    autoLaunchToggle.checked = previousValue;
                });
            });
        }

        const scheduleDashboardResumeWork = () => {
            clearDashboardResumeWork();
            scheduleDashboardResumeTask(() => {
                if (!document.body.contains(container) || currentPage !== 'dashboard') return;
                refreshGatewayStatus({ silent: true, fast: true });
            }, 120);
            scheduleDashboardResumeTask(() => {
                if (!document.body.contains(container) || currentPage !== 'dashboard') return;
                loadDashboardCounts();
            }, 180);
            const autoStartProbeDelayMs = dashboardAutoStartColdProbePending ? 1200 : 520;
            dashboardAutoStartColdProbePending = false;
            scheduleDashboardResumeTask(() => {
                if (!document.body.contains(container) || currentPage !== 'dashboard') return;
                window.__openclawRefreshDashboardAutoStart?.({ delayMs: 0 });
            }, autoStartProbeDelayMs);
            if (dashboardRealtimeLogEnabled) {
                scheduleDashboardResumeTask(() => {
                    if (!document.body.contains(container) || currentPage !== 'dashboard') return;
                    connectDashboardLogs();
                }, 420);
            }
        };

            window.__openclawResumeDashboard = () => {
                if (isDashboardRenderStale()) return;
            container.dataset.dashboardMode = dashboardStartMode;
                window.__openclawRefreshDashboardStatus = (options = {}) => refreshGatewayStatus(options);
            dashboardLogState.gatewayLoading = false;
            setDashboardCountsLoading();
            syncDashboardStatusTimer();
            applyDashboardRealtimeLogPreference({ resetBuffer: false });
            scheduleDashboardResumeWork();
            };

            dashboardLogState.gatewayLoading = false;
            setDashboardCountsLoading();
            syncDashboardStatusTimer();
            applyDashboardRealtimeLogPreference();
            setDashboardLogStatus('首页不自动连接实时日志。', '#8f98ab');
            scheduleDashboardResumeWork();
            container.dataset.dashboardMounted = '1';
        }, 0);

    }

    function renderCommandListHTML(container, commands) {
        // 鏋勫缓 Tabs
        let tabsHtml = `<div class="category-tabs" style="margin-bottom: 20px; display: flex; gap: 10px;">`;
        ['全部', ...categories].forEach(cat => {
            const activeClass = currentCategoryTab === cat ? 'active' : '';
            tabsHtml += `<button class="tab-btn ${activeClass}" data-tab="${cat}">${cat}</button>`;
        });
        tabsHtml += `</div>`;

        let html = `
            <div style="display:flex; justify-content:space-between; align-items:flex-end;">
                <div>
                    <h2 class="page-title">指令大全</h2>
                    <p class="page-desc">系统全量功能检索表，包含详细底层脚本。</p>
                </div>
            </div>
            ${tabsHtml}
            <div id="commandsInlineLogMount" class="command-inline-log-mount" style="display:none;"></div>
            <div class="list-view">
        `;
        if (commands.length === 0) {
            html += `<p style="color:var(--text-secondary)">未检索到任何指令...</p>`;
        } else {
            commands.forEach(cmd => { html += createCardHTML(cmd, true); });
        }
        html += `</div>`;
        container.innerHTML = html;

        // 缁戝畾 Tab 鐐瑰嚮浜嬩欢
        container.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                currentCategoryTab = e.currentTarget.getAttribute('data-tab');
                refreshCommandsPage(true);
                return;
                renderPage();
            });
        });
    }

    function createCardHTML(cmd, isListMode) {
        const tagHTML = cmd.tags.map(t => `<span>${escapeHtml(t)}</span>`).join('');
        const interactiveBadge = isInteractiveCommand(cmd.code)
            ? '<span class="cmd-hint-badge">交互式</span>'
            : '';
        const safeId = escapeHtml(cmd.id);
        const safeCode = escapeHtml(cmd.code);
        const safeName = escapeHtml(cmd.name);
        const safeDesc = escapeHtml(cmd.desc);
        if (isListMode) {
            return `
                <div class="cmd-card">
                    <div class="cmd-info-area">
                        <div class="cmd-header">
                            <span class="cmd-name">${safeName}</span>
                            <div class="cmd-tags">${tagHTML}${interactiveBadge}</div>
                        </div>
                        <div class="cmd-desc">${safeDesc}</div>
                        <div class="cmd-code">${safeCode}</div>
                    </div>
                    <div class="cmd-action-area">
                        <button class="exec-btn" data-id="${safeId}" data-code="${safeCode}">${isInteractiveCommand(cmd.code) ? '进入交互' : '执行命令'}</button>
                    </div>
                </div>
            `;
        } else {
            return `
                <div class="cmd-card">
                    <div>
                        <div class="cmd-header">
                            <span class="cmd-name">${safeName}</span>
                        </div>
                        <div class="cmd-tags" style="margin-bottom:12px;">${tagHTML}${interactiveBadge}</div>
                        <div class="cmd-desc">${safeDesc}</div>
                        <div class="cmd-code" style="margin-top:14px;">${safeCode}</div>
                    </div>
                    <div>
                        <button class="exec-btn" data-id="${safeId}" data-code="${safeCode}">${isInteractiveCommand(cmd.code) ? '进入交互' : '执行命令'}</button>
                    </div>
                </div>
            `;
        }
    }

    // --- Phase 6: Async Dynamic Parameter Modal Logic ---
    const paramDropdown = document.getElementById('paramDropdown');

    function askParameterAsync(paramName) {
        return new Promise(async (resolve) => {
            // Fetch dynamic models if needed
            let dynamicModels = [];
            let dynamicProviders = []; // 鐢ㄤ簬瀛樻斁鎻愪緵鐨勫晢鍒楄〃
            
            // 鏄惁鏄姹傝緭鍏?Provider" (鎻愪緵鍟?
            const isProviderParam = paramName.includes('鎻愪緵鍟?') && !paramName.includes('妯″瀷') && !paramName.toLowerCase().includes('model');
            // 鏄惁鏄姹傝緭鍏?Model" (妯″瀷鍚嶏紝鍙兘甯︽湁鎻愪緵鍟嗗 <鎻愪緵鍟?妯″瀷鍚?')
            const isModelParam = paramName.includes('妯″瀷') || paramName.toLowerCase().includes('model') || (paramName.includes('鎻愪緵鍟?') && paramName.includes('/'));
            
            if ((isModelParam || isProviderParam) && window.api && window.api.getOpenClawConfig) {
                const configObj = await window.api.getOpenClawConfig();
                if (configObj) {
                    const providers = configObj.models?.providers || configObj.providers || configObj.models || {};
                    if (typeof providers === 'object') {
                        dynamicProviders = Object.keys(providers);
                        if(dynamicProviders.length === 0) {
                            dynamicProviders = ['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'moonshot'];
                        }
                        for (const [pName, pData] of Object.entries(providers)) {
                            let mList = [];
                            if (Array.isArray(pData)) mList = pData;
                            else if (pData && Array.isArray(pData.models)) mList = pData.models;
                            mList.forEach(m => dynamicModels.push(`${pName}/${typeof m === 'string' ? m : (m.id || m.name)}`));
                        }
                    }
                }
            }

            // Setup UI
            paramModalDesc.textContent = `璇疯緭鍏ュ弬鏁版墍闇€鐨勫€? 瀵瑰簲 ${paramName}`;
            paramModalInput.value = '';
            paramDropdown.innerHTML = '';
            paramDropdown.classList.remove('active');
            let dropdownSelectedIndex = -1;
            
            // Show quick selects if it's a model or provider
            if (isModelParam || isProviderParam) {
                paramQuickSelectArea.style.display = 'block';
                paramQuickTags.innerHTML = '';
                
                let tagList = [];
                if (isModelParam) {
                    // 濡傛灉鎻愬彇鍒颁簡鍔ㄦ€佸垪琛紝浼樺厛鎴彇鍓?涓紱鍚﹀垯闄嶇骇缁欏嚑涓厹搴?
                    tagList = dynamicModels.length > 0 ? dynamicModels.slice(0, 6) : ["openai/gpt-4o", "anthropic/claude-3-5-sonnet", "google/gemini-1.5-pro"];
                } else if (isProviderParam) {
                    // 瀵逛簬鍗曠函鐨勬彁渚涘晢杈撳叆
                    tagList = dynamicProviders.length > 0 ? dynamicProviders : ['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'moonshot'];
                }

                tagList.forEach(item => {
                    const btn = document.createElement('button');
                    btn.className = 'quick-tag-btn';
                    btn.textContent = item.split('/').pop() || item; 
                    btn.onclick = () => {
                        paramModalInput.value = item; 
                        onConfirm(); // 鐐瑰嚮鐩存帴濉叆骞舵墽琛?
                    };
                    paramQuickTags.appendChild(btn);
                });
            } else {
                paramQuickSelectArea.style.display = 'none';
            }

            paramModalOverlay.style.display = 'flex';
            paramModalInput.focus();

            // Render Dropdown
            const renderDropdown = (query) => {
                if (!(isModelParam || isProviderParam)) {
                    paramDropdown.classList.remove('active');
                    return;
                }
                
                let sourceList = isModelParam ? dynamicModels : dynamicProviders;
                // 闃叉绌烘暟鎹厹搴?
                if (sourceList.length === 0 && isProviderParam) sourceList = ['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'moonshot'];

                const q = query.toLowerCase();
                const filtered = sourceList.filter(m => m.toLowerCase().includes(q)).slice(0, 10);
                
                if (filtered.length > 0) {
                    paramDropdown.innerHTML = '';
                    filtered.forEach((m, idx) => {
                        const li = document.createElement('li');
                        li.className = 'param-dropdown-item';
                        
                        // Split provider and model for nice UI (濡傛灉瀛樺湪鏂滄潬)
                        const parts = m.split('/');
                        const providerText = parts.length > 1 ? `<span class="provider">${parts[0]}</span>` : '';
                        const modelText = parts.length > 1 ? parts.slice(1).join('/') : m;
                        
                        li.innerHTML = `<span>${modelText}</span>${providerText}`;
                        li.onclick = () => {
                            paramModalInput.value = m;
                            paramDropdown.classList.remove('active');
                            paramModalInput.focus();
                        };
                        paramDropdown.appendChild(li);
                    });
                    paramDropdown.classList.add('active');
                    highlightDropdown(0);
                } else {
                    paramDropdown.classList.remove('active');
                }
            };

            const highlightDropdown = (index) => {
                const items = paramDropdown.querySelectorAll('.param-dropdown-item');
                if (items.length === 0) return;
                items.forEach(i => i.classList.remove('selected'));
                if (index >= 0 && index < items.length) {
                    items[index].classList.add('selected');
                    dropdownSelectedIndex = index;
                    items[index].scrollIntoView({ block: 'nearest' });
                }
            };

            // Setup Event Listeners
            const cleanup = () => {
                paramBtnCancel.removeEventListener('click', onCancel);
                paramBtnConfirm.removeEventListener('click', onConfirm);
                paramModalInput.removeEventListener('keydown', onKeydown);
                paramModalInput.removeEventListener('focus', onFocus);
                paramModalInput.removeEventListener('input', onInput);
                paramModalOverlay.removeEventListener('click', onOverlayClick);
                paramModalOverlay.style.display = 'none';
            };

            const onCancel = () => { cleanup(); resolve(null); };
            const onConfirm = () => { cleanup(); resolve(paramModalInput.value || null); };
            const onOverlayClick = (e) => {
                if (e.target === paramModalOverlay) onCancel();
                else if (e.target !== paramModalInput && paramDropdown && !paramDropdown.contains(e.target)) {
                    paramDropdown.classList.remove('active');
                }
            };
            const onFocus = () => {
                if (isModelParam) renderDropdown(paramModalInput.value);
            };
            const onInput = (e) => {
                renderDropdown(paramModalInput.value);
            };
            const onKeydown = (e) => {
                const items = paramDropdown.querySelectorAll('.param-dropdown-item');
                if (paramDropdown.classList.contains('active') && items.length > 0) {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        if (dropdownSelectedIndex < items.length - 1) highlightDropdown(dropdownSelectedIndex + 1);
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        if (dropdownSelectedIndex > 0) highlightDropdown(dropdownSelectedIndex - 1);
                    } else if (e.key === 'Enter') {
                        e.preventDefault();
                        if (dropdownSelectedIndex >= 0) {
                            items[dropdownSelectedIndex].click();
                            return; // Fill in the dropdown item, do not bubble up to submit yet
                        }
                    }
                }
                if (e.key === 'Enter' && !paramDropdown.classList.contains('active')) onConfirm();
                if (e.key === 'Escape') {
                    if (paramDropdown.classList.contains('active')) paramDropdown.classList.remove('active');
                    else onCancel();
                }
            };

            paramBtnCancel.addEventListener('click', onCancel);
            paramBtnConfirm.addEventListener('click', onConfirm);
            paramModalInput.addEventListener('keydown', onKeydown);
            paramModalInput.addEventListener('focus', onFocus);
            paramModalInput.addEventListener('input', onInput);
            paramModalOverlay.addEventListener('click', onOverlayClick);
            
            // Initial render
            if (isModelParam || isProviderParam) renderDropdown('');
        });
    }

    // --- 浜や簰锛氱粺涓€甯﹀弬鍛戒护鐨勫噯澶囧拰鎵ц娴佺▼ ---
    async function prepareAndExecuteCommand(targetBtn, cmdId, cmdCode) {
        let finalCmdCode = cmdCode;
        // 妫€鏌ユ槸鍚﹀寘鍚渶瑕佸～鍐欑殑鍙傛暟锛屽舰濡?<...> 鎴?[...]
        const argMatches = finalCmdCode.match(/<([^>]+)>/g) || finalCmdCode.match(/\[([^\]]+)\]/g);
        if (argMatches) {
            for (let match of argMatches) {
                const paramName = match.replace(/[<>[\]]/g, '');
                
                // 闈為樆濉炲紡鍓嶇鍙傛暟鏀堕泦
                const userInput = await askParameterAsync(paramName);
                
                // 鐢ㄦ埛鐐瑰嚮浜嗗彇娑堟垨鎸変簡 Esc
                if (userInput === null) {
appendTerminalLog(`> 取消执行：未提供必要参数 [${paramName}]\n`, 'error');
                    return; 
                }
                // 鏇挎崲鎸囦护涓殑鍗犱綅绗?
                finalCmdCode = finalCmdCode.replace(match, userInput.trim());
            }
        }
        executeCommand(targetBtn, cmdId, finalCmdCode);
    }

    // --- 浜や簰锛氱粦瀹氭墽琛屾寜閽偣鍑讳簨浠?---
    function bindExecuteButtons() {
        const btns = document.querySelectorAll('.exec-btn');
        btns.forEach(btn => {
            // 淇锛氱Щ闄ゆ棫鐨勪簨浠剁洃鍚櫒锛岄伩鍏嶉噸澶嶇粦瀹氬鑷村娆″脊绐?
            const newBtn = btn.cloneNode(true);
            if (btn.parentNode) {
                btn.parentNode.replaceChild(newBtn, btn);
            }
            
            newBtn.addEventListener('click', (e) => {
                const target = e.currentTarget;
                const cmdId = target.getAttribute('data-id');
                const cmdCode = target.getAttribute('data-code');
                prepareAndExecuteCommand(target, cmdId, cmdCode);
            });
        });
    }

    // --- IPC 閫氫俊涓庣湡瀹炲懡浠ゆ墽琛?---
    function setActionButtonBusy(btn, busyLabel = '执行中...') {
        if (!btn) return;
        btn.dataset.originalText = btn.dataset.originalText || btn.innerText;
        btn.innerText = busyLabel;
        btn.classList.add('loading');
        btn.classList.remove('success');
        btn.disabled = true;
        btn.dataset.executing = 'true';
    }

    function releaseActionButton(btn, code) {
        if (!btn) return;
        const originalText = btn.dataset.originalText || '执行';
        btn.innerText = `完成 (${code})`;
        btn.classList.remove('loading');
        btn.classList.add('success');
        setTimeout(() => {
            btn.innerText = originalText;
            btn.classList.remove('success');
            btn.disabled = false;
            delete btn.dataset.executing;
            delete btn.dataset.originalText;
        }, 2600);
    }

    function syncTerminalStatus() {
        const sessions = Array.from(commandSessions.values());
        const runningCount = sessions.filter(item => item.status === 'running').length;
        if (sessions.length === 0) {
            terminalStatusHint.textContent = '暂无执行会话';
            focusedSessionId = null;
        } else if (runningCount > 0) {
            terminalStatusHint.textContent = `${runningCount} 个会话运行中，共 ${sessions.length} 条执行记录`;
        } else {
            terminalStatusHint.textContent = `最近 ${sessions.length} 条执行记录`;
        }

        if (terminalEmptyState) {
            terminalEmptyState.style.display = sessions.length === 0 ? 'flex' : 'none';
        }

        const focused = focusedSessionId ? commandSessions.get(focusedSessionId) : null;
        const hasRunningFocused = focused && focused.status === 'running';
        killCmdBtn.style.display = hasRunningFocused ? 'inline-block' : 'none';
        currentExecutingCommandId = hasRunningFocused ? focusedSessionId : null;
    }

    function scrollTerminalToBottom() {
        if (terminalAutoScrollToggle && !terminalAutoScrollToggle.checked) return;
        terminalBody.scrollTop = terminalBody.scrollHeight;
    }

    function setFocusedSession(id) {
        focusedSessionId = id;
        terminalBody.querySelectorAll('.command-session').forEach(card => {
            card.classList.toggle('focused', card.getAttribute('data-session-id') === id);
        });
        syncTerminalStatus();
    }

    window.__openclawFocusCommandSession = (id) => {
        const normalizedId = String(id || '').trim();
        if (!normalizedId || !commandSessions.has(normalizedId)) return false;
        terminalPanel.style.display = 'flex';
        setFocusedSession(normalizedId);
        scrollTerminalToBottom();
        return true;
    };

    function setSessionState(session, status, codeLabel = '') {
        if (!session) return;
        session.status = status;
        session.lastUpdatedAt = Date.now();
        const stateMap = {
            running: { text: '运行中', className: 'running' },
            success: { text: '已完成', className: 'success' },
            warning: { text: '已终止', className: 'warning' },
            error: { text: '异常退出', className: 'error' }
        };
        const view = stateMap[status] || stateMap.error;
        session.stateEl.className = `command-session-state ${view.className}`;
        session.stateEl.textContent = codeLabel ? `${view.text} · ${codeLabel}` : view.text;
        if (session.killBtn) {
            session.killBtn.disabled = status !== 'running';
        }
        if (session.inputBox) {
            const disabled = status !== 'running';
            session.inputBox.disabled = disabled;
            session.block.querySelectorAll('.command-input-btn').forEach(btn => {
                btn.disabled = disabled;
            });
            session.inputBox.placeholder = disabled ? '该交互会话已结束' : '输入内容后回车发送';
        }
        syncTerminalStatus();
        scheduleCommandsInlineLogRefresh();
    }

    function buildCommandSessionSnapshot(session) {
        if (!session) return null;
        return {
            id: session.id,
            status: session.status,
            title: session.title,
            commandCode: session.commandCode,
            sourceLabel: session.sourceLabel,
            inlineLogScope: session.inlineLogScope,
            startedAt: session.startedAt,
            lastUpdatedAt: session.lastUpdatedAt,
            interactive: !!session.interactive,
            logText: String(session.logText || '')
        };
    }

    function isQrSafeCommand(commandCode) {
        const code = String(commandCode || '').toLowerCase();
        return code.includes('@tencent-weixin/openclaw-weixin-cli install')
            || code.includes('channels login --channel openclaw-weixin');
    }

    function applyCommandSessionDisplayMode(session, commandCode) {
        if (!session?.block) return;
        session.block.classList.toggle('command-session-qr-safe', isQrSafeCommand(commandCode || session.commandCode));
    }

    function notifyCommandSessionObservers(eventType, payload = {}) {
        if (!commandSessionObservers.size) return;
        commandSessionObservers.forEach((observer) => {
            try {
                observer({ type: eventType, ...payload });
            } catch (_) {}
        });
    }

    function clearSilentCommandNotice(sessionId) {
        const normalizedId = String(sessionId || '').trim();
        if (!normalizedId) return;
        const timer = commandSilentStartTimers.get(normalizedId);
        if (timer) {
            clearTimeout(timer);
            commandSilentStartTimers.delete(normalizedId);
        }
    }

    function scheduleSilentCommandNotice(sessionId) {
        const normalizedId = String(sessionId || '').trim();
        if (!normalizedId) return;
        clearSilentCommandNotice(normalizedId);
        const timer = window.setTimeout(() => {
            commandSilentStartTimers.delete(normalizedId);
            const session = commandSessions.get(normalizedId);
            if (!session || session.status !== 'running' || String(session.logText || '').trim()) {
                return;
            }
            const message = session.interactive
                ? '[系统] 命令已启动，但当前 CLI 还没有输出日志；如果这是扫码、登录或配对命令，请继续观察当前窗口，或稍后执行状态检查。\n'
                : '[系统] 命令已启动，但当前 CLI 还没有输出日志；界面会继续等待后续结果。\n';
            appendTerminalLog(message, 'sys', normalizedId);
        }, 1400);
        commandSilentStartTimers.set(normalizedId, timer);
    }

    window.__openclawRegisterCommandSessionObserver = (callback) => {
        if (typeof callback !== 'function') {
            return () => {};
        }
        commandSessionObservers.add(callback);
        return () => {
            commandSessionObservers.delete(callback);
        };
    };

    window.__openclawGetCommandSessionSnapshot = (id) => {
        return buildCommandSessionSnapshot(commandSessions.get(String(id || '').trim()));
    };

    window.__openclawListCommandSessionSnapshots = () => {
        return Array.from(commandSessions.values()).map((session) => buildCommandSessionSnapshot(session)).filter(Boolean);
    };

    function ensureSessionRecord(sessionInfo) {
        if (commandSessions.has(sessionInfo.id)) {
            const existing = commandSessions.get(sessionInfo.id);
            if (sessionInfo.triggerButton) existing.triggerButton = sessionInfo.triggerButton;
            if (sessionInfo.sourceLabel) existing.sourceLabel = sessionInfo.sourceLabel;
            if (sessionInfo.title) existing.title = sessionInfo.title;
            if (sessionInfo.commandCode) existing.commandCode = sessionInfo.commandCode;
            if (sessionInfo.inlineLogScope) existing.inlineLogScope = sessionInfo.inlineLogScope;
            existing.lastUpdatedAt = Date.now();
            applyCommandSessionDisplayMode(existing, sessionInfo.commandCode);
            scheduleCommandsInlineLogRefresh();
            return existing;
        }

        if (sessionInfo.autoReveal === true) {
            terminalPanel.style.display = 'flex';
        }
        const timeStr = new Date().toLocaleString('zh-CN', { hour12: false });
        const block = document.createElement('section');
        block.className = 'command-session';
        block.setAttribute('data-session-id', sessionInfo.id);
        block.innerHTML = `
            <div class="command-session-head">
                <div class="command-session-head-main">
                    <div class="command-session-title-row">
                        <span class="command-session-title">${escapeHtml(sessionInfo.title || sessionInfo.commandCode || sessionInfo.id)}</span>
                        ${sessionInfo.interactive ? '<span class="command-session-badge">交互式</span>' : ''}
                        ${sessionInfo.modeLabel ? `<span class="command-session-badge subtle">${escapeHtml(sessionInfo.modeLabel)}</span>` : ''}
                    </div>
                    <div class="command-session-meta">${escapeHtml(sessionInfo.sourceLabel || '命令执行')} · ${escapeHtml(timeStr)}</div>
                </div>
                <div class="command-session-head-actions">
                    <span class="command-session-state running">运行中</span>
                    <button class="command-session-kill command-input-btn" data-session-kill="${escapeHtml(sessionInfo.id)}" type="button">终止</button>
                </div>
            </div>
            <div class="command-session-command">${escapeHtml(sessionInfo.commandCode || '')}</div>
            <div class="command-session-output"></div>
            ${sessionInfo.interactive ? `
                <div class="command-session-input-panel">
                    <div class="command-session-input-hint">交互式命令会停在这里等待输入。文本框默认“发送并回车”，方向键和纯回车可用快捷按钮发送。</div>
                    <div class="command-session-input-row">
                        <input class="command-session-input-box" type="text" data-session-input="${escapeHtml(sessionInfo.id)}" placeholder="输入内容后回车发送">
                        <button class="command-input-btn" data-input-send="${escapeHtml(sessionInfo.id)}" type="button">发送并回车</button>
                        <button class="command-input-btn" data-input-enter="${escapeHtml(sessionInfo.id)}" type="button">回车</button>
                    </div>
                    <div class="command-session-shortcuts">
                        <button class="command-input-btn" data-input-key="${escapeHtml(sessionInfo.id)}" data-key="up" type="button">上</button>
                        <button class="command-input-btn" data-input-key="${escapeHtml(sessionInfo.id)}" data-key="down" type="button">下</button>
                        <button class="command-input-btn" data-input-key="${escapeHtml(sessionInfo.id)}" data-key="space" type="button">空格</button>
                        <button class="command-input-btn" data-input-key="${escapeHtml(sessionInfo.id)}" data-key="esc" type="button">Esc</button>
                    </div>
                </div>
            ` : ''}
        `;

        const session = {
            id: sessionInfo.id,
            status: sessionInfo.initialStatus || 'running',
            title: sessionInfo.title || sessionInfo.commandCode || sessionInfo.id,
            commandCode: sessionInfo.commandCode || '',
            sourceLabel: sessionInfo.sourceLabel || '命令执行',
            inlineLogScope: sessionInfo.inlineLogScope || (sessionInfo.sourceLabel === '指令大全' ? 'commands' : ''),
            startedAt: Date.now(),
            lastUpdatedAt: Date.now(),
            logText: '',
            block,
            commandEl: block.querySelector('.command-session-command'),
            outputEl: block.querySelector('.command-session-output'),
            stateEl: block.querySelector('.command-session-state'),
            killBtn: block.querySelector('.command-session-kill'),
            inputBox: block.querySelector('.command-session-input-box'),
            triggerButton: sessionInfo.triggerButton || null,
            interactive: !!sessionInfo.interactive,
            pendingOutputFragment: document.createDocumentFragment(),
            outputFlushQueued: false,
            outputNeedsScroll: false
        };

        commandSessions.set(sessionInfo.id, session);
        applyCommandSessionDisplayMode(session, sessionInfo.commandCode);
        terminalBody.appendChild(block);
        if (session.status === 'running' || !focusedSessionId) {
            setFocusedSession(sessionInfo.id);
        }
        scrollTerminalToBottom();
        syncTerminalStatus();
        scheduleCommandsInlineLogRefresh();

        if (session.status !== 'running') {
            setSessionState(session, session.status);
        }

        if (session.inputBox) {
            setTimeout(() => session.inputBox?.focus(), 80);
        }

        return session;
    }

    function flushSessionOutput(session) {
        if (!session?.outputEl) return;
        session.outputFlushQueued = false;
        if (session.pendingOutputFragment?.childNodes?.length) {
            session.outputEl.appendChild(session.pendingOutputFragment);
        }
        if (session.outputNeedsScroll) {
            scrollTerminalToBottom();
            session.outputNeedsScroll = false;
        }
    }

    function scheduleSessionOutputFlush(session, forceScroll = false) {
        if (!session) return;
        session.outputNeedsScroll = session.outputNeedsScroll || forceScroll;
        if (session.outputFlushQueued) return;
        session.outputFlushQueued = true;
        scheduleUiFlush(() => flushSessionOutput(session));
    }

    function appendTerminalLog(text, type = 'stdout', sessionId = null) {
        const targetSessionId = sessionId || currentExecutingCommandId || 'ui-notice';
        clearSilentCommandNotice(targetSessionId);
        const session = ensureSessionRecord({
            id: targetSessionId,
            title: targetSessionId === 'ui-notice' ? '界面提示' : '执行会话',
            commandCode: targetSessionId === 'ui-notice' ? '本地 UI 提示' : '',
            interactive: false,
            sourceLabel: targetSessionId === 'ui-notice' ? '本地界面' : '命令执行',
            initialStatus: targetSessionId === 'ui-notice' ? 'success' : 'running'
        });

        const normalizedText = String(text || '').replace(/\r/g, '');
        const chunk = document.createElement('div');
        chunk.className = 'command-session-line';
        if (type === 'stderr' || type === 'error') {
            chunk.classList.add('is-error');
        } else if (type === 'sys') {
            chunk.classList.add('is-system');
        } else {
            chunk.classList.add('is-stdout');
        }
        chunk.textContent = normalizedText;
        session.logText += normalizedText;
        session.lastUpdatedAt = Date.now();
        session.pendingOutputFragment.appendChild(chunk);
        scheduleSessionOutputFlush(session, true);
        scheduleCommandsInlineLogRefresh();
        notifyCommandSessionObservers('stream', {
            id: targetSessionId,
            streamType: type,
            text: normalizedText,
            session: buildCommandSessionSnapshot(session)
        });
        if (session.inlineLogScope === 'commands' && session.interactive && commandsInlineDraftState.sessionId === session.id && commandsInlineDraftState.surfaceFocused) {
            focusCommandsInlineTerminalSurface();
        }
    }
    
    function hideTerminalPanel() {
        terminalPanel.style.display = 'none';
    }

    function isTerminalPanelVisible() {
        return terminalPanel.style.display !== 'none';
    }

    closeTerminalBtn.addEventListener('click', () => {
        hideTerminalPanel();
    });

    document.addEventListener('pointerdown', (event) => {
        if (!isTerminalPanelVisible()) return;
        if (terminalPanel.contains(event.target)) return;
        hideTerminalPanel();
    });

    clearTerminalBtn?.addEventListener('click', () => {
        Array.from(commandSessions.entries()).forEach(([id, session]) => {
            if (session.status === 'running') return;
            session.block.remove();
            commandSessions.delete(id);
        });
        if (commandSessions.size === 0) {
            terminalBody.querySelectorAll('.command-session').forEach(node => node.remove());
        }
        syncTerminalStatus();
        scheduleCommandsInlineLogRefresh();
    });

    // 缁堟鎸夐挳锛氭墜鍔?Kill 姝ｅ湪杩愯鐨勫懡浠?
    killCmdBtn.addEventListener('click', () => {
        if (currentExecutingCommandId && window.api && window.api.killCommand) {
            window.api.killCommand(currentExecutingCommandId);
        }
    });

    terminalBody.addEventListener('click', (event) => {
        const sessionCard = event.target.closest('.command-session');
        if (sessionCard) {
            setFocusedSession(sessionCard.getAttribute('data-session-id'));
        }

        const killBtn = event.target.closest('[data-session-kill]');
        if (killBtn && window.api?.killCommand) {
            window.api.killCommand(killBtn.getAttribute('data-session-kill'));
            return;
        }

        const sendBtn = event.target.closest('[data-input-send]');
        if (sendBtn) {
            const sessionId = sendBtn.getAttribute('data-input-send');
            const input = terminalBody.querySelector(`[data-session-input="${CSS.escape(sessionId)}"]`);
            const value = input?.value || '';
            if (window.api?.sendCommandInput) {
                window.api.sendCommandInput(sessionId, value, true);
                appendTerminalLog(`> ${value}\n`, 'sys', sessionId);
                if (input) input.value = '';
            }
            return;
        }

        const enterBtn = event.target.closest('[data-input-enter]');
        if (enterBtn && window.api?.sendCommandInput) {
            const sessionId = enterBtn.getAttribute('data-input-enter');
            window.api.sendCommandInput(sessionId, '', true);
            appendTerminalLog('> [鍥炶溅]\n', 'sys', sessionId);
            return;
        }

        const keyBtn = event.target.closest('[data-input-key]');
        if (keyBtn && window.api?.sendCommandInput) {
            const sessionId = keyBtn.getAttribute('data-input-key');
            const key = keyBtn.getAttribute('data-key');
            const inputMap = {
                up: '\u001B[A',
                down: '\u001B[B',
                space: ' ',
                esc: '\u001B'
            };
            if (inputMap[key]) {
                window.api.sendCommandInput(sessionId, inputMap[key], false);
                appendTerminalLog(`> [${key.toUpperCase()}]\n`, 'sys', sessionId);
            }
        }
    });

    terminalBody.addEventListener('keydown', (event) => {
        const input = event.target.closest('.command-session-input-box');
        if (!input || event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        const sessionId = input.getAttribute('data-session-input');
        if (window.api?.sendCommandInput) {
            window.api.sendCommandInput(sessionId, input.value || '', true);
            appendTerminalLog(`> ${input.value || ''}\n`, 'sys', sessionId);
            input.value = '';
        }
    });

    function finishCommandOnUI(commandId, code) {
        clearSilentCommandNotice(commandId);
        const session = commandSessions.get(commandId);
        const btn = session?.triggerButton || null;
        const codeLabel = String(code);
        if (code === 0 || code === '0') {
            setSessionState(session, 'success', codeLabel);
        } else if (code === 'KILLED' || code === 'TIMEOUT') {
            setSessionState(session, 'warning', codeLabel);
        } else {
            setSessionState(session, 'error', codeLabel);
        }
        if (btn) {
            releaseActionButton(btn, codeLabel);
        }
    }

    function summarizeDashboardActionResult(session, code) {
        if (!session || !session.dashboardAction) return;

        const action = session.dashboardAction;
        const mode = session.dashboardMode === 'npm' ? 'npm' : 'official';
        const isSuccess = code === 0 || code === '0';
        const isLifecycleAction = ['start', 'stop', 'restart'].includes(action);
        const dashboardLifecycleHooks = window.__openclawDashboardLifecycleHooks;
        const resumeDashboardLifecycle = (options = 900) => {
            if (typeof options === 'number') {
                dashboardLifecycleHooks?.resume?.({ delayMs: options });
                return;
            }
            dashboardLifecycleHooks?.resume?.(options || {});
        };
        const refreshStatusCard = () => {
            if (currentPage === 'dashboard') {
                window.__openclawRefreshDashboardStatus?.();
            }
        };

        if (!isSuccess) {
            if (isLifecycleAction) {
                resumeDashboardLifecycle(1100);
                window.__openclawSetTopbarRuntimeHint?.(
                    action === 'stop' ? '停止失败' : action === 'restart' ? '重启失败' : '启动失败',
                    '请结合终端输出继续排查。',
                    { tone: 'offline' }
                );
            }
            appendTerminalLog('[首页动作] 管理命令未正常完成，请结合上方输出来继续排查。\n', 'sys', session.id);
            if (action === 'enable-autostart' || action === 'disable-autostart') {
                window.__openclawRefreshDashboardAutoStart?.({ delayMs: 300, bypassCache: true, showPending: false });
            }
            refreshStatusCard();
            return;
        }

        if (action === 'list-tasks') {
            appendTerminalLog('[首页动作] 查看任务命令已执行完成，上方输出就是当前运行中的任务列表。\n', 'sys', session.id);
            refreshStatusCard();
            return;
        }

        if (action === 'enable-autostart') {
            appendTerminalLog('[首页动作] 已执行启用开机自启命令，可在系统 Startup 目录中复核结果。\n', 'sys', session.id);
            refreshStatusCard();
            window.__openclawRefreshDashboardAutoStart?.({ delayMs: 800, bypassCache: true, showPending: false });
            return;
        }

        if (action === 'disable-autostart') {
            appendTerminalLog('[首页动作] 已执行禁用开机自启命令，可在系统 Startup 目录中复核结果。\n', 'sys', session.id);
            refreshStatusCard();
            window.__openclawRefreshDashboardAutoStart?.({ delayMs: 800, bypassCache: true, showPending: false });
            return;
        }

        if (!isLifecycleAction || !window.api?.getDashboardGatewayStatus) {
            if (isLifecycleAction) {
                resumeDashboardLifecycle(1100);
                window.__openclawSetTopbarRuntimeHint?.(
                    action === 'stop' ? '等待停止确认' : action === 'restart' ? '等待重启确认' : '等待启动确认',
                    '命令已执行，正在刷新最新运行状态...',
                    { tone: 'pending' }
                );
            }
            appendTerminalLog('[首页动作] 管理命令已执行完成。\n', 'sys', session.id);
            refreshStatusCard();
            return;
        }

        resumeDashboardLifecycle(
            mode === 'official' && (action === 'start' || action === 'restart')
                ? { delayMs: 1100, refreshStatus: false }
                : 1100
        );
        window.__openclawSetTopbarRuntimeHint?.(
            action === 'stop' ? '等待停止确认' : action === 'restart' ? '等待重启确认' : '等待启动确认',
            '命令已执行，正在刷新最新运行状态...',
            { tone: 'pending' }
        );

        setTimeout(async () => {
            try {
                const status = await window.api.getDashboardGatewayStatus({ mode });
                const statusText = status?.statusText || (status?.online ? '在线' : '离线');
                const detail = String(status?.detail || '').trim();
                const isOnline = Boolean(status?.online);
                const introMap = {
                    start: '[首页动作] 启动命令已执行完成。这表示管理命令本身已经退出，不代表 Gateway 已经停止。',
                    stop: '[首页动作] 停止命令已执行完成。',
                    restart: '[首页动作] 重启命令已执行完成。'
                };
                const suffix = detail ? ` 当前状态：${statusText}，${detail}` : ` 当前状态：${statusText}。`;
                appendTerminalLog(`${introMap[action] || '[首页动作] 管理命令已执行完成。'}${suffix}\n`, 'sys', session.id);
            } catch (error) {
                appendTerminalLog(`[首页动作] 管理命令已执行完成，但状态刷新失败：${error?.message || error}\n`, 'sys', session.id);
            } finally {
                refreshStatusCard();
            }
        }, 1200);
        setTimeout(async () => {
            if (!window.api?.getDashboardGatewayStatus) return;
            try {
                const status = await window.api.getDashboardGatewayStatus({ mode });
                const isOnline = Boolean(status?.online);
                const statusText = status?.statusText || (isOnline ? '在线' : '离线');
                const detail = String(status?.detail || '').trim();
                const suffix = detail ? ` 当前状态：${statusText}，${detail}` : ` 当前状态：${statusText}。`;

                if ((action === 'start' || action === 'restart') && !isOnline) {
                    appendTerminalLog(`[首页动作] ${action === 'start' ? '启动' : '重启'}命令已退出，但网关仍未在线。请结合上方输出继续排查。${suffix}\n`, 'error', session.id);
                } else if (action === 'stop' && isOnline) {
                    appendTerminalLog(`[首页动作] 停止命令已退出，但网关仍在线。请结合上方输出继续排查。${suffix}\n`, 'error', session.id);
                }
            } catch (_) {}
        }, 1800);

        if (action === 'start' || action === 'restart') {
            scheduleDashboardLifecycleStatusFollowUp(mode, {
                initialDelayMs: mode === 'npm' ? 2400 : 2600,
                intervalMs: mode === 'npm' ? 1200 : 1400,
                maxAttempts: mode === 'npm' ? 10 : 14
            });
        }
    }

    function executeDashboardAction(btnElement, payload) {
        const commandId = payload.id || `dashboard-${Date.now()}`;
        const modeMeta = getDashboardModeMetaV2(payload.mode);
        const mode = payload.mode === 'npm' ? 'npm' : 'official';
        const action = String(payload.action || '').trim();
        const sessionInfo = {
            id: commandId,
            title: payload.title,
            commandCode: payload.previewCommand,
            interactive: false,
        sourceLabel: '首页',
            modeLabel: modeMeta.label,
            triggerButton: btnElement,
            autoReveal: payload.autoReveal !== false
        };
        const pm2ActionsRequiringRuntime = new Set(['start', 'stop', 'restart', 'enable-autostart', 'disable-autostart', 'list-tasks']);
        if (payload.__pm2RuntimeChecked !== true
            && mode === 'npm'
            && pm2ActionsRequiringRuntime.has(action)
            && window.api?.checkPm2RuntimeInstalled
            && window.api?.ensurePm2RuntimeInstalled) {
            Promise.resolve().then(async () => {
                const installSession = ensureSessionRecord(sessionInfo);
        installSession.sourceLabel = payload.sourceLabel || installSession.sourceLabel || '控制台';
                installSession.triggerButton = btnElement;
                installSession.dashboardAction = payload.action;
                installSession.dashboardMode = payload.mode;
                installSession.dashboardIsLifecycleAction = ['start', 'stop', 'restart'].includes(payload.action);
                setSessionState(installSession, 'running');
                setFocusedSession(commandId);
                const runtimeStatus = await window.api.checkPm2RuntimeInstalled().catch((error) => ({
                    ok: false,
                    installed: false,
                    canAutoInstall: false,
                    error: error?.message || String(error),
                    logs: []
                }));
                if (runtimeStatus?.installed) {
                    executeDashboardAction(btnElement, {
                        ...payload,
                        id: commandId,
                        __pm2RuntimeChecked: true
                    });
                    return;
                }

                if (runtimeStatus?.canAutoInstall === false) {
                    const reason = runtimeStatus?.error || '当前缺少系统 Node.js/npm，无法自动安装 PM2。';
                    const runtimeLines = [];
                    if (runtimeStatus?.nodeExe) runtimeLines.push(`[PM2 环境] Node: ${runtimeStatus.nodeExe}`);
                    if (runtimeStatus?.npmCli) runtimeLines.push(`[PM2 环境] npm CLI: ${runtimeStatus.npmCli}`);
                    if (runtimeLines.length) {
                        appendTerminalLog(`${runtimeLines.join('\n')}\n`, 'sys', commandId);
                    }
                    appendTerminalLog(`[PM2 环境] ${reason}\n`, 'error', commandId);
                    window.__openclawSetTopbarRuntimeHint?.('PM2 环境未就绪', reason, { tone: 'offline' });
                    return;
                }

                const actionTextMap = {
                    start: '启动',
                    stop: '停止',
                    restart: '重启',
                    'enable-autostart': '启用 PM2 自启动',
                    'disable-autostart': '禁用 PM2 自启动',
                    'list-tasks': '查看 PM2 任务'
                };
                const actionText = actionTextMap[action] || '执行当前操作';
                const confirmed = window.confirm(`当前未检测到 PM2 启动环境，无法继续${actionText}。\n\n是否现在安装 PM2 启动环境？`);
                if (!confirmed) {
                    appendTerminalLog(`[PM2 环境] 用户取消安装，已停止${actionText}。\n`, 'sys', commandId);
                    return;
                }

                window.__openclawSetTopbarRuntimeHint?.('安装 PM2 环境中', '正在准备 PM2 启动能力，请稍候...', { tone: 'pending' });
                appendTerminalLog('[PM2 环境] 正在安装 PM2 与 pm2-windows-startup，请稍候...\n', 'sys', commandId);
                const installResult = await window.api.ensurePm2RuntimeInstalled().catch((error) => ({
                    ok: false,
                    installed: false,
                    error: error?.message || String(error),
                    logs: []
                }));
                const installLogs = Array.isArray(installResult?.logs) ? installResult.logs.filter(Boolean) : [];
                if (installLogs.length) {
                    appendTerminalLog(`${installLogs.join('\n')}\n`, installResult?.ok ? 'sys' : 'error', commandId);
                }
                if (!installResult?.ok || !installResult?.installed) {
                    const reason = installResult?.error || 'PM2 环境安装失败。';
                    appendTerminalLog(`[PM2 环境] ${reason}\n`, 'error', commandId);
                    window.__openclawSetTopbarRuntimeHint?.('PM2 环境安装失败', reason, { tone: 'offline' });
                    return;
                }

                appendTerminalLog('[PM2 环境] 安装完成，正在继续执行本次 PM2 操作。\n', 'sys', commandId);
                executeDashboardAction(btnElement, {
                    ...payload,
                    id: commandId,
                    __pm2RuntimeChecked: true
                });
            });
            return;
        }
        if (payload.__pm2ServiceChecked !== true
            && mode === 'npm'
            && pm2ActionsRequiringRuntime.has(action)
            && window.api?.checkPm2ServiceInstalled
            && window.api?.ensurePm2ServiceInstalled) {
            Promise.resolve().then(async () => {
                const installSession = ensureSessionRecord(sessionInfo);
                installSession.sourceLabel = payload.sourceLabel || installSession.sourceLabel || '控制台';
                installSession.triggerButton = btnElement;
                installSession.dashboardAction = payload.action;
                installSession.dashboardMode = payload.mode;
                installSession.dashboardIsLifecycleAction = ['start', 'stop', 'restart'].includes(payload.action);
                setSessionState(installSession, 'running');
                setFocusedSession(commandId);
                const serviceStatus = await window.api.checkPm2ServiceInstalled().catch((error) => ({
                    ok: false,
                    installed: false,
                    error: error?.message || String(error),
                    logs: []
                }));
                if (serviceStatus?.installed) {
                    executeDashboardAction(btnElement, {
                        ...payload,
                        id: commandId,
                        __pm2RuntimeChecked: true,
                        __pm2ServiceChecked: true
                    });
                    return;
                }

                window.__openclawSetTopbarRuntimeHint?.('初始化 PM2 服务中', '正在准备 OpenClaw 的 PM2 服务配置，请稍候...', { tone: 'pending' });
                appendTerminalLog('[PM2 服务] 未检测到 OpenClaw PM2 服务配置，正在初始化...\n', 'sys', commandId);
                const installResult = await window.api.ensurePm2ServiceInstalled().catch((error) => ({
                    ok: false,
                    installed: false,
                    error: error?.message || String(error),
                    logs: []
                }));
                const installLogs = Array.isArray(installResult?.logs) ? installResult.logs.filter(Boolean) : [];
                if (installLogs.length) {
                    appendTerminalLog(`${installLogs.join('\n')}\n`, installResult?.ok ? 'sys' : 'error', commandId);
                }
                if (!installResult?.ok || !installResult?.installed) {
                    const reason = installResult?.error || 'OpenClaw PM2 服务初始化失败。';
                    appendTerminalLog(`[PM2 服务] ${reason}\n`, 'error', commandId);
                    window.__openclawSetTopbarRuntimeHint?.('PM2 服务初始化失败', reason, { tone: 'offline' });
                    return;
                }

                appendTerminalLog('[PM2 服务] 初始化完成，正在继续执行本次 PM2 操作。\n', 'sys', commandId);
                executeDashboardAction(btnElement, {
                    ...payload,
                    id: commandId,
                    __pm2RuntimeChecked: true,
                    __pm2ServiceChecked: true
                });
            });
            return;
        }
        const legacyDashboardSession = ensureSessionRecord({
            id: commandId,
            title: payload.title,
            commandCode: payload.previewCommand,
            interactive: false,
            sourceLabel: '首页',
            modeLabel: modeMeta.label,
            triggerButton: btnElement,
            autoReveal: payload.autoReveal !== false
        });
        const session = legacyDashboardSession;
        ensureSessionRecord(sessionInfo);

        session.sourceLabel = payload.sourceLabel || session.sourceLabel || '控制台';
        session.triggerButton = btnElement;
        session.dashboardAction = payload.action;
        session.dashboardMode = payload.mode;
        session.dashboardIsLifecycleAction = ['start', 'stop', 'restart'].includes(payload.action);
        setActionButtonBusy(btnElement, '执行中...');
        setSessionState(session, 'running');
        setFocusedSession(commandId);

        if (session.dashboardIsLifecycleAction) {
            window.__openclawDashboardLifecycleHooks?.pause?.();
            const lifecycleLabelMap = {
                start: '启动中',
                stop: '停止中',
                restart: '重启中'
            };
            const lifecycleVerbMap = {
                start: '启动',
                stop: '停止',
                restart: '重启'
            };
            const lifecycleToneMap = {
                start: 'pending',
                stop: 'pending',
                restart: 'pending'
            };
            const lifecycleLabel = lifecycleLabelMap[payload.action] || '执行中';
            const lifecycleVerb = lifecycleVerbMap[payload.action] || '执行';
            window.__openclawSetTopbarRuntimeHint?.(
                lifecycleLabel,
                `正在按 ${modeMeta.label} 方式${lifecycleVerb} OpenClaw，请稍候...`,
                { tone: lifecycleToneMap[payload.action] || 'pending' }
            );
            appendTerminalLog(`[首页动作] 正在按 ${modeMeta.label} 方式${lifecycleVerb} OpenClaw，请稍候...\n`, 'sys', commandId);
        }

        if (window.api?.executeDashboardAction) {
            window.api.executeDashboardAction({
                id: commandId,
                action: payload.action,
                mode: payload.mode,
                previewCommand: payload.previewCommand
            });
        } else {
            appendTerminalLog('(璀﹀憡: 褰撳墠鏈湪 Electron 妗岄潰鐜杩愯锛屼粎涓烘ā鎷熷姩浣?\n', 'error', commandId);
            setTimeout(() => finishCommandOnUI(commandId, 0), 800);
        }
    }

    async function executeCommand(btnElement, commandId, commandCode, options = {}) {
        // 鏋佽嚧鍏煎澶勭悊锛氬幓闄ょ┖鏍笺€佽浆灏忓啓锛屾嫤鎴墍鏈夋枩鏉犳垨鏂板缓鎸囦护
        const cleanCmd = (commandCode || "").trim().toLowerCase();
        
        // 鐗规畩鎷︽埅锛氬鏋滄槸鑱婂ぉ鍔╂墜鎸囦护 (浠?/ 寮€澶? 鎴栬€?openclaw new
        if (cleanCmd.startsWith('/') || cleanCmd === 'openclaw new') {
            // 璺宠浆鍒拌亰澶╃獥鍙?
            document.querySelector('.nav-links li[data-page="chat"]').click();
            // 绛夊緟 webview 娓叉煋鍜屽氨缁紝鐒跺悗鍙?IPC
            setTimeout(() => {
                const webview = document.getElementById('chatWebview');
                if (webview) {
                    // 閫氳繃 send() 鐩存帴灏嗙郴缁熺骇鎸囦护鎺ㄩ€佸埌 webview 鐨?preload 閲?
                    webview.send('inject-chat-command', commandCode.trim());
                }
            }, 500); // 棰勭暀澶氫竴鐐瑰姩鐢绘覆鏌撴椂闂?
            return;
        }

        const interactive = options.interactive ?? isInteractiveCommand(commandCode);
        const timeout = options.timeout !== undefined ? options.timeout : (interactive ? 0 : undefined);

        if (currentPage === 'commands') {
            await dismissRunningCommandsInlineInteractiveSession(commandId);
        }

        const session = ensureSessionRecord({
            id: commandId,
            title: options.title || commandCode,
            commandCode,
            interactive,
            inlineLogScope: currentPage === 'commands' ? 'commands' : '',
        sourceLabel: options.sourceLabel || (currentPage === 'dashboard' ? '首页' : '指令大全'),
            modeLabel: options.modeLabel || null,
            triggerButton: btnElement,
            autoReveal: options.autoReveal !== undefined ? options.autoReveal : (currentPage !== 'commands')
        });

        session.triggerButton = btnElement;
        setActionButtonBusy(btnElement, interactive ? '连接交互...' : '执行中...');
        setSessionState(session, 'running');
        setFocusedSession(commandId);

        if (currentPage === 'commands') {
            hideTerminalPanel();
            focusCommandsInlineLog();
            if (interactive) {
                focusCommandsInlineTerminalSurface();
            }
        }

        if (window.api && window.api.executeCommand) {
            window.api.executeCommand(
                commandId,
                commandCode,
                timeout,
                interactive,
                options.commandOptions || {}
            );
        } else {
            appendTerminalLog('(璀﹀憡: 褰撳墠鏈湪 Electron 妗岄潰鐜杩愯锛屼粎涓烘ā鎷熷姩浣?\n', 'error', commandId);
            setTimeout(() => { finishCommandOnUI(commandId, 0); }, 1000);
        }
    }

    window.__openclawRunCommand = (commandCode, options = {}) => {
        const sessionId = options.id || `panel-${Date.now()}`;
        executeCommand(options.button || null, sessionId, commandCode, options);
        return sessionId;
    };

    if (window.api) {
        window.api.onCommandStarted((data) => {
            const session = commandSessions.get(data.id);
            if (session) {
                if (data?.command && session.commandEl) {
                    session.commandEl.textContent = String(data.command);
                }
                setSessionState(session, 'running');
            }
            scheduleSilentCommandNotice(data?.id);
            notifyCommandSessionObservers('started', {
                id: data?.id,
                command: String(data?.command || ''),
                session: buildCommandSessionSnapshot(session || commandSessions.get(data?.id))
            });
        });

        window.api.onCommandStream((data) => {
            appendTerminalLog(data.text, data.type, data.id);
        });

        window.api.onCommandFinished((data) => {
            clearSilentCommandNotice(data?.id);
            const session = commandSessions.get(data.id);
            appendTerminalLog(`\n[命令结束] 退出码: ${data.code}\n`, 'sys', data.id);
            finishCommandOnUI(data.id, data.code);
            summarizeDashboardActionResult(session, data.code);
            notifyCommandSessionObservers('finished', {
                id: data?.id,
                code: data?.code,
                session: buildCommandSessionSnapshot(commandSessions.get(data?.id))
            });
        });
    }

    // --- 浜嬩欢鐩戝惉锛氫晶杈规爮鑿滃崟鍒囨崲 ---
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            navigateToPage(e.currentTarget.getAttribute('data-page'));
        });
    });

    // --- 浜嬩欢鐩戝惉锛氬叏灞€鎼滅储妗?---
    let searchTimer;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            const nextQuery = e.target.value.trim();
            if (searchQuery === nextQuery) return;
            searchQuery = nextQuery;
            if (currentPage === 'commands') {
                scheduleUiFlush(() => {
                    if (currentPage === 'commands') {
                        refreshCommandsPage();
                    }
                }, 1);
                return;
            }
            renderPage();
            return;
            // 涓嶅啀閲嶇疆鏁翠釜 DOM锛屽彧鏇存柊闇€瑕佹洿鏂扮殑鍐呮兜锛佽繖瑙ｅ喅浜嗘悳绱犳椂鐨勫埛鏂伴棶棰橈紒
            renderPage();
        }, 300);
    });

    // --- Spotlight 鎮诞鎼滅储涓績閫昏緫 ---
    function toggleSpotlight(show) {
        if (show) {
            spotlightOverlay.style.display = 'flex';
            spotlightInput.value = '';
            spotlightInput.focus();
            updateSpotlightResults();
        } else {
            spotlightOverlay.style.display = 'none';
        }
    }

    document.addEventListener('keydown', (e) => {
        // 濡傛灉鍦ㄦ櫘閫氳緭鍏ユ閲岃緭鍏ユ枃瀛楋紝蹇界暐蹇嵎閿?
        if (e.target.tagName === 'INPUT' && e.target.id !== 'spotlightInput' && e.target.id !== 'globalSearch') return;
        
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            toggleSpotlight(true);
        } else if (e.key === '/') {
            if(document.activeElement !== searchInput && document.activeElement !== spotlightInput) {
                e.preventDefault();
                toggleSpotlight(true);
                spotlightInput.value = '/';
            }
        } else if (e.key === 'Escape' && spotlightOverlay.style.display === 'flex') {
            toggleSpotlight(false);
        }
    });

    spotlightOverlay.addEventListener('click', (e) => {
        if (e.target === spotlightOverlay) toggleSpotlight(false);
    });

    function updateSpotlightResults() {
        // Spotlight 鎼滅储淇锛氭敮鎸佸ぇ娈典腑鏂囧懡浠よ繃婊?
        const query = spotlightInput.value.toLowerCase().replace('/', '').trim();
        spotlightResults.innerHTML = '';
        spotlightSelectedIndex = -1;

        if (!query) {
             currentFilteredCommands = commandsDB.slice(0, 10);
        } else {
             currentFilteredCommands = commandsDB.filter(cmd => {
                return cmd.name.toLowerCase().includes(query) || 
                       cmd.desc.toLowerCase().includes(query) ||
                       cmd.code.toLowerCase().includes(query);
            }).slice(0, 8);
        }

        if (currentFilteredCommands.length === 0) {
            spotlightResults.innerHTML = '<li class="spotlight-result-item" style="justify-content:center; color:var(--text-muted); cursor:default;">鏃犲尮閰嶆寚浠?/li>';
            return;
        }

        currentFilteredCommands.forEach((cmd, index) => {
            const li = document.createElement('li');
            li.className = 'spotlight-result-item';
            li.innerHTML = `
                <div>
                    <div class="spotlight-result-cmd">${cmd.code}</div>
                    <div class="spotlight-result-desc">${cmd.name} - ${cmd.desc}</div>
                </div>
            `;
            li.addEventListener('click', () => { triggerSpotlightExecution(cmd); });
            spotlightResults.appendChild(li);
        });
        
        highlightSpotlightItem(0);
    }

    function highlightSpotlightItem(index) {
        const items = spotlightResults.querySelectorAll('.spotlight-result-item');
        if (items.length === 0) return;
        
        items.forEach(i => i.classList.remove('selected'));
        if (index >= 0 && index < items.length) {
            items[index].classList.add('selected');
            spotlightSelectedIndex = index;
            items[index].scrollIntoView({ block: 'nearest' });
        }
    }

    function triggerSpotlightExecution(cmd) {
        toggleSpotlight(false);
        const fakeBtn = document.createElement('button');
        fakeBtn.innerText = "Spotlight杩愯";
        prepareAndExecuteCommand(fakeBtn, cmd.id, cmd.code);
    }

    spotlightInput.addEventListener('keydown', (e) => {
        const items = spotlightResults.querySelectorAll('.spotlight-result-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (spotlightSelectedIndex < items.length - 1) {
                highlightSpotlightItem(spotlightSelectedIndex + 1);
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (spotlightSelectedIndex > 0) {
                highlightSpotlightItem(spotlightSelectedIndex - 1);
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (spotlightSelectedIndex >= 0 && currentFilteredCommands.length > 0) {
                triggerSpotlightExecution(currentFilteredCommands[spotlightSelectedIndex]);
            }
        }
    });

    spotlightInput.addEventListener('input', updateSpotlightResults);

    // Bootstrap!
    initThemeMode();
    initSidebarLayout();
    initViewsOnce();
    renderPage();
    window.setTimeout(() => {
        maybeAutoLaunchRuntimeOnAppStart();
    }, 220);
});

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeSelectorValue(value) {
    const text = String(value ?? '');
    if (window.CSS?.escape) return window.CSS.escape(text);
    return text.replace(/["\\]/g, '\\$&');
}

function showConfirmDialog(message, options = {}) {
    const title = options.title || '确认操作';
    const confirmText = options.confirmText || '确定';
    const cancelText = options.cancelText || '取消';

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'ocp-dialog-overlay';
        overlay.innerHTML = `
            <div class="ocp-dialog">
                <div class="ocp-dialog-title">${escapeHtml(title)}</div>
                <div class="ocp-dialog-body">${escapeHtml(message)}</div>
                <div class="ocp-dialog-actions">
                    <button data-action="cancel" class="ocp-dialog-btn">${escapeHtml(cancelText)}</button>
                    <button data-action="confirm" class="ocp-dialog-btn primary danger">${escapeHtml(confirmText)}</button>
                </div>
            </div>
        `;

        const close = (result) => {
            overlay.remove();
            resolve(result);
        };

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close(false);
        });
        overlay.querySelector('[data-action="cancel"]').onclick = () => close(false);
        overlay.querySelector('[data-action="confirm"]').onclick = () => close(true);
        document.body.appendChild(overlay);
        overlay.querySelector('[data-action="confirm"]').focus();
    });
}

function showFormDialog({ title, description = '', fields, confirmText = '保存', cancelText = '取消', onConfirm, onClose, onFieldChange }) {
    if (typeof window.__openclawActiveFormDialogClose === 'function') {
        try {
            window.__openclawActiveFormDialogClose('replace');
        } catch (_) {}
    }
    const overlay = document.createElement('div');
    overlay.className = 'ocp-dialog-overlay';
    const normalizeSelectOptions = (options = []) => {
        const selectLabelMap = {
            '': '默认',
            default: '默认',
            open: '开放',
            pairing: '配对审批',
            allowlist: '白名单',
            disabled: '停用',
            allow: '允许',
            deny: '拒绝',
            mentioned: '仅提及',
            websocket: 'WebSocket',
            webhook: 'Webhook',
            markdown: 'Markdown',
            card: '卡片',
            all: '全部',
            true: '启用',
            false: '关闭'
        };
        return (options || []).map((option) => {
            if (Array.isArray(option)) {
                const rawValue = String(option[0] ?? '');
                const rawLabel = String(option[1] ?? option[0] ?? '');
                return {
                    value: rawValue,
                    label: selectLabelMap[rawLabel] || rawLabel
                };
            }
            if (option && typeof option === 'object') {
                const rawValue = String(option.value ?? '');
                const rawLabel = String(option.label ?? option.value ?? '');
                return {
                    value: rawValue,
                    label: selectLabelMap[rawLabel] || rawLabel
                };
            }
            const rawValue = String(option ?? '');
            return {
                value: rawValue,
                label: selectLabelMap[rawValue] || rawValue
            };
        });
    };

    const fieldHtml = fields.map((field) => {
        const labelHtml = `<label class="ocp-dialog-label">${escapeHtml(field.label)}</label>`;
        const descriptionHtml = (field.description || field.hint)
            ? `<div class="ocp-dialog-field-copy">${escapeHtml(field.description || field.hint)}</div>`
            : '';
        const errorHtml = `<div class="ocp-dialog-field-error" data-role="field-error" data-field-error="${escapeHtml(field.name)}"></div>`;

        if (field.type === 'select') {
            const normalizedOptions = normalizeSelectOptions(field.options || []);
            const currentValue = String(field.value ?? '');
            return `
                <div class="ocp-dialog-field">
                    ${labelHtml}
                    ${descriptionHtml}
                    <select data-field="${escapeHtml(field.name)}" ${(field.readonly || field.disabled) ? 'disabled' : ''} class="ocp-dialog-input ocp-dialog-select">
                        ${normalizedOptions.map(option => `<option value="${escapeHtml(option.value)}" ${option.value === currentValue ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
                    </select>
                    ${errorHtml}
                </div>
            `;
        }

        if (field.type === 'textarea') {
            return `
                <div class="ocp-dialog-field">
                    ${labelHtml}
                    ${descriptionHtml}
                    <textarea
                        data-field="${escapeHtml(field.name)}"
                        placeholder="${escapeHtml(field.placeholder ?? '')}"
                        ${field.readonly ? 'readonly' : ''}
                        ${(field.readonly || field.disabled) ? 'disabled' : ''}
                        class="ocp-dialog-input ocp-dialog-textarea ${field.readonly ? 'is-readonly' : ''}">${escapeHtml(field.value ?? '')}</textarea>
                    ${errorHtml}
                </div>
            `;
        }

        if (field.type === 'checkbox') {
            return `
                <div class="ocp-dialog-field ocp-dialog-field-checkbox">
                    <label class="ocp-dialog-checkbox-wrap">
                        <input
                            data-field="${escapeHtml(field.name)}"
                            type="checkbox"
                            ${field.value ? 'checked' : ''}
                            ${(field.readonly || field.disabled) ? 'disabled' : ''}>
                        <span>${escapeHtml(field.label)}</span>
                    </label>
                    ${descriptionHtml}
                    ${errorHtml}
                </div>
            `;
        }

        const inputType = field.secret ? 'password' : (field.inputType || 'text');
        return `
            <div class="ocp-dialog-field">
                ${labelHtml}
                ${descriptionHtml}
                <input
                    data-field="${escapeHtml(field.name)}"
                    type="${escapeHtml(inputType)}"
                    value="${escapeHtml(field.value ?? '')}"
                    placeholder="${escapeHtml(field.placeholder ?? '')}"
                    ${field.readonly ? 'readonly' : ''}
                    ${(field.readonly || field.disabled) ? 'disabled' : ''}
                    class="ocp-dialog-input ${field.readonly ? 'is-readonly' : ''}">
                ${errorHtml}
            </div>
        `;
    }).join('');

    overlay.innerHTML = `
        <div class="ocp-dialog ocp-dialog-form">
            <div class="ocp-dialog-title">${escapeHtml(title)}</div>
            ${description ? `<div class="ocp-dialog-lead">${escapeHtml(description)}</div>` : ''}
            ${fieldHtml}
            <div data-role="status" class="ocp-dialog-status"></div>
            <div class="ocp-dialog-actions">
                <button data-action="cancel" class="ocp-dialog-btn">${escapeHtml(cancelText)}</button>
                <button data-action="confirm" class="ocp-dialog-btn primary">${escapeHtml(confirmText)}</button>
            </div>
        </div>
    `;

    let closed = false;
    const close = (reason = 'cancel') => {
        if (closed) return;
        closed = true;
        if (window.__openclawActiveFormDialogClose === close) {
            window.__openclawActiveFormDialogClose = null;
        }
        overlay.remove();
        if (typeof onClose === 'function') {
            try {
                onClose(reason);
            } catch (_) {}
        }
    };
    const statusEl = overlay.querySelector('[data-role="status"]');
    const confirmBtn = overlay.querySelector('[data-action="confirm"]');
    const readValues = () => {
        const values = {};
        overlay.querySelectorAll('[data-field]').forEach((field) => {
            values[field.dataset.field] = field.type === 'checkbox' ? field.checked : field.value;
        });
        return values;
    };
    const findFieldEl = (fieldName) => overlay.querySelector(`[data-field="${escapeSelectorValue(fieldName)}"]`);
    const clearFieldErrors = () => {
        overlay.querySelectorAll('[data-role="field-error"]').forEach((node) => {
            node.textContent = '';
        });
    };
    const dialogApi = {
        close: (reason = 'confirm') => close(reason),
        setStatus: (text, color = '#ff8080') => {
            statusEl.textContent = text;
            statusEl.style.color = color;
        },
        setFieldError: (fieldName, text) => {
            const errorEl = overlay.querySelector(`[data-field-error="${escapeSelectorValue(fieldName)}"]`);
            if (errorEl) errorEl.textContent = text || '';
        },
        clearFieldErrors,
        getValues: readValues,
        setFieldValue: (fieldName, value) => {
            const fieldEl = findFieldEl(fieldName);
            if (!fieldEl) return false;
            if (fieldEl.type === 'checkbox') {
                fieldEl.checked = Boolean(value);
            } else {
                fieldEl.value = value == null ? '' : String(value);
            }
            return true;
        },
        setFieldOptions: (fieldName, options = [], selectedValue = undefined) => {
            const fieldEl = findFieldEl(fieldName);
            if (!(fieldEl instanceof HTMLSelectElement)) return false;
            const normalizedOptions = normalizeSelectOptions(options);
            const nextValue = selectedValue === undefined ? String(fieldEl.value ?? '') : String(selectedValue ?? '');
            fieldEl.innerHTML = normalizedOptions.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === nextValue ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
            if (![...fieldEl.options].some((option) => option.value === nextValue) && fieldEl.options.length) {
                fieldEl.value = fieldEl.options[0].value;
            }
            return true;
        },
        setFieldDisabled: (fieldName, disabled) => {
            const fieldEl = findFieldEl(fieldName);
            if (!fieldEl) return false;
            fieldEl.disabled = Boolean(disabled);
            return true;
        }
    };
    const notifyFieldChange = async (fieldName) => {
        if (!fieldName || typeof onFieldChange !== 'function') return;
        try {
            await onFieldChange(fieldName, readValues(), dialogApi);
        } catch (error) {
            console.warn('[FormDialog] Field change handler failed:', error);
        }
    };

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close('cancel');
    });
    overlay.querySelector('[data-action="cancel"]').onclick = () => close('cancel');
    confirmBtn.onclick = async () => {
        const values = readValues();

        confirmBtn.disabled = true;
        clearFieldErrors();
        statusEl.style.color = '#8f98ab';
        statusEl.textContent = '处理中...';

        try {
            await onConfirm(values, dialogApi);
        } catch (error) {
            statusEl.style.color = '#ff8080';
            statusEl.textContent = error?.message || String(error);
            confirmBtn.disabled = false;
        }

        if (!closed) {
            confirmBtn.disabled = false;
            if (statusEl.textContent === '处理中...') {
                statusEl.textContent = '';
                statusEl.style.color = '#8f98ab';
            }
        }
    };

    overlay.addEventListener('input', (event) => {
        const fieldName = event.target?.getAttribute?.('data-field');
        if (!fieldName) return;
        const errorEl = overlay.querySelector(`[data-field-error="${escapeSelectorValue(fieldName)}"]`);
        if (errorEl?.textContent) errorEl.textContent = '';
    });
    overlay.addEventListener('change', (event) => {
        const fieldName = event.target?.getAttribute?.('data-field');
        if (!fieldName) return;
        const errorEl = overlay.querySelector(`[data-field-error="${escapeSelectorValue(fieldName)}"]`);
        if (errorEl?.textContent) errorEl.textContent = '';
        void notifyFieldChange(fieldName);
    });

    window.__openclawActiveFormDialogClose = close;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-field]')?.focus();
}

window.showConfirmDialog = showConfirmDialog;
window.showFormDialog = showFormDialog;

// =======================================================
// 妯″瀷閰嶇疆椤?(Ported from clawpanel models.js)
// =======================================================
async function renderModelsPage(container) {
    container.innerHTML = `
        <div style="padding:24px 28px">
            <h2 class="page-title">模型配置</h2>
            <p class="page-desc">管理 AI 服务商与可用模型，设置主模型和备选模型。</p>
            <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap;align-items:center">
                <button id="mpBtnAddProvider" style="padding:8px 18px;background:var(--accent,#78dce8);color:#1e1e24;border:none;border-radius:8px;cursor:pointer;font-weight:600">+ 新增服务商</button>
                <button id="mpBtnSave" style="padding:8px 18px;background:#a9dc76;color:#1e1e24;border:none;border-radius:8px;cursor:pointer;font-weight:600">保存配置</button>
                <span id="mpSaveStatus" style="font-size:13px;color:#8b8b93"></span>
            </div>
            <div id="mpDefaultBar" style="margin-bottom:14px"></div>
            <div id="mpProvidersList"><div style="color:#8b8b93;padding:20px">正在加载配置...</div></div>
        </div>
    `;

    let config = null;
    try {
        config = await window.api.getOpenClawConfig();
    } catch(e) {}

    if (!config) {
        container.querySelector('#mpProvidersList').innerHTML = '<div style="color:#ff6188;padding:20px">无法加载配置文件</div>';
        return;
    }
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};

    const state = { config };

    function getPrimary() {
        return config?.agents?.defaults?.model?.primary || '';
    }

    function collectAllModels() {
        const result = [];
        const providers = config?.models?.providers || {};
        for (const [pk, pv] of Object.entries(providers)) {
            for (const m of (pv.models || [])) {
                const id = typeof m === 'string' ? m : m.id;
                if (id) result.push({ provider: pk, modelId: id, full: `${pk}/${id}` });
            }
        }
        return result;
    }

    function renderDefaultBar() {
        const bar = container.querySelector('#mpDefaultBar');
        const primary = getPrimary();
        const allModels = collectAllModels();
        const fallbacks = allModels.filter(m => m.full !== primary).map(m => m.full);
        bar.innerHTML = `
            <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px 16px;display:flex;gap:20px;flex-wrap:wrap">
                <span style="color:#8b8b93;font-size:13px">涓绘ā鍨嬶細<span style="color:${primary ? '#a9dc76' : '#ff6188'};font-family:monospace">${primary || '鏈厤缃?'}</span></span>
                <span style="color:#8b8b93;font-size:13px">澶囬€夛細<span style="color:#8b8b93">${fallbacks.length ? fallbacks.slice(0,3).join(', ') + (fallbacks.length > 3 ? '...' : '') : '鏃?'}</span></span>
            </div>`;
    }

    function renderProviders() {
        const listEl = container.querySelector('#mpProvidersList');
        const providers = config?.models?.providers || {};
        const keys = Object.keys(providers);
        const primary = getPrimary();
        if (!keys.length) {
            listEl.innerHTML = '<div style="color:#8b8b93;padding:20px;text-align:center">鏆傛棤鏈嶅姟鍟嗭紝鐐瑰嚮銆? 娣诲姞鏈嶅姟鍟嗐€嶅紑濮嬮厤缃?/div>';
            return;
        }
        listEl.innerHTML = keys.map(key => {
            const p = providers[key];
            const models = p.models || [];
            return `
            <div class="mpProvider" data-key="${key}" style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px 18px;margin-bottom:14px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
                    <span style="font-weight:600;color:#e0e0e0">${key} <span style="font-size:11px;color:#8b8b93;font-weight:400">${p.api || 'openai'} 路 ${models.length} 涓ā鍨?/span></span>
                    <div style="display:flex;gap:7px">
                        <button class="mpEditProv" style="padding:5px 12px;background:rgba(255,255,255,0.07);border:none;border-radius:6px;color:#e0e0e0;cursor:pointer;font-size:12px">缂栬緫</button>
                        <button class="mpAddModel" style="padding:5px 12px;background:rgba(255,255,255,0.07);border:none;border-radius:6px;color:#e0e0e0;cursor:pointer;font-size:12px">+ 妯″瀷</button>
                        <button class="mpDelProvider" style="padding:5px 12px;background:#ff618820;border:none;border-radius:6px;color:#ff6188;cursor:pointer;font-size:12px">鍒犻櫎</button>
                    </div>
                </div>
                <div class="mpModels">
                    ${models.map(m => {
                        const id = typeof m === 'string' ? m : m.id;
                        const full = `${key}/${id}`;
                        const isPrim = full === primary;
                        return `
                        <div class="mpModelRow" data-modelid="${id}" data-full="${full}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:7px;margin-bottom:5px;background:${isPrim ? 'rgba(169,220,118,0.08)' : 'rgba(255,255,255,0.02)'};border:1px solid ${isPrim ? '#a9dc7640' : 'rgba(255,255,255,0.05)'}">
                            <span style="flex:1;font-family:monospace;font-size:13px;color:#e0e0e0">${id}</span>
                            ${isPrim ? '<span style="font-size:11px;background:#a9dc76;color:#1e1e24;padding:1px 8px;border-radius:5px">涓绘ā鍨?/span>' : ''}
                            ${!isPrim ? `<button class="mpSetPrimary" style="padding:4px 10px;background:rgba(255,255,255,0.07);border:none;border-radius:5px;color:#8b8b93;cursor:pointer;font-size:11px">璁句负涓绘ā鍨?/button>` : ''}
                            <button class="mpTestModel" style="padding:4px 10px;background:rgba(255,255,255,0.07);border:none;border-radius:5px;color:#78dce8;cursor:pointer;font-size:11px">娴嬭瘯</button>
                            <button class="mpDelModel" style="padding:4px 10px;background:#ff618820;border:none;border-radius:5px;color:#ff6188;cursor:pointer;font-size:11px">鍒犻櫎</button>
                        </div>`;
                    }).join('')}
                </div>
            </div>`;
        }).join('');

        // Bind buttons
        listEl.querySelectorAll('.mpProvider').forEach(section => {
            const key = section.dataset.key;
            const provider = config.models.providers[key];

            section.querySelector('.mpDelProvider').onclick = async () => {
                if (!confirm(`纭畾鍒犻櫎銆?{key}銆嶅強鍏舵墍鏈夋ā鍨嬶紵`)) return;
                delete config.models.providers[key];
                renderProviders(); renderDefaultBar();
            };

            section.querySelector('.mpEditProv').onclick = () => {
                showProviderModal(key, provider);
            };

            section.querySelector('.mpAddModel').onclick = () => {
                showAddModelModal(key);
            };

            section.querySelectorAll('.mpModelRow').forEach(row => {
                const modelId = row.dataset.modelid;
                const full = row.dataset.full;

                const setPrimBtn = row.querySelector('.mpSetPrimary');
                if (setPrimBtn) {
                    setPrimBtn.onclick = () => {
                        if (!config.agents) config.agents = {};
                        if (!config.agents.defaults) config.agents.defaults = {};
                        if (!config.agents.defaults.model) config.agents.defaults.model = {};
                        config.agents.defaults.model.primary = full;
                        renderProviders(); renderDefaultBar();
                    };
                }

                const testBtn = row.querySelector('.mpTestModel');
                if (testBtn) {
                    testBtn.onclick = async () => {
                        const pData = config.models.providers[key];
                        const modelFull = `${key}/${modelId}`;
                        testBtn.textContent = '娴嬭瘯涓?..';
                        testBtn.disabled = true;
                        const t0 = Date.now();
                        try {
                            const res = await fetch(`${pData.baseUrl || ''}/chat/completions`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pData.apiKey || ''}` },
                                body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
                                signal: AbortSignal.timeout(10000)
                            });
                            const ms = Date.now() - t0;
                            if (res.ok || res.status === 200) {
                                testBtn.textContent = `鉁?${(ms/1000).toFixed(1)}s`;
                                testBtn.style.color = '#a9dc76';
                            } else {
                                testBtn.textContent = `鉂?${res.status}`;
                                testBtn.style.color = '#ff6188';
                            }
                        } catch(e) {
                            testBtn.textContent = '鉂?瓒呮椂';
                            testBtn.style.color = '#ff6188';
                        }
                        testBtn.disabled = false;
                    };
                }

                const delBtn = row.querySelector('.mpDelModel');
                if (delBtn) {
                    delBtn.onclick = () => {
                        if (!confirm(`鍒犻櫎妯″瀷銆?{modelId}銆嶏紵`)) return;
                        const idx = (provider.models || []).findIndex(m => (typeof m === 'string' ? m : m.id) === modelId);
                        if (idx >= 0) provider.models.splice(idx, 1);
                        renderProviders(); renderDefaultBar();
                    };
                }
            });
        });
    }

    function showProviderModal(existingKey, existingData) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center';
        overlay.innerHTML = `
            <div style="background:#2c2c3a;border-radius:14px;padding:24px;min-width:380px;max-width:540px;width:90%">
                <h3 style="color:#e0e0e0;margin:0 0 16px">${existingKey ? '编辑服务商' : '添加服务商'}</h3>
                <div style="display:flex;flex-direction:column;gap:12px">
                    <div><label style="color:#8b8b93;font-size:13px;display:block;margin-bottom:4px">鏈嶅姟鍟嗗悕绉帮紙鍞竴鏍囪瘑锛?/label>
                        <input id="mpProvKey" value="${existingKey || ''}" ${existingKey ? 'readonly' : ''} style="width:100%;padding:8px 10px;background:#1e1e24;border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;font-size:13px;box-sizing:border-box"></div>
                    <div><label style="color:#8b8b93;font-size:13px;display:block;margin-bottom:4px">Base URL</label>
                        <input id="mpProvUrl" value="${existingData?.baseUrl || ''}" placeholder="https://api.openai.com/v1" style="width:100%;padding:8px 10px;background:#1e1e24;border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;font-size:13px;box-sizing:border-box"></div>
                    <div><label style="color:#8b8b93;font-size:13px;display:block;margin-bottom:4px">API Key</label>
                        <input id="mpProvKey2" type="password" value="${existingData?.apiKey || ''}" placeholder="sk-..." style="width:100%;padding:8px 10px;background:#1e1e24;border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;font-size:13px;box-sizing:border-box"></div>
                    <div><label style="color:#8b8b93;font-size:13px;display:block;margin-bottom:4px">API 绫诲瀷</label>
                        <select id="mpProvApi" style="width:100%;padding:8px 10px;background:#1e1e24;border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;font-size:13px">
                            <option value="openai-completions" ${existingData?.api === 'openai-completions' ? 'selected' : ''}>OpenAI-鍏煎 (ChatCompletions)</option>
                            <option value="anthropic-messages" ${existingData?.api === 'anthropic-messages' ? 'selected' : ''}>Anthropic (Messages)</option>
                            <option value="google-gemini" ${existingData?.api === 'google-gemini' ? 'selected' : ''}>Google Gemini</option>
                        </select>
                    </div>
                </div>
                <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:10px">
                    <button id="mpProvCancel" style="padding:8px 18px;background:rgba(255,255,255,0.07);border:none;border-radius:7px;color:#e0e0e0;cursor:pointer">取消</button>
                    <button id="mpProvSave" style="padding:8px 18px;background:#78dce8;color:#1e1e24;border:none;border-radius:7px;cursor:pointer;font-weight:600">保存</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#mpProvCancel').onclick = () => overlay.remove();
        overlay.querySelector('#mpProvSave').onclick = () => {
            const key = overlay.querySelector('#mpProvKey').value.trim();
            const url = overlay.querySelector('#mpProvUrl').value.trim();
            const apiKey = overlay.querySelector('#mpProvKey2').value.trim();
            const api = overlay.querySelector('#mpProvApi').value;
            if (!key) { alert('请填写服务商名称'); return; }
            if (!config.models) config.models = {};
            if (!config.models.providers) config.models.providers = {};
            if (existingKey) {
                config.models.providers[existingKey].baseUrl = url;
                config.models.providers[existingKey].apiKey = apiKey;
                config.models.providers[existingKey].api = api;
            } else {
                config.models.providers[key] = { baseUrl: url, apiKey, api, models: [] };
            }
            overlay.remove();
            renderProviders(); renderDefaultBar();
        };
    }

    function showAddModelModal(providerKey) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center';
        overlay.innerHTML = `
            <div style="background:#2c2c3a;border-radius:14px;padding:24px;min-width:360px">
                <h3 style="color:#e0e0e0;margin:0 0 14px">新增模型到 ${providerKey}</h3>
                <input id="mpNewModelId" placeholder="模型 ID，例如 gpt-4o、claude-3-5-sonnet-20241022" style="width:100%;padding:8px 10px;background:#1e1e24;border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;font-size:13px;box-sizing:border-box">
                <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:10px">
                    <button id="mpAddCancel" style="padding:7px 16px;background:rgba(255,255,255,0.07);border:none;border-radius:7px;color:#e0e0e0;cursor:pointer">取消</button>
                    <button id="mpAddConfirm" style="padding:7px 16px;background:#78dce8;color:#1e1e24;border:none;border-radius:7px;cursor:pointer;font-weight:600">新增</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#mpAddCancel').onclick = () => overlay.remove();
        overlay.querySelector('#mpAddConfirm').onclick = () => {
            const id = overlay.querySelector('#mpNewModelId').value.trim();
            if (!id) { alert('请输入模型 ID'); return; }
            const provider = config.models.providers[providerKey];
            if (!provider.models) provider.models = [];
            const exists = provider.models.some(m => (typeof m === 'string' ? m : m.id) === id);
            if (exists) { alert('璇ユā鍨嬪凡瀛樺湪'); return; }
            provider.models.push(id);
            overlay.remove();
            renderProviders();
        };
        overlay.querySelector('#mpNewModelId').focus();
    }

    async function saveConfig() {
        const saveBtn = container.querySelector('#mpBtnSave');
        const status = container.querySelector('#mpSaveStatus');
        saveBtn.disabled = true;
        status.textContent = '淇濆瓨涓?..';
        try {
            const result = await window.api.writeOpenClawConfig(config);
            if (result && result.ok === false) throw new Error(result.error);
            status.textContent = '鉁?宸蹭繚瀛?';
            status.style.color = '#a9dc76';
        } catch(e) {
            status.textContent = `鉂?淇濆瓨澶辫触: ${e.message}`;
            status.style.color = '#ff6188';
        }
        saveBtn.disabled = false;
        setTimeout(() => { status.textContent = ''; }, 3000);
    }

    container.querySelector('#mpBtnSave').onclick = saveConfig;
    sidebarEl.onclick = (event) => {
        const navEl = event.target.closest('[data-mp-provider-nav]');
        if (!navEl) return;
        state.selectedProvider = navEl.getAttribute('data-mp-provider-nav') || '';
        renderProviders();
    };
    container.querySelector('#mpBtnAddProvider').onclick = () => showProviderModal(null, null);

    renderDefaultBar();
    renderProviders();
}

// =======================================================
// 鏃ュ織鏌ョ湅椤?(Ported from clawpanel logs.js)
// =======================================================
async function renderLogsPage(container) {
    container.innerHTML = `
        <div style="padding:24px 28px;height:100%;display:flex;flex-direction:column;box-sizing:border-box">
            <h2 class="page-title">日志查看</h2>
            <p class="page-desc">查看 Agent 会话日志和 Gateway 运行日志。</p>
            <div style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
                <select id="lgAgentSelect" style="padding:7px 12px;background:#2c2c3a;border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;font-size:13px;cursor:pointer">
                    <option value="main">main</option>
                </select>
                <select id="lgFileSelect" style="padding:7px 12px;background:#2c2c3a;border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;font-size:13px;cursor:pointer;min-width:200px">
                    <option value="">加载中...</option>
                </select>
                <button id="lgRefreshBtn" style="padding:7px 14px;background:rgba(120,220,232,0.15);border:1px solid rgba(120,220,232,0.3);border-radius:7px;color:#78dce8;cursor:pointer;font-size:13px">刷新</button>
                <button id="lgGatewayBtn" style="padding:7px 14px;background:rgba(255,97,136,0.12);border:1px solid rgba(255,97,136,0.25);border-radius:7px;color:#ff6188;cursor:pointer;font-size:13px">Gateway 日志</button>
            </div>
            <div id="lgContent" style="flex:1;background:#141418;border-radius:10px;padding:14px 16px;overflow-y:auto;font-family:monospace;font-size:12px;line-height:1.7;color:#c0c0c0;white-space:pre-wrap;word-break:break-all">
                请选择日志文件
            </div>
        </div>
    `;

    const agentSelect = container.querySelector('#lgAgentSelect');
    const fileSelect = container.querySelector('#lgFileSelect');
    const content = container.querySelector('#lgContent');
    let currentMode = 'session';

    // Load agents
    try {
        const agents = await window.api.listAgents();
        if (agents.length) {
            agentSelect.innerHTML = agents.map(a => `<option value="${a}">${a}</option>`).join('');
        }
    } catch(e) {}

    async function loadFiles() {
        const agent = agentSelect.value;
        fileSelect.innerHTML = '<option value="">加载文件列表...</option>';
        try {
            const files = await window.api.listLogFiles(agent);
            if (!files.length) {
                fileSelect.innerHTML = '<option value="">无日志文件</option>';
                content.textContent = '该 Agent 暂无会话日志';
                return;
            }
            fileSelect.innerHTML = files.map(f => `<option value="${f.path}" data-name="${f.name}">${f.name.replace('.jsonl', '')} (${new Date(f.mtime).toLocaleString('zh-CN')})</option>`).join('');
            // Auto-load latest
            await loadFile(files[0].path);
        } catch(e) {
            fileSelect.innerHTML = '<option value="">加载失败</option>';
            content.textContent = '日志加载失败: ' + e.message;
        }
    }

    async function loadFile(filePath) {
        currentMode = 'session';
        content.textContent = '加载中...';
        try {
            const raw = await window.api.readLogFile(filePath, 300);
            if (!raw.trim()) { content.textContent = '锛堟棩蹇楁枃浠朵负绌猴級'; return; }
            // Parse JSONL
            const lines = raw.trim().split('\n');
            let formatted = '';
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    const role = obj.role || obj.type || '?';
                    const text = obj.content || obj.text || obj.message || JSON.stringify(obj);
                    const roleColor = role === 'user' ? '#78dce8' : role === 'assistant' ? '#a9dc76' : '#fc9867';
                    formatted += `\n[${roleColor === '#78dce8' ? '馃懁' : roleColor === '#a9dc76' ? '馃' : '鈿欙笍'} ${role.toUpperCase()}]\n${typeof text === 'string' ? text : JSON.stringify(text, null, 2)}\n${'鈹€'.repeat(60)}\n`;
                } catch {
                    formatted += line + '\n';
                }
            }
            content.textContent = formatted || raw;
            content.scrollTop = content.scrollHeight;
        } catch(e) {
            content.textContent = '璇诲彇澶辫触: ' + e.message;
        }
    }

    async function loadGatewayLog() {
        currentMode = 'gateway';
        content.textContent = '鍔犺浇 Gateway 鏃ュ織...';
        try {
            const raw = await window.api.readGatewayLog(300);
            if (!raw.trim()) {
                content.textContent = '锛圙ateway 鏃ュ織涓虹┖鎴栨湭鎵惧埌鏃ュ織鏂囦欢锛塡n\n鍙兘鐨勪綅缃細\n~/.openclaw/gateway.log\n~/.openclaw/logs/gateway.log';
                return;
            }
            // Colorize log lines
            const lines = raw.split('\n').map(line => {
                if (line.includes('[ERROR]') || line.includes('ERROR')) return '[鉂宂 ' + line;
                if (line.includes('[WARN]') || line.includes('WARN')) return '[鈿狅笍] ' + line;
                if (line.includes('[INFO]') || line.includes('INFO')) return '[鈩癸笍] ' + line;
                return line;
            });
            content.textContent = lines.join('\n');
            content.scrollTop = content.scrollHeight;
        } catch(e) {
            content.textContent = 'Gateway 鏃ュ織鍔犺浇澶辫触: ' + e.message;
        }
    }

    agentSelect.onchange = loadFiles;
    fileSelect.onchange = () => { if (fileSelect.value) loadFile(fileSelect.value); };
    container.querySelector('#lgRefreshBtn').onclick = () => {
        if (currentMode === 'gateway') loadGatewayLog();
        else loadFiles();
    };
    container.querySelector('#lgGatewayBtn').onclick = loadGatewayLog;

    await loadFiles();
}

// =======================================================
// Gateway 閰嶇疆椤?(Ported from clawpanel gateway.js)
// =======================================================
async function renderGatewayPage(container) {
    container.innerHTML = `
        <div style="padding:24px 28px">
            <h2 class="page-title">网关配置</h2>
            <p class="page-desc">配置 Gateway 服务端口、访问权限和认证 Token。</p>
            <div id="gwContent"><div style="color:#8b8b93;padding:20px">正在加载...</div></div>
        </div>`;

    let config = null;
    try { config = await window.api.getOpenClawConfig(); } catch(e) {}

    if (!config) {
        container.querySelector('#gwContent').innerHTML = '<div style="color:#ff6188">无法加载配置</div>';
        return;
    }
    if (!config.gateway) config.gateway = {};
    const gw = config.gateway;

    container.querySelector('#gwContent').innerHTML = `
        <div style="display:flex;flex-direction:column;gap:16px;max-width:560px">
            <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:18px">
                <h3 style="color:#e0e0e0;margin:0 0 14px;font-size:15px">基本设置</h3>
                <div style="display:flex;flex-direction:column;gap:12px">
                    <div>
                        <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:4px">端口号</label>
                        <input id="gwPort" type="number" value="${gw.port || 18789}" style="width:100%;padding:8px 10px;background:#1e1e24;border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;font-size:13px;box-sizing:border-box">
                    </div>
                    <div>
                        <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:4px">访问模式</label>
                        <select id="gwMode" style="width:100%;padding:8px 10px;background:#1e1e24;border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;font-size:13px">
                            <option value="local" ${!gw.mode || gw.mode === 'local' ? 'selected' : ''}>仅本机 (local)</option>
                            <option value="lan" ${gw.mode === 'lan' ? 'selected' : ''}>局域网 (lan)</option>
                            <option value="public" ${gw.mode === 'public' ? 'selected' : ''}>公网 (public)</option>
                        </select>
                    </div>
                </div>
            </div>
            <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:18px">
                <h3 style="color:#e0e0e0;margin:0 0 14px;font-size:15px">认证设置</h3>
                <div style="display:flex;flex-direction:column;gap:12px">
                    <div>
                        <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:4px">Gateway Token <span style="font-size:11px">(用于 API 认证)</span></label>
                        <div style="display:flex;gap:8px">
                            <input id="gwToken" type="text" value="${gw.auth?.token || ''}" placeholder="未设置 Token"
                                style="flex:1;padding:8px 10px;background:#1e1e24;border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;font-size:13px;font-family:monospace">
                            <button id="gwGenToken" style="padding:8px 14px;background:rgba(120,220,232,0.15);border:1px solid rgba(120,220,232,0.3);border-radius:7px;color:#78dce8;cursor:pointer;font-size:12px;white-space:nowrap">生成新 Token</button>
                        </div>
                    </div>
                </div>
            </div>
            <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:18px">
                <h3 style="color:#e0e0e0;margin:0 0 14px;font-size:15px">工具权限</h3>
                <div>
                    <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:6px">tools_mode</label>
                    <select id="gwToolPerms" style="width:100%;padding:8px 12px;background:#1e1e24;border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e0e0e0;font-size:13px">
                        <option value="full" ${config.agents?.defaults?.tools_mode === 'full' ? 'selected' : ''}>full</option>
                        <option value="restricted" ${!config.agents?.defaults?.tools_mode || config.agents?.defaults?.tools_mode === 'restricted' ? 'selected' : ''}>restricted</option>
                        <option value="disabled" ${config.agents?.defaults?.tools_mode === 'disabled' ? 'selected' : ''}>disabled</option>
                    </select>
                    <p style="font-size:11px;color:#8b8b93;margin:6px 0 0">这里会同步写回本地配置文件中的 <code>agents.defaults.tools_mode</code>。</p>
                </div>
            </div>
            <div style="display:flex;gap:10px;align-items:center">
                <button id="gwSaveBtn" style="padding:10px 24px;background:#a9dc76;color:#1e1e24;border:none;border-radius:8px;cursor:pointer;font-weight:600">保存配置</button>
                <span id="gwStatus" style="font-size:13px;color:#8b8b93"></span>
            </div>
        </div>
    `;

    container.querySelector('#gwGenToken').onclick = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const token = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        container.querySelector('#gwToken').value = token;
    };

    container.querySelector('#gwSaveBtn').onclick = async () => {
        const saveBtn = container.querySelector('#gwSaveBtn');
        const statusEl = container.querySelector('#gwStatus');
        const port = parseInt(container.querySelector('#gwPort').value) || 18789;
        const mode = container.querySelector('#gwMode').value;
        const token = container.querySelector('#gwToken').value.trim();

        config.gateway.port = port;
        config.gateway.mode = mode;
        if (!config.gateway.auth) config.gateway.auth = {};
        config.gateway.auth.token = token;
        if (!config.agents || typeof config.agents !== 'object') config.agents = {};
        if (!config.agents.defaults || typeof config.agents.defaults !== 'object') config.agents.defaults = {};
        config.agents.defaults.tools_mode = container.querySelector('#gwToolPerms').value;
        config.agents.defaults.tools_enabled = config.agents.defaults.tools_mode !== 'disabled';

        saveBtn.disabled = true;
        statusEl.textContent = '保存中...';
        try {
            const result = await window.api.writeOpenClawConfig(config);
            if (result && result.ok === false) throw new Error(result.error);
            statusEl.textContent = '配置已保存，重启 Gateway 后生效。';
            statusEl.style.color = '#a9dc76';
        } catch(e) {
            statusEl.textContent = '保存失败: ' + e.message;
            statusEl.style.color = '#ff6188';
        }
        saveBtn.disabled = false;
        setTimeout(() => { statusEl.textContent = ''; }, 4000);
    };
}

// =======================================================
// Agent 管理页 (Ported from clawpanel agents.js)
// =======================================================
async function renderAgentsPage(container) {
    container.innerHTML = `
        <div style="padding:24px 28px;height:100%;display:flex;flex-direction:column;box-sizing:border-box">
            <h2 class="page-title">Agent 管理</h2>
            <p class="page-desc">查看和编辑 Agent 配置文件，例如 IDENTITY、SOUL、USER。</p>
            <div style="display:flex;gap:16px;flex:1;min-height:0">
                <div style="width:200px;flex-shrink:0">
                    <div style="color:#8b8b93;font-size:12px;margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Agent 列表</div>
                    <div id="agAgentList" style="display:flex;flex-direction:column;gap:5px">
                        <div style="color:#8b8b93;font-size:13px">加载中...</div>
                    </div>
                </div>
                <div style="flex:1;min-width:0">
                    <div id="agFilePanel" style="height:100%;display:flex;flex-direction:column">
                        <div style="color:#8b8b93;padding:20px;text-align:center">请先从左侧选择 Agent</div>
                    </div>
                </div>
            </div>
        </div>`;

    let agents = [];
    let selectedAgent = null;
    let selectedFile = null;

    const agentList = container.querySelector('#agAgentList');
    const filePanel = container.querySelector('#agFilePanel');

    try { agents = await window.api.listAgents(); } catch(e) {}

    if (!agents.length) {
        agentList.innerHTML = '<div style="color:#8b8b93;font-size:13px">未找到任何 Agent</div>';
        return;
    }

    function renderAgentList() {
        agentList.innerHTML = agents.map(name => `
            <div class="agItem" data-name="${name}" style="padding:8px 10px;border-radius:7px;cursor:pointer;background:${selectedAgent === name ? 'rgba(120,220,232,0.12)' : 'rgba(255,255,255,0.03)'};border:1px solid ${selectedAgent === name ? 'rgba(120,220,232,0.3)' : 'transparent'};color:${selectedAgent === name ? '#78dce8' : '#c0c0c0'};font-size:13px;transition:all 0.15s">
                ${name}
            </div>`).join('');
        agentList.querySelectorAll('.agItem').forEach(el => {
            el.onclick = () => {
                selectedAgent = el.dataset.name;
                selectedFile = null;
                renderAgentList();
                loadAgentFiles();
            };
        });
    }

    async function loadAgentFiles() {
        const FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md', 'TOOLS.json'];
        filePanel.innerHTML = `
            <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
                ${FILES.map(f => `<button class="agFileBtn" data-file="${f}" style="padding:5px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#c0c0c0;cursor:pointer;font-size:12px">${f}</button>`).join('')}
            </div>
            <div id="agEditor" style="flex:1;display:flex;flex-direction:column">
                <div style="color:#8b8b93;font-size:13px;padding:10px">请选择要查看的文件</div>
            </div>`;

        filePanel.querySelectorAll('.agFileBtn').forEach(btn => {
            btn.onclick = () => {
                selectedFile = btn.dataset.file;
                filePanel.querySelectorAll('.agFileBtn').forEach(b => {
                    b.style.background = b === btn ? 'rgba(120,220,232,0.15)' : 'rgba(255,255,255,0.06)';
                    b.style.borderColor = b === btn ? 'rgba(120,220,232,0.4)' : 'rgba(255,255,255,0.1)';
                    b.style.color = b === btn ? '#78dce8' : '#c0c0c0';
                });
                loadFileContent();
            };
        });
    }

    async function loadFileContent() {
        const editor = filePanel.querySelector('#agEditor');
        editor.innerHTML = '<div style="color:#8b8b93;font-size:13px;padding:10px">加载中...</div>';
        try {
            const content = await window.api.readAgentFile(selectedAgent, selectedFile);
            if (content === null) {
                editor.innerHTML = `
                    <div style="color:#8b8b93;font-size:13px;padding:10px;margin-bottom:10px">文件不存在，可以在这里创建。</div>
                    <textarea id="agTextarea" style="flex:1;width:100%;background:#141418;border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#c0c0c0;font-family:monospace;font-size:12px;padding:12px;resize:none;box-sizing:border-box;min-height:240px" placeholder="在这里输入内容..."></textarea>
                    <div style="margin-top:8px;display:flex;gap:8px"><button id="agSaveBtn" style="padding:7px 16px;background:#a9dc76;color:#1e1e24;border:none;border-radius:7px;cursor:pointer;font-weight:600">创建</button><span id="agSaveStatus" style="font-size:12px;color:#8b8b93"></span></div>`;
            } else {
                editor.innerHTML = `
                    <textarea id="agTextarea" style="flex:1;width:100%;background:#141418;border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#c0c0c0;font-family:monospace;font-size:12px;padding:12px;resize:none;box-sizing:border-box;min-height:240px">${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
                    <div style="margin-top:8px;display:flex;gap:8px"><button id="agSaveBtn" style="padding:7px 16px;background:#a9dc76;color:#1e1e24;border:none;border-radius:7px;cursor:pointer;font-weight:600">保存</button><span id="agSaveStatus" style="font-size:12px;color:#8b8b93"></span></div>`;
            }
            editor.classList.add('ag-editor-card');
            editor.querySelector('#agTextarea')?.classList.add('ag-editor-textarea');
            editor.querySelector('#agSaveBtn')?.classList.add('ops-btn', 'ops-btn-primary');
            editor.querySelector('#agSaveStatus')?.classList.add('ops-status-text');

            const saveBtn = editor.querySelector('#agSaveBtn');
            if (saveBtn) {
                saveBtn.onclick = async () => {
                    const text = editor.querySelector('#agTextarea').value;
                    const statusEl = editor.querySelector('#agSaveStatus');
                    saveBtn.disabled = true;
                    statusEl.textContent = '保存中...';
                    try {
                        await window.api.writeAgentFile(selectedAgent, selectedFile, text);
                        statusEl.textContent = '已保存';
                        statusEl.style.color = '#a9dc76';
                    } catch(e) {
                        statusEl.textContent = '保存失败: ' + e.message;
                        statusEl.style.color = '#ff6188';
                    }
                    saveBtn.disabled = false;
                    setTimeout(() => { statusEl.textContent = ''; }, 3000);
                };
            }
        } catch(e) {
            editor.innerHTML = `<div style="color:#ff6188;padding:10px">加载失败: ${e.message}</div>`;
        }
    }

    renderAgentList();
}

async function renderAgentsPageV2(container) {
    const FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md', 'TOOLS.json'];
    let config = {};
    let agents = [];
    let selectedAgent = null;
    let selectedFile = 'IDENTITY.md';

    container.innerHTML = `
        <div style="padding:24px 28px;height:100%;display:flex;flex-direction:column;box-sizing:border-box;gap:16px">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
                <div>
                    <h2 class="page-title">Agent 管理</h2>
                    <p class="page-desc">Agent 数据、模型和设置都直接来自本地 openclaw 配置文件。</p>
                </div>
                <div style="display:flex;gap:10px;flex-wrap:wrap">
                    <button id="agBtnRefresh" style="padding:8px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#d7dce5;cursor:pointer">刷新</button>
                    <button id="agBtnNew" style="padding:8px 16px;background:#a9dc76;border:none;border-radius:10px;color:#102014;font-weight:700;cursor:pointer">+ 新建 Agent</button>
                </div>
            </div>
            <div style="display:flex;gap:18px;flex:1;min-height:0">
                <div id="agAgentList" style="width:260px;flex-shrink:0;display:flex;flex-direction:column;gap:8px;overflow:auto"></div>
                <div id="agFilePanel" style="flex:1;min-width:0;display:flex;min-height:0"></div>
            </div>
        </div>`;

    const listEl = container.querySelector('#agAgentList');
    const panelEl = container.querySelector('#agFilePanel');
    const agentsShell = container.firstElementChild;
    const agentsHead = agentsShell?.firstElementChild;
    const agentsWorkspace = agentsHead?.nextElementSibling;
    const clone = (value) => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value || {}));
    const current = () => agents.find(agent => agent.id === selectedAgent) || null;

    if (agentsShell) {
        agentsShell.classList.add('ops-page-shell', 'agents-page-shell');
        agentsShell.removeAttribute('style');
    }
    if (agentsHead) {
        agentsHead.classList.add('ops-page-head');
        agentsHead.removeAttribute('style');
        const actionRow = agentsHead.lastElementChild;
        if (actionRow) {
            actionRow.classList.add('ops-page-actions');
            actionRow.removeAttribute('style');
        }
    }
    if (agentsWorkspace) {
        agentsWorkspace.classList.add('agents-workspace');
        agentsWorkspace.removeAttribute('style');
    }
    listEl.classList.add('agents-list');
    panelEl.classList.add('agents-panel');
    container.querySelector('#agBtnRefresh')?.classList.add('ops-btn', 'ops-btn-secondary');
    container.querySelector('#agBtnNew')?.classList.add('ops-btn', 'ops-btn-primary');
    container.querySelector('.page-title')?.replaceChildren(document.createTextNode('Agent 管理'));
    container.querySelector('.page-desc')?.replaceChildren(document.createTextNode('管理 Agent 的配置文件、模型绑定和本地工作区。'));
    container.querySelector('#agBtnRefresh')?.replaceChildren(document.createTextNode('刷新'));
    container.querySelector('#agBtnNew')?.replaceChildren(document.createTextNode('+ 新建 Agent'));

    function empty(message) {
        panelEl.innerHTML = `<div style="flex:1;display:flex;align-items:center;justify-content:center;border:1px dashed rgba(255,255,255,0.08);border-radius:18px;background:rgba(255,255,255,0.02);padding:24px;color:#8f98ab;text-align:center;line-height:1.8">${escapeHtml(message)}</div>`;
    }

    function modelOptions(cfg, currentValue = '') {
        const options = [];
        const seen = new Set();
        const providers = cfg?.models?.providers || {};

        Object.entries(providers).forEach(([providerKey, provider]) => {
            (provider?.models || []).forEach((model) => {
                const modelId = typeof model === 'string' ? model : model?.id;
                if (!modelId) return;
                const value = `${providerKey}/${modelId}`;
                if (seen.has(value)) return;
                seen.add(value);
                options.push({ value, label: value });
            });
        });

        if (currentValue && !seen.has(currentValue)) {
            options.unshift({ value: currentValue, label: `${currentValue}（当前）` });
        }

        return options;
    }

    function buildAgents(cfg, ids) {
        const map = new Map();
        const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list.filter(Boolean) : [];

        list.forEach((entry) => {
            const id = String(entry?.id || '').trim();
            if (!id) return;
            map.set(id, {
                id,
                name: String(entry?.name || id),
                model: typeof entry?.model === 'object' ? (entry.model?.primary || entry.model?.id || '') : String(entry?.model || ''),
                workspace: String(entry?.workspace || ''),
                agentDir: String(entry?.agentDir || ''),
                isDefault: id === 'main'
            });
        });

        ids.forEach((id) => {
            if (!map.has(id)) {
                map.set(id, { id, name: id, model: '', workspace: '', agentDir: '', isDefault: id === 'main' });
            }
        });

        const mainEntry = map.get('main') || {};
        map.set('main', {
            id: 'main',
            name: 'main',
            model: cfg?.agents?.defaults?.model?.primary || String(mainEntry.model || ''),
            workspace: cfg?.agents?.defaults?.workspace || String(mainEntry.workspace || ''),
            agentDir: String(mainEntry.agentDir || ''),
            isDefault: true
        });

        return Array.from(map.values()).sort((a, b) => {
            if (a.id === 'main') return -1;
            if (b.id === 'main') return 1;
            return a.id.localeCompare(b.id, 'zh-CN');
        });
    }

    async function reload(preferredId = selectedAgent) {
        try { config = await window.api.getOpenClawConfig() || {}; } catch { config = {}; }
        let ids = [];
        try { ids = await window.api.listAgents() || []; } catch {}
        agents = buildAgents(config, ids);
        selectedAgent = preferredId && agents.some(agent => agent.id === preferredId) ? preferredId : (agents[0]?.id || null);
        renderList();
        renderDetail();
    }

    function renderList() {
        if (!agents.length) {
            listEl.innerHTML = '<div style="padding:14px;border:1px dashed rgba(255,255,255,0.08);border-radius:12px;color:#8f98ab;line-height:1.7">当前没有检测到 Agent。</div>';
            return;
        }

        listEl.innerHTML = agents.map(agent => `
            <div class="agItem" data-name="${escapeHtml(agent.id)}" style="padding:12px 14px;border-radius:14px;border:1px solid ${agent.id === selectedAgent ? 'rgba(120,220,232,0.36)' : 'rgba(255,255,255,0.06)'};background:${agent.id === selectedAgent ? 'rgba(120,220,232,0.10)' : 'rgba(255,255,255,0.02)'};cursor:pointer">
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:4px">
                    <strong style="color:#eef2f8;font-size:14px;word-break:break-all">${escapeHtml(agent.name || agent.id)}</strong>
                    ${agent.isDefault ? '<span style="font-size:11px;color:#b9ef8e">默认</span>' : ''}
                </div>
                <div style="font-size:12px;color:#8f98ab;word-break:break-all">${escapeHtml(agent.id)}</div>
                <div style="font-size:12px;color:#8f98ab;word-break:break-all;margin-top:4px">${escapeHtml(agent.model || '未配置模型')}</div>
            </div>
        `).join('');

        listEl.querySelectorAll('.agItem').forEach((item) => {
            item.classList.toggle('is-active', item.dataset.name === selectedAgent);
            item.querySelector('span[style*="color:#b9ef8e"]')?.classList.add('ag-default-chip');
        });

        listEl.querySelectorAll('.agItem').forEach((item) => {
            item.onclick = () => {
                selectedAgent = item.dataset.name;
                selectedFile = 'IDENTITY.md';
                renderList();
                renderDetail();
            };
        });
    }

    async function loadFile(agentId, fileName) {
        const editor = panelEl.querySelector('#agEditor');
        if (!editor) return;
        editor.innerHTML = '<div style="color:#8f98ab">正在加载文件内容...</div>';

        try {
            const content = await window.api.readAgentFile(agentId, fileName);
            editor.innerHTML = `
                <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
                    <div style="color:#eef2f8;font-weight:700">${escapeHtml(fileName)}</div>
                    <div style="font-size:12px;color:#8f98ab">${content === null ? '文件不存在，保存后会自动创建。' : '保存后会直接写回本地文件。'}</div>
                </div>
                <textarea id="agTextarea" style="flex:1;min-height:260px;width:100%;background:#141823;border:1px solid rgba(255,255,255,0.08);border-radius:12px;color:#dbe4ee;font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.7;padding:14px;resize:none;box-sizing:border-box">${escapeHtml(content === null ? '' : String(content))}</textarea>
                <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                    <button id="agSaveBtn" style="padding:9px 16px;background:#a9dc76;border:none;border-radius:10px;color:#102014;font-weight:700;cursor:pointer">${content === null ? '创建文件' : '保存修改'}</button>
                    <span id="agSaveStatus" style="font-size:12px;color:#8f98ab"></span>
                </div>
            `;

            const saveBtn = editor.querySelector('#agSaveBtn');
            const statusEl = editor.querySelector('#agSaveStatus');
            saveBtn.onclick = async () => {
                saveBtn.disabled = true;
                statusEl.style.color = '#8f98ab';
                statusEl.textContent = '正在保存...';
                try {
                    const result = await window.api.writeAgentFile(agentId, fileName, editor.querySelector('#agTextarea').value);
                    if (result && result.ok === false) throw new Error(result.error || '保存失败');
                    statusEl.style.color = '#a9dc76';
                    statusEl.textContent = '已保存';
                } catch (error) {
                    statusEl.style.color = '#ff6188';
                    statusEl.textContent = error?.message || String(error);
                } finally {
                    saveBtn.disabled = false;
                }
            };
        } catch (error) {
            editor.innerHTML = `<div style="color:#ff6188">加载失败: ${escapeHtml(error?.message || String(error))}</div>`;
        }
    }

    function renderDetail() {
        const agent = current();
        if (!agent) {
            empty('当前没有可用的 Agent。');
            return;
        }

        panelEl.innerHTML = `
            <div style="flex:1;display:flex;flex-direction:column;gap:14px;min-height:0">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
                    <div style="padding:14px;border-radius:16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06)">
                        <div style="font-size:12px;color:#8f98ab">Agent ID</div>
                        <div style="margin-top:6px;color:#eef2f8;font-weight:700;word-break:break-all">${escapeHtml(agent.id)}</div>
                    </div>
                    <div style="padding:14px;border-radius:16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06)">
                        <div style="font-size:12px;color:#8f98ab">工作区</div>
                        <div style="margin-top:6px;color:#eef2f8;font-size:12px;font-family:monospace;line-height:1.7;word-break:break-all">${escapeHtml(agent.workspace || '自动路径')}</div>
                    </div>
                </div>
                <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                        ${FILES.map(fileName => `<button class="agFileBtn" data-file="${fileName}" style="padding:7px 12px;border-radius:9px;border:1px solid ${selectedFile === fileName ? 'rgba(120,220,232,0.36)' : 'rgba(255,255,255,0.08)'};background:${selectedFile === fileName ? 'rgba(120,220,232,0.14)' : 'rgba(255,255,255,0.03)'};color:${selectedFile === fileName ? '#78dce8' : '#d4d9e2'};cursor:pointer;font-size:12px">${fileName}</button>`).join('')}
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                        <button class="agEditBtn" style="padding:8px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#d7dce5;cursor:pointer">编辑设置</button>
                        <button class="agRenameBtn" style="padding:8px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#d7dce5;cursor:pointer;${agent.isDefault ? 'opacity:0.5;cursor:not-allowed;' : ''}" ${agent.isDefault ? 'disabled' : ''}>重命名</button>
                        ${agent.isDefault ? '' : '<button class="agDeleteBtn" style="padding:8px 12px;background:rgba(255,107,107,0.12);border:1px solid rgba(255,107,107,0.28);border-radius:10px;color:#ff8f8f;cursor:pointer">删除</button>'}
                    </div>
                </div>
                <div id="agEditor" style="flex:1;min-height:0;display:flex;flex-direction:column;padding:16px;border-radius:18px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06)"></div>
            </div>
        `;

        const detailShell = panelEl.firstElementChild;
        detailShell?.classList.add('agents-detail-shell');
        detailShell?.children?.[0]?.classList.add('agents-meta-grid');
        detailShell?.children?.[1]?.classList.add('agents-detail-toolbar');
        detailShell?.children?.[1]?.children?.[0]?.classList.add('agents-file-tabs');
        detailShell?.children?.[1]?.children?.[1]?.classList.add('agents-detail-actions');
        panelEl.querySelector('#agEditor')?.classList.add('ag-editor-card');
        panelEl.querySelectorAll('.agEditBtn, .agRenameBtn').forEach((btn) => btn.classList.add('ops-btn', 'ops-btn-secondary'));
        panelEl.querySelector('.agDeleteBtn')?.classList.add('ops-btn', 'ops-btn-danger');
        panelEl.querySelectorAll('.agFileBtn').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.file === selectedFile));

        panelEl.querySelectorAll('.agFileBtn').forEach((btn) => {
            btn.onclick = () => {
                selectedFile = btn.dataset.file;
                renderDetail();
            };
        });

        panelEl.querySelector('.agEditBtn').onclick = () => openEdit(agent);
        const renameBtn = panelEl.querySelector('.agRenameBtn');
        if (renameBtn) {
            renameBtn.onclick = () => {
                if (!renameBtn.disabled) openRename(agent);
            };
        }

        const deleteBtn = panelEl.querySelector('.agDeleteBtn');
        if (deleteBtn) {
            deleteBtn.onclick = async () => {
                try {
                    deleteBtn.disabled = true;
                    const ok = await showConfirmDialog(`确定要删除 Agent「${agent.id}」吗？\n\n这会同时删除目录、会话和配置记录。`, {
                        title: '删除 Agent',
                        confirmText: '确认删除',
                        cancelText: '取消'
                    });
                    if (!ok) return;
                    const result = await window.api.deleteAgent(agent.id);
                    if (!result?.ok) throw new Error(result?.error || '删除失败');
                    selectedAgent = null;
                    selectedFile = 'IDENTITY.md';
                    await reload();
                } catch (error) {
                    window.alert(`删除 Agent 失败: ${error?.message || error}`);
                } finally {
                    deleteBtn.disabled = false;
                }
            };
        }

        loadFile(agent.id, selectedFile);
    }

    function openCreate() {
        const options = modelOptions(config, config?.agents?.defaults?.model?.primary || '');
        showFormDialog({
            title: '新建 Agent',
            confirmText: '创建',
            fields: [
                { name: 'id', label: 'Agent ID', value: '', placeholder: '例如 translator', hint: '仅支持小写字母、数字、下划线和连字符。' },
                { name: 'name', label: '显示名称', value: '', placeholder: '例如 翻译助理' },
                options.length ? { name: 'model', label: '模型', type: 'select', value: options[0].value, options } : { name: 'model', label: '模型', value: config?.agents?.defaults?.model?.primary || '', placeholder: '留空则使用默认模型' },
                { name: 'workspace', label: '工作区路径', value: '', placeholder: '留空则自动创建' }
            ],
            onConfirm: async (values, dialog) => {
                const id = String(values.id || '').trim();
                if (!id) return dialog.setStatus('请填写 Agent ID。');
                if (!/^[a-z0-9_-]+$/.test(id)) return dialog.setStatus('Agent ID 格式不合法。');
                if (agents.some(agent => agent.id === id)) return dialog.setStatus('该 Agent 已存在。');
                dialog.setStatus('正在创建...', '#8f98ab');
                const result = await window.api.createAgent({
                    id,
                    name: String(values.name || '').trim() || id,
                    model: String(values.model || '').trim(),
                    workspace: String(values.workspace || '').trim()
                });
                if (!result?.ok) throw new Error(result?.error || '创建失败');
                selectedAgent = id;
                selectedFile = 'IDENTITY.md';
                await reload(id);
                dialog.close();
            }
        });
    }

    function openRename(agent) {
        showFormDialog({
            title: `重命名 Agent: ${agent.id}`,
            confirmText: '重命名',
            fields: [{ name: 'newName', label: '新的 Agent ID', value: agent.id, placeholder: '例如 agent_helper' }],
            onConfirm: async (values, dialog) => {
                const newName = String(values.newName || '').trim();
                if (!newName) return dialog.setStatus('请输入新的 Agent ID。');
                if (!/^[a-z0-9_-]+$/.test(newName)) return dialog.setStatus('新的 Agent ID 格式不合法。');
                if (newName === agent.id) return dialog.close();
                if (agents.some(item => item.id === newName)) return dialog.setStatus('目标 Agent ID 已存在。');
                dialog.setStatus('正在重命名...', '#8f98ab');
                const result = await window.api.renameAgent(agent.id, newName);
                if (!result?.ok) throw new Error(result?.error || '重命名失败');
                selectedAgent = newName;
                await reload(newName);
                dialog.close();
            }
        });
    }

    function openEdit(agent) {
        const options = modelOptions(config, agent.model || config?.agents?.defaults?.model?.primary || '');
        showFormDialog({
            title: `编辑 Agent: ${agent.id}`,
            confirmText: '保存设置',
            fields: [
                { name: 'name', label: '显示名称', value: agent.name || agent.id, placeholder: '用于面板展示的名称' },
                options.length ? { name: 'model', label: '模型', type: 'select', value: agent.model || options[0].value, options } : { name: 'model', label: '模型', value: agent.model || '', placeholder: '例如 codex/gpt-5.4' },
                { name: 'workspace', label: '工作区路径', value: agent.workspace || '自动路径', readonly: true, hint: '当前页面只展示工作区路径。' }
            ],
            onConfirm: async (values, dialog) => {
                const next = clone(config || {});
                if (!next.agents || typeof next.agents !== 'object') next.agents = {};
                if (!Array.isArray(next.agents.list)) next.agents.list = [];
                let entry = next.agents.list.find(item => item?.id === agent.id);
                if (!entry && agent.id !== 'main') {
                    entry = { id: agent.id };
                    next.agents.list.push(entry);
                }

                const name = String(values.name || '').trim() || agent.id;
                const model = String(values.model || '').trim();

                if (agent.id === 'main') {
                    next.agents.list = next.agents.list.filter(item => String(item?.id || '').trim() !== 'main');
                    if (!next.agents.defaults || typeof next.agents.defaults !== 'object') next.agents.defaults = {};
                    if (!next.agents.defaults.model || typeof next.agents.defaults.model !== 'object') next.agents.defaults.model = {};
                    next.agents.defaults.model.primary = model;
                } else if (entry) {
                    entry.model = model;
                }

                if (entry) {
                    entry.name = name;
                    if (!entry.workspace && agent.workspace) entry.workspace = agent.workspace;
                    if (!entry.agentDir && agent.agentDir) entry.agentDir = agent.agentDir;
                }

                dialog.setStatus('正在保存配置...', '#8f98ab');
                const result = await window.api.writeOpenClawConfig(next);
                if (result && result.ok === false) throw new Error(result.error || '保存失败');
                try {
                    config = await window.api.getOpenClawConfig() || next;
                } catch (_) {
                    config = next;
                }
                await reload(agent.id);
                dialog.close();
            }
        });
    }
    container.querySelector('#agBtnNew').onclick = () => openCreate();
    container.querySelector('#agBtnRefresh').onclick = () => reload();

    empty('正在加载 Agent 列表...');
    await reload();
}

async function renderModelsPage(container) {
    container.innerHTML = `
        <div class="models-page-shell">
            <h2 class="page-title">模型配置</h2>
            <p class="page-desc">管理模型服务商、主模型和回退模型，并支持勾选后批量测试连通性。</p>
            <div class="models-page-toolbar">
                <button id="mpBtnAddProvider" style="padding:8px 18px;background:var(--accent,#78dce8);color:#1e1e24;border:none;border-radius:8px;cursor:pointer;font-weight:600">+ 新增服务商</button>
                <button id="mpBtnSave" style="padding:8px 18px;background:#a9dc76;color:#1e1e24;border:none;border-radius:8px;cursor:pointer;font-weight:600">保存配置</button>
                <span id="mpSaveStatus" class="models-page-status"></span>
            </div>
            <div id="mpProvidersList"><div style="color:#8b8b93;padding:20px">正在加载配置...</div></div>
        </div>
    `;

    let config = null;
    try {
        config = await window.api.getOpenClawConfig();
    } catch (error) {}

    if (!config) {
        container.querySelector('#mpProvidersList').innerHTML = '<div style="color:#ff6188;padding:20px">无法加载模型配置</div>';
        return;
    }

    if (!config.models || typeof config.models !== 'object') config.models = {};
    if (!config.models.providers || typeof config.models.providers !== 'object') config.models.providers = {};
    if (!config.agents || typeof config.agents !== 'object') config.agents = {};
    if (!config.agents.defaults || typeof config.agents.defaults !== 'object') config.agents.defaults = {};
    if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') config.agents.defaults.model = {};

    const state = {
        selectedModels: new Set(),
        testResults: new Map(),
        batchRun: null,
        statusTimer: null,
        searchTimer: null
    };

    function setPageStatus(message, color = '#8b8b93') {
        const statusEl = container.querySelector('#mpSaveStatus');
        if (!statusEl) return;
        statusEl.textContent = message || '';
        statusEl.style.color = color;
        if (state.statusTimer) clearTimeout(state.statusTimer);
        if (message) {
            state.statusTimer = setTimeout(() => {
                if (statusEl.textContent === message) statusEl.textContent = '';
            }, 4000);
        }
    }

    function setPageStatus(message, color = '#8b8b93') {
        const statusEl = container.querySelector('#mpSaveStatus');
        if (!statusEl) return;
        statusEl.textContent = message || '';
        const isLightTheme = document.documentElement?.dataset?.theme === 'light';
        const colorMap = isLightTheme
            ? {
                '#a9dc76': '#18743d',
                '#00ff88': '#18743d',
                '#ff8f8f': '#c62828',
                '#ff6188': '#c62828',
                '#78dce8': '#127d96',
                '#fc9867': '#a65e16'
            }
            : null;
        statusEl.style.color = colorMap?.[color] || color;
        if (state.statusTimer) clearTimeout(state.statusTimer);
        if (message) {
            state.statusTimer = setTimeout(() => {
                if (statusEl.textContent === message) statusEl.textContent = '';
            }, 4000);
        }
    }

    function getPrimary() {
        return String(config?.agents?.defaults?.model?.primary || '').trim();
    }

    function escapeSelectorValue(value) {
        const text = String(value ?? '');
        if (window.CSS?.escape) return window.CSS.escape(text);
        return text.replace(/["\\]/g, '\\$&');
    }

    function collectProviderModels(providerKey) {
        const provider = config?.models?.providers?.[providerKey] || {};
        return (provider.models || [])
            .map((model) => typeof model === 'string' ? model : model?.id)
            .filter(Boolean)
            .map((modelId) => ({ providerKey, modelId, full: `${providerKey}/${modelId}` }));
    }

    function collectAllModels() {
        return Object.keys(config?.models?.providers || {}).flatMap((providerKey) => collectProviderModels(providerKey));
    }

    function normalizeBaseUrl(provider) {
        const apiType = provider?.api || 'openai-completions';
        const raw = String(provider?.baseUrl || '').trim().replace(/\/+$/, '');
        if (raw) return raw;
        if (apiType === 'anthropic-messages') return 'https://api.anthropic.com/v1';
        if (apiType === 'google-gemini') return 'https://generativelanguage.googleapis.com/v1beta';
        return 'https://api.openai.com/v1';
    }

    function renderDefaultBar() {
        const bar = container.querySelector('#mpDefaultBar');
        if (!bar) return;
        const primary = getPrimary();
        const allModels = collectAllModels();
        const fallbackPreview = allModels.filter((model) => model.full !== primary).map((model) => model.full);
        const fallbackText = fallbackPreview.length > 3 ? `${fallbackPreview.slice(0, 3).join(', ')} ...` : (fallbackPreview.join(', ') || '暂无');

        bar.innerHTML = `
            <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px 16px;display:flex;gap:20px;flex-wrap:wrap;align-items:center">
                <div style="display:flex;flex-direction:column;gap:6px">
                    <span style="color:#8b8b93;font-size:12px">主模型</span>
                    <span style="color:${primary ? '#a9dc76' : '#ff6188'};font-family:monospace;font-size:13px">${escapeHtml(primary || '未配置')}</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px">
                    <span style="color:#8b8b93;font-size:12px">回退候选</span>
                    <span style="color:#d7dce5;font-size:13px">${escapeHtml(fallbackText)}</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px">
                    <span style="color:#8b8b93;font-size:12px">批量测试</span>
                    <span style="color:#d7dce5;font-size:13px">勾选模型后点击“批量测试”；如果没有勾选，就默认测试当前服务商的全部模型。</span>
                </div>
            </div>
        `;
    }

    function renderTestBadge(full) {
        const result = state.testResults.get(full);
        if (!result) return '<span style="font-size:11px;color:#8b8b93">未测试</span>';
        if (result.state === 'running') return '<span style="font-size:11px;color:#78dce8">测试中...</span>';
        if (result.state === 'success') return `<span style="font-size:11px;color:#a9dc76">通过 ${escapeHtml(result.label)}</span>`;
        return `<span style="font-size:11px;color:#ff8f8f">${escapeHtml(result.label || '失败')}</span>`;
    }

    function renderTestBadge(full) {
        const result = state.testResults.get(full);
        if (!result) return '<span class="models-test-badge is-idle">未测试</span>';
        if (result.state === 'running') return '<span class="models-test-badge is-running">测试中...</span>';
        if (result.state === 'success') return `<span class="models-test-badge is-success">通过 ${escapeHtml(result.label)}</span>`;
        return `<span class="models-test-badge is-error">${escapeHtml(result.label || '失败')}</span>`;
    }

    function getProviderSelectionText(providerKey) {
        const models = collectProviderModels(providerKey);
        const selectedCount = models.filter((item) => state.selectedModels.has(item.full)).length;
        return selectedCount ? `已勾选 ${selectedCount} 个模型` : '未勾选时默认测试这个 provider 的全部模型。';
    }

    function updateModelTestBadge(full) {
        const badge = listEl.querySelector(`[data-mp-test-badge="${escapeSelectorValue(full)}"]`);
        if (!badge) {
            renderProviders();
            return;
        }
        badge.innerHTML = renderTestBadge(full);
        updateInvalidModelButton();
    }

    function updateBatchButton(providerKey) {
        const button = listEl.querySelector(`[data-mp-action="batch-test"][data-provider="${escapeSelectorValue(providerKey)}"]`);
        if (!button) {
            renderProviders();
            return;
        }
        const batchRun = state.batchRun && state.batchRun.providerKey === providerKey ? state.batchRun : null;
        button.textContent = batchRun ? `停止批量测试 ${batchRun.done}/${batchRun.total}` : '批量测试';
        button.style.background = batchRun ? 'rgba(255,152,103,0.14)' : 'rgba(120,220,232,0.15)';
        button.style.borderColor = batchRun ? 'rgba(255,152,103,0.32)' : 'rgba(120,220,232,0.3)';
        button.style.color = batchRun ? '#fc9867' : '#78dce8';
    }

    function updateProviderSelectionUi(providerKey, options = {}) {
        const card = listEl.querySelector(`[data-provider-card="${escapeSelectorValue(providerKey)}"]`);
        if (!card) {
            renderProviders();
            return;
        }

        const models = collectProviderModels(providerKey);
        const selectedCount = models.filter((item) => state.selectedModels.has(item.full)).length;
        const allSelected = models.length > 0 && selectedCount === models.length;

        const summary = card.querySelector(`[data-provider-selection-status="${escapeSelectorValue(providerKey)}"]`);
        if (summary) {
            summary.textContent = getProviderSelectionText(providerKey);
        }

        const selectAll = card.querySelector(`[data-mp-select-all="${escapeSelectorValue(providerKey)}"]`);
        if (selectAll) {
            selectAll.checked = allSelected;
            selectAll.indeterminate = selectedCount > 0 && !allSelected;
        }

        if (options.syncModelCheckboxes) {
            models.forEach((model) => {
                const checkbox = card.querySelector(`[data-mp-select-model="${escapeSelectorValue(model.full)}"]`);
                if (checkbox) {
                    checkbox.checked = state.selectedModels.has(model.full);
                }
            });
        }
    }

    function refreshModelsView(options = {}) {
        if (options.defaultBar !== false) {
            renderDefaultBar();
        }
        renderProviders();
    }

    function getRecentModelTestResult(fullModelId) {
        const cached = state.testResults.get(fullModelId);
        if (!cached || cached.state === 'running') return null;
        if (!cached.updatedAt || (Date.now() - cached.updatedAt) > MODEL_TEST_CACHE_TTL_MS) return null;
        return cached;
    }

    async function requestModelTest(providerKey, modelId, timeoutMs = MODEL_TEST_TIMEOUT_MS) {
        const provider = config?.models?.providers?.[providerKey];
        if (!provider) throw new Error('服务商不存在');

        const apiType = provider.api || 'openai-completions';
        const baseUrl = normalizeBaseUrl(provider);
        const apiKey = String(provider.apiKey || '').trim();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();

        try {
            let url = '';
            let headers = { 'Content-Type': 'application/json' };
            let body = null;

            if (apiType === 'anthropic-messages') {
                if (!apiKey) throw new Error('缺少 API Key');
                url = `${baseUrl}/messages`;
                headers['x-api-key'] = apiKey;
                headers['anthropic-version'] = '2023-06-01';
                body = {
                    model: modelId,
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'ping' }]
                };
            } else if (apiType === 'google-gemini') {
                if (!apiKey) throw new Error('缺少 API Key');
                const endpoint = new URL(`${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`);
                endpoint.searchParams.set('key', apiKey);
                url = endpoint.toString();
                body = {
                    contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
                    generationConfig: { maxOutputTokens: 1 }
                };
            } else {
                if (!apiKey) throw new Error('缺少 API Key');
                url = `${baseUrl}/chat/completions`;
                headers.Authorization = `Bearer ${apiKey}`;
                body = {
                    model: modelId,
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1
                };
            }

            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });

            const elapsed = Date.now() - startedAt;
            let text = '';
            try {
                text = await response.text();
            } catch (error) {}

            if (!response.ok) {
                throw new Error((text || `HTTP ${response.status}`).slice(0, 160));
            }

            return {
                ok: true,
                elapsed,
                label: `${(elapsed / 1000).toFixed(1)}s`
            };
        } finally {
            clearTimeout(timer);
        }
    }

    async function runSingleModelTest(providerKey, modelId, options = {}) {
        const full = `${providerKey}/${modelId}`;
        const cached = !options.force ? getRecentModelTestResultV2(full) : null;
        if (cached) {
            updateModelTestBadge(full);
            if (!options.fromBatch) {
                setPageStatus(
                    cached.state === 'success'
                        ? `${full} 刚才已测试，直接复用最近结果`
                        : `${full} 刚才测试失败，先显示最近结果`,
                    cached.state === 'success' ? '#a9dc76' : '#fc9867'
                );
            }
            return {
                ok: cached.state === 'success',
                label: cached.label,
                elapsed: cached.elapsed || 0,
                cached: true
            };
        }
        state.testResults.set(full, { state: 'running', label: '测试中...' });
        renderProviders();

        try {
            const result = await requestModelTest(providerKey, modelId);
            state.testResults.set(full, { state: 'success', label: result.label });
            renderProviders();
            if (!options.fromBatch) setPageStatus(`${full} 测试通过`, '#a9dc76');
            return result;
        } catch (error) {
            const label = error?.name === 'AbortError' ? '请求超时' : String(error?.message || error || '测试失败');
            state.testResults.set(full, { state: 'error', label });
            renderProviders();
            if (!options.fromBatch) setPageStatus(`${full} 测试失败: ${label}`, '#ff6188');
            return { ok: false, label };
        }
    }

    function toggleProviderSelection(providerKey, checked) {
        collectProviderModels(providerKey).forEach((model) => {
            if (checked) state.selectedModels.add(model.full);
            else state.selectedModels.delete(model.full);
        });
        renderProviders();
    }

    async function runBatchTest(providerKey) {
        if (state.batchRun) {
            if (state.batchRun.providerKey === providerKey) {
                state.batchRun.cancelRequested = true;
                setPageStatus('已经请求停止批量测试，当前模型结束后会中断。', '#fc9867');
                renderProviders();
                return;
            }
            setPageStatus('已有其他服务商正在批量测试，请稍后再试。', '#fc9867');
            return;
        }

        const selected = collectProviderModels(providerKey).filter((model) => state.selectedModels.has(model.full));
        const targets = selected.length ? selected : collectProviderModels(providerKey);
        if (!targets.length) {
            setPageStatus('这个服务商还没有可测试的模型。', '#fc9867');
            return;
        }

        state.batchRun = {
            providerKey,
            cancelRequested: false,
            total: targets.length,
            done: 0
        };
        renderProviders();
        setPageStatus(`开始批量测试 ${targets.length} 个模型...`, '#78dce8');

        let passed = 0;
        for (const item of targets) {
            if (!state.batchRun || state.batchRun.cancelRequested) break;
            const result = await runSingleModelTest(item.providerKey, item.modelId, { fromBatch: true });
            if (result?.ok) passed += 1;
            if (!state.batchRun) break;
            state.batchRun.done += 1;
            renderProviders();
            setPageStatus(`批量测试进度 ${state.batchRun.done}/${state.batchRun.total}`, '#78dce8');
        }

        const cancelled = Boolean(state.batchRun?.cancelRequested);
        const finished = state.batchRun ? state.batchRun.done : 0;
        state.batchRun = null;
        renderProviders();

        if (cancelled) {
            setPageStatus(`批量测试已停止，已完成 ${finished} 项。`, '#fc9867');
        } else {
            setPageStatus(`批量测试完成：通过 ${passed}/${targets.length}`, passed === targets.length ? '#a9dc76' : '#fc9867');
        }
    }

    function renderProviders() {
        const listEl = container.querySelector('#mpProvidersList');
        const providers = config?.models?.providers || {};
        const keys = Object.keys(providers);
        const primary = getPrimary();

        if (!keys.length) {
            listEl.innerHTML = '<div style="color:#8b8b93;padding:20px;text-align:center;border:1px dashed rgba(255,255,255,0.08);border-radius:12px">暂无服务商，点击“添加服务商”开始配置。</div>';
            return;
        }

        listEl.innerHTML = keys.map((key) => {
            const provider = providers[key] || {};
            const models = collectProviderModels(key);
            const selectedCount = models.filter((model) => state.selectedModels.has(model.full)).length;
            const allSelected = models.length > 0 && selectedCount === models.length;
            const batchRun = state.batchRun && state.batchRun.providerKey === key ? state.batchRun : null;
            const apiLabelMap = {
                'openai-completions': 'OpenAI 兼容',
                'anthropic-messages': 'Anthropic',
                'google-gemini': 'Google Gemini'
            };

            return `
                <div class="mpProvider" data-key="${escapeHtml(key)}" style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:18px 18px 14px;margin-bottom:16px">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;flex-wrap:wrap;gap:12px">
                        <div style="display:flex;flex-direction:column;gap:6px">
                            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                                <strong style="color:#eef2f8;font-size:15px">${escapeHtml(key)}</strong>
                                <span style="font-size:11px;color:#8f98ab">${escapeHtml(apiLabelMap[provider.api] || provider.api || 'OpenAI 兼容')}</span>
                                <span style="font-size:11px;color:#8f98ab">${models.length} 个模型</span>
                                ${selectedCount ? `<span style="font-size:11px;color:#78dce8">已勾选 ${selectedCount} 个</span>` : ''}
                            </div>
                            <div style="font-size:12px;color:#8f98ab;word-break:break-all">${escapeHtml(normalizeBaseUrl(provider))}</div>
                        </div>
                        <div style="display:flex;gap:8px;flex-wrap:wrap">
                            <button class="mpEditProv" style="padding:6px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#d7dce5;cursor:pointer;font-size:12px">编辑</button>
                            <button class="mpAddModel" style="padding:6px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#d7dce5;cursor:pointer;font-size:12px">+ 模型</button>
                            <button class="mpBatchTest" style="padding:6px 12px;background:${batchRun ? 'rgba(255,152,103,0.14)' : 'rgba(120,220,232,0.15)'};border:1px solid ${batchRun ? 'rgba(255,152,103,0.32)' : 'rgba(120,220,232,0.3)'};border-radius:8px;color:${batchRun ? '#fc9867' : '#78dce8'};cursor:pointer;font-size:12px">${batchRun ? `停止批量测试 ${batchRun.done}/${batchRun.total}` : '批量测试'}</button>
                            <button class="mpDelProvider" style="padding:6px 12px;background:rgba(255,97,136,0.10);border:1px solid rgba(255,97,136,0.24);border-radius:8px;color:#ff8f8f;cursor:pointer;font-size:12px">删除</button>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05)">
                        <label style="display:flex;align-items:center;gap:8px;color:#d7dce5;font-size:13px;cursor:pointer">
                            <input type="checkbox" class="mpSelectAll" ${allSelected ? 'checked' : ''}>
                            全选当前服务商模型
                        </label>
                        <span style="font-size:12px;color:#8f98ab">不勾选时会默认批量测试该服务商全部模型。</span>
                    </div>
                    <div class="mpModels" style="display:flex;flex-direction:column;gap:8px">
                        ${models.length ? models.map((model) => {
                            const isPrimary = model.full === primary;
                            const selected = state.selectedModels.has(model.full);
                            return `
                                <div class="mpModelRow" data-provider="${escapeHtml(model.providerKey)}" data-modelid="${escapeHtml(model.modelId)}" data-full="${escapeHtml(model.full)}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:${isPrimary ? 'rgba(169,220,118,0.08)' : 'rgba(255,255,255,0.02)'};border:1px solid ${isPrimary ? 'rgba(169,220,118,0.28)' : 'rgba(255,255,255,0.05)'};flex-wrap:wrap">
                                    <input type="checkbox" class="mpSelectModel" ${selected ? 'checked' : ''} style="margin:0">
                                    <span style="flex:1;min-width:180px;font-family:monospace;font-size:13px;color:#eef2f8;word-break:break-all">${escapeHtml(model.modelId)}</span>
                                    ${isPrimary ? '<span style="font-size:11px;background:#a9dc76;color:#102014;padding:2px 8px;border-radius:999px">主模型</span>' : '<button class="mpSetPrimary" style="padding:5px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#d7dce5;cursor:pointer;font-size:11px">设为主模型</button>'}
                                    <span style="min-width:84px;text-align:right">${renderTestBadge(model.full)}</span>
                                    <button class="mpTestModel" style="padding:5px 10px;background:rgba(120,220,232,0.15);border:1px solid rgba(120,220,232,0.3);border-radius:8px;color:#78dce8;cursor:pointer;font-size:11px">测试</button>
                                    <button class="mpDelModel" style="padding:5px 10px;background:rgba(255,97,136,0.10);border:1px solid rgba(255,97,136,0.24);border-radius:8px;color:#ff8f8f;cursor:pointer;font-size:11px">删除</button>
                                </div>
                            `;
                        }).join('') : '<div style="padding:16px;border:1px dashed rgba(255,255,255,0.08);border-radius:12px;color:#8b8b93;text-align:center">当前服务商还没有模型，先点击“+ 模型”添加。</div>'}
                    </div>
                </div>
            `;
        }).join('');

        listEl.querySelectorAll('.mpProvider').forEach((section) => {
            const key = section.dataset.key;
            const provider = config.models.providers[key];
            if (!provider) return;

            const selectAll = section.querySelector('.mpSelectAll');
            if (selectAll) {
                selectAll.onchange = () => toggleProviderSelection(key, selectAll.checked);
            }

            section.querySelector('.mpBatchTest').onclick = () => runBatchTest(key);
            section.querySelector('.mpEditProv').onclick = () => showProviderModal(key, provider);
            section.querySelector('.mpAddModel').onclick = () => showAddModelModal(key);
            section.querySelector('.mpDelProvider').onclick = async () => {
                const ok = await showConfirmDialog(`确定要删除服务商“${key}”以及它下面的全部模型吗？`, {
                    title: '删除服务商',
                    confirmText: '确认删除',
                    cancelText: '取消'
                });
                if (!ok) return;

                collectProviderModels(key).forEach((model) => {
                    state.selectedModels.delete(model.full);
                    state.testResults.delete(model.full);
                });
                delete config.models.providers[key];
                if (getPrimary().startsWith(`${key}/`)) config.agents.defaults.model.primary = '';
                renderDefaultBar();
                renderProviders();
                setPageStatus(`已删除服务商 ${key}`, '#fc9867');
            };

            section.querySelectorAll('.mpModelRow').forEach((row) => {
                const modelId = row.dataset.modelid;
                const full = row.dataset.full;

                row.querySelector('.mpSelectModel').onchange = (event) => {
                    if (event.target.checked) state.selectedModels.add(full);
                    else state.selectedModels.delete(full);
                    renderProviders();
                };

                const setPrimaryBtn = row.querySelector('.mpSetPrimary');
                if (setPrimaryBtn) {
                    setPrimaryBtn.onclick = () => {
                        config.agents.defaults.model.primary = full;
                        renderDefaultBar();
                        renderProviders();
                        setPageStatus(`已将 ${full} 设为主模型`, '#a9dc76');
                    };
                }

                row.querySelector('.mpTestModel').onclick = () => runSingleModelTest(key, modelId);
                row.querySelector('.mpDelModel').onclick = async () => {
                    const ok = await showConfirmDialog(`确定要删除模型“${modelId}”吗？`, {
                        title: '删除模型',
                        confirmText: '确认删除',
                        cancelText: '取消'
                    });
                    if (!ok) return;

                    const index = (provider.models || []).findIndex((model) => (typeof model === 'string' ? model : model?.id) === modelId);
                    if (index >= 0) provider.models.splice(index, 1);
                    state.selectedModels.delete(full);
                    state.testResults.delete(full);
                    if (getPrimary() === full) config.agents.defaults.model.primary = '';
                    renderDefaultBar();
                    renderProviders();
                };
            });
        });
    }

    function showProviderModal(existingKey, existingData) {
        showFormDialog({
            title: existingKey ? `编辑服务商 ${existingKey}` : '添加服务商',
            confirmText: '保存',
            fields: [
                {
                    name: 'key',
                    label: '服务商标识',
                    value: existingKey || '',
                    placeholder: '例如 openai 或 claude',
                    readonly: Boolean(existingKey),
                    hint: '服务商标识会作为模型前缀，例如 openai/gpt-4o。'
                },
                {
                    name: 'baseUrl',
                    label: 'Base URL',
                    value: existingData?.baseUrl || '',
                    placeholder: '留空则按 API 类型使用默认地址'
                },
                {
                    name: 'apiKey',
                    label: 'API Key',
                    value: existingData?.apiKey || '',
                    placeholder: '例如 sk-...'
                },
                {
                    name: 'api',
                    label: 'API 类型',
                    type: 'select',
                    value: existingData?.api || 'openai-completions',
                    options: [
                        { value: 'openai-completions', label: 'OpenAI 兼容 (Chat Completions)' },
                        { value: 'anthropic-messages', label: 'Anthropic Messages' },
                        { value: 'google-gemini', label: 'Google Gemini' }
                    ]
                }
            ],
            onConfirm: async (values, dialog) => {
                const key = String(values.key || '').trim();
                if (!key) return dialog.setStatus('请填写服务商标识。');
                if (!existingKey && config.models.providers[key]) return dialog.setStatus('这个服务商标识已经存在。');

                if (!existingKey) config.models.providers[key] = { models: [] };
                const target = config.models.providers[existingKey || key];
                target.baseUrl = String(values.baseUrl || '').trim();
                target.apiKey = String(values.apiKey || '').trim();
                target.api = String(values.api || 'openai-completions').trim() || 'openai-completions';
                if (!Array.isArray(target.models)) target.models = [];

                dialog.close();
                renderDefaultBar();
                renderProviders();
                setPageStatus(existingKey ? `已更新服务商 ${existingKey}` : `已添加服务商 ${key}`, '#a9dc76');
            }
        });
    }

    function showAddModelModal(providerKey) {
        showFormDialog({
            title: `为 ${providerKey} 添加模型`,
            confirmText: '添加',
            fields: [
                {
                    name: 'modelIds',
                    label: '模型 ID',
                    value: '',
                    placeholder: '例如 gpt-4o-mini, claude-3-7-sonnet',
                    hint: '支持一次输入多个模型，用英文逗号分隔。'
                }
            ],
            onConfirm: async (values, dialog) => {
                const raw = String(values.modelIds || '').trim();
                if (!raw) return dialog.setStatus('请至少输入一个模型 ID。');

                const provider = config.models.providers[providerKey];
                if (!provider) return dialog.setStatus('服务商不存在。');
                if (!Array.isArray(provider.models)) provider.models = [];

                const existing = new Set(provider.models.map((model) => typeof model === 'string' ? model : model?.id).filter(Boolean));
                const incoming = raw.split(',').map((item) => item.trim()).filter(Boolean);
                const appended = [];

                incoming.forEach((modelId) => {
                    if (!existing.has(modelId)) {
                        provider.models.push(modelId);
                        existing.add(modelId);
                        appended.push(modelId);
                    }
                });

                if (!appended.length) return dialog.setStatus('输入的模型都已经存在了。');

                dialog.close();
                renderDefaultBar();
                renderProviders();
                setPageStatus(`已向 ${providerKey} 添加 ${appended.length} 个模型`, '#a9dc76');
            }
        });
    }

    async function saveConfig() {
        const saveBtn = container.querySelector('#mpBtnSave');
        saveBtn.disabled = true;
        setPageStatus('正在保存配置...', '#8b8b93');
        try {
            const result = await window.api.writeOpenClawConfig(config);
            if (result && result.ok === false) throw new Error(result.error || '保存失败');
            setPageStatus('模型配置已保存', '#a9dc76');
        } catch (error) {
            setPageStatus(`保存失败: ${error?.message || error}`, '#ff6188');
        } finally {
            saveBtn.disabled = false;
        }
    }

    container.querySelector('#mpBtnSave').onclick = saveConfig;
    container.querySelector('#mpBtnAddProvider').onclick = () => showProviderModal(null, null);

    renderDefaultBar();
    renderProviders();
}

async function renderModelsPageV2(container) {
    container.innerHTML = `
        <div class="models-page-shell">
            <h2 class="page-title">模型配置</h2>
            <p class="page-desc">把服务商、模型和默认模型拆成清晰的列表与明细结构，先看清状态，再决定新增、编辑、导入或测试。</p>
            <div class="models-toolbar">
                <div class="models-toolbar-group models-toolbar-group-primary">
                    <button id="mpBtnAddProvider" class="models-btn models-btn-primary">新增服务商</button>
                    <button id="mpBtnSave" class="models-btn models-btn-secondary">保存配置</button>
                    <button id="mpBtnRefresh" class="models-btn models-btn-subtle">刷新目录</button>
                </div>
                <div class="models-toolbar-group models-toolbar-group-secondary">
                    <input id="mpSearchInput" class="models-search-input" placeholder="搜索服务商、模型 ID 或模型名称">
                    <button id="mpBtnRemoveInvalid" class="models-btn models-btn-danger-soft">删除无效模型</button>
                </div>
            </div>
            <div id="mpSaveStatus" class="models-page-status"></div>
            <div class="models-workbench">
                <aside class="models-sidebar">
                    <div class="models-sidebar-head">
                        <div class="models-sidebar-title">服务商列表</div>
                        <div class="models-sidebar-desc">按来源浏览服务商，选中后在右侧查看模型与操作。</div>
                    </div>
                    <div id="mpProviderSidebar"><div class="models-empty-state">正在整理服务商列表...</div></div>
                </aside>
                <section id="mpProvidersList" class="models-detail"><div class="models-empty-state">正在加载模型目录...</div></section>
            </div>
        </div>
    `;

    const pageDescEl = container.querySelector('.page-desc');
    if (pageDescEl) {
        pageDescEl.textContent = '把服务商、模型和默认模型拆成清晰的列表与明细结构，先看清状态，再决定新增、编辑、导入或测试。获取模型列表会优先走标准接口，没有标准接口时再适配官方专有列表接口，仍不可用时回退到内置静态目录。';
    }

    container.querySelector('.page-title')?.replaceChildren(document.createTextNode('模型配置'));
    pageDescEl?.replaceChildren(document.createTextNode('把服务商、模型和默认模型拆成清晰的列表与明细结构，先看清状态，再决定新增、编辑、导入或测试。获取模型列表会优先走标准接口，没有标准接口时再适配官方专有列表接口，仍不可用时回退到内置静态目录。'));
    container.querySelector('#mpBtnAddProvider')?.replaceChildren(document.createTextNode('新增服务商'));
    container.querySelector('#mpBtnSave')?.replaceChildren(document.createTextNode('保存配置'));
    container.querySelector('#mpBtnRefresh')?.replaceChildren(document.createTextNode('刷新目录'));
    container.querySelector('#mpBtnRemoveInvalid')?.replaceChildren(document.createTextNode('删除无效模型'));
    container.querySelector('#mpSearchInput')?.setAttribute('placeholder', '搜索服务商、模型 ID 或模型名称');
    container.querySelector('.models-sidebar-title')?.replaceChildren(document.createTextNode('服务商列表'));
    container.querySelector('.models-sidebar-desc')?.replaceChildren(document.createTextNode('按来源浏览服务商，选中后在右侧查看模型与操作。'));
    container.querySelector('#mpProviderSidebar .models-empty-state')?.replaceChildren(document.createTextNode('正在整理服务商列表...'));
    container.querySelector('#mpProvidersList .models-empty-state')?.replaceChildren(document.createTextNode('正在加载模型目录...'));

    let config = null;
    let runtimeCatalog = { providers: [] };

    try {
        config = await window.api.getOpenClawConfig();
        runtimeCatalog = await window.api.getRuntimeModelCatalog({ agentName: 'main' });
    } catch (error) {}

    if (!config) {
        container.querySelector('#mpProvidersList').innerHTML = '<div style="color:#ff6188;padding:20px">无法加载模型配置</div>';
        return;
    }

    const listEl = container.querySelector('#mpProvidersList');
    const sidebarEl = container.querySelector('#mpProviderSidebar');
    const searchInput = container.querySelector('#mpSearchInput');
    const MODEL_HIDDEN_STORAGE_KEY = 'openclaw.models.hiddenByProvider';
    const state = {
        runtimeCatalog: runtimeCatalog && Array.isArray(runtimeCatalog.providers) ? runtimeCatalog : { providers: [] },
        selectedModels: new Set(),
        testResults: new Map(),
        collapsedProviders: new Set(),
        selectedProvider: '',
        batchRun: null,
        statusTimer: null,
        search: '',
        searchTimer: null,
        hiddenModelsByProvider: loadHiddenModelState()
    };
    const MODEL_TEST_TIMEOUT_MS = 9000;
    const MODEL_TEST_CACHE_TTL_MS = 30000;

    function ensureConfigShape() {
        if (!config.models || typeof config.models !== 'object') config.models = {};
        if (!config.models.providers || typeof config.models.providers !== 'object') config.models.providers = {};
        Object.values(config.models.providers).forEach((provider) => {
            if (provider && typeof provider === 'object' && 'excludedModels' in provider) {
                delete provider.excludedModels;
            }
        });
        if (!config.agents || typeof config.agents !== 'object') config.agents = {};
        if (!config.agents.defaults || typeof config.agents.defaults !== 'object') config.agents.defaults = {};
        if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') config.agents.defaults.model = {};
        if (!config.agents.defaults.models || typeof config.agents.defaults.models !== 'object') config.agents.defaults.models = {};
    }

    ensureConfigShape();

    function normalizeApiType(value) {
        const raw = String(value || '').trim();
        if (!raw) return 'openai-completions';
        if (raw === 'google-gemini') return 'google-generative-ai';
        return raw;
    }

    function normalizeBaseUrl(providerKey, provider) {
        const apiType = normalizeApiType(provider?.api);
        const raw = String(provider?.baseUrl || '').trim().replace(/\/+$/, '');
        if (providerKey === 'openai-codex' || apiType === 'openai-codex-responses') {
            if (!raw || /^https?:\/\/api\.openai\.com\/v1\/?$/i.test(raw)) return 'https://chatgpt.com/backend-api';
            return raw;
        }
        if (raw) return raw;
        if (apiType === 'anthropic-messages') return 'https://api.anthropic.com/v1';
        if (apiType === 'google-generative-ai') return 'https://generativelanguage.googleapis.com/v1beta';
        return 'https://api.openai.com/v1';
    }

    function normalizeModelRecord(model, fallbackApi) {
        if (!model) return null;
        if (typeof model === 'string') {
            const modelId = String(model).trim();
            if (!modelId) return null;
            return {
                id: modelId,
                name: modelId,
                api: normalizeApiType(fallbackApi)
            };
        }

        if (typeof model !== 'object') return null;
        const modelId = String(model.id || model.name || '').trim();
        if (!modelId) return null;
        const next = { ...model };
        next.id = modelId;
        if (!next.name) next.name = modelId;
        if (!next.api) next.api = normalizeApiType(fallbackApi);
        return next;
    }

    function mergeModelRecords(primary = [], secondary = [], fallbackApi) {
        const merged = new Map();

        for (const model of secondary || []) {
            const normalized = normalizeModelRecord(model, fallbackApi);
            if (!normalized) continue;
            merged.set(normalized.id, normalized);
        }

        for (const model of primary || []) {
            const normalized = normalizeModelRecord(model, fallbackApi);
            if (!normalized) continue;
            merged.set(normalized.id, {
                ...(merged.get(normalized.id) || {}),
                ...normalized
            });
        }

        return Array.from(merged.values());
    }

    function setPageStatus(message, color = '#8b8b93') {
        const statusEl = container.querySelector('#mpSaveStatus');
        if (!statusEl) return;
        statusEl.textContent = message || '';
        statusEl.style.color = color;
        if (state.statusTimer) clearTimeout(state.statusTimer);
        if (message) {
            state.statusTimer = setTimeout(() => {
                if (statusEl.textContent === message) statusEl.textContent = '';
            }, 4000);
        }
    }

    function setPageStatus(message, color = '#8b8b93') {
        const statusEl = container.querySelector('#mpSaveStatus');
        if (!statusEl) return;
        statusEl.textContent = message || '';
        const isLightTheme = document.documentElement?.dataset?.theme === 'light';
        const colorMap = isLightTheme
            ? {
                '#a9dc76': '#18743d',
                '#00ff88': '#18743d',
                '#ff8f8f': '#c62828',
                '#ff6188': '#c62828',
                '#78dce8': '#127d96',
                '#fc9867': '#a65e16'
            }
            : null;
        statusEl.style.color = colorMap?.[color] || color;
        if (state.statusTimer) clearTimeout(state.statusTimer);
        if (message) {
            state.statusTimer = setTimeout(() => {
                if (statusEl.textContent === message) statusEl.textContent = '';
            }, 4000);
        }
    }

    function getPrimary() {
        return String(config?.agents?.defaults?.model?.primary || '').trim();
    }

    function escapeSelectorValue(value) {
        const text = String(value ?? '');
        if (window.CSS?.escape) return window.CSS.escape(text);
        return text.replace(/["\\]/g, '\\$&');
    }

    function normalizeHiddenModelState(raw) {
        if (!raw || typeof raw !== 'object') return {};
        const normalized = {};
        Object.entries(raw).forEach(([providerKey, modelIds]) => {
            const safeKey = String(providerKey || '').trim();
            if (!safeKey || !Array.isArray(modelIds)) return;
            const cleaned = Array.from(new Set(modelIds.map((modelId) => String(modelId || '').trim()).filter(Boolean)));
            if (cleaned.length) {
                normalized[safeKey] = cleaned;
            }
        });
        return normalized;
    }

    function loadHiddenModelState() {
        try {
            const raw = localStorage.getItem(MODEL_HIDDEN_STORAGE_KEY);
            if (!raw) return {};
            return normalizeHiddenModelState(JSON.parse(raw));
        } catch (_) {
            return {};
        }
    }

    function saveHiddenModelState() {
        try {
            localStorage.setItem(MODEL_HIDDEN_STORAGE_KEY, JSON.stringify(normalizeHiddenModelState(state.hiddenModelsByProvider)));
        } catch (_) {}
    }

    function getRuntimeProviderMap() {
        const map = new Map();
        for (const provider of state.runtimeCatalog.providers || []) {
            if (!provider?.key) continue;
            map.set(provider.key, { ...provider });
        }
        return map;
    }

    function getMergedProviderEntries() {
        const runtimeMap = getRuntimeProviderMap();
        const allKeys = new Set([
            ...runtimeMap.keys(),
            ...Object.keys(config?.models?.providers || {})
        ]);
        const orderMap = {
            config: 0,
            'auth-oauth': 1,
            'auth-key': 2,
            runtime: 3,
            reference: 4
        };

        return Array.from(allKeys).map((providerKey) => {
            const runtimeProvider = runtimeMap.get(providerKey) || {};
            const localProvider = config?.models?.providers?.[providerKey] || null;
            const api = normalizeApiType(localProvider?.api || runtimeProvider.api);
            const mergedModels = mergeModelRecords(localProvider?.models || [], runtimeProvider.models || [], api);
            const excludedModelIds = new Set(
                Array.isArray(state.hiddenModelsByProvider?.[providerKey])
                    ? state.hiddenModelsByProvider[providerKey].map((modelId) => String(modelId || '').trim()).filter(Boolean)
                    : []
            );
            return {
                ...runtimeProvider,
                ...(localProvider ? localProvider : {}),
                key: providerKey,
                api,
                baseUrl: normalizeBaseUrl(providerKey, localProvider || runtimeProvider),
                models: mergedModels.filter((model) => !excludedModelIds.has(model.id)),
                editable: Boolean(localProvider),
                inConfig: Boolean(localProvider),
                sourceKey: localProvider ? 'config' : (runtimeProvider.sourceKey || 'reference'),
                credentialMode: localProvider?.apiKey ? 'config-key' : (runtimeProvider.credentialMode || 'none')
            };
        }).sort((a, b) => {
            const orderA = orderMap[a.sourceKey] ?? 99;
            const orderB = orderMap[b.sourceKey] ?? 99;
            if (orderA !== orderB) return orderA - orderB;
            return a.key.localeCompare(b.key, 'zh-CN');
        });
    }

    function getProviderEntry(providerKey) {
        return getMergedProviderEntries().find((item) => item.key === providerKey) || null;
    }

    function collectProviderModels(providerKey) {
        const provider = getProviderEntry(providerKey);
        if (!provider) return [];
        return (provider.models || [])
            .map((model) => normalizeModelRecord(model, provider.api))
            .filter(Boolean)
            .map((model) => ({
                providerKey,
                modelId: model.id,
                full: `${providerKey}/${model.id}`,
                raw: model
            }));
    }

    function collectAllModels() {
        return getMergedProviderEntries().flatMap((provider) => collectProviderModels(provider.key));
    }

    function getGroupMeta(sourceKey) {
        const groups = {
            config: {
                title: '配置文件 / 自定义',
                desc: '直接来自 openclaw.json 的 provider，可编辑、可保存。'
            },
            'auth-oauth': {
                title: 'Auth 登录 / OAuth',
                desc: '来自本地登录状态，可直接拉取远程模型并设为主模型。'
            },
            'auth-key': {
                title: 'Auth API Key',
                desc: '来自本地 auth-profiles 的 API Key provider，同样可以拉取远程模型。'
            },
            runtime: {
                title: '运行时元数据',
                desc: '来自 agent 本地元数据，方便核对当前可见模型。'
            },
            reference: {
                title: '引用中的模型',
                desc: '当前配置已经引用这些模型，即使 provider 尚未完整写入。'
            }
        };
        if (sourceKey === 'auth-oauth') {
            return {
                title: '登录态来源',
                desc: '来自本地凭据目录，主要用于补全当前可用的 provider 与模型上下文。'
            };
        }
        if (sourceKey === 'auth-key') {
            return {
                title: '密钥来源',
                desc: '来自本地凭据目录，主要用于补全当前可用的 provider 与模型上下文。'
            };
        }
        return groups[sourceKey] || groups.reference;
    }

    function ensureConfigProvider(providerKey, seed = null) {
        if (!config.models.providers[providerKey]) {
            const source = seed || getProviderEntry(providerKey) || {};
            config.models.providers[providerKey] = {
                api: normalizeApiType(source.api),
                baseUrl: normalizeBaseUrl(providerKey, source),
                models: []
            };
        }

        const provider = config.models.providers[providerKey];
        provider.api = normalizeApiType(provider.api || seed?.api);
        provider.baseUrl = normalizeBaseUrl(providerKey, provider);
        if (!Array.isArray(provider.models)) provider.models = [];
        return provider;
    }

    function upsertModelsIntoProvider(providerKey, incomingModels = []) {
        const provider = ensureConfigProvider(providerKey, getProviderEntry(providerKey));
        const beforeIds = new Set((provider.models || [])
            .map((model) => typeof model === 'string' ? model : model?.id)
            .filter(Boolean));
        provider.models = mergeModelRecords(incomingModels, provider.models || [], provider.api);

        const appended = [];
        for (const model of incomingModels) {
            const normalized = normalizeModelRecord(model, provider.api);
            if (!normalized) continue;
            if (!beforeIds.has(normalized.id)) {
                appended.push(normalized);
            }
        }
        clearProviderModelExclusions(
            providerKey,
            incomingModels
                .map((model) => normalizeModelRecord(model, provider.api))
                .filter(Boolean)
                .map((model) => model.id)
        );
        return appended;
    }

    function markProviderModelsExcluded(providerKey, modelIds = []) {
        const safeKey = String(providerKey || '').trim();
        if (!safeKey) return;
        const excluded = new Set(Array.isArray(state.hiddenModelsByProvider?.[safeKey]) ? state.hiddenModelsByProvider[safeKey] : []);
        modelIds.filter(Boolean).forEach((modelId) => excluded.add(modelId));
        state.hiddenModelsByProvider[safeKey] = Array.from(excluded);
        saveHiddenModelState();
    }

    function clearProviderModelExclusions(providerKey, modelIds = []) {
        const safeKey = String(providerKey || '').trim();
        if (!safeKey || !Array.isArray(state.hiddenModelsByProvider?.[safeKey])) return;
        const targetIds = new Set(modelIds.map((modelId) => String(modelId || '').trim()).filter(Boolean));
        if (!targetIds.size) return;
        const next = state.hiddenModelsByProvider[safeKey].filter((modelId) => !targetIds.has(String(modelId || '').trim()));
        if (next.length) {
            state.hiddenModelsByProvider[safeKey] = next;
        } else {
            delete state.hiddenModelsByProvider[safeKey];
        }
        saveHiddenModelState();
    }

    function rememberModelReference(fullModelId) {
        if (!fullModelId) return;
        if (!config.agents.defaults.models || typeof config.agents.defaults.models !== 'object') {
            config.agents.defaults.models = {};
        }
        if (!config.agents.defaults.models[fullModelId]) {
            config.agents.defaults.models[fullModelId] = {};
        }
    }

    function dropModelReferences(fullModelId) {
        const target = String(fullModelId || '').trim();
        if (!target) return;

        if (getPrimary() === target) {
            config.agents.defaults.model.primary = '';
        }

        const fallbacks = Array.isArray(config?.agents?.defaults?.model?.fallbacks)
            ? config.agents.defaults.model.fallbacks
            : [];
        config.agents.defaults.model.fallbacks = fallbacks.filter((item) => String(item || '').trim() !== target);

        if (config?.agents?.defaults?.models && typeof config.agents.defaults.models === 'object') {
            delete config.agents.defaults.models[target];
        }
    }

    function dropProviderReferences(providerKey) {
        if (getPrimary().startsWith(`${providerKey}/`)) {
            config.agents.defaults.model.primary = '';
        }

        const fallbacks = Array.isArray(config?.agents?.defaults?.model?.fallbacks)
            ? config.agents.defaults.model.fallbacks
            : [];
        config.agents.defaults.model.fallbacks = fallbacks.filter((item) => !String(item || '').startsWith(`${providerKey}/`));

        if (config?.agents?.defaults?.models && typeof config.agents.defaults.models === 'object') {
            Object.keys(config.agents.defaults.models).forEach((full) => {
                if (full.startsWith(`${providerKey}/`)) {
                    delete config.agents.defaults.models[full];
                }
            });
        }
    }

    function renderDefaultBar() {
        const bar = container.querySelector('#mpDefaultBar');
        if (!bar) return;
        const primary = getPrimary();
        const allModels = collectAllModels();
        const fallbackList = Array.isArray(config?.agents?.defaults?.model?.fallbacks)
            ? config.agents.defaults.model.fallbacks.filter(Boolean)
            : [];
        const fallbackText = fallbackList.length
            ? fallbackList.join(', ')
            : (allModels.filter((model) => model.full !== primary).slice(0, 4).map((model) => model.full).join(', ') || '暂无');
        const providers = getMergedProviderEntries();
        const authCount = providers.filter((provider) => ['auth-oauth', 'auth-key'].includes(provider.sourceKey)).length;
        const configCount = providers.filter((provider) => provider.inConfig).length;

        bar.innerHTML = `
            <article class="models-summary-card">
                <span class="models-summary-label">主模型</span>
                <strong class="models-summary-value ${primary ? 'is-good' : 'is-danger'}">${escapeHtml(primary || '未配置')}</strong>
                <span class="models-summary-note">先在右侧明细区选择模型，再设置为主模型。</span>
            </article>
            <article class="models-summary-card">
                <span class="models-summary-label">回退候选</span>
                <strong class="models-summary-value">${escapeHtml(fallbackText)}</strong>
                <span class="models-summary-note">未单独配置时，会从可用模型里补足默认候选。</span>
            </article>
            <article class="models-summary-card">
                <span class="models-summary-label">服务商概览</span>
                <strong class="models-summary-value">${providers.length} 个服务商</strong>
                <span class="models-summary-note">其中 ${configCount} 个已写入配置，${authCount} 个来自 Auth 登录 / Key。</span>
            </article>
        `;
    }

    function renderTestBadge(full) {
        const result = state.testResults.get(full);
        if (!result) return '<span style="font-size:11px;color:#8b8b93">未测试</span>';
        if (result.state === 'running') return '<span style="font-size:11px;color:#78dce8">测试中...</span>';
        if (result.state === 'success') return `<span style="font-size:11px;color:#a9dc76">通过 ${escapeHtml(result.label)}</span>`;
        return `<span style="font-size:11px;color:#ff8f8f">${escapeHtml(result.label || '失败')}</span>`;
    }

    function renderTestBadge(full) {
        const result = state.testResults.get(full);
        if (!result) return '<span class="models-test-badge is-idle">未测试</span>';
        if (result.state === 'running') return '<span class="models-test-badge is-running">测试中...</span>';
        if (result.state === 'success') return `<span class="models-test-badge is-success">通过 ${escapeHtml(result.label)}</span>`;
        return `<span class="models-test-badge is-error">${escapeHtml(result.label || '失败')}</span>`;
    }

    function getProviderSelectionText(providerKey) {
        const models = collectProviderModels(providerKey);
        const selectedCount = models.filter((item) => state.selectedModels.has(item.full)).length;
        return selectedCount ? `已勾选 ${selectedCount} 个模型` : '未勾选时默认测试这个 provider 的全部模型。';
    }

    function getProviderSelectionLabel(providerKey) {
        const models = collectProviderModels(providerKey);
        const selectedCount = models.filter((item) => state.selectedModels.has(item.full)).length;
        return selectedCount ? `已勾选 ${selectedCount} 个模型` : '未勾选时默认测试当前列表里的全部模型。';
    }

    function updateModelTestBadge(full) {
        renderProviders();
        updateInvalidModelButton();
    }

    function updateBatchButton(providerKey) {
        renderProviders();
    }

    function updateProviderSelectionUi(providerKey, options = {}) {
        renderProviders();
    }

    function refreshModelsView(options = {}) {
        if (options.defaultBar !== false) {
            renderDefaultBar();
        }
        renderProviders();
    }

    function collectInvalidModelIds() {
        return Array.from(state.testResults.entries())
            .filter(([, result]) => result?.state === 'error')
            .map(([full]) => full);
    }

    function isProviderCollapsed(providerKey) {
        return !state.search && state.collapsedProviders.has(providerKey);
    }

    function toggleProviderCollapsed(providerKey) {
        if (!providerKey) return;
        if (state.collapsedProviders.has(providerKey)) {
            state.collapsedProviders.delete(providerKey);
        } else {
            state.collapsedProviders.add(providerKey);
        }
        renderProviders();
    }

    function expandAllProviders() {
        state.collapsedProviders.clear();
        renderProviders();
    }

    function collapseAllProviders() {
        const visibleProviders = getMergedProviderEntries().map((provider) => provider.key);
        state.collapsedProviders = new Set(visibleProviders);
        renderProviders();
    }

    function updateInvalidModelButton() {
        const button = container.querySelector('#mpBtnRemoveInvalid');
        if (!button) return;
        const invalidCount = collectInvalidModelIds().length;
        button.textContent = invalidCount ? `删除无效模型 (${invalidCount})` : '删除无效模型';
        button.disabled = invalidCount === 0 || Boolean(state.batchRun);
        button.style.opacity = button.disabled ? '0.55' : '1';
        button.style.cursor = button.disabled ? 'not-allowed' : 'pointer';
    }

    function applyProviderCollapseState() {
        listEl.querySelectorAll('.mpProviderCardV2').forEach((card) => {
            const providerKey = card.getAttribute('data-provider');
            const modelCount = card.querySelectorAll('[data-mp-select-model]').length;
            const header = card.firstElementChild;
            const actionBar = card.querySelector('.models-provider-selection .models-provider-actions')
                || header?.querySelector('.models-provider-actions');
            const collapsed = modelCount > 0 && isProviderCollapsed(providerKey);
            const contentBlocks = Array.from(card.children).slice(1);

            if (actionBar && modelCount > 0) {
                let toggleBtn = actionBar.querySelector('[data-mp-toggle-provider]');
                if (!toggleBtn) {
                    toggleBtn = document.createElement('button');
                    toggleBtn.setAttribute('type', 'button');
                    toggleBtn.setAttribute('data-mp-toggle-provider', providerKey);
                    toggleBtn.style.padding = '6px 12px';
                    toggleBtn.style.background = 'rgba(255,255,255,0.05)';
                    toggleBtn.style.border = '1px solid rgba(255,255,255,0.08)';
                    toggleBtn.style.borderRadius = '8px';
                    toggleBtn.style.color = '#d7dce5';
                    toggleBtn.style.cursor = 'pointer';
                    toggleBtn.style.fontSize = '12px';
                    actionBar.insertBefore(toggleBtn, actionBar.firstChild);
                }
                toggleBtn.textContent = collapsed ? '+ 展开' : '- 折叠';
                toggleBtn.onclick = () => toggleProviderCollapsed(providerKey);
            } else if (header) {
                header.querySelector('[data-mp-toggle-provider]')?.remove();
            }

            let hint = card.querySelector('.mpProviderCollapsedHint');
            if (!hint) {
                hint = document.createElement('div');
                hint.className = 'mpProviderCollapsedHint';
                hint.style.padding = '12px 14px';
                hint.style.borderRadius = '12px';
                hint.style.background = 'rgba(255,255,255,0.02)';
                hint.style.border = '1px dashed rgba(255,255,255,0.06)';
                hint.style.color = '#8f98ab';
                hint.style.fontSize = '12px';
                hint.style.display = 'none';
                card.appendChild(hint);
            }

            contentBlocks.forEach((block) => {
                block.style.display = collapsed ? 'none' : '';
            });

            if (collapsed) {
                hint.textContent = `已折叠 ${modelCount} 个模型，点击右上角“展开”查看。`;
                hint.style.display = 'block';
            } else {
                hint.style.display = 'none';
            }
        });
    }

    function buildProviderRequest(providerKey) {
        const provider = getProviderEntry(providerKey) || config?.models?.providers?.[providerKey];
        if (!provider) return null;
        return {
            api: normalizeApiType(provider.api),
            baseUrl: normalizeBaseUrl(providerKey, provider),
            apiKey: String(provider.apiKey || '').trim(),
            models: Array.isArray(provider.models) ? provider.models : []
        };
    }

    async function reloadRuntimeCatalog() {
        try {
            const nextCatalog = await window.api.getRuntimeModelCatalog({ agentName: 'main' });
            state.runtimeCatalog = nextCatalog && Array.isArray(nextCatalog.providers) ? nextCatalog : { providers: [] };
        } catch (_) {
            state.runtimeCatalog = { providers: [] };
        }
    }

    async function persistModelConfig(options = {}) {
        const {
            successMessage = '模型配置已保存',
            failurePrefix = '保存失败',
            refreshRuntime = true
        } = options;
        const saveBtn = container.querySelector('#mpBtnSave');
        const previousDisabled = Boolean(saveBtn?.disabled);
        if (saveBtn) saveBtn.disabled = true;

        try {
            const result = await window.api.writeOpenClawConfig(config);
            if (result && result.ok === false) throw new Error(result.error || '保存失败');
            if (refreshRuntime) {
                await reloadRuntimeCatalog();
            }
            renderDefaultBar();
            renderProviders();
            if (successMessage) setPageStatus(successMessage, '#a9dc76');
            return true;
        } catch (error) {
            setPageStatus(String(failurePrefix) + ': ' + String(error?.message || error), '#ff6188');
            return false;
        } finally {
            if (saveBtn) saveBtn.disabled = previousDisabled;
        }
    }

    function getRecentModelTestResultV2(fullModelId) {
        const cached = state.testResults.get(fullModelId);
        if (!cached || cached.state === 'running') return null;
        if (!cached.updatedAt || (Date.now() - cached.updatedAt) > MODEL_TEST_CACHE_TTL_MS) return null;
        return cached;
    }

    async function requestModelTest(providerKey, modelId, timeoutMs = MODEL_TEST_TIMEOUT_MS) {
        const result = await window.api.testProviderModel({
            agentName: 'main',
            providerKey,
            provider: buildProviderRequest(providerKey),
            modelId,
            timeoutMs
        });

        if (!result || result.ok === false) {
            throw new Error(result?.error || result?.label || '测试失败');
        }

        return result;
    }

    async function runSingleModelTest(providerKey, modelId, options = {}) {
        const full = providerKey + '/' + modelId;
        state.testResults.set(full, { state: 'running', label: '测试中...' });
        updateModelTestBadge(full);

        try {
            const result = await requestModelTest(providerKey, modelId, MODEL_TEST_TIMEOUT_MS);
            state.testResults.set(full, {
                state: 'success',
                label: result.label || ((result.elapsed / 1000).toFixed(1) + 's'),
                elapsed: Number(result.elapsed || 0),
                updatedAt: Date.now()
            });
            updateModelTestBadge(full);
            if (!options.fromBatch) setPageStatus(full + ' 测试通过', '#a9dc76');
            return result;
        } catch (error) {
            const label = String(error?.message || error || '测试失败');
            state.testResults.set(full, { state: 'error', label, updatedAt: Date.now() });
            updateModelTestBadge(full);
            if (!options.fromBatch) setPageStatus(full + ' 测试失败: ' + label, '#ff6188');
            return { ok: false, label };
        }
    }

    function toggleProviderSelection(providerKey, checked) {
        collectProviderModels(providerKey).forEach((model) => {
            if (checked) state.selectedModels.add(model.full);
            else state.selectedModels.delete(model.full);
        });
        updateProviderSelectionUi(providerKey, { syncModelCheckboxes: true });
    }

    async function runBatchTest(providerKey) {
        if (state.batchRun) {
            if (state.batchRun.providerKey === providerKey) {
                state.batchRun.cancelRequested = true;
                setPageStatus('已经请求停止批量测试，当前模型结束后会中断。', '#fc9867');
                updateBatchButton(providerKey);
                return;
            }

            setPageStatus('已有其他 provider 正在批量测试，请稍后再试。', '#fc9867');
            return;
        }

        const selected = collectProviderModels(providerKey).filter((model) => state.selectedModels.has(model.full));
        const targets = selected.length ? selected : collectProviderModels(providerKey);
        if (!targets.length) {
            setPageStatus('这个 provider 还没有可测试的模型。', '#fc9867');
            return;
        }

        state.batchRun = {
            providerKey,
            cancelRequested: false,
            total: targets.length,
            done: 0
        };
        updateBatchButton(providerKey);
        const concurrency = Math.max(1, Math.min(4, targets.length));
        setPageStatus(`开始批量测试 ${targets.length} 个模型（并发 ${concurrency}）...`, '#78dce8');

        let passed = 0;
        let nextIndex = 0;
        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (true) {
                if (!state.batchRun || state.batchRun.cancelRequested) return;
                const currentIndex = nextIndex;
                nextIndex += 1;
                if (currentIndex >= targets.length) return;
                const item = targets[currentIndex];
                const result = await runSingleModelTest(item.providerKey, item.modelId, { fromBatch: true });
                if (result?.ok) passed += 1;
                if (!state.batchRun) return;
                state.batchRun.done += 1;
                updateBatchButton(providerKey);
                setPageStatus(`批量测试进度 ${state.batchRun.done}/${state.batchRun.total}`, '#78dce8');
            }
        }));

        const cancelled = Boolean(state.batchRun?.cancelRequested);
        const finished = state.batchRun ? state.batchRun.done : 0;
        state.batchRun = null;
        updateBatchButton(providerKey);

        if (cancelled) {
            setPageStatus(`批量测试已停止，已完成 ${finished} 项。`, '#fc9867');
        } else {
            setPageStatus(`批量测试完成：通过 ${passed}/${targets.length}`, passed === targets.length ? '#a9dc76' : '#fc9867');
        }
    }

    function showProviderModal(existingKey, existingData) {
        showFormDialog({
            title: existingKey ? `编辑服务商 ${existingKey}` : '添加服务商',
            description: existingKey ? '先确认服务商标识、地址和凭据，再保存本地配置。' : '新增服务商时，先定义标识和 API 类型，再补充地址与凭据。',
            confirmText: '保存',
            fields: [
                {
                    name: 'key',
                    label: '服务商标识',
                    value: existingKey || '',
                    placeholder: '例如 openai、anthropic、google',
                    readonly: Boolean(existingKey),
                    hint: '服务商标识会作为模型前缀，例如 openai/gpt-4o。'
                },
                {
                    name: 'baseUrl',
                    label: 'Base URL',
                    value: existingData?.baseUrl || '',
                    placeholder: '留空则按 API 类型使用默认地址'
                },
                {
                    name: 'apiKey',
                    label: 'API Key',
                    value: existingData?.apiKey || '',
                    placeholder: '例如 sk-...；Auth 登录型 provider 可留空'
                },
                {
                    name: 'api',
                    label: 'API 类型',
                    type: 'select',
                    value: normalizeApiType(existingData?.api || 'openai-completions'),
                    options: [
                        { value: 'openai-completions', label: 'OpenAI 兼容 / Chat Completions' },
                        { value: 'openai-responses', label: 'OpenAI Responses' },
                        { value: 'openai-codex-responses', label: 'OpenAI Codex Responses' },
                        { value: 'anthropic-messages', label: 'Anthropic Messages' },
                        { value: 'google-generative-ai', label: 'Google Gemini / Generative AI' }
                    ]
                }
            ],
            onConfirm: async (values, dialog) => {
                const key = String(values.key || '').trim();
                if (!key) return dialog.setStatus('请填写服务商标识。');
                if (!existingKey && config.models.providers[key]) return dialog.setStatus('这个服务商标识已经存在。');

                const target = ensureConfigProvider(existingKey || key, existingData || getProviderEntry(existingKey || key));
                target.baseUrl = String(values.baseUrl || '').trim();
                target.apiKey = String(values.apiKey || '').trim();
                target.api = normalizeApiType(values.api || 'openai-completions');
                target.baseUrl = normalizeBaseUrl(existingKey || key, target);

                dialog.close();
                await persistModelConfig({
                    successMessage: existingKey ? `已更新服务商 ${existingKey}，并自动保存` : `已添加服务商 ${key}，并自动保存`
                });
            }
        });
    }

    function showAddModelModal(providerKey) {
        showFormDialog({
            title: `向 ${providerKey} 添加模型`,
            description: '按统一的单列表单输入模型 ID；需要一次新增多个模型时，用英文逗号分隔。',
            confirmText: '添加',
            fields: [
                {
                    name: 'modelIds',
                    label: '模型 ID',
                    value: '',
                    placeholder: '例如 gpt-4o-mini, claude-3-7-sonnet',
                    hint: '支持一次输入多个模型，用英文逗号分隔。'
                }
            ],
            onConfirm: async (values, dialog) => {
                const raw = String(values.modelIds || '').trim();
                if (!raw) return dialog.setStatus('请至少输入一个模型 ID。');
                const incoming = raw.split(',').map((item) => item.trim()).filter(Boolean).map((item) => ({ id: item, name: item }));
                const appended = upsertModelsIntoProvider(providerKey, incoming);
                if (!appended.length) return dialog.setStatus('输入的模型都已经存在了。');

                dialog.close();
                await persistModelConfig({
                    successMessage: `已向 ${providerKey} 添加 ${appended.length} 个模型，并自动保存`
                });
            }
        });
    }

    function showRemoteModelPicker(providerEntry, remoteModels, note = '') {
        const providerKey = providerEntry.key;
        const remoteMap = new Map(remoteModels.map((model) => [model.id, model]));
        const configProvider = config?.models?.providers?.[providerKey] || null;
        const existingIds = new Set(
            Array.isArray(configProvider?.models)
                ? configProvider.models
                    .map((model) => typeof model === 'string' ? model : model?.id)
                    .filter(Boolean)
                : []
        );

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(9,11,16,0.78);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px;box-sizing:border-box';
        overlay.innerHTML = `
            <div style="width:min(860px,96vw);max-height:82vh;background:#1c212d;border:1px solid rgba(255,255,255,0.08);border-radius:18px;padding:20px;box-shadow:0 30px 60px rgba(0,0,0,0.38);display:flex;flex-direction:column;gap:14px">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
                    <div>
                        <div style="color:#f5f7fb;font-size:18px;font-weight:700;margin-bottom:6px">远程模型列表 - ${escapeHtml(providerKey)}</div>
                        <div style="color:#8f98ab;font-size:13px;line-height:1.7">共获取到 ${remoteModels.length} 个模型。勾选后会写入本地 openclaw.json，保存后就能直接用于主模型、回退模型和批量测试。</div>
                    </div>
                    <button data-role="close" type="button" style="padding:8px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#d7dce5;cursor:pointer">关闭</button>
                </div>
                <div style="display:flex;gap:10px;flex-wrap:wrap">
                    <input id="mpRemoteFilter" placeholder="搜索模型..." style="flex:1;min-width:220px;padding:10px 12px;background:#141823;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eef2f8;font-size:13px">
                    <button id="mpRemoteToggleAll" type="button" style="padding:9px 14px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#d7dce5;cursor:pointer">全选</button>
                </div>
                <div id="mpRemoteStatus" style="font-size:12px;color:#8f98ab"></div>
                <div id="mpRemoteList" style="flex:1;max-height:48vh;overflow-y:auto;background:#10141d;border-radius:14px;border:1px solid rgba(255,255,255,0.06);padding:12px"></div>
                <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
                    <span id="mpRemoteCount" style="font-size:12px;color:#8f98ab">已选 0 个</span>
                    <div style="display:flex;gap:10px">
                        <button id="mpRemoteCancel" type="button" style="padding:9px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#d7dce5;cursor:pointer">取消</button>
                        <button id="mpRemoteImport" type="button" style="padding:9px 16px;background:#78dce8;border:none;border-radius:10px;color:#102028;font-weight:700;cursor:pointer">导入到配置</button>
                    </div>
                </div>
            </div>
        `;

        const listPanel = overlay.querySelector('#mpRemoteList');
        const filterInput = overlay.querySelector('#mpRemoteFilter');
        const countEl = overlay.querySelector('#mpRemoteCount');
        const statusEl = overlay.querySelector('#mpRemoteStatus');
        if (note) {
            statusEl.textContent = note;
            statusEl.style.color = '#78dce8';
        }

        function closeOverlay() {
            overlay.remove();
        }

        function updateCount() {
            const checked = listPanel.querySelectorAll('.mpRemoteCb:checked').length;
            countEl.textContent = `已选 ${checked} 个`;
        }

        function renderRemoteList(filterText = '') {
            const normalizedFilter = String(filterText || '').trim().toLowerCase();
            const filtered = normalizedFilter
                ? remoteModels.filter((item) => {
                    const haystack = `${item.id} ${item.name || ''}`.toLowerCase();
                    return haystack.includes(normalizedFilter);
                })
                : remoteModels;

            listPanel.innerHTML = filtered.length
                ? filtered.map((item) => {
                    const exists = existingIds.has(item.id);
                    return `
                        <label style="display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,0.05);background:${exists ? 'rgba(255,255,255,0.02)' : 'rgba(120,220,232,0.04)'};margin-bottom:8px;cursor:${exists ? 'not-allowed' : 'pointer'};opacity:${exists ? '0.72' : '1'}">
                            <input type="checkbox" class="mpRemoteCb" data-id="${escapeHtml(item.id)}" ${exists ? 'disabled' : ''} style="margin-top:2px">
                            <div style="flex:1;min-width:0">
                                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                                    <span style="font-family:monospace;font-size:13px;color:#eef2f8;word-break:break-all">${escapeHtml(item.id)}</span>
                                    ${exists ? '<span style="font-size:11px;background:rgba(255,255,255,0.08);color:#aab3c5;padding:2px 8px;border-radius:999px">已存在</span>' : ''}
                                    ${item.reasoning ? '<span style="font-size:11px;background:rgba(120,220,232,0.14);color:#78dce8;padding:2px 8px;border-radius:999px">推理</span>' : ''}
                                </div>
                                <div style="margin-top:4px;font-size:12px;color:#8f98ab;line-height:1.7">
                                    ${escapeHtml(item.name || item.id)}
                                    ${item.contextWindow ? ` · 上下文 ${escapeHtml(String(item.contextWindow))}` : ''}
                                    ${item.maxTokens ? ` · 最大输出 ${escapeHtml(String(item.maxTokens))}` : ''}
                                </div>
                            </div>
                        </label>
                    `;
                }).join('')
                : '<div style="padding:18px;text-align:center;color:#8f98ab">没有匹配到任何模型。</div>';

            listPanel.querySelectorAll('.mpRemoteCb').forEach((checkbox) => {
                checkbox.onchange = updateCount;
            });
            updateCount();
        }

        overlay.querySelectorAll('[data-role="close"]').forEach((button) => {
            button.onclick = closeOverlay;
        });
        overlay.querySelector('#mpRemoteCancel').onclick = closeOverlay;
        overlay.querySelector('#mpRemoteToggleAll').onclick = () => {
            const checkboxes = Array.from(listPanel.querySelectorAll('.mpRemoteCb:not(:disabled)'));
            const shouldCheck = checkboxes.some((checkbox) => !checkbox.checked);
            checkboxes.forEach((checkbox) => {
                checkbox.checked = shouldCheck;
            });
            updateCount();
        };
        overlay.querySelector('#mpRemoteImport').onclick = async () => {
            const selectedIds = Array.from(listPanel.querySelectorAll('.mpRemoteCb:checked')).map((checkbox) => checkbox.dataset.id);
            if (!selectedIds.length) {
                statusEl.textContent = '请至少选择一个模型再导入。';
                statusEl.style.color = '#ff8f8f';
                return;
            }

            const incoming = selectedIds.map((id) => remoteMap.get(id)).filter(Boolean);
            const appended = upsertModelsIntoProvider(providerKey, incoming);
            if (!appended.length) {
                statusEl.textContent = '选中的模型都已经在配置里了。';
                statusEl.style.color = '#fc9867';
                return;
            }

            appended.forEach((model) => rememberModelReference(`${providerKey}/${model.id}`));
            closeOverlay();
            await persistModelConfig({
                successMessage: `已向 ${providerKey} 导入 ${appended.length} 个远程模型，并自动保存`
            });
        };

        filterInput.oninput = () => renderRemoteList(filterInput.value);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeOverlay();
        });
        document.body.appendChild(overlay);
        renderRemoteList('');
        filterInput.focus();
    }

    async function fetchRemoteModels(providerKey) {
        const providerEntry = getProviderEntry(providerKey);
        if (!providerEntry) {
            setPageStatus(`未找到服务商 ${providerKey}`, '#ff6188');
            return;
        }

        setPageStatus(`正在从 ${providerKey} 拉取远程模型列表...`, '#78dce8');
        try {
            const result = await window.api.listRemoteModels({
                agentName: 'main',
                providerKey,
                provider: buildProviderRequest(providerKey)
            });
            if (!result || result.ok === false) {
                throw new Error(result?.error || '拉取失败');
            }

            const remoteModels = Array.isArray(result.models) ? result.models.filter((item) => item && item.id) : [];
            if (!remoteModels.length) {
                setPageStatus(`${providerKey} 没有返回可导入的模型`, '#fc9867');
                return;
            }

            const note = String(result?.note || '').trim();
            setPageStatus(
                note || `已获取 ${remoteModels.length} 个模型，请选择要导入的条目。`,
                note ? '#78dce8' : '#a9dc76'
            );
            showRemoteModelPicker(providerEntry, remoteModels, note);
        } catch (error) {
            setPageStatus(`拉取 ${providerKey} 远程模型失败: ${error?.message || error}`, '#ff6188');
        }
    }

    function renderProviders() {
        const searchValue = String(state.search || '').trim().toLowerCase();
        const credentialLabelMap = {
            'config-key': '配置 API Key',
            oauth: 'Auth 登录',
            'auth-api-key': 'Auth API Key',
            none: '未发现凭据'
        };
        const visibleEntries = [];

        for (const provider of getMergedProviderEntries()) {
            const providerMatches = `${provider.key} ${provider.authProfileId || ''}`.toLowerCase().includes(searchValue);
            const models = collectProviderModels(provider.key).filter((model) => {
                if (!searchValue) return true;
                const rawName = String(model.raw?.name || '').toLowerCase();
                const haystack = `${model.modelId} ${rawName}`.toLowerCase();
                return haystack.includes(searchValue);
            });

            if (searchValue && !providerMatches && !models.length) continue;
            visibleEntries.push({ provider, models });
        }

        if (!visibleEntries.length) {
            sidebarEl.innerHTML = '<div class="models-empty-state">没有匹配到服务商或模型。</div>';
            listEl.innerHTML = '<div class="models-empty-state">调整搜索词后，再选择服务商查看右侧明细。</div>';
            return;
        }

        if (!state.selectedProvider || !visibleEntries.some((entry) => entry.provider.key === state.selectedProvider)) {
            state.selectedProvider = visibleEntries[0].provider.key;
        }

        sidebarEl.innerHTML = `
            <section class="models-sidebar-section is-plain">
                <div class="models-sidebar-list">
                    ${visibleEntries.map(({ provider, models }) => {
                        const selected = provider.key === state.selectedProvider;
                        const selectedCount = models.filter((item) => state.selectedModels.has(item.full)).length;
                        return `
                            <button type="button" class="models-provider-nav ${selected ? 'is-active' : ''}" data-mp-provider-nav="${escapeHtml(provider.key)}">
                                <div class="models-provider-nav-top">
                                    <strong>${escapeHtml(provider.key)}</strong>
                                    <span class="models-provider-nav-count">${models.length}</span>
                                </div>
                                <div class="models-provider-nav-meta">${escapeHtml(provider.inConfig ? '已写入配置' : '目录来源')}${selectedCount ? ` · 已选 ${selectedCount}` : ''}</div>
                            </button>
                        `;
                    }).join('')}
                </div>
            </section>
        `;

        const currentEntry = visibleEntries.find((entry) => entry.provider.key === state.selectedProvider) || visibleEntries[0];
        const { provider, models } = currentEntry;
        const selectedCount = models.filter((item) => state.selectedModels.has(item.full)).length;
        const allSelected = models.length > 0 && selectedCount === models.length;
        const primary = getPrimary();
        const batchRun = state.batchRun && state.batchRun.providerKey === provider.key ? state.batchRun : null;

        listEl.innerHTML = `
            <div class="models-provider-detail" data-provider-card="${escapeHtml(provider.key)}">
                <div class="models-detail-header">
                    <div class="models-detail-heading">
                        <div class="models-detail-kicker">服务商明细</div>
                        <div class="models-detail-title-row">
                            <h3 class="models-detail-title">${escapeHtml(provider.key)}</h3>
                            <span class="models-detail-pill ${provider.inConfig ? 'is-success' : 'is-info'}">${provider.inConfig ? '已写入配置' : '仅目录可见'}</span>
                        </div>
                        <p class="models-detail-desc">${escapeHtml(provider.inConfig ? '先确认服务商配置，再在下方维护模型和默认项。' : '当前服务商尚未写入本地配置，可以先写入配置，再继续编辑或导入模型。')}</p>
                    </div>
                    <div class="models-overview-grid">
                        <article class="models-overview-card">
                            <span class="models-overview-label">连接地址</span>
                            <strong class="models-overview-value">${escapeHtml(normalizeBaseUrl(provider.key, provider))}</strong>
                        </article>
                        <article class="models-overview-card">
                            <span class="models-overview-label">凭据状态</span>
                            <strong class="models-overview-value">${escapeHtml(credentialLabelMap[provider.credentialMode] || provider.credentialMode || '未发现凭据')}</strong>
                        </article>
                        <article class="models-overview-card">
                            <span class="models-overview-label">模型数量</span>
                            <strong class="models-overview-value">${models.length} 个</strong>
                        </article>
                        <article class="models-overview-card">
                            <span class="models-overview-label">当前选择</span>
                            <strong class="models-overview-value">${selectedCount ? `已选 ${selectedCount}` : '未批量选择'}</strong>
                        </article>
                    </div>
                </div>
                <div class="models-detail-actions">
                    <div class="models-action-cluster">
                        ${provider.inConfig
                            ? `<button class="models-btn models-btn-compact models-btn-primary" data-mp-action="add-model" data-provider="${escapeHtml(provider.key)}">添加模型</button>`
                            : `<button class="models-btn models-btn-compact models-btn-primary" data-mp-action="adopt-provider" data-provider="${escapeHtml(provider.key)}">写入配置</button>`}
                        ${provider.inConfig ? `<button class="models-btn models-btn-compact" data-mp-action="edit-provider" data-provider="${escapeHtml(provider.key)}">编辑服务商</button>` : ''}
                        <button class="models-btn models-btn-compact" data-mp-action="fetch-models" data-provider="${escapeHtml(provider.key)}">获取模型列表</button>
                        ${models.length ? `<button class="models-btn models-btn-compact" data-mp-action="batch-test" data-provider="${escapeHtml(provider.key)}">${batchRun ? `停止批量测试 ${batchRun.done}/${batchRun.total}` : (selectedCount ? `批量测试已选 (${selectedCount})` : '测试当前服务商')}</button>` : ''}
                        ${provider.inConfig ? `<button class="models-btn models-btn-compact models-btn-danger" data-mp-action="${selectedCount ? 'delete-selected-models' : 'delete-provider'}" data-provider="${escapeHtml(provider.key)}">${selectedCount ? `删除已选 (${selectedCount})` : '删除服务商'}</button>` : ''}
                    </div>
                </div>
                <section class="models-model-section">
                    <div class="models-model-section-head">
                        <div>
                            <div class="models-model-section-title">模型列表</div>
                            <div class="models-model-section-desc">行内只保留一个高频动作，测试和删除降级到次级操作区。</div>
                        </div>
                        ${models.length ? `
                            <label class="models-select-all">
                                <input type="checkbox" data-mp-select-all="${escapeHtml(provider.key)}" ${allSelected ? 'checked' : ''}>
                                <span>${getProviderSelectionText(provider.key)}</span>
                            </label>
                        ` : ''}
                    </div>
                    ${models.length ? `
                        <div class="models-model-list">
                            ${models.map((model) => {
                                const isPrimary = model.full === primary;
                                const selected = state.selectedModels.has(model.full);
                                return `
                                    <article class="models-model-row ${isPrimary ? 'is-primary' : ''}" data-provider="${escapeHtml(model.providerKey)}" data-modelid="${escapeHtml(model.modelId)}" data-full="${escapeHtml(model.full)}">
                                        <label class="models-model-select">
                                            <input type="checkbox" data-mp-select-model="${escapeHtml(model.full)}" ${selected ? 'checked' : ''}>
                                        </label>
                                        <div class="models-model-main">
                                            <div class="models-model-title-row">
                                                <span class="models-model-name">${escapeHtml(model.modelId)}</span>
                                                ${isPrimary ? '<span class="models-detail-pill is-success">主模型</span>' : ''}
                                                ${model.raw?.reasoning ? '<span class="models-detail-pill is-info">推理</span>' : ''}
                                            </div>
                                            <div class="models-model-meta">
                                                ${model.raw?.name && model.raw.name !== model.modelId ? `<span>${escapeHtml(model.raw.name)}</span>` : ''}
                                                ${model.raw?.contextWindow ? `<span>上下文 ${escapeHtml(String(model.raw.contextWindow))}</span>` : ''}
                                                ${model.raw?.maxTokens ? `<span>最大输出 ${escapeHtml(String(model.raw.maxTokens))}</span>` : ''}
                                                <span data-mp-test-badge="${escapeHtml(model.full)}">${renderTestBadge(model.full)}</span>
                                            </div>
                                        </div>
                                        <div class="models-model-actions">
                                            ${isPrimary ? '<span class="models-model-primary-label">当前主模型</span>' : `<button class="models-link-btn" data-mp-action="set-primary" data-provider="${escapeHtml(model.providerKey)}" data-model="${escapeHtml(model.modelId)}">设为主模型</button>`}
                                            <div class="models-model-secondary-actions">
                                                <button class="models-link-btn subtle" data-mp-action="test-model" data-provider="${escapeHtml(model.providerKey)}" data-model="${escapeHtml(model.modelId)}">测试</button>
                                                ${provider.inConfig ? `<button class="models-link-btn subtle danger" data-mp-action="delete-model" data-provider="${escapeHtml(model.providerKey)}" data-model="${escapeHtml(model.modelId)}">删除</button>` : ''}
                                            </div>
                                        </div>
                                    </article>
                                `;
                            }).join('')}
                        </div>
                    ` : '<div class="models-empty-state">当前服务商还没有模型，可以先获取远程列表或手动添加模型。</div>'}
                </section>
            </div>
        `;

        updateInvalidModelButton();
        return;

        {
        const searchValue = String(state.search || '').trim().toLowerCase();
        const groups = new Map();
        const apiLabelMap = {
            'openai-completions': 'OpenAI 兼容',
            'openai-responses': 'OpenAI Responses',
            'openai-codex-responses': 'OpenAI Codex Responses',
            'anthropic-messages': 'Anthropic',
            'google-generative-ai': 'Google Gemini'
        };
        const credentialLabelMap = {
            'config-key': '配置 API Key',
            oauth: 'Auth 登录',
            'auth-api-key': 'Auth API Key',
            none: '未发现凭据'
        };

        for (const provider of getMergedProviderEntries()) {
            const providerMatches = `${provider.key} ${provider.authProfileId || ''}`.toLowerCase().includes(searchValue);
            const models = collectProviderModels(provider.key).filter((model) => {
                if (!searchValue) return true;
                const rawName = String(model.raw?.name || '').toLowerCase();
                const haystack = `${model.modelId} ${rawName}`.toLowerCase();
                return haystack.includes(searchValue);
            });

            if (searchValue && !providerMatches && !models.length) {
                continue;
            }

            if (!groups.has(provider.sourceKey)) {
                groups.set(provider.sourceKey, []);
            }
            groups.get(provider.sourceKey).push({ provider, models });
        }

        if (!groups.size) {
            listEl.innerHTML = '<div style="color:#8b8b93;padding:20px;text-align:center;border:1px dashed rgba(255,255,255,0.08);border-radius:12px">没有匹配到任何 provider 或模型。</div>';
            return;
        }

        listEl.innerHTML = Array.from(groups.entries()).map(([sourceKey, entries]) => {
            const groupMeta = getGroupMeta(sourceKey);
            return `
                <section style="margin-bottom:22px">
                    <div style="margin-bottom:12px">
                        <div style="font-size:16px;font-weight:700;color:#eef2f8">${escapeHtml(groupMeta.title)}</div>
                        <div style="margin-top:4px;font-size:12px;color:#8f98ab;line-height:1.7">${escapeHtml(groupMeta.desc)}</div>
                    </div>
                    ${entries.map(({ provider, models }) => {
                        const primary = getPrimary();
                        const selectedCount = models.filter((item) => state.selectedModels.has(item.full)).length;
                        const allSelected = models.length > 0 && selectedCount === models.length;
                        const batchRun = state.batchRun && state.batchRun.providerKey === provider.key ? state.batchRun : null;
                        return `
                            <div class="mpProviderCardV2 mpProvider models-provider-card" data-provider="${escapeHtml(provider.key)}" data-provider-card="${escapeHtml(provider.key)}" style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:18px 18px 14px;margin-bottom:16px">
                                <div class="models-provider-header" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;flex-wrap:wrap;gap:12px">
                                    <div class="models-provider-meta" style="display:flex;flex-direction:column;gap:6px">
                                        <div class="models-provider-meta-row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                                            <strong style="color:#eef2f8;font-size:15px">${escapeHtml(provider.key)}</strong>
                                            <span style="font-size:11px;color:#8f98ab">${escapeHtml(apiLabelMap[provider.api] || provider.api || 'OpenAI 兼容')}</span>
                                            <span style="font-size:11px;color:#8f98ab">${models.length} 个模型</span>
                                            <span style="font-size:11px;color:${provider.inConfig ? '#a9dc76' : '#78dce8'}">${provider.inConfig ? '已写入配置' : '仅读取目录'}</span>
                                            <span style="font-size:11px;color:#8f98ab">${escapeHtml(credentialLabelMap[provider.credentialMode] || provider.credentialMode || '未发现凭据')}</span>
                                        </div>
                                        <div style="font-size:12px;color:#8f98ab;word-break:break-all">${escapeHtml(normalizeBaseUrl(provider.key, provider))}</div>
                                        ${provider.authProfileId ? `<div style="font-size:11px;color:#8f98ab">当前认证: ${escapeHtml(provider.authProfileId)}</div>` : ''}
                                    </div>
                                    <div class="models-provider-actions" style="display:flex;gap:8px;flex-wrap:wrap">
                                        ${provider.inConfig ? `<button data-mp-action="edit-provider" data-provider="${escapeHtml(provider.key)}" style="padding:6px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#d7dce5;cursor:pointer;font-size:12px">编辑</button>` : `<button data-mp-action="adopt-provider" data-provider="${escapeHtml(provider.key)}" style="padding:6px 12px;background:rgba(120,220,232,0.15);border:1px solid rgba(120,220,232,0.28);border-radius:8px;color:#78dce8;cursor:pointer;font-size:12px">写入配置</button>`}
                                        ${provider.inConfig ? `<button data-mp-action="add-model" data-provider="${escapeHtml(provider.key)}" style="padding:6px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#d7dce5;cursor:pointer;font-size:12px">+ 模型</button>` : ''}
                                        <button data-mp-action="fetch-models" data-provider="${escapeHtml(provider.key)}" style="padding:6px 12px;background:rgba(120,220,232,0.15);border:1px solid rgba(120,220,232,0.3);border-radius:8px;color:#78dce8;cursor:pointer;font-size:12px">获取列表</button>
                                        ${models.length ? `<button class="mpBatchTest" data-mp-action="batch-test" data-provider="${escapeHtml(provider.key)}" style="padding:6px 12px;background:${batchRun ? 'rgba(255,152,103,0.14)' : 'rgba(120,220,232,0.15)'};border:1px solid ${batchRun ? 'rgba(255,152,103,0.32)' : 'rgba(120,220,232,0.3)'};border-radius:8px;color:${batchRun ? '#fc9867' : '#78dce8'};cursor:pointer;font-size:12px">${batchRun ? `停止批量测试 ${batchRun.done}/${batchRun.total}` : '批量测试'}</button>` : ''}
                                        ${provider.inConfig ? `<button data-mp-action="${selectedCount ? 'delete-selected-models' : 'delete-provider'}" data-provider="${escapeHtml(provider.key)}" style="padding:6px 12px;background:rgba(255,97,136,0.10);border:1px solid rgba(255,97,136,0.24);border-radius:8px;color:#ff8f8f;cursor:pointer;font-size:12px">${selectedCount ? `删除已选 (${selectedCount})` : '删除全部'}</button>` : ''}
                                    </div>
                                </div>
                                ${models.length ? `
                                    <div class="models-provider-selection" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05)">
                                        <label style="display:flex;align-items:center;gap:8px;color:#d7dce5;font-size:13px;cursor:pointer">
                                            <input type="checkbox" data-mp-select-all="${escapeHtml(provider.key)}" ${allSelected ? 'checked' : ''}>
                                            全选当前 provider 模型
                                        </label>
                                        <span style="font-size:12px;color:#8f98ab">${selectedCount ? `已勾选 ${selectedCount} 个模型` : '未勾选时默认测试这个 provider 的全部模型。'}</span>
                                    </div>
                                ` : ''}
                                <div class="models-provider-list" style="display:flex;flex-direction:column;gap:8px">
                                    ${models.length ? models.map((model) => {
                                        const isPrimary = model.full === primary;
                                        const selected = state.selectedModels.has(model.full);
                                        return `
                                            <div class="models-provider-row" data-provider="${escapeHtml(model.providerKey)}" data-modelid="${escapeHtml(model.modelId)}" data-full="${escapeHtml(model.full)}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:${isPrimary ? 'rgba(169,220,118,0.08)' : 'rgba(255,255,255,0.02)'};border:1px solid ${isPrimary ? 'rgba(169,220,118,0.28)' : 'rgba(255,255,255,0.05)'};flex-wrap:wrap">
                                                <input type="checkbox" data-mp-select-model="${escapeHtml(model.full)}" ${selected ? 'checked' : ''} style="margin:0">
                                                <div style="flex:1;min-width:200px">
                                                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                                                        <span style="font-family:monospace;font-size:13px;color:#eef2f8;word-break:break-all">${escapeHtml(model.modelId)}</span>
                                                        ${isPrimary ? '<span style="font-size:11px;background:#a9dc76;color:#102014;padding:2px 8px;border-radius:999px">主模型</span>' : ''}
                                                        ${model.raw?.reasoning ? '<span style="font-size:11px;background:rgba(120,220,232,0.14);color:#78dce8;padding:2px 8px;border-radius:999px">推理</span>' : ''}
                                                        ${model.raw?.name && model.raw.name !== model.modelId ? `<span style="font-size:11px;color:#8f98ab">${escapeHtml(model.raw.name)}</span>` : ''}
                                                    </div>
                                                    <div style="margin-top:4px;font-size:12px;color:#8f98ab;line-height:1.7">
                                                        ${model.raw?.contextWindow ? `上下文 ${escapeHtml(String(model.raw.contextWindow))}` : ''}
                                                        ${model.raw?.maxTokens ? `${model.raw?.contextWindow ? ' · ' : ''}最大输出 ${escapeHtml(String(model.raw.maxTokens))}` : ''}
                                                    </div>
                                                </div>
                                                ${isPrimary ? '' : `<button data-mp-action="set-primary" data-provider="${escapeHtml(model.providerKey)}" data-model="${escapeHtml(model.modelId)}" style="padding:5px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#d7dce5;cursor:pointer;font-size:11px">设为主模型</button>`}
                                                <span data-mp-test-badge="${escapeHtml(model.full)}" style="min-width:88px;text-align:right">${renderTestBadge(model.full)}</span>
                                                <button data-mp-action="test-model" data-provider="${escapeHtml(model.providerKey)}" data-model="${escapeHtml(model.modelId)}" style="padding:5px 10px;background:rgba(120,220,232,0.15);border:1px solid rgba(120,220,232,0.3);border-radius:8px;color:#78dce8;cursor:pointer;font-size:11px">测试</button>
                                                ${provider.inConfig ? `<button data-mp-action="delete-model" data-provider="${escapeHtml(model.providerKey)}" data-model="${escapeHtml(model.modelId)}" style="padding:5px 10px;background:rgba(255,97,136,0.10);border:1px solid rgba(255,97,136,0.24);border-radius:8px;color:#ff8f8f;cursor:pointer;font-size:11px">删除</button>` : ''}
                                            </div>
                                        `;
                                    }).join('') : '<div style="padding:16px;border:1px dashed rgba(255,255,255,0.08);border-radius:12px;color:#8f98ab;text-align:center">当前 provider 还没有已收录模型，可以点击“获取列表”从供应商 API 拉取。</div>'}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </section>
            `;
        }).join('');

        listEl.querySelectorAll('[data-provider-card]').forEach((card) => {
            const header = card.querySelector('.models-provider-header');
            const meta = header?.querySelector('.models-provider-meta');
            const metaRow = meta?.querySelector('.models-provider-meta-row');
            const actions = card.querySelector('.models-provider-actions');
            if (!header || !meta || !metaRow || !actions) return;

            const modelCount = card.querySelectorAll('[data-mp-select-model]').length;
            const selectedCount = card.querySelectorAll('[data-mp-select-model]:checked').length;
            const inConfig = Boolean(
                actions.querySelector('[data-mp-action="edit-provider"]')
                || actions.querySelector('[data-mp-action="add-model"]')
                || actions.querySelector('[data-mp-action="delete-provider"]')
                || actions.querySelector('[data-mp-action="delete-selected-models"]')
            );
            const metaSpans = Array.from(metaRow.querySelectorAll('span'));
            const credentialBadge = metaSpans[metaSpans.length - 1] || null;
            const credentialText = String(credentialBadge?.textContent || '').trim();
            if (credentialBadge) {
                credentialBadge.remove();
            }
            const detailBlocks = Array.from(meta.children).slice(1);
            const baseUrlText = String(detailBlocks[0]?.textContent || '').trim();
            const authProfileText = String(detailBlocks[1]?.textContent || '').trim();
            detailBlocks.forEach((node) => node.remove());

            let intro = header.querySelector('.models-provider-intro');
            if (!intro) {
                intro = document.createElement('div');
                intro.className = 'models-provider-intro';
                intro.style.cssText = 'display:flex;flex-direction:column;gap:6px;min-width:220px;max-width:420px;text-align:right';
                intro.innerHTML = `
                    <span style="font-size:12px;color:#8f98ab">${escapeHtml(inConfig ? '这里展示服务商说明与凭据状态，操作按钮已放到下方工具区。' : '当前服务商尚未写入配置，可以先查看说明，再在下方执行写入或拉取模型。')}</span>
                    <span style="font-size:11px;color:#8f98ab">${escapeHtml(modelCount ? `当前共 ${modelCount} 个模型${selectedCount ? `，已选 ${selectedCount} 个` : ''}。` : '当前还没有模型，可以先获取列表或手动添加模型。')}</span>
                `;
                header.appendChild(intro);
            }
            intro.innerHTML = `
                <div class="models-provider-intro-label">${escapeHtml(credentialText || (inConfig ? '配置 API Key' : '未发现凭据'))}</div>
                <div class="models-provider-intro-url">${escapeHtml(baseUrlText || '未配置地址')}</div>
                ${authProfileText ? `<div class="models-provider-intro-auth">${escapeHtml(authProfileText)}</div>` : ''}
            `;

            let selection = card.querySelector('.models-provider-selection');
            if (!selection) {
                selection = document.createElement('div');
                selection.className = 'models-provider-selection';
                selection.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05)';
                selection.innerHTML = `
                    <div class="models-provider-selection-copy" style="display:flex;flex-direction:column;gap:6px;min-width:220px">
                        <span style="font-size:13px;color:#d7dce5">当前还没有模型</span>
                        <span style="font-size:12px;color:#8f98ab">可以先获取官方模型列表，或手动添加模型。</span>
                    </div>
                `;
                header.insertAdjacentElement('afterend', selection);
            } else if (!selection.querySelector('.models-provider-selection-copy')) {
                const copy = document.createElement('div');
                copy.className = 'models-provider-selection-copy';
                copy.style.cssText = 'display:flex;flex-direction:column;gap:6px;min-width:220px';
                while (selection.firstChild) {
                    copy.appendChild(selection.firstChild);
                }
                selection.appendChild(copy);
            }

            if (!actions.dataset.layoutReady) {
                actions.dataset.layoutReady = '1';
                const primaryAction = actions.querySelector('[data-mp-action="add-model"], [data-mp-action="adopt-provider"]');
                const editAction = actions.querySelector('[data-mp-action="edit-provider"]');
                const fetchAction = actions.querySelector('[data-mp-action="fetch-models"]');
                const testAction = actions.querySelector('[data-mp-action="batch-test"]');
                const dangerAction = actions.querySelector('[data-mp-action="delete-provider"], [data-mp-action="delete-selected-models"]');

                if (editAction) editAction.classList.add('models-btn-secondary');
                [fetchAction, testAction].filter(Boolean).forEach((button) => {
                    button.classList.add('models-btn-subtle');
                });

                const primaryGroup = document.createElement('div');
                primaryGroup.className = 'models-action-cluster models-action-cluster-primary';
                [primaryAction, editAction].filter(Boolean).forEach((button) => primaryGroup.appendChild(button));

                const secondaryGroup = document.createElement('div');
                secondaryGroup.className = 'models-action-cluster models-action-cluster-secondary';
                [fetchAction, testAction].filter(Boolean).forEach((button) => secondaryGroup.appendChild(button));

                const dangerGroup = document.createElement('div');
                dangerGroup.className = 'models-action-cluster models-action-cluster-danger';
                if (dangerAction) dangerGroup.appendChild(dangerAction);

                actions.replaceChildren(primaryGroup);
                if (secondaryGroup.childElementCount) actions.appendChild(secondaryGroup);
                if (dangerGroup.childElementCount) actions.appendChild(dangerGroup);
            }

            actions.style.justifyContent = 'flex-end';
            actions.style.marginLeft = 'auto';
            actions.style.maxWidth = '100%';
            selection.appendChild(actions);
        });

        applyProviderCollapseState();
        updateInvalidModelButton();
        }
    }

    async function removeInvalidModels() {
        if (state.batchRun) {
            setPageStatus('请先等待当前批量测试结束，再删除无效模型。', '#fc9867');
            return;
        }

        const invalidModels = collectInvalidModelIds();
        if (!invalidModels.length) {
            setPageStatus('当前没有可删除的无效模型。', '#8b8b93');
            updateInvalidModelButton();
            return;
        }

        const ok = await showConfirmDialog(`确定要删除 ${invalidModels.length} 个测试失败的模型吗？`, {
            title: '删除无效模型',
            confirmText: '确认删除',
            cancelText: '取消'
        });
        if (!ok) return;

        const button = container.querySelector('#mpBtnRemoveInvalid');
        if (button) button.disabled = true;
        setPageStatus(`正在删除 ${invalidModels.length} 个无效模型...`, '#8b8b93');

        try {
            const result = await window.api.removeInvalidModels({
                agentName: 'main',
                models: invalidModels
            });
            if (!result || result.ok === false) {
                throw new Error(result?.error || '删除失败');
            }

            invalidModels.forEach((full) => {
                state.selectedModels.delete(full);
                state.testResults.delete(full);
            });

            config = await window.api.getOpenClawConfig();
            ensureConfigShape();
            await reloadRuntimeCatalog();
            renderDefaultBar();
            renderProviders();
            setPageStatus(`已删除 ${result.count || invalidModels.length} 个无效模型`, '#a9dc76');
        } catch (error) {
            setPageStatus(`删除失败: ${error?.message || error}`, '#ff6188');
        } finally {
            updateInvalidModelButton();
        }
    }

    listEl.onclick = async (event) => {
        const actionEl = event.target.closest('[data-mp-action]');
        if (!actionEl) return;

        const providerKey = actionEl.getAttribute('data-provider');
        const modelId = actionEl.getAttribute('data-model');
        const providerEntry = providerKey ? getProviderEntry(providerKey) : null;

        if (actionEl.dataset.mpAction === 'edit-provider' && providerKey) {
            showProviderModal(providerKey, config.models.providers[providerKey] || providerEntry);
            return;
        }

        if (actionEl.dataset.mpAction === 'adopt-provider' && providerKey) {
            ensureConfigProvider(providerKey, providerEntry);
            await persistModelConfig({
                successMessage: `已把 ${providerKey} 写入本地配置并自动保存`
            });
            return;
        }

        if (actionEl.dataset.mpAction === 'add-model' && providerKey) {
            ensureConfigProvider(providerKey, providerEntry);
            showAddModelModal(providerKey);
            return;
        }

        if (actionEl.dataset.mpAction === 'fetch-models' && providerKey) {
            await fetchRemoteModels(providerKey);
            return;
        }

        if (actionEl.dataset.mpAction === 'batch-test' && providerKey) {
            await runBatchTest(providerKey);
            return;
        }

        if (actionEl.dataset.mpAction === 'delete-selected-models' && providerKey) {
            const selected = collectProviderModels(providerKey).filter((model) => state.selectedModels.has(model.full));
            if (!selected.length) {
                setPageStatus('请先勾选要删除的模型', '#fc9867');
                return;
            }

            const ok = await showConfirmDialog(`确定要删除 ${selected.length} 个已勾选模型吗？`, {
                title: '删除已选模型',
                confirmText: '确认删除',
                cancelText: '取消'
            });
            if (!ok) return;

            const provider = ensureConfigProvider(providerKey, providerEntry);
            const targetIds = new Set(selected.map((model) => model.modelId));
            provider.models = (provider.models || []).filter((model) => {
                const currentId = typeof model === 'string' ? model : model?.id;
                return !targetIds.has(currentId);
            });
            markProviderModelsExcluded(providerKey, Array.from(targetIds));

            selected.forEach((model) => {
                state.selectedModels.delete(model.full);
                state.testResults.delete(model.full);
                dropModelReferences(model.full);
            });

            await persistModelConfig({
                successMessage: `已删除 ${selected.length} 个模型，并自动保存`
            });
            return;
        }

        if (actionEl.dataset.mpAction === 'delete-provider' && providerKey) {
            const ok = await showConfirmDialog(`确定要删除服务商“${providerKey}”以及它下面的全部模型吗？`, {
                title: '删除服务商',
                confirmText: '确认删除',
                cancelText: '取消'
            });
            if (!ok) return;

            collectProviderModels(providerKey).forEach((model) => {
                state.selectedModels.delete(model.full);
                state.testResults.delete(model.full);
            });
            delete state.hiddenModelsByProvider[providerKey];
            saveHiddenModelState();
            delete config.models.providers[providerKey];
            dropProviderReferences(providerKey);
            await persistModelConfig({
                successMessage: `已从配置中删除 ${providerKey}，并自动保存`
            });
            return;
        }

        if (actionEl.dataset.mpAction === 'set-primary' && providerKey && modelId) {
            const full = `${providerKey}/${modelId}`;
            config.agents.defaults.model.primary = full;
            rememberModelReference(full);
            await persistModelConfig({
                successMessage: `已将 ${full} 设为主模型，并自动保存`
            });
            return;
        }

        if (actionEl.dataset.mpAction === 'test-model' && providerKey && modelId) {
            await runSingleModelTest(providerKey, modelId);
            return;
        }

        if (actionEl.dataset.mpAction === 'delete-model' && providerKey && modelId) {
            const ok = await showConfirmDialog(`确定要删除模型“${modelId}”吗？`, {
                title: '删除模型',
                confirmText: '确认删除',
                cancelText: '取消'
            });
            if (!ok) return;

            const provider = ensureConfigProvider(providerKey, providerEntry);
            provider.models = (provider.models || []).filter((model) => {
                const currentId = typeof model === 'string' ? model : model?.id;
                return currentId !== modelId;
            });
            markProviderModelsExcluded(providerKey, [modelId]);
            const full = `${providerKey}/${modelId}`;
            state.selectedModels.delete(full);
            state.testResults.delete(full);
            dropModelReferences(full);
            await persistModelConfig({
                successMessage: `已删除模型 ${full}，并自动保存`
            });
        }
    };

    listEl.onchange = (event) => {
        const selectAllKey = event.target.getAttribute('data-mp-select-all');
        if (selectAllKey) {
            toggleProviderSelection(selectAllKey, event.target.checked);
            return;
        }

        const fullModelId = event.target.getAttribute('data-mp-select-model');
        if (fullModelId) {
            if (event.target.checked) state.selectedModels.add(fullModelId);
            else state.selectedModels.delete(fullModelId);
            const providerCard = event.target.closest('[data-provider-card]');
            const providerKey = providerCard?.getAttribute('data-provider-card');
            if (providerKey) {
                updateProviderSelectionUi(providerKey);
            } else {
                renderProviders();
            }
        }
    };

    sidebarEl.onclick = (event) => {
        const navEl = event.target.closest('[data-mp-provider-nav]');
        if (!navEl) return;
        state.selectedProvider = navEl.getAttribute('data-mp-provider-nav') || '';
        renderProviders();
    };

    async function saveConfig() {
        setPageStatus('正在保存配置...', '#8b8b93');
        await persistModelConfig();
    }

    container.querySelector('#mpBtnAddProvider').onclick = () => showProviderModal(null, null);
    container.querySelector('#mpBtnSave').onclick = saveConfig;
    container.querySelector('#mpBtnRefresh').onclick = async () => {
        setPageStatus('正在刷新模型目录...', '#8b8b93');
        await reloadRuntimeCatalog();
        refreshModelsView();
        setPageStatus('模型目录已刷新', '#a9dc76');
    };
    container.querySelector('#mpBtnRemoveInvalid').onclick = removeInvalidModels;
    searchInput.oninput = () => {
        state.search = searchInput.value || '';
        if (state.searchTimer) clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => {
            state.searchTimer = null;
            renderProviders();
        }, 120);
    };

    renderDefaultBar();
    renderProviders();
    updateInvalidModelButton();
}

async function renderLogsPage(container) {
    return window.__openclawLogsPage.renderLogsPage(container, {
        escapeHtml
    });
}

async function renderGatewayPage(container) {
    container.innerHTML = `
        <div style="padding:24px 28px">
            <h2 class="page-title">网关配置</h2>
            <p class="page-desc">配置 Gateway 端口、访问模式、认证 Token 和工具权限策略。</p>
            <div id="gwContent"><div style="color:#8b8b93;padding:20px">正在加载...</div></div>
        </div>
    `;

    let config = null;
    try {
        config = await window.api.getOpenClawConfig();
    } catch (error) {}

    if (!config) {
        container.querySelector('#gwContent').innerHTML = '<div style="color:#ff6188">无法加载网关配置</div>';
        return;
    }

    if (!config.gateway || typeof config.gateway !== 'object') config.gateway = {};
    if (!config.gateway.auth || typeof config.gateway.auth !== 'object') config.gateway.auth = {};
    if (!config.agents || typeof config.agents !== 'object') config.agents = {};
    if (!config.agents.defaults || typeof config.agents.defaults !== 'object') config.agents.defaults = {};

    const currentToolMode = String(config.agents.defaults.tools_mode || 'restricted');
    const toolModeCards = {
        full: {
            title: '完整权限',
            desc: 'Agent 可以使用所有工具，适合本机受控环境，推荐作为默认模式。',
            note: '会保留文件、命令和网络等全部能力。'
        },
        restricted: {
            title: '受限模式',
            desc: '仅允许安全工具，适合需要收敛风险的场景。',
            note: '通常会限制文件系统和命令执行类操作。'
        },
        disabled: {
            title: '禁用工具',
            desc: 'Agent 只能进行对话，不再调用任何工具。',
            note: '适合只读演示或对外展示环境。'
        }
    };

    container.querySelector('#gwContent').innerHTML = `
        <div style="display:flex;flex-direction:column;gap:16px;max-width:860px">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
                <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:18px">
                    <h3 style="color:#eef2f8;margin:0 0 14px;font-size:15px">基本设置</h3>
                    <div style="display:flex;flex-direction:column;gap:12px">
                        <div>
                            <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:6px">端口号</label>
                            <input id="gwPort" type="number" value="${escapeHtml(config.gateway.port || 18789)}" style="width:100%;padding:9px 12px;background:#141823;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eef2f8;font-size:13px;box-sizing:border-box">
                        </div>
                        <div>
                            <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:6px">访问模式</label>
                            <select id="gwMode" style="width:100%;padding:9px 12px;background:#141823;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eef2f8;font-size:13px">
                                <option value="local" ${!config.gateway.mode || config.gateway.mode === 'local' ? 'selected' : ''}>仅本机 (local)</option>
                                <option value="lan" ${config.gateway.mode === 'lan' ? 'selected' : ''}>局域网 (lan)</option>
                                <option value="public" ${config.gateway.mode === 'public' ? 'selected' : ''}>公网 (public)</option>
                            </select>
                            <div style="margin-top:6px;color:#8f98ab;font-size:12px;line-height:1.6">建议默认使用“仅本机”，除非你明确需要让其他设备访问。</div>
                        </div>
                    </div>
                </div>
                <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:18px">
                    <h3 style="color:#eef2f8;margin:0 0 14px;font-size:15px">认证设置</h3>
                    <div style="display:flex;flex-direction:column;gap:12px">
                        <div>
                            <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:6px">Gateway Token</label>
                            <div style="display:flex;gap:8px;flex-wrap:wrap">
                                <input id="gwToken" type="text" value="${escapeHtml(config.gateway.auth.token || '')}" placeholder="未设置 Token" style="flex:1;min-width:240px;padding:9px 12px;background:#141823;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eef2f8;font-size:13px;font-family:Consolas,Monaco,monospace">
                                <button id="gwGenToken" style="padding:9px 14px;background:rgba(120,220,232,0.15);border:1px solid rgba(120,220,232,0.28);border-radius:10px;color:#78dce8;cursor:pointer;font-size:12px">生成新 Token</button>
                            </div>
                            <div style="margin-top:6px;color:#8f98ab;font-size:12px;line-height:1.6">这个 Token 会写回本地配置文件，用于访问 Gateway API。</div>
                        </div>
                    </div>
                </div>
            </div>
            <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:18px">
                    <h3 style="color:#eef2f8;margin:0 0 14px;font-size:15px">工具权限</h3>
                <div style="margin-bottom:12px">
                    <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:6px">tools_mode</label>
                    <select id="gwToolPerms" style="width:100%;max-width:320px;padding:9px 12px;background:#141823;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eef2f8;font-size:13px">
                        <option value="full" ${currentToolMode === 'full' ? 'selected' : ''}>完整权限 (full)</option>
                        <option value="restricted" ${currentToolMode === 'restricted' ? 'selected' : ''}>受限模式 (restricted)</option>
                        <option value="disabled" ${currentToolMode === 'disabled' ? 'selected' : ''}>禁用工具 (disabled)</option>
                    </select>
                    <div style="margin-top:6px;color:#8f98ab;font-size:12px;line-height:1.6">保存时会同步写回本地配置里的 <code>agents.defaults.tools_mode</code> 和 <code>tools_enabled</code>。</div>
                </div>
                <div id="gwToolModeCards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px"></div>
                <div id="gwToolModeHint" style="margin-top:12px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);font-size:12px;color:#d7dce5;line-height:1.8"></div>
            </div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                <button id="gwSaveBtn" style="padding:10px 24px;background:#a9dc76;color:#102014;border:none;border-radius:10px;cursor:pointer;font-weight:700">保存配置</button>
                <span id="gwStatus" style="font-size:13px;color:#8b8b93"></span>
            </div>
        </div>
    `;

    const toolSelect = container.querySelector('#gwToolPerms');
    const cardsEl = container.querySelector('#gwToolModeCards');
    const hintEl = container.querySelector('#gwToolModeHint');
    const gatewayShell = container.firstElementChild;
    const gatewayContentRoot = container.querySelector('#gwContent > div');
    const gatewayGrid = gatewayContentRoot?.children?.[0];
    const gatewayToolCard = gatewayContentRoot?.children?.[1];
    const gatewayActionRow = gatewayContentRoot?.children?.[2];

    if (gatewayShell) {
        gatewayShell.classList.add('ops-page-shell', 'gateway-page-shell');
        gatewayShell.removeAttribute('style');
    }
    if (gatewayContentRoot) {
        gatewayContentRoot.classList.add('ops-stack', 'gateway-stack');
        gatewayContentRoot.removeAttribute('style');
    }
    if (gatewayGrid) {
        gatewayGrid.classList.add('gateway-grid');
        gatewayGrid.removeAttribute('style');
        gatewayGrid.querySelectorAll(':scope > div').forEach((card) => {
            card.classList.add('ops-card');
            card.removeAttribute('style');
        });
    }
    if (gatewayToolCard) {
        gatewayToolCard.classList.add('ops-card');
        gatewayToolCard.removeAttribute('style');
    }
    if (gatewayActionRow) {
        gatewayActionRow.classList.add('ops-action-row');
        gatewayActionRow.removeAttribute('style');
    }
    container.querySelector('#gwPort')?.classList.add('ops-control');
    container.querySelector('#gwMode')?.classList.add('ops-control');
    container.querySelector('#gwToken')?.classList.add('ops-control');
    container.querySelector('#gwToolPerms')?.classList.add('ops-control');
    container.querySelector('#gwGenToken')?.classList.add('ops-btn', 'ops-btn-secondary');
    container.querySelector('#gwSaveBtn')?.classList.add('ops-btn', 'ops-btn-primary');
    container.querySelector('#gwStatus')?.classList.add('ops-status-text');
    if (hintEl) hintEl.classList.add('gateway-hint');
    container.querySelector('.page-title')?.replaceChildren(document.createTextNode('网关配置'));
    container.querySelector('.page-desc')?.replaceChildren(document.createTextNode('配置 Gateway 端口、访问范围、认证 Token 和工具调用权限。'));
    container.querySelector('#gwGenToken')?.replaceChildren(document.createTextNode('生成新 Token'));
    container.querySelector('#gwSaveBtn')?.replaceChildren(document.createTextNode('保存配置'));

    function renderToolModeCards() {
        const current = toolSelect.value;
        cardsEl.innerHTML = Object.entries(toolModeCards).map(([value, item]) => {
            const active = value === current;
            return `
                <button
                    class="gwToolCard ${active ? 'is-active' : ''}"
                    data-value="${escapeHtml(value)}"
                    style="text-align:left;padding:16px 16px 14px;border-radius:14px;border:1px solid ${active ? 'rgba(120,220,232,0.34)' : 'rgba(255,255,255,0.08)'};background:${active ? 'rgba(120,220,232,0.12)' : 'rgba(255,255,255,0.03)'};color:#eef2f8;cursor:pointer"
                >
                    <div style="font-size:14px;font-weight:700;margin-bottom:6px">${escapeHtml(item.title)}</div>
                    <div style="font-size:12px;color:#d7dce5;line-height:1.7">${escapeHtml(item.desc)}</div>
                    <div style="margin-top:8px;font-size:11px;color:#8f98ab;line-height:1.7">${escapeHtml(item.note)}</div>
                </button>
            `;
        }).join('');

        const currentInfo = toolModeCards[current] || toolModeCards.restricted;
        hintEl.innerHTML = `<strong style="color:#eef2f8">${escapeHtml(currentInfo.title)}</strong>：${escapeHtml(currentInfo.desc)} ${escapeHtml(currentInfo.note)}`;

        cardsEl.querySelectorAll('.gwToolCard').forEach((card) => {
            card.classList.toggle('is-active', card.dataset.value === current);
            card.onclick = () => {
                toolSelect.value = card.dataset.value;
                renderToolModeCards();
            };
        });
    }

    container.querySelector('#gwGenToken').onclick = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const token = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        container.querySelector('#gwToken').value = token;
    };

    toolSelect.onchange = () => renderToolModeCards();
    renderToolModeCards();

    container.querySelector('#gwSaveBtn').onclick = async () => {
        const saveBtn = container.querySelector('#gwSaveBtn');
        const statusEl = container.querySelector('#gwStatus');

        config.gateway.port = parseInt(container.querySelector('#gwPort').value, 10) || 18789;
        config.gateway.mode = container.querySelector('#gwMode').value;
        config.gateway.auth.token = container.querySelector('#gwToken').value.trim();
        config.agents.defaults.tools_mode = toolSelect.value;
        config.agents.defaults.tools_enabled = toolSelect.value !== 'disabled';

        saveBtn.disabled = true;
        statusEl.textContent = '正在保存配置...';
        statusEl.style.color = '#8b8b93';

        try {
            const result = await window.api.writeOpenClawConfig(config);
            if (result && result.ok === false) throw new Error(result.error || '保存失败');
            statusEl.textContent = '配置已保存，重启 Gateway 后生效。';
            statusEl.style.color = '#a9dc76';
        } catch (error) {
            statusEl.textContent = `保存失败: ${error?.message || error}`;
            statusEl.style.color = '#ff6188';
        } finally {
            saveBtn.disabled = false;
            setTimeout(() => {
                if (statusEl.textContent.includes('配置已保存')) statusEl.textContent = '';
            }, 4000);
        }
    };
}

async function renderGatewayPage(container) {
    container.innerHTML = `
        <div style="padding:24px 28px">
            <h2 class="page-title">网关配置</h2>
            <p class="page-desc">配置 Gateway 端口、访问范围、认证 Token 和工具调用权限。</p>
            <div id="gwContent"><div style="color:#8b8b93;padding:20px">正在加载...</div></div>
        </div>
    `;

    let config = null;
    try {
        config = await window.api.getOpenClawConfig();
    } catch (error) {}

    if (!config) {
        container.querySelector('#gwContent').innerHTML = '<div style="color:#ff6188">无法加载网关配置</div>';
        return;
    }

    if (!config.gateway || typeof config.gateway !== 'object') config.gateway = {};
    if (!config.gateway.auth || typeof config.gateway.auth !== 'object') config.gateway.auth = {};
    if (!config.tools || typeof config.tools !== 'object') config.tools = {};
    if (!config.agents || typeof config.agents !== 'object') config.agents = {};
    if (!config.agents.defaults || typeof config.agents.defaults !== 'object') config.agents.defaults = {};
    let resolvedGatewayToken = String(config.gateway.auth.token || '').trim();
    try {
        if (window.api?.getOpenClawToken) {
            resolvedGatewayToken = String(await window.api.getOpenClawToken() || resolvedGatewayToken).trim();
        }
    } catch (_) {}
    if (resolvedGatewayToken) {
        config.gateway.auth.token = resolvedGatewayToken;
    }

    const gatewayAccessMode = config.gateway.bind === 'lan' ? 'lan' : 'local';
    const toolProfileToUi = {
        full: 'full',
        limited: 'restricted',
        none: 'disabled'
    };
    const uiToToolProfile = {
        full: 'full',
        restricted: 'limited',
        disabled: 'none'
    };
    const currentToolMode = toolProfileToUi[String(config.tools.profile || '').trim()] || 'full';
    const toolModeCards = {
        full: {
            title: '完整权限',
            desc: 'Agent 可以使用所有工具，适合本机受控环境，推荐作为默认模式。',
            note: '保留文件、命令和网络等全部能力。'
        },
        restricted: {
            title: '受限模式',
            desc: '仅允许安全工具，禁用高风险文件和命令操作。',
            note: '更适合需要控制风险的共享环境。'
        },
        disabled: {
            title: '禁用工具',
            desc: 'Agent 只能对话，不能调用任何工具。',
            note: '适合只读演示或对外展示环境。'
        }
    };

    container.querySelector('#gwContent').innerHTML = `
        <div style="display:flex;flex-direction:column;gap:16px;max-width:860px">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
                <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:18px">
                    <h3 style="color:#eef2f8;margin:0 0 14px;font-size:15px">基本设置</h3>
                    <div style="display:flex;flex-direction:column;gap:12px">
                        <div>
                            <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:6px">端口号</label>
                            <input id="gwPort" type="number" value="${escapeHtml(config.gateway.port || 18789)}" style="width:100%;padding:9px 12px;background:#141823;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eef2f8;font-size:13px;box-sizing:border-box">
                        </div>
                        <div>
                            <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:6px">访问范围</label>
                            <select id="gwMode" style="width:100%;padding:9px 12px;background:#141823;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eef2f8;font-size:13px">
                                <option value="local" ${gatewayAccessMode === 'local' ? 'selected' : ''}>仅本机使用</option>
                                <option value="lan" ${gatewayAccessMode === 'lan' ? 'selected' : ''}>局域网共享</option>
                            </select>
                            <div style="margin-top:6px;color:#8f98ab;font-size:12px;line-height:1.6">仅本机使用最安全；如果手机、平板也要访问，再切换到局域网共享。</div>
                        </div>
                    </div>
                </div>
                <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:18px">
                    <h3 style="color:#eef2f8;margin:0 0 14px;font-size:15px">认证设置</h3>
                    <div style="display:flex;flex-direction:column;gap:12px">
                        <div>
                            <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:6px">Gateway Token</label>
                            <div style="display:flex;gap:8px;flex-wrap:wrap">
                                <input id="gwToken" type="text" value="${escapeHtml(config.gateway.auth.token || '')}" placeholder="未设置 Token" style="flex:1;min-width:240px;padding:9px 12px;background:#141823;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eef2f8;font-size:13px;font-family:Consolas,Monaco,monospace">
                                <button id="gwGenToken" style="padding:9px 14px;background:rgba(120,220,232,0.15);border:1px solid rgba(120,220,232,0.28);border-radius:10px;color:#78dce8;cursor:pointer;font-size:12px">生成新 Token</button>
                            </div>
                            <div style="margin-top:6px;color:#8f98ab;font-size:12px;line-height:1.6">Token 会写回本地配置文件，用于访问 Gateway API。</div>
                        </div>
                    </div>
                </div>
            </div>
            <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:18px">
                <h3 style="color:#eef2f8;margin:0 0 14px;font-size:15px">工具权限</h3>
                <div style="margin-bottom:12px">
                    <label style="display:block;color:#8b8b93;font-size:13px;margin-bottom:6px">权限策略</label>
                    <select id="gwToolPerms" style="width:100%;max-width:320px;padding:9px 12px;background:#141823;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eef2f8;font-size:13px">
                        <option value="full" ${currentToolMode === 'full' ? 'selected' : ''}>完整权限</option>
                        <option value="restricted" ${currentToolMode === 'restricted' ? 'selected' : ''}>受限模式</option>
                        <option value="disabled" ${currentToolMode === 'disabled' ? 'selected' : ''}>禁用工具</option>
                    </select>
                    <div style="margin-top:6px;color:#8f98ab;font-size:12px;line-height:1.6">保存时会写回本地配置里的 <code>tools.profile</code>，不会再写入 CLI 不支持的字段。</div>
                </div>
                <div id="gwToolModeCards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px"></div>
                <div id="gwToolModeHint" style="margin-top:12px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);font-size:12px;color:#d7dce5;line-height:1.8"></div>
            </div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                <button id="gwSaveBtn" style="padding:10px 24px;background:#a9dc76;color:#102014;border:none;border-radius:10px;cursor:pointer;font-weight:700">保存配置</button>
                <span id="gwStatus" style="font-size:13px;color:#8b8b93"></span>
            </div>
        </div>
    `;
    container.querySelector('#gwToken').value = resolvedGatewayToken;

    const toolSelect = container.querySelector('#gwToolPerms');
    const cardsEl = container.querySelector('#gwToolModeCards');
    const hintEl = container.querySelector('#gwToolModeHint');

    function renderToolModeCards() {
        const current = toolSelect.value;
        cardsEl.innerHTML = Object.entries(toolModeCards).map(([value, item]) => {
            const active = value === current;
            return `
                <button
                    class="gwToolCard"
                    data-value="${escapeHtml(value)}"
                    style="text-align:left;padding:16px 16px 14px;border-radius:14px;border:1px solid ${active ? 'rgba(120,220,232,0.34)' : 'rgba(255,255,255,0.08)'};background:${active ? 'rgba(120,220,232,0.12)' : 'rgba(255,255,255,0.03)'};color:#eef2f8;cursor:pointer"
                >
                    <div style="font-size:14px;font-weight:700;margin-bottom:6px">${escapeHtml(item.title)}</div>
                    <div style="font-size:12px;color:#d7dce5;line-height:1.7">${escapeHtml(item.desc)}</div>
                    <div style="margin-top:8px;font-size:11px;color:#8f98ab;line-height:1.7">${escapeHtml(item.note)}</div>
                </button>
            `;
        }).join('');

        const currentInfo = toolModeCards[current] || toolModeCards.full;
        hintEl.innerHTML = `<strong style="color:#eef2f8">${escapeHtml(currentInfo.title)}</strong>：${escapeHtml(currentInfo.desc)} ${escapeHtml(currentInfo.note)}`;

        cardsEl.querySelectorAll('.gwToolCard').forEach((card) => {
            card.onclick = () => {
                toolSelect.value = card.dataset.value;
                renderToolModeCards();
            };
        });
    }

    container.querySelector('#gwGenToken').onclick = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const token = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        container.querySelector('#gwToken').value = token;
    };

    toolSelect.onchange = () => renderToolModeCards();
    renderToolModeCards();

    container.querySelector('#gwSaveBtn').onclick = async () => {
        const saveBtn = container.querySelector('#gwSaveBtn');
        const statusEl = container.querySelector('#gwStatus');
        const accessMode = container.querySelector('#gwMode').value;

        config.gateway.port = parseInt(container.querySelector('#gwPort').value, 10) || 18789;
        config.gateway.mode = 'local';
        config.gateway.bind = accessMode === 'lan' ? 'lan' : 'loopback';
        config.gateway.auth.token = container.querySelector('#gwToken').value.trim();

        if (!config.tools || typeof config.tools !== 'object') config.tools = {};
        config.tools.profile = uiToToolProfile[toolSelect.value] || 'full';

        if (config.agents?.defaults && typeof config.agents.defaults === 'object') {
            delete config.agents.defaults.tools_mode;
            delete config.agents.defaults.tools_enabled;
        }

        saveBtn.disabled = true;
        statusEl.textContent = '正在保存配置...';
        statusEl.style.color = '#8b8b93';

        try {
            const result = await window.api.writeOpenClawConfig(config);
            if (result && result.ok === false) throw new Error(result.error || '保存失败');
            statusEl.textContent = '配置已保存，Gateway 和 CLI 命令会使用新配置。';
            statusEl.style.color = '#a9dc76';
        } catch (error) {
            statusEl.textContent = `保存失败: ${error?.message || error}`;
            statusEl.style.color = '#ff6188';
        } finally {
            saveBtn.disabled = false;
            setTimeout(() => {
                if ((statusEl.textContent || '').includes('配置已保存')) statusEl.textContent = '';
            }, 4000);
        }
    };
}

async function renderSettingsPage(container) {
    if (typeof window.renderSettingsPageModule === 'function') {
        return window.renderSettingsPageModule(container);
    }
    throw new Error('settings-page.js is not loaded');
}


