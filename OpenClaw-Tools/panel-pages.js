(function () {
    function esc(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function ensureObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    function ensureArray(value) {
        return Array.isArray(value) ? value : [];
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value ?? {}));
    }

    const CRON_VIEW_CACHE_KEY = 'openclaw.cron.view-cache.v1';
    const CRON_VIEW_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const CHANNEL_PAIRING_CACHE_KEY = 'openclaw.channels.pairing-cache.v1';
const CHANNEL_PAIRING_CACHE_MAX_AGE_MS = 2 * 60 * 1000;
const MEMORY_VIEW_CACHE_KEY = 'openclaw.memory.view-cache.v1';
const MEMORY_VIEW_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const WEIXIN_PERSONAL_CHANNEL_KEY = 'openclaw-weixin';
const WEIXIN_AUTO_INSTALL_COMMAND = 'npx -y @tencent-weixin/openclaw-weixin-cli install';
const WEIXIN_LOGIN_COMMAND = 'openclaw channels login --channel openclaw-weixin';
const WEIXIN_GATEWAY_RESTART_COMMAND = 'openclaw gateway restart';
const WEIXIN_CHANNEL_STATUS_COMMAND = 'openclaw channels status --probe';
    let channelEnvironmentColdProbePending = true;

    function isWeixinPersonalChannel(channelName) {
        return normalizeChannelKey(channelName) === WEIXIN_PERSONAL_CHANNEL_KEY;
    }

    function resolveCreateChannelIdForPreset(presetKey, rawValue = '') {
        const normalizedPreset = normalizeChannelKey(presetKey);
        const defaultChannelIds = {
            qqbot: 'qqbot',
            feishu: 'feishu',
            wecom: 'wecom',
            telegram: 'telegram',
            dingtalk: 'dingtalk-connector',
            [WEIXIN_PERSONAL_CHANNEL_KEY]: WEIXIN_PERSONAL_CHANNEL_KEY
        };
        if (isWeixinPersonalChannel(presetKey)) {
            return WEIXIN_PERSONAL_CHANNEL_KEY;
        }
        return String(rawValue || '').trim() || defaultChannelIds[normalizedPreset] || normalizedPreset;
    }

    function extractLatestLoginLink(text) {
        const source = String(text || '');
        const matches = source.match(/(?:https?:\/\/|weixin:\/\/|wx:\/\/)[^\s"'<>]+/gi);
        return matches && matches.length ? matches[matches.length - 1] : '';
    }

    function isQrCandidateLine(line) {
        const value = String(line || '').replace(/\r/g, '').trimEnd();
        if (!value.trim()) return false;
        if (value.length < 12) return false;
        if (!/[\u2580-\u259f\u2800-\u28ff█▀▄▌▐▓▒░#]/.test(value)) return false;
        if (/[A-Za-z0-9]{6,}/.test(value) && !/[█▀▄▌▐▓▒░]/.test(value)) return false;
        return /^[\s\u2580-\u259f\u2800-\u28ff█▀▄▌▐▓▒░#|]+$/.test(value);
    }

    function extractLatestAsciiQr(text) {
        const lines = String(text || '').replace(/\r/g, '').split('\n');
        const groups = [];
        let current = [];
        lines.forEach((line) => {
            if (isQrCandidateLine(line)) {
                current.push(line);
                return;
            }
            if (current.length >= 8) {
                groups.push(current.join('\n'));
            }
            current = [];
        });
        if (current.length >= 8) {
            groups.push(current.join('\n'));
        }
        return groups.length ? groups[groups.length - 1] : '';
    }

    function parseWeixinLoginSignal(text) {
        const source = String(text || '');
        const lower = source.toLowerCase();
        const link = extractLatestLoginLink(source);
        const asciiQr = extractLatestAsciiQr(source);
        const hasQrPrompt = /二维码|扫码|qrcode|qr code|scan/i.test(source);
        const expired = /二维码.*(?:过期|失效|超时)|qr(?: code)? .*?(?:expired|timeout)|login timeout|scan timeout/i.test(source);
        const scanned = /已扫码|扫码成功|scan(?:ned)?(?: successfully)?|请在手机上确认|confirm on phone|waiting for confirmation/i.test(source);
        const loginSuccess = /登录成功|login success|认证成功|authorized successfully|已完成扫码|登录完成/i.test(source);
        const restartSeen = /gateway.*restart|自动重启.*gateway|restarting gateway|gateway restart/i.test(source);
        const hardFailure = !/warning|deprecationwarning|duplicate plugin|config warnings/i.test(lower)
            && /登录失败|扫码失败|认证失败|login failed|authorize failed|fatal:|unexpected error/i.test(source);
        return {
            link,
            asciiQr,
            hasQrPrompt,
            expired,
            scanned,
            loginSuccess,
            restartSeen,
            hardFailure
        };
    }

    function parseWeixinRuntimeStatus(text) {
        const source = String(text || '');
        const lines = source.split(/\r?\n/);
        const relevantIndexes = [];
        lines.forEach((line, index) => {
            if (/(openclaw-weixin|个人微信(?:\s*v?1)?)/i.test(line)) {
                relevantIndexes.push(index);
            }
        });
        const relevantLineSet = new Set();
        relevantIndexes.forEach((index) => {
            for (let cursor = Math.max(0, index - 1); cursor <= Math.min(lines.length - 1, index + 1); cursor += 1) {
                relevantLineSet.add(cursor);
            }
        });
        const relevantBlock = Array.from(relevantLineSet)
            .sort((left, right) => left - right)
            .map((index) => lines[index])
            .join('\n');
        const mentionsWeixin = relevantBlock.trim().length > 0;
        const connected = mentionsWeixin
            && /(connected|online|ready|logged in|authenticated|已连接|已登录|登录成功|连接成功)/i.test(relevantBlock)
            && !/(offline|disconnected|未连接|未登录|失效|失败)/i.test(relevantBlock);
        const disconnected = mentionsWeixin && /(offline|disconnected|未连接|未登录|失效|失败)/i.test(relevantBlock);
        const looksLikeStatusOutput = /checking channel status|gateway (?:not )?reachable|source:\s|config:\s|mode:\s|tip:\s|status --probe/i.test(source)
            || /-\s+.+:\s+(?:enabled|disabled|configured|mode:|token:)/i.test(source);
        const missingFromStatus = looksLikeStatusOutput && !mentionsWeixin;
        return {
            mentionsWeixin,
            connected,
            disconnected,
            missingFromStatus,
            raw: relevantBlock || source
        };
    }

    function getWeixinPluginCompatibilityMessage(plugin = {}, logText = '') {
        const pluginMessage = String(plugin?.compatibilityIssue || '').trim();
        if (pluginMessage) return pluginMessage;
        const source = String(logText || '');
        if (
            source.includes('resolvePreferredOpenClawTmpDir')
            || source.includes('OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED')
            || source.includes('plugin-sdk/compat')
        ) {
            return '当前安装的个人微信插件与现有 OpenClaw 运行时不兼容，请先点击“升级到兼容版”安装新版本，再继续扫码或检查状态。';
        }
        return '';
    }

    function getWeixinLoginTone(phase) {
        if (phase === 'success') return 'success';
        if (phase === 'failure' || phase === 'expired') return 'danger';
        if (phase === 'waiting-scan' || phase === 'scanned' || phase === 'checking' || phase === 'installing') return 'info';
        return 'muted';
    }

    function getWeixinRuntimeNoticeState(weixinState = {}) {
        if (weixinState.weixinLoginPhase === 'scanned') {
            return {
                tone: 'success',
                eyebrow: 'Scanned',
                title: '已扫码，请在手机上完成确认',
                detail: '系统已经识别到扫码动作。手机确认后，界面会继续自动检查连接状态。'
            };
        }
        if (weixinState.weixinLoginPhase === 'checking') {
            return {
                tone: 'info',
                eyebrow: 'Checking',
                title: '正在确认个人微信连接状态',
                detail: '这一步只会检查是否已经接入成功，不会再生成新的二维码或扫码链接。'
            };
        }
        if (weixinState.weixinLoginPhase === 'success') {
            return {
                tone: 'success',
                eyebrow: 'Connected',
                title: '个人微信已确认接入',
                detail: '状态检查已经确认当前渠道可用，后续只需要按需重绑或编辑配置。'
            };
        }
        if (weixinState.weixinLoginPhase === 'failure' || weixinState.weixinLoginPhase === 'expired') {
            return {
                tone: 'danger',
                eyebrow: 'Attention',
                title: weixinState.weixinLoginPhase === 'expired' ? '二维码已过期' : '本次登录未确认成功',
                detail: '可以重新生成二维码，或在确认手机侧操作后再次点击“检查状态”。'
            };
        }
        return null;
    }

    const WEIXIN_LOG_NOISE_PATTERNS = [
        /^\[plugins\] plugins\.allow is empty/i,
        /^\[plugins\] feishu_(?:doc|chat|wiki|drive|bitable):/i,
        /^\[plugins\].*Registered/i,
        /^\[qqbot-channel-api\]/i,
        /^\[qqbot-remind\]/i,
        /^\[系统\] 命令已启动，但当前 CLI 还没有输出日志；界面会继续等待后续结果。$/i,
        /^\[状态检查\] 命令仍在运行，已等待 .+?；当前尚未返回新的 CLI 输出。$/i,
        /^\[扫码登录\] 命令仍在运行，已等待 .+?；当前尚未输出二维码或链接。$/i
    ];

    function isWeixinNoiseLogLine(line = '') {
        const value = String(line || '').trim();
        if (!value) return true;
        return WEIXIN_LOG_NOISE_PATTERNS.some((pattern) => pattern.test(value));
    }

    function buildWeixinLogDigest(logText = '') {
        const source = String(logText || '');
        if (!source.trim()) return '';
        const digestLines = [];
        for (const rawLine of source.split(/\r?\n/)) {
            const line = String(rawLine || '').trim();
            if (!line) continue;
            if (/^[\u2580\u2584\u2588 ]+$/.test(line)) continue;
            if (line.includes('liteapp.weixin.qq.com')) continue;
            if (isWeixinNoiseLogLine(line)) continue;
            if (digestLines[digestLines.length - 1] === line) continue;
            digestLines.push(line);
        }
        if (!digestLines.length) return '';
        return digestLines.slice(-12).join('\n');
    }

    function buildWeixinUserFacingRuntimeLog(logText = '', options = {}) {
        const source = String(logText || '').trim();
        const digest = buildWeixinLogDigest(source);
        if (digest) return digest;

        const runtimeActive = options.runtimeActive === true;
        const elapsedMs = Math.max(0, Number(options.elapsedMs || 0));
        const phase = String(options.phase || '').trim();

        if (source) {
            const meaningfulLine = source
                .split(/\r?\n/)
                .map((line) => String(line || '').trim())
                .find((line) => line && !isWeixinNoiseLogLine(line));
            if (meaningfulLine) return meaningfulLine;

            if (runtimeActive) {
                if (phase === 'checking') {
                    return '当前只收到启动级日志，状态检查命令仍在运行；这不是页面卡住，请等待状态结果返回。';
                }
                if (elapsedMs >= 5000) {
                    return '当前只收到插件启动日志，CLI 还没有回显二维码或链接；这不是页面卡住，可以稍等几秒，或直接点击“检查状态”。';
                }
                return '扫码命令已经启动，但目前只收到插件启动日志；二维码通常会稍后出现在这里。';
            }

            return '当前日志里只有插件启动信息，还没有出现可用于扫码或状态确认的结果。';
        }

        if (runtimeActive) {
            if (phase === 'checking') {
                return '状态检查命令已发出，正在等待返回结果...';
            }
            if (elapsedMs >= 5000) {
                return '命令仍在运行，但 CLI 暂时没有回显二维码或链接；这不是页面卡住，可以继续等待或点击“检查状态”。';
            }
            return '命令已经启动，正在等待 CLI 输出二维码、链接或确认状态...';
        }

        return '';
    }

    function isWeixinBindingCompleteFromState(state, channelName) {
        if (!isWeixinPersonalChannel(channelName)) return false;
        const safeState = ensureObject(state);
        const probe = ensureObject(safeState.channelAccess?.[channelName]);
        const normalizedState = String(probe.state || probe.status || '').toLowerCase();
        const rawProbeText = [
            String(probe.detail || ''),
            typeof probe.raw === 'string' ? probe.raw : '',
            typeof probe.message === 'string' ? probe.message : ''
        ].filter(Boolean).join('\n');
        const parsed = parseWeixinRuntimeStatus(rawProbeText);
        const runtimeParsed = parseWeixinRuntimeStatus([
            String(safeState.weixinStatusCheckRawLog || ''),
            String(safeState.weixinLoginRawLog || '')
        ].filter(Boolean).join('\n'));
        if (typeof probe.connected === 'boolean') {
            return probe.connected && (parsed.mentionsWeixin || /openclaw-weixin|微信/i.test(normalizedState));
        }
        if (parsed.connected) return true;
        if (runtimeParsed.connected) return true;
        if (/connected|online|ready/.test(normalizedState) && parsed.mentionsWeixin) return true;
        return false;
    }

    function loadCronViewCache() {
        try {
            const raw = window.localStorage?.getItem(CRON_VIEW_CACHE_KEY);
            if (!raw) return { jobs: [], updatedAt: 0 };
            const parsed = JSON.parse(raw);
            const updatedAt = Number(parsed?.updatedAt || 0);
            const jobs = ensureArray(parsed?.jobs);
            if (!updatedAt || Date.now() - updatedAt > CRON_VIEW_CACHE_MAX_AGE_MS) {
                return { jobs: [], updatedAt: 0 };
            }
            return { jobs, updatedAt };
        } catch (_) {
            return { jobs: [], updatedAt: 0 };
        }
    }

    function saveCronViewCache(jobs) {
        try {
            window.localStorage?.setItem(CRON_VIEW_CACHE_KEY, JSON.stringify({
                jobs: ensureArray(jobs),
                updatedAt: Date.now()
            }));
        } catch (_) {}
    }

    function loadExpiringObjectCache(storageKey, maxAgeMs) {
        try {
            const raw = window.localStorage?.getItem(storageKey);
            if (!raw) return {};
            const parsed = ensureObject(JSON.parse(raw));
            const now = Date.now();
            return Object.fromEntries(Object.entries(parsed).filter(([, value]) => {
                const updatedAt = Number(value?.updatedAt || 0);
                return updatedAt && now - updatedAt <= maxAgeMs;
            }));
        } catch (_) {
            return {};
        }
    }

    function saveObjectCache(storageKey, value) {
        try {
            window.localStorage?.setItem(storageKey, JSON.stringify(ensureObject(value)));
        } catch (_) {}
    }

    function loadChannelPairingCache() {
        return loadExpiringObjectCache(CHANNEL_PAIRING_CACHE_KEY, CHANNEL_PAIRING_CACHE_MAX_AGE_MS);
    }

    function saveChannelPairingCache(cache) {
        saveObjectCache(CHANNEL_PAIRING_CACHE_KEY, cache);
    }

    function loadMemoryViewCache() {
        return loadExpiringObjectCache(MEMORY_VIEW_CACHE_KEY, MEMORY_VIEW_CACHE_MAX_AGE_MS);
    }

    function saveMemoryViewCache(cache) {
        saveObjectCache(MEMORY_VIEW_CACHE_KEY, cache);
    }

    function toJsonText(value) {
        return JSON.stringify(value ?? {}, null, 2);
    }

    function parseJsonText(text, label) {
        const source = String(text || '').trim();
        if (!source) return {};
        try {
            const parsed = JSON.parse(source);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('必须是对象');
            }
            return parsed;
        } catch (error) {
            throw new Error(`${label} JSON 解析错误：${error.message}`);
        }
    }

    function statusClass(tone) {
        return `ocp-inline-status tone-${tone || 'info'}`;
    }

    function formatNumber(value) {
        return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
    }

    function formatTokens(value) {
        const number = Number(value || 0);
        if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
        if (number >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
        return formatNumber(number);
    }

    function formatCost(value) {
        return `$${Number(value || 0).toFixed(Number(value || 0) >= 1 ? 2 : 4)}`;
    }

    function formatDateTime(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('zh-CN', {
            hour12: false,
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function formatRelative(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const diff = Date.now() - date.getTime();
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`;
        if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
        return `${Math.round(diff / 86400000)} 天前`;
    }

    function formatUsageChannelLabel(value) {
        const raw = String(value || '').trim();
        const normalized = raw.toLowerCase();
        if (!normalized || normalized === 'unknown' || normalized === 'local') return '本机';
        return raw;
    }

    function buildUsageSessionTitle(session) {
        const safeSession = ensureObject(session);
        const displayName = String(safeSession.displayName || '').trim();
        const sessionId = String(safeSession.sessionId || '').trim();
        const channel = String(safeSession.channel || '').trim().toLowerCase();
        const agentId = String(safeSession.agentId || '').trim() || 'main';

        if (displayName) {
            if (sessionId && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId) && !displayName.includes(sessionId)) {
                return `${displayName}.${sessionId}`;
            }
            return displayName;
        }

        const sessionKey = String(safeSession.sessionKey || '').trim();
        if (sessionKey) return sessionKey;

        const prefix = channel && channel !== 'unknown' && channel !== 'local'
            ? channel
            : agentId;
        if (sessionId) return `${prefix}.${sessionId}`;
        return prefix || 'main';
    }

    function buildUsageDailyTooltip(item) {
        const daily = ensureObject(item);
        return [
            `日期：${daily.date || '-'}`,
            `输出：${formatTokens(daily.output)}`,
            `输入：${formatTokens(daily.input)}`,
            `缓存写入：${formatTokens(daily.cacheWrite)}`,
            `缓存读取：${formatTokens(daily.cacheRead)}`,
            `总计：${formatTokens(daily.tokens)}`,
            `总花费：${formatCost(daily.cost)}`
        ].join('\n');
    }

    function ensureUsageChartTooltip() {
        let tooltip = document.getElementById('ocpUsageChartTooltip');
        if (tooltip) return tooltip;
        tooltip = document.createElement('div');
        tooltip.id = 'ocpUsageChartTooltip';
        tooltip.className = 'ocp-chart-tooltip';
        tooltip.hidden = true;
        document.body.appendChild(tooltip);
        return tooltip;
    }

    function bindUsageChartTooltips(container) {
        const tooltip = ensureUsageChartTooltip();
        const hide = () => {
            tooltip.hidden = true;
            tooltip.textContent = '';
        };
        const move = (event, text) => {
            tooltip.textContent = text;
            tooltip.hidden = false;
            const offsetX = 14;
            const offsetY = 18;
            const maxLeft = Math.max(12, window.innerWidth - tooltip.offsetWidth - 12);
            const maxTop = Math.max(12, window.innerHeight - tooltip.offsetHeight - 12);
            const left = Math.min(maxLeft, event.clientX + offsetX);
            const top = Math.min(maxTop, event.clientY + offsetY);
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        };

        container.querySelectorAll('[data-usage-tooltip]').forEach((element) => {
            const text = String(element.getAttribute('data-usage-tooltip') || '').trim();
            if (!text) return;
            element.addEventListener('mouseenter', (event) => move(event, text));
            element.addEventListener('mousemove', (event) => move(event, text));
            element.addEventListener('mouseleave', hide);
        });
    }

    async function confirmDiscardChanges(message) {
        const promptText = String(message || '是否放弃未保存修改？');
        if (typeof window.showConfirmDialog === 'function') {
            return window.showConfirmDialog(promptText, { confirmText: '放弃' });
        }
        return window.confirm(promptText);
    }

    async function readConfig() {
        return ensureObject(await window.api.getOpenClawConfig());
    }

    async function listAgents() {
        const agents = ensureArray(await window.api.listAgents()).map(item => String(item || '').trim()).filter(Boolean);
        return agents.length ? agents : ['main'];
    }

    function renderHeader(title, desc) {
        return `
            <div class="ocp-hero">
                <div>
                    <h2 class="page-title">${esc(title)}</h2>
                    <p class="page-desc">${esc(desc)}</p>
                </div>
            </div>
        `;
    }

    function getBoundAgent(config, channelName) {
        const bindingKey = String(channelName || '').trim().toLowerCase() === 'dingtalk'
            ? 'dingtalk-connector'
            : String(channelName || '').trim();
        const binding = ensureArray(config?.bindings).find(item => String(item?.match?.channel || '').trim() === bindingKey);
        return binding?.agentId || 'main';
    }

    function setSingleChannelBinding(config, channelName, agentId) {
        const bindingKey = String(channelName || '').trim().toLowerCase() === 'dingtalk'
            ? 'dingtalk-connector'
            : String(channelName || '').trim();
        const bindings = ensureArray(config.bindings).filter(item => String(item?.match?.channel || '').trim() !== bindingKey);
        if (agentId && agentId !== '__unbound__') {
            bindings.push({ agentId, match: { channel: bindingKey, accountId: 'default' } });
        }
        config.bindings = bindings;
    }

    function getChannelPresets() {
        return {
            telegram: { enabled: true, botToken: '', proxy: '', allowFrom: [], groupAllowFrom: [], groupPolicy: 'open', dmPolicy: 'pairing' },
            qqbot: { enabled: true, appId: '', appSecret: '', clientSecret: '', allowFrom: ['*'] },
            feishu: {
                enabled: true,
                appId: '',
                appSecret: '',
                domain: 'feishu',
                connectionMode: 'websocket',
                allowFrom: [],
                groupAllowFrom: [],
                groupPolicy: 'open',
                dmPolicy: 'pairing',
                streaming: true,
                typingIndicator: true,
                resolveSenderNames: true,
                verificationToken: '',
                encryptKey: '',
                webhookPath: ''
            },
            wecom: {
                enabled: true,
                botId: '',
                secret: '',
                allowFrom: [],
                groupAllowFrom: [],
                dmPolicy: 'open',
                groupPolicy: 'open',
                websocketUrl: '',
                sendThinkingMessage: true
            },
            'openclaw-weixin': {
                enabled: true
            },
            discord: { enabled: true, token: '', guildId: '', channelId: '' },
            dingtalk: {
                enabled: true,
                clientId: '',
                clientSecret: '',
                robotCode: '',
                corpId: '',
                agentId: '',
                allowFrom: [],
                groupAllowFrom: [],
                dmPolicy: 'open',
                groupPolicy: 'open',
                messageType: 'markdown',
                cardTemplateId: '',
                cardTemplateKey: '',
                displayNameResolution: 'disabled',
                ackReaction: ''
            }
        };
    }

    function normalizeChannelKey(channelName) {
        return String(channelName || '').trim().toLowerCase();
    }

    const CHANNEL_REGISTRY = {
        telegram: {
            label: 'Telegram',
            desc: '通过 BotFather 创建机器人，用 Bot Token 接入。',
            builtIn: true,
            guide: [
                '在 Telegram 中搜索 @BotFather，发送 /newbot 创建机器人。',
                '按提示设置机器人名称和用户名，成功后 BotFather 会返回 Bot Token。',
                '将 Bot Token 和允许的用户 ID 填入下方表单，保存后即可接入。',
                '当前页面保留配对审批入口，适用于支持配对的通道。'
            ],
            defaults: { enabled: true, botToken: '', proxy: '', allowFrom: [], groupAllowFrom: [], groupPolicy: 'open', dmPolicy: 'pairing' },
            fields: [
                { key: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...', required: true },
                { key: 'proxy', label: '代理地址', placeholder: 'socks5://127.0.0.1:7890', description: '可选。Telegram 走代理时填写完整地址，例如 socks5://127.0.0.1:7890' },
                { key: 'allowedUsers', label: '允许的用户 ID', kind: 'list', targetKey: 'allowFrom', placeholder: 'groupPolicy=open 时可留空；多个用逗号分隔，如 12345, 67890' },
                { key: 'groupPolicy', label: '群聊策略', type: 'select', options: [
                    ['open', 'open'],
                    ['allowlist', 'allowlist'],
                    ['disabled', 'disabled']
                ] },
                { key: 'dmPolicy', label: '私聊策略', type: 'select', options: [
                    ['pairing', 'pairing'],
                    ['open', 'open'],
                    ['disabled', 'disabled']
                ] }
            ],
            pairing: true
        },
        qqbot: {
            label: 'QQ 机器人',
            desc: '通过 QQ 机器人开放平台接入，填写 AppID 与 AppSecret 后即可启用。',
            guide: [
                '使用手机 QQ 扫描二维码，前往 QQ 机器人开放平台完成注册登录。',
                '创建机器人后复制 AppID 与 AppSecret。',
                '安装命令为 openclaw plugins install @tencent-connect/openclaw-qqbot@latest。',
                'OpenClaw CLI 也支持通过 --token "AppID:AppSecret" 方式快速写入 QQ 凭证。',
                '每次安装完成后都需要重启网关，配置才会真正生效。'
            ],
            defaults: { enabled: true, appId: '', appSecret: '', clientSecret: '', allowFrom: ['*'] },
            fields: [
                { key: 'appId', label: 'AppID', placeholder: '如 1903224859', required: true },
                { key: 'appSecret', label: 'AppSecret', placeholder: '如 cisldqspngYlyPdc', secret: true, required: true },
                { key: 'allowFrom', label: '允许来源', kind: 'list', placeholder: '多个用逗号分隔，留 * 表示全部' }
            ],
            pairing: false
        },
        feishu: {
            label: '飞书机器人',
            desc: '飞书/Lark 企业消息集成，适合文档、多维表格、日历等场景。',
            builtIn: true,
            guide: [
                '前往飞书开放平台创建企业自建应用，并添加机器人能力。',
                '在凭证页面获取 App ID 和 App Secret。',
                '当前 OpenClaw 正式版通常已内置飞书渠道；如果你的环境缺失，再手动执行 openclaw plugins install @openclaw/feishu。',
                '域名可按实际环境选择 feishu 或 lark，连接模式默认推荐 websocket。',
                '每次安装完成后都需要重启网关，配置才会真正生效。'
            ],
            defaults: {
                enabled: true,
                appId: '',
                appSecret: '',
                domain: 'feishu',
                connectionMode: 'websocket',
                allowFrom: [],
                groupAllowFrom: [],
                groupPolicy: 'open',
                dmPolicy: 'pairing',
                streaming: true,
                typingIndicator: true,
                resolveSenderNames: true,
                verificationToken: '',
                encryptKey: '',
                webhookPath: ''
            },
            fields: [
                { key: 'appId', label: 'App ID', placeholder: 'cli_xxxxxxxxxx', required: true },
                { key: 'appSecret', label: 'App Secret', placeholder: '应用密钥', secret: true, required: true },
                { key: 'domain', label: '域名', placeholder: 'feishu（国际版选 lark）' },
                { key: 'connectionMode', label: '连接模式', type: 'select', options: [
                    ['websocket', 'websocket'],
                    ['webhook', 'webhook']
                ] },
                { key: 'dmPolicy', label: '私聊策略', type: 'select', options: [
                    ['pairing', 'pairing'],
                    ['open', 'open'],
                    ['allowlist', 'allowlist'],
                    ['disabled', 'disabled']
                ] },
                { key: 'allowFrom', label: '私聊白名单', kind: 'list', placeholder: 'dmPolicy=allowlist 时填写' },
                { key: 'groupPolicy', label: '群聊策略', type: 'select', options: [
                    ['open', 'open'],
                    ['allowlist', 'allowlist'],
                    ['disabled', 'disabled']
                ] },
                { key: 'groupAllowFrom', label: '群聊白名单', kind: 'list', placeholder: 'groupPolicy=allowlist 时填写' },
                { key: 'streaming', label: '长连接', type: 'select', options: [
                    ['true', '启用'],
                    ['false', '关闭']
                ] },
                { key: 'typingIndicator', label: '输入中提示', type: 'select', options: [
                    ['true', '启用'],
                    ['false', '关闭']
                ] },
                { key: 'resolveSenderNames', label: '解析发送者名称', type: 'select', options: [
                    ['true', '启用'],
                    ['false', '关闭']
                ] },
                { key: 'verificationToken', label: 'Verification Token', placeholder: 'connectionMode=webhook 时可选' },
                { key: 'encryptKey', label: 'Encrypt Key', placeholder: 'connectionMode=webhook 时可选', secret: true },
                { key: 'webhookPath', label: 'Webhook Path', placeholder: 'connectionMode=webhook 时可选' }
            ],
            pairing: true,
            pairingChannel: 'feishu',
            pairingNotify: true
        },
        wecom: {
            label: '企业微信机器人',
            desc: '通过企业微信 AI 助手 + wecom-openclaw-plugin 接入。',
            guide: [
                '前往企业微信 AI 助手页面创建机器人：https://work.weixin.qq.com/wework_admin/frame#/aiHelper/list?from=manage_tools',
                '点击“安装并继续”时可以选择 npmmirror、淘宝源、npm 官方或华为云镜像。',
                '配置字段可直接参考当前机器 openclaw.json 里的 channels.wecom 节点，保存后即可写入企业微信渠道配置。',
                '每次安装完成后都需要重启网关，配置才会真正生效。'
            ],
            defaults: {
                enabled: true,
                botId: '',
                secret: '',
                allowFrom: [],
                groupAllowFrom: [],
                dmPolicy: 'open',
                groupPolicy: 'open',
                websocketUrl: '',
                sendThinkingMessage: true
            },
            fields: [
                { key: 'botId', label: 'Bot ID', placeholder: '企业微信 AI 助手 Bot ID', required: true },
                { key: 'secret', label: 'Secret', placeholder: '企业微信插件 Secret', secret: true, required: true },
                { key: 'websocketUrl', label: 'WebSocket URL', placeholder: '可选，默认 wss://openws.work.weixin.qq.com' },
                { key: 'dmPolicy', label: '私聊策略', type: 'select', options: [
                    ['pairing', 'pairing'],
                    ['open', 'open'],
                    ['allowlist', 'allowlist'],
                    ['disabled', 'disabled']
                ] },
                { key: 'allowFrom', label: '私聊白名单', kind: 'list', placeholder: 'dmPolicy=allowlist 时填写' },
                { key: 'groupPolicy', label: '群聊策略', type: 'select', options: [
                    ['open', 'open'],
                    ['allowlist', 'allowlist'],
                    ['disabled', 'disabled']
                ] },
                { key: 'groupAllowFrom', label: '群聊白名单', kind: 'list', placeholder: 'groupPolicy=allowlist 时填写' },
                { key: 'sendThinkingMessage', label: '思考中提示', type: 'select', options: [
                    ['true', '启用'],
                    ['false', '关闭']
                ] }
            ],
            pairing: false
        },
        'openclaw-weixin': {
            label: '个人微信 V1',
            desc: '支持自动安装流与手动回退流的扫码登录渠道。',
            guide: [
                '自动安装流会执行 npx -y @tencent-weixin/openclaw-weixin-cli install，正常情况下会自动安装或更新、生成二维码并在登录成功后自动重启 Gateway。',
                '手动回退流建议按顺序执行：安装插件、启用插件、手动登录、重启 Gateway。',
                '二维码与扫码链接会在当前页面单独展示；普通终端日志仅作为辅助信息。'
            ],
            defaults: {
                enabled: true
            },
            fields: [],
            pairing: false
        },
        dingtalk: {
            label: '钉钉机器人',
            desc: '钉钉企业内部应用 + 机器人 Stream 模式接入。',
            guide: [
                '前往钉钉开放平台创建企业内部应用，并添加机器人能力。',
                '安装命令为 openclaw plugins install @soimy/dingtalc。',
                '核心字段是 Client ID 和 Client Secret，可选补充 Robot Code、Corp ID、Agent ID。',
                '如启用 AI 互动卡片模式，还需要填写 Card Template ID 和 Card Template Key。',
                '每次安装完成后都需要重启网关，配置才会真正生效。'
            ],
            defaults: {
                enabled: true,
                clientId: '',
                clientSecret: '',
                robotCode: '',
                corpId: '',
                agentId: '',
                allowFrom: [],
                groupAllowFrom: [],
                dmPolicy: 'open',
                groupPolicy: 'open',
                messageType: 'markdown',
                cardTemplateId: '',
                cardTemplateKey: '',
                displayNameResolution: 'disabled',
                ackReaction: ''
            },
            fields: [
                { key: 'clientId', label: 'Client ID', placeholder: 'dingxxxxxxxxxx', required: true },
                { key: 'clientSecret', label: 'Client Secret', placeholder: '应用密钥', secret: true, required: true },
                { key: 'robotCode', label: 'Robot Code', placeholder: '可选' },
                { key: 'corpId', label: 'Corp ID', placeholder: '可选' },
                { key: 'agentId', label: 'Agent ID', placeholder: '推荐填写' },
                { key: 'dmPolicy', label: '私聊策略', type: 'select', options: [
                    ['open', 'open'],
                    ['pairing', 'pairing'],
                    ['allowlist', 'allowlist'],
                    ['disabled', 'disabled']
                ] },
                { key: 'allowFrom', label: '私聊白名单', kind: 'list', placeholder: 'dmPolicy=allowlist 时填写' },
                { key: 'groupPolicy', label: '群聊策略', type: 'select', options: [
                    ['open', 'open'],
                    ['allowlist', 'allowlist'],
                    ['disabled', 'disabled']
                ] },
                { key: 'groupAllowFrom', label: '群聊白名单', kind: 'list', placeholder: 'groupPolicy=allowlist 时填写' },
                { key: 'messageType', label: '消息类型', type: 'select', options: [
                    ['markdown', 'markdown'],
                    ['card', 'card']
                ] },
                { key: 'cardTemplateId', label: 'Card Template ID', placeholder: 'messageType=card 时填写' },
                { key: 'cardTemplateKey', label: 'Card Template Key', placeholder: '默认 content', secret: true },
                { key: 'displayNameResolution', label: '名称解析', type: 'select', options: [
                    ['disabled', 'disabled'],
                    ['all', 'all']
                ] },
                { key: 'ackReaction', label: 'Ack Reaction', placeholder: '可选，例如 🤔思考中' }
            ],
            pairing: true,
            pairingChannel: 'dingtalk-connector'
        },
        discord: {
            label: 'Discord',
            desc: '通过 Discord Developer Portal 创建 Bot 应用接入。',
            guide: [
                '在 Discord Developer Portal 创建应用。',
                '进入 Bot 页面生成 Bot Token，并开启 Message Content Intent。',
                '将 Bot Token、服务器 ID 和频道 ID 填入后保存。',
                '当前页仅负责保存配置与 Agent 绑定，不自动执行官方邀请流程。'
            ],
            defaults: { enabled: true, token: '', guildId: '', channelId: '' },
            fields: [
                { key: 'token', label: 'Bot Token', placeholder: 'MTIz...', secret: true, required: true },
                { key: 'guildId', label: '服务器 ID', placeholder: '右键服务器 -> 复制服务器 ID' },
                { key: 'channelId', label: '频道 ID（可选）', placeholder: '不填则监听所有频道' }
            ],
            pairing: false
        }
    };

    const PRIMARY_CHANNEL_ORDER = ['qqbot', 'feishu', 'wecom', 'openclaw-weixin', 'dingtalk'];

    function sortChannelKeys(keys) {
        return ensureArray(keys).slice().sort((left, right) => {
            const leftIndex = PRIMARY_CHANNEL_ORDER.indexOf(left);
            const rightIndex = PRIMARY_CHANNEL_ORDER.indexOf(right);
            if (leftIndex !== -1 || rightIndex !== -1) {
                return (leftIndex === -1 ? PRIMARY_CHANNEL_ORDER.length : leftIndex)
                    - (rightIndex === -1 ? PRIMARY_CHANNEL_ORDER.length : rightIndex);
            }
            return String(left).localeCompare(String(right), 'zh-CN');
        });
    }

    function inferChannelProfileKey(channelName, channelConfig = {}) {
        const normalizedName = normalizeChannelKey(channelName);
        const directKey = normalizedName === 'dingtalk-connector' ? 'dingtalk' : normalizedName;
        if (CHANNEL_REGISTRY[directKey]) {
            return directKey;
        }

        const source = ensureObject(channelConfig);
        if (!Object.keys(source).length) {
            return directKey;
        }

        if (
            Object.keys(ensureObject(source.accounts)).length
            || source.domain
            || source.connectionMode
            || source.verificationToken
            || source.encryptKey
            || source.webhookPath
            || typeof source.streaming === 'boolean'
            || typeof source.typingIndicator === 'boolean'
            || typeof source.resolveSenderNames === 'boolean'
        ) {
            return 'feishu';
        }

        if (
            source.botId
            || source.websocketUrl
            || typeof source.sendThinkingMessage === 'boolean'
        ) {
            return 'wecom';
        }

        if (source.botToken) {
            return 'telegram';
        }

        if (
            source.messageType
            || source.cardTemplateId
            || source.cardTemplateKey
            || source.robotCode
            || source.clientId
        ) {
            return 'dingtalk';
        }

        if (
            source.appId
            && (source.appSecret || source.clientSecret || source.token)
        ) {
            return 'qqbot';
        }

        return directKey;
    }

    function getChannelProfile(channelName, channelConfig = {}) {
        const key = inferChannelProfileKey(channelName, channelConfig);
        return CHANNEL_REGISTRY[key] || {
            label: channelName || '未命名渠道',
            desc: '自定义渠道配置。',
            guide: ['当前通道没有专属模板，可以继续保存原始 JSON 配置。'],
            defaults: { enabled: true },
            fields: [],
            pairing: false
        };
    }

    function normalizePairingRequests(raw) {
        if (Array.isArray(raw)) return raw;
        if (Array.isArray(raw?.requests)) return raw.requests;
        if (Array.isArray(raw?.items)) return raw.items;
        return [];
    }

    function supportsPairing(channelName) {
        return Boolean(getChannelProfile(channelName).pairing);
    }

    function csvText(value) {
        return ensureArray(value).join(', ');
    }

    function parseCsvText(value) {
        return String(value || '')
            .split(/[\n,]/)
            .map(item => String(item || '').trim())
            .filter(Boolean);
    }

    function getFieldValue(channelConfig, field) {
        const key = field.targetKey || field.key;
        let value = channelConfig?.[key];
        if ((field.key === 'appId' || field.key === 'appSecret' || field.key === 'clientSecret') && !value) {
            const token = String(channelConfig?.token || '').trim();
            if (token.includes(':')) {
                const parts = token.split(':');
                value = field.key === 'appId' ? parts.shift() : parts.join(':');
            }
        }
        if (field.kind === 'list') return csvText(value);
        if (field.type === 'select') return String(value ?? field.default ?? (field.options?.[0]?.[0] ?? field.options?.[0]?.value ?? ''));
        return value ?? '';
    }

    function applyFieldValue(target, field, inputValue) {
        const key = field.targetKey || field.key;
        if (field.kind === 'list') {
            const list = parseCsvText(inputValue);
            if (list.length) target[key] = list;
            else delete target[key];
            return;
        }
        const value = String(inputValue ?? '').trim();
        if (!value && !field.required) {
            delete target[key];
            return;
        }
        if (field.type === 'select' && value === 'false') {
            target[key] = false;
            return;
        }
        if (field.type === 'select' && value === 'true') {
            target[key] = true;
            return;
        }
        target[key] = value;
    }

    function buildChannelDraft(channelName, base = {}) {
        const profile = getChannelProfile(channelName, base);
        const normalized = inferChannelProfileKey(channelName, base);
        const source = ensureObject(base);
        const draft = clone(Object.assign({}, profile.defaults || {}, source || {}));
        if (normalized === 'qqbot' && source.token && (!draft.appId || !(draft.appSecret || draft.clientSecret))) {
            const parts = String(source.token || '').split(':');
            if (parts.length >= 2) {
                draft.appId = draft.appId || parts.shift() || '';
                const tokenSecret = parts.join(':');
                draft.appSecret = draft.appSecret || draft.clientSecret || tokenSecret;
                draft.clientSecret = draft.clientSecret || draft.appSecret;
            }
        }
        if (normalized === 'feishu' && source.accounts && !draft.appId) {
            const firstAccountId = Object.keys(ensureObject(source.accounts))[0];
            if (firstAccountId) {
                const account = ensureObject(source.accounts[firstAccountId]);
                draft.appId = account.appId || '';
                draft.appSecret = account.appSecret || '';
                draft.domain = account.domain || draft.domain;
                if (Object.prototype.hasOwnProperty.call(account, 'streaming')) {
                    draft.streaming = account.streaming;
                }
                draft.__accountId = firstAccountId;
            }
        }
        return draft;
    }

    function serializeChannelDraft(channelName, previousConfig, draft) {
        const normalized = inferChannelProfileKey(channelName, draft || previousConfig);
        const next = clone(draft || {});
        delete next.__accountId;

        if (normalized === 'qqbot') {
            const saved = { enabled: next.enabled !== false };
            const appSecret = String(next.appSecret || next.clientSecret || '').trim();
            if (next.appId && appSecret) {
                saved.appId = next.appId;
                saved.appSecret = appSecret;
                saved.clientSecret = appSecret;
                saved.token = `${next.appId}:${appSecret}`;
            }
            if (ensureArray(next.allowFrom).length) {
                saved.allowFrom = clone(next.allowFrom);
            }
            return saved;
        }

        if (normalized === 'feishu') {
            const saved = clone(previousConfig);
            const accountId = String(
                draft.__accountId
                || saved.defaultAccount
                || Object.keys(ensureObject(saved.accounts))[0]
                || 'default'
            );
            saved.enabled = next.enabled !== false;
            saved.domain = next.domain || 'feishu';
            saved.connectionMode = next.connectionMode || 'websocket';
            saved.dmPolicy = next.dmPolicy || 'pairing';
            saved.groupPolicy = next.groupPolicy || 'open';
            saved.streaming = next.streaming !== false;
            saved.typingIndicator = next.typingIndicator !== false;
            saved.resolveSenderNames = next.resolveSenderNames !== false;
            saved.defaultAccount = accountId;
            saved.accounts = ensureObject(saved.accounts);
            saved.accounts[accountId] = {
                ...(ensureObject(saved.accounts[accountId])),
                enabled: true,
                appId: next.appId || '',
                appSecret: next.appSecret || '',
                domain: next.domain || 'feishu',
                typingIndicator: next.typingIndicator !== false,
                resolveSenderNames: next.resolveSenderNames !== false
            };
            if (ensureArray(next.allowFrom).length) saved.allowFrom = clone(next.allowFrom);
            else delete saved.allowFrom;
            if (ensureArray(next.groupAllowFrom).length) saved.groupAllowFrom = clone(next.groupAllowFrom);
            else delete saved.groupAllowFrom;
            if (next.verificationToken) saved.verificationToken = next.verificationToken;
            else delete saved.verificationToken;
            if (next.encryptKey) saved.encryptKey = next.encryptKey;
            else delete saved.encryptKey;
            if (next.webhookPath) saved.webhookPath = next.webhookPath;
            else delete saved.webhookPath;
            delete saved.appId;
            delete saved.appSecret;
            return saved;
        }

        if (normalized === 'dingtalk') {
            if (String(next.messageType || '').trim() !== 'card') {
                delete next.cardTemplateId;
                delete next.cardTemplateKey;
            } else if (!String(next.cardTemplateKey || '').trim()) {
                next.cardTemplateKey = 'content';
            }
        }

        return next;
    }

    function renderChannelGuideList(profile) {
        return (profile.guide || []).map(step => `<div class="ocp-row-meta">• ${esc(step)}</div>`).join('');
    }

    function resolveChannelStorageKey(channelName, config = {}) {
        const normalized = normalizeChannelKey(channelName);
        if (normalized === 'dingtalk' && !ensureObject(config?.channels)?.dingtalk) {
            return 'dingtalk-connector';
        }
        return channelName;
    }

    function normalizeChannelAccessProbeResult(result, channelName) {
        if (result == null) return null;
        if (typeof result === 'string') {
            return { channel: channelName, state: result, detail: result };
        }

        const wrapper = ensureObject(result);
        const payload = ensureObject(wrapper.channel && typeof wrapper.channel === 'object' ? wrapper.channel : wrapper);
        const state = String(payload.state || payload.status || payload.mode || '').trim().toLowerCase();
        const detail = String(payload.detail || payload.message || payload.reason || payload.error || '').trim();
        const installed = typeof payload.installed === 'boolean'
            ? payload.installed
            : (/installed|ready|available|online|connected/i.test(state) ? true : /missing|absent|not installed|uninstalled/i.test(state) ? false : null);
        const repairRequired = typeof payload.repairRequired === 'boolean'
            ? payload.repairRequired
            : /repair|broken|failed|error|invalid/i.test(state);
        const configured = typeof payload.configured === 'boolean' ? payload.configured : null;
        const needsInstallation = typeof payload.needsInstallation === 'boolean' ? payload.needsInstallation : null;
        const needsConfiguration = typeof payload.needsConfiguration === 'boolean' ? payload.needsConfiguration : null;

        return {
            channel: channelName,
            state,
            detail,
            installed,
            repairRequired,
            configured,
            needsInstallation,
            needsConfiguration,
            raw: payload
        };
    }

        function getChannelAccessActionState(state, channelName, options = {}) {
            const profile = options.profile || getChannelProfile(channelName);
            const channelConfig = ensureObject(options.channelConfig || state.config?.channels?.[channelName]);
            const probe = ensureObject(options.probe || state.channelAccess?.[channelName]);
            const isWeixinChannel = isWeixinPersonalChannel(channelName);
            const isBuiltIn = profile?.builtIn === true;
            const configured = typeof probe.configured === 'boolean'
                ? probe.configured
                : Object.keys(channelConfig).length > 0;
            const normalizedState = String(probe.state || probe.status || '').toLowerCase();
            const isRepair = !isBuiltIn && (Boolean(probe.repairRequired) || /repair|broken|failed|error|invalid/.test(normalizedState));
        const isInstalled = typeof probe.installed === 'boolean'
            ? probe.installed
            : ((isBuiltIn || /installed|ready|available|online|connected/.test(normalizedState)) ? true : null);
        const isMissing = typeof isInstalled === 'boolean' ? !isInstalled : (!isBuiltIn && /missing|absent|not installed|uninstalled/.test(normalizedState));
        const needsInstall = isBuiltIn
            ? false
            : (typeof probe.needsInstallation === 'boolean'
                ? probe.needsInstallation
                : (isMissing || /needs-install|missing|absent|not installed|uninstalled/.test(normalizedState)));
        const needsConfig = typeof probe.needsConfiguration === 'boolean'
            ? probe.needsConfiguration
            : /needs-config|incomplete|partial/.test(normalizedState);

        if (configured && (isRepair || needsInstall)) {
            return {
                state: 'repair',
                badge: '环境缺失',
                button: '修复环境',
                tone: 'danger',
                detail: `已发现 ${profile.label || channelName} 配置，但当前机器缺少可用插件/环境。`,
                hint: '先按接入说明补齐环境，再回到弹窗里调整参数和校验凭证。',
                action: 'install',
                followupAction: 'edit',
                target: channelName
            };
        }

        if (configured && !isRepair) {
            return {
                state: needsConfig ? 'needs-config' : 'configured',
                badge: isWeixinChannel
                    ? (isWeixinBindingCompleteFromState(state, channelName) ? '已绑定' : '待绑定')
                    : (needsConfig ? '待补全' : (channelConfig.enabled !== false ? '已接入' : '已停用')),
                button: isWeixinChannel ? '编辑接入' : '编辑配置',
                tone: needsConfig ? 'warning' : (channelConfig.enabled !== false ? 'success' : 'muted'),
                detail: isWeixinChannel
                    ? (isWeixinBindingCompleteFromState(state, channelName)
                    ? '个人微信已完成扫码绑定，后续如需重新绑定可再次进入编辑接入。'
                    : '个人微信插件已安装，但当前还没完成扫码绑定。点击“编辑接入”继续处理。')
                    : (needsConfig
                        ? `已检测到 ${profile.label || channelName} 环境，但当前配置还没补齐。`
                        : `已写入配置，点击可继续编辑 ${profile.label || channelName}。`),
                hint: isWeixinChannel
                ? 'V1 仅保留最小接入流程；安装、升级与扫码都收敛在编辑弹窗里。'
                    : (needsConfig
                        ? '弹窗里可以继续补齐参数，并先做凭证校验再保存。'
                        : '参数编辑与凭证校验会在弹窗里完成。'),
                action: 'edit',
                target: channelName
            };
        }

        if (isRepair) {
            return {
                state: 'repair',
                badge: '环境异常',
                button: '修复环境',
                tone: 'danger',
                detail: '检测到当前机器环境异常，先查看接入说明，再继续配置。',
                hint: '这里不会执行真实安装，只提供引导与接入弹窗。',
                action: 'install',
                followupAction: configured ? 'edit' : 'create',
                target: channelName
            };
        }

        if (isInstalled === true && !configured) {
            return {
                state: 'ready',
                badge: '可接入',
                button: isWeixinChannel ? '编辑接入' : '立即接入',
                tone: 'info',
                detail: isWeixinChannel
                    ? '已检测到个人微信 V1 插件环境，可直接进入编辑接入并开始扫码绑定。'
                    : '已检测到可用环境，直接打开接入弹窗即可。',
                hint: isWeixinChannel
                    ? '不会再展示分散按钮；安装、升级与扫码都集中在编辑弹窗里完成。'
                    : '如果后端接入状态接口可用，这里会自动显示环境状态。',
                action: isWeixinChannel ? 'edit' : 'create',
                target: channelName
            };
        }

        if (needsInstall || (!configured && isInstalled === false)) {
            return {
                state: 'missing',
                badge: '未安装',
                button: isWeixinChannel ? '安装并接入' : '安装并继续',
                tone: 'warning',
                detail: isWeixinChannel
                    ? '当前机器还未安装个人微信 V1 插件，先安装后再进入扫码接入。'
                    : '当前机器未检测到对应插件/环境，先打开接入引导与表单。',
                hint: isWeixinChannel
                    ? 'V1 只保留一个主入口：安装并接入。安装完成后会继续进入扫码接入。'
                    : '确认后会先自动安装本机插件/环境，成功后再继续填写配置。',
                action: 'install',
                followupAction: configured ? 'edit' : 'create',
                target: channelName
            };
        }

        return {
            state: configured ? 'configured' : 'unknown',
            badge: configured ? '已接入' : '待接入',
            button: configured ? '编辑配置' : '安装并接入',
            tone: configured ? 'success' : 'info',
            detail: configured
                ? `已写入配置，点击可继续编辑 ${profile.label || channelName}。`
                : '点击主按钮打开接入弹窗，后续可接后端环境检测接口。',
            hint: configured
                ? '参数编辑与凭证校验会在弹窗里完成。'
                : '当前状态未确认环境安装情况，先按接入流程完成配置。',
            action: configured ? 'edit' : 'create',
            followupAction: configured ? 'edit' : 'create',
            target: channelName
        };
    }

    function isInstallingChannelState(state, channelName) {
        return Boolean(channelName) && normalizeChannelKey(state?.installingChannel) === normalizeChannelKey(channelName);
    }

    function getChannelActionButtonLabel(state, actionState, channelName) {
        if (isInstallingChannelState(state, channelName)) return '安装中...';
        return actionState?.button || '继续';
    }

    function getChannelAccessProbe(state, channelName) {
        const storedKey = resolveChannelStorageKey(channelName, state.config);
        return ensureObject(state.channelAccess?.[storedKey] || state.channelAccess?.[channelName]);
    }

    function describeChannelInstalledState(actionState, probe) {
        const normalizedState = String(probe.state || probe.status || '').toLowerCase();
        if (probe.installed === true || /installed|ready|available|online|connected/.test(normalizedState)) {
            return {
                label: '安装',
                value: '已安装',
                tone: 'success',
                detail: '当前机器已检测到可用环境。'
            };
        }
        if (probe.installed === false || actionState.state === 'missing' || actionState.state === 'repair' || /missing|absent|not installed|uninstalled/.test(normalizedState)) {
            return {
                label: '安装',
                value: '未安装',
                tone: 'warning',
                detail: '需要先完成安装或修复环境。'
            };
        }
        return {
            label: '安装',
            value: '待检测',
            tone: 'muted',
            detail: '当前还没有拿到明确的安装状态。'
        };
    }

    function describeChannelConfiguredState(channelName, channelConfig, actionState) {
        const configured = Object.keys(channelConfig).length > 0 || ['configured', 'needs-config', 'repair'].includes(actionState.state);
        if (!configured) {
            return {
                label: '配置',
                value: '未配置',
                tone: 'info',
                detail: '可以先从接入弹窗开始写入配置。'
            };
        }
        if (actionState.state === 'needs-config') {
            return {
                label: '配置',
                value: '待补全',
                tone: 'warning',
                detail: `已写入 ${channelName} 配置，但还需要补齐部分字段。`
            };
        }
        return {
            label: '配置',
            value: channelConfig.enabled === false ? '已停用' : '已配置',
            tone: channelConfig.enabled === false ? 'muted' : 'success',
            detail: channelConfig.enabled === false ? '当前配置已保存，但处于停用状态。' : '当前配置已保存，可继续编辑。'
        };
    }

    function describeChannelConnectionState(state, channelName, channelConfig, actionState, probe) {
        const normalizedState = String(probe.state || probe.status || '').toLowerCase();
        const isWeixinChannel = isWeixinPersonalChannel(channelName);
        const bindingComplete = isWeixinChannel && isWeixinBindingCompleteFromState(state, channelName);
        const rawProbeText = [
            String(probe.detail || ''),
            typeof probe.raw === 'string' ? probe.raw : '',
            typeof probe.message === 'string' ? probe.message : ''
        ].filter(Boolean).join('\n');
        const weixinRuntimeStatus = isWeixinChannel ? parseWeixinRuntimeStatus(rawProbeText) : null;

        if (bindingComplete) {
            return {
                label: '连接',
                value: '已绑定',
                tone: 'success',
                detail: '个人微信扫码绑定已完成。'
            };
        }

        if (isWeixinChannel && (weixinRuntimeStatus?.missingFromStatus || Object.keys(channelConfig).length > 0)) {
            return {
                label: '连接',
                value: '待绑定',
                tone: 'info',
                detail: '当前还没有确认个人微信扫码绑定成功，可以继续扫码登录后再检查状态。'
            };
        }

        if (/connected|online|ready|authenticated/.test(normalizedState)) {
            return {
                label: '连接',
                value: '已连接',
                tone: 'success',
                detail: '当前渠道已经处于可用连接状态。'
            };
        }

        if (/disconnected|offline|未连接|未登录|失效|失败/.test(normalizedState) || actionState.state === 'missing') {
            return {
                label: '连接',
                value: '未连接',
                tone: 'warning',
                detail: '还没有建立有效连接，下一步可以继续接入或登录。'
            };
        }

        if (Object.keys(channelConfig).length > 0 || ['configured', 'needs-config', 'repair'].includes(actionState.state)) {
            return {
                label: '连接',
                value: '待确认',
                tone: 'info',
                detail: '配置已存在，但连接状态仍需要进一步确认。'
            };
        }

        return {
            label: '连接',
            value: '待检测',
            tone: 'muted',
            detail: '当前还没有拿到明确的连接状态。'
        };
    }

    function getChannelStateDescriptors(state, channelName, options = {}) {
        const profile = options.profile || getChannelProfile(channelName, options.channelConfig || state.config?.channels?.[channelName]);
        const channelConfig = ensureObject(options.channelConfig || state.config?.channels?.[channelName]);
        const probe = ensureObject(options.probe || getChannelAccessProbe(state, channelName));
        const actionState = options.actionState || getChannelAccessActionState(state, channelName, {
            profile,
            channelConfig,
            probe
        });
        return [
            describeChannelInstalledState(actionState, probe),
            describeChannelConfiguredState(channelName, channelConfig, actionState),
            describeChannelConnectionState(state, channelName, channelConfig, actionState, probe)
        ];
    }

    function renderChannelStatusGrid(items, options = {}) {
        const list = ensureArray(items).filter(Boolean);
        if (!list.length) return '';
        const extraClass = options.compact ? ' is-compact' : '';
        return `
            <div class="ocp-channel-status-grid${extraClass}">
                ${list.map((item) => `
                    <div class="ocp-channel-status-item tone-${esc(item.tone || 'muted')}">
                        <div class="ocp-channel-status-label">${esc(item.label || '')}</div>
                        <div class="ocp-channel-status-value">${esc(item.value || '')}</div>
                        <div class="ocp-channel-status-detail">${esc(item.detail || '')}</div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    function buildChannelDialogContextBlock(items, options = {}) {
        const list = ensureArray(items).filter(Boolean);
        if (!list.length) return '';
        return `
            <div class="ocp-channel-dialog-block ocp-channel-dialog-context">
                <div class="ocp-card-title">${esc(options.title || '接入状态')}</div>
                ${options.description ? `<div class="ocp-row-meta">${esc(options.description)}</div>` : ''}
                <div class="ocp-channel-dialog-context-grid">
                    ${list.map((item) => `
                        <div class="ocp-channel-dialog-context-item tone-${esc(item.tone || 'muted')}">
                            <div class="ocp-channel-dialog-context-label">${esc(item.label || '')}</div>
                            <div class="ocp-channel-dialog-context-value">${esc(item.value || '')}</div>
                            <div class="ocp-channel-dialog-context-detail">${esc(item.detail || '')}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    function renderChannelStateCards(state, channelName, options = {}) {
        return renderChannelStatusGrid(getChannelStateDescriptors(state, channelName, options));
    }

    function getChannelMonogram(profile, channelName) {
        const label = String(profile?.label || channelName || 'CH').trim();
        const words = label.split(/[\s/-]+/).filter(Boolean);
        if (words.length >= 2) {
            return `${words[0][0] || ''}${words[1][0] || ''}`.slice(0, 2).toUpperCase();
        }
        return label.replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '').slice(0, 2).toUpperCase() || 'CH';
    }

    function renderChannelListRow(channelName, state, options = {}) {
        const profile = options.profile || getChannelProfile(channelName, options.channelConfig || state.config?.channels?.[channelName]);
        const channelConfig = ensureObject(options.channelConfig || state.config?.channels?.[channelName]);
        const probe = ensureObject(options.probe || getChannelAccessProbe(state, channelName));
        const actionState = options.actionState || getChannelAccessActionState(state, channelName, {
            profile,
            channelConfig,
            probe
        });
        const selected = normalizeChannelKey(state.selected) === normalizeChannelKey(channelName);
        const isConfigured = Object.keys(channelConfig).length > 0;
        const boundAgent = getBoundAgent(state.config, channelName);
        const actionLabel = getChannelActionButtonLabel(state, actionState, channelName);
        const statusItems = getChannelStateDescriptors(state, channelName, {
            profile,
            channelConfig,
            probe,
            actionState
        });
        const monogram = getChannelMonogram(profile, channelName);
        const actionSummary = actionState.detail || profile.desc || '点击主按钮继续接入。';
        const helperSummary = isConfigured
            ? `绑定 Agent：${boundAgent || 'main'}`
            : '保存后会直接写入渠道配置并回到当前页。';
        const secondaryActions = isConfigured ? `
            <div class="ocp-channel-platform-utility">
                <button class="ocp-btn sm" data-channel-toggle="${esc(channelName)}">${channelConfig.enabled === false ? '启用' : '停用'}</button>
                <button class="ocp-btn sm danger" data-channel-remove="${esc(channelName)}">移除</button>
            </div>
        ` : '';

        return `
            <article class="ocp-channel-platform-card ocp-clickable ${selected ? 'is-selected' : ''}" data-channel-select="${esc(channelName)}">
                <div class="ocp-channel-platform-card-head">
                    <div class="ocp-channel-platform-icon" aria-hidden="true">${esc(monogram)}</div>
                    <div class="ocp-channel-platform-copy">
                        <div class="ocp-row-title">${esc(profile.label || channelName)}</div>
                        <div class="ocp-row-meta">${esc(profile.desc || channelName)}</div>
                    </div>
                    <span class="ocp-pill ${actionState.tone}">${esc(actionState.badge || '待接入')}</span>
                </div>
                <div class="ocp-channel-platform-intent tone-${esc(actionState.tone || 'info')}">
                    <div class="ocp-channel-platform-intent-eyebrow">主操作</div>
                    <div class="ocp-channel-platform-intent-title">${esc(actionLabel)}</div>
                    <div class="ocp-channel-platform-intent-detail">${esc(actionSummary)}</div>
                </div>
                ${renderChannelStatusGrid(statusItems, { compact: true })}
                <div class="ocp-channel-platform-footer">
                    <div class="ocp-channel-platform-meta">
                        <span class="ocp-channel-platform-meta-item">${esc(helperSummary)}</span>
                        <span class="ocp-channel-platform-meta-item">${esc(actionState.hint || '主按钮保留给下一步动作，其余操作降级展示。')}</span>
                    </div>
                    <div class="ocp-channel-platform-actions">
                        <button class="ocp-btn sm primary" data-channel-main-action="${esc(channelName)}" data-channel-main-kind="${esc(actionState.action)}" ${isInstallingChannelState(state, channelName) ? 'disabled' : ''}>${esc(actionLabel)}</button>
                        ${secondaryActions}
                    </div>
                </div>
            </article>
        `;
    }

    function renderChannelAvailablePick(channelName, state, options = {}) {
        const profile = options.profile || getChannelProfile(channelName);
        const probe = ensureObject(options.probe || getChannelAccessProbe(state, channelName));
        const actionState = options.actionState || getChannelAccessActionState(state, channelName, {
            profile,
            channelConfig: {},
            probe
        });
        const selected = normalizeChannelKey(state.selected) === normalizeChannelKey(channelName);
        const monogram = getChannelMonogram(profile, channelName);
        const actionLabel = getChannelActionButtonLabel(state, actionState, channelName);
        const badges = [];
        if (profile?.pairing) badges.push('支持配对审批');
        if (ensureArray(profile?.actions).length) badges.push('支持预检查');
        if (profile?.desc) badges.push(profile.desc);

        return `
            <article class="ocp-channel-platform-pick ocp-clickable ${selected ? 'is-selected' : ''}" data-channel-select="${esc(channelName)}">
                <div class="ocp-channel-platform-pick-icon" aria-hidden="true">${esc(monogram)}</div>
                <div class="ocp-channel-platform-pick-name">${esc(profile.label || channelName)}</div>
                <div class="ocp-channel-platform-pick-desc">${esc(profile.desc || '选择模板后可直接开始填写接入参数。')}</div>
                <div class="ocp-channel-platform-pick-intent tone-${esc(actionState.tone || 'info')}">
                    <div class="ocp-channel-platform-intent-eyebrow">推荐入口</div>
                    <div class="ocp-channel-platform-intent-title">${esc(actionLabel)}</div>
                    <div class="ocp-channel-platform-intent-detail">${esc(actionState.detail || '选择模板后会直接进入接入流程。')}</div>
                </div>
                <div class="ocp-channel-platform-pick-badges">
                    ${badges.slice(0, 2).map((badge) => `<span class="ocp-pill ${esc(actionState.tone || 'muted')}">${esc(badge)}</span>`).join('')}
                </div>
                <div class="ocp-channel-platform-pick-meta">${esc(actionState.hint || '优先沿着模板流程填写、校验、保存。')}</div>
                <button class="ocp-btn sm primary" data-channel-main-action="${esc(channelName)}" data-channel-main-kind="${esc(actionState.action || 'create')}" ${isInstallingChannelState(state, channelName) ? 'disabled' : ''}>${esc(actionLabel)}</button>
            </article>
        `;
    }

    function renderChannelListSection(title, description, keys, state, emptyText, options = {}) {
        const variant = options.variant === 'available' ? 'available' : 'configured';
        return `
            <div class="ocp-channel-section">
                <div class="ocp-card-title">${esc(title)}</div>
                <div class="ocp-row-meta">${esc(description)}</div>
                <div class="ocp-channel-platform-grid ${variant === 'available' ? 'is-available' : 'is-configured'}">
                    ${keys.length
                        ? keys.map((channelName) => (
                            variant === 'available'
                                ? renderChannelAvailablePick(channelName, state)
                                : renderChannelListRow(channelName, state)
                        )).join('')
                        : `<div class="ocp-empty">${esc(emptyText)}</div>`}
                </div>
            </div>
        `;
    }

    function renderChannelsOverview(state, options = {}) {
        const channelKeys = ensureArray(options.channelKeys);
        const availableListKeys = ensureArray(options.availableListKeys);
        const allKeys = Array.from(new Set([...channelKeys, ...availableListKeys]));
        const selectedChannel = options.selectedChannel || state.selected || '';
        const selectedProfile = options.selectedProfile || getChannelProfile(selectedChannel);
        const selectedActionState = options.selectedActionState || (selectedChannel
            ? getChannelAccessActionState(state, selectedChannel, {
                profile: selectedProfile,
                channelConfig: ensureObject(state.config?.channels?.[selectedChannel]),
                probe: getChannelAccessProbe(state, selectedChannel)
            })
            : null);
        const selectedStateItems = selectedChannel
            ? getChannelStateDescriptors(state, selectedChannel, {
                profile: selectedProfile,
                channelConfig: ensureObject(state.config?.channels?.[selectedChannel]),
                probe: getChannelAccessProbe(state, selectedChannel),
                actionState: selectedActionState
            })
            : [];
        const pendingCount = allKeys.reduce((count, key) => {
            const actionState = getChannelAccessActionState(state, key, {
                profile: getChannelProfile(key),
                channelConfig: ensureObject(state.config?.channels?.[key]),
                probe: getChannelAccessProbe(state, key)
            });
            return ['missing', 'repair', 'needs-config', 'ready'].includes(actionState.state) ? count + 1 : count;
        }, 0);
        const connectedCount = channelKeys.reduce((count, key) => {
            const channelConfig = ensureObject(state.config?.channels?.[key]);
            const probe = getChannelAccessProbe(state, key);
            const actionState = getChannelAccessActionState(state, key, {
                profile: getChannelProfile(key, channelConfig),
                channelConfig,
                probe
            });
            const connection = describeChannelConnectionState(state, key, channelConfig, actionState, probe);
            return /已绑定|已连接/.test(connection.value) ? count + 1 : count;
        }, 0);

        return `
            <section class="ocp-card ocp-channel-overview">
                <div class="ocp-channel-overview-head">
                    <div class="ocp-channel-overview-copy">
                        <div class="ocp-channel-surface-eyebrow">Overview</div>
                        <div class="ocp-card-title">接入总览</div>
                        <div class="ocp-row-meta">先确认当前页最重要的下一步，再进入具体接入工具的编辑、安装或扫码流程。</div>
                    </div>
                    <div class="ocp-channel-overview-actions">
                        <button class="ocp-btn primary" id="channelsAddBtn">新建渠道</button>
                        <button class="ocp-btn" id="channelsReloadBtn">刷新</button>
                    </div>
                </div>
                <div class="ocp-channel-overview-grid">
                    <div class="ocp-stat-card ocp-channel-overview-stat">
                        <span>已写入配置</span>
                        <strong>${esc(String(channelKeys.length))}</strong>
                        <div class="ocp-row-meta">当前已经保存到配置文件的渠道数量。</div>
                    </div>
                    <div class="ocp-stat-card ocp-channel-overview-stat">
                        <span>待处理渠道</span>
                        <strong>${esc(String(pendingCount))}</strong>
                        <div class="ocp-row-meta">包含待安装、待补全、待绑定和环境异常。</div>
                    </div>
                    <div class="ocp-stat-card ocp-channel-overview-stat">
                        <span>已确认连接</span>
                        <strong>${esc(String(connectedCount))}</strong>
                        <div class="ocp-row-meta">已经确认绑定或连接成功的渠道数量。</div>
                    </div>
                    <div class="ocp-stat-card ocp-channel-overview-stat">
                        <span>可新增模板</span>
                        <strong>${esc(String(availableListKeys.length))}</strong>
                        <div class="ocp-row-meta">还没有写入配置、可以直接开始的新渠道模板。</div>
                    </div>
                </div>
                <div class="ocp-channel-overview-focus ${selectedChannel ? '' : 'is-empty'}">
                    ${selectedChannel ? `
                        <div class="ocp-channel-overview-focus-copy">
                            <div class="ocp-channel-platform-intent tone-${esc(selectedActionState?.tone || 'info')}">
                                <div class="ocp-channel-platform-intent-eyebrow">当前选中</div>
                                <div class="ocp-channel-platform-intent-title">${esc(selectedProfile.label || selectedChannel)}</div>
                                <div class="ocp-channel-platform-intent-detail">${esc(selectedActionState?.detail || selectedProfile.desc || '继续处理当前渠道。')}</div>
                            </div>
                            <div class="ocp-channel-overview-next">
                                <div class="ocp-row-meta">推荐下一步</div>
                                <div class="ocp-channel-overview-next-title">${esc(selectedActionState?.button || '继续')}</div>
                                <div class="ocp-row-meta">${esc(selectedActionState?.hint || '主按钮只负责推进下一步，次要操作会留在卡片内部。')}</div>
                            </div>
                        </div>
                        <div class="ocp-channel-overview-focus-status">
                            ${renderChannelStatusGrid(selectedStateItems, { compact: true })}
                        </div>
                    ` : `
                        <div class="ocp-empty">点击任意接入工具卡片后，这里会显示当前渠道的状态摘要和推荐下一步。</div>
                    `}
                </div>
            </section>
        `;
    }

    function buildChannelGuideBlock(profile, options = {}) {
        const guideItems = ensureArray(profile?.guide);
        if (!guideItems.length) return '';
        const openAttr = options.collapsed ? '' : ' open';
        return `
            <details class="ocp-channel-dialog-block ocp-channel-dialog-guide"${openAttr}>
                <summary>接入步骤</summary>
                <ol>
                    ${guideItems.map((item) => `<li>${esc(item)}</li>`).join('')}
                </ol>
                ${profile?.guideFooter ? `<div class="ocp-channel-dialog-footnote">${profile.guideFooter}</div>` : ''}
            </details>
        `;
    }

    function getLatestChannelDialogModal() {
        const dialogs = Array.from(document.querySelectorAll('.ocp-dialog-form'));
        return dialogs[dialogs.length - 1] || null;
    }

    function attachChannelDialogPairing(modal, channelName, profile, options = {}) {
        if (!modal || !profile?.pairing || typeof window.api?.approvePairingRequest !== 'function' || typeof window.api?.listPairingRequests !== 'function') {
            return;
        }
        const pairingChannel = profile.pairingChannel || channelName;
        const pairingCache = ensureObject(options.pairingCache);
        const persistPairingCache = typeof options.onSavePairingCache === 'function'
            ? options.onSavePairingCache
            : () => {};
        const listEl = modal.querySelector('[data-role="channel-dialog-pairing-list"]');
        const resultEl = modal.querySelector('[data-role="channel-dialog-pairing-result"]');
        const codeInput = modal.querySelector('[data-role="channel-dialog-pairing-code"]');
        const refreshBtn = modal.querySelector('[data-role="channel-dialog-pairing-refresh"]');
        const approveBtn = modal.querySelector('[data-role="channel-dialog-pairing-approve"]');
        if (!listEl || !resultEl || !refreshBtn || !approveBtn) return;

        const renderRequests = (requests) => {
            const normalized = normalizePairingRequests(requests);
            if (!normalized.length) {
                listEl.innerHTML = '<div class="ocp-empty">当前没有待审批请求。</div>';
                return;
            }
            listEl.innerHTML = normalized.map((request, index) => {
                const code = request?.code || request?.pairingCode || request?.id || '';
                const sender = request?.sender || request?.from || request?.label || request?.requester || 'unknown';
                return `
                    <div class="ocp-list-row">
                        <div>
                            <div class="ocp-row-title">${esc(String(code || `request-${index}`))}</div>
                            <div class="ocp-row-meta">${esc(typeof sender === 'string' ? sender : JSON.stringify(sender))}</div>
                        </div>
                        <button class="ocp-btn sm" data-role="channel-dialog-approve-code" data-code="${esc(code)}">审批</button>
                    </div>
                `;
            }).join('');
            listEl.querySelectorAll('[data-role="channel-dialog-approve-code"]').forEach((button) => {
                button.onclick = async () => {
                    const code = button.getAttribute('data-code');
                    if (!code) return;
                    approveBtn.disabled = true;
                    refreshBtn.disabled = true;
                    resultEl.textContent = '正在审批...';
                    try {
                        const result = await window.api.approvePairingRequest({
                            channel: pairingChannel,
                            code,
                            notify: !!profile.pairingNotify
                        });
                        if (!result?.ok) throw new Error(result?.error || '审批失败');
                        resultEl.textContent = `已审批 ${code}`;
                        persistPairingCache(channelName, normalized.filter((item) => {
                            const itemCode = item?.code || item?.pairingCode || item?.id || '';
                            return String(itemCode) !== String(code);
                        }));
                        await refreshPairingList();
                    } catch (error) {
                        resultEl.textContent = error?.message || String(error);
                    } finally {
                        approveBtn.disabled = false;
                        refreshBtn.disabled = false;
                    }
                };
            });
        };

        const refreshPairingList = async () => {
            refreshBtn.disabled = true;
            approveBtn.disabled = true;
            listEl.innerHTML = '<div class="ocp-empty">正在刷新待审批请求...</div>';
            try {
                const result = await window.api.listPairingRequests({ channel: pairingChannel });
                const requests = result?.ok ? normalizePairingRequests(result.requests) : [];
                persistPairingCache(channelName, requests);
                renderRequests(requests);
                resultEl.textContent = requests.length ? `已加载 ${requests.length} 条待审批请求` : '当前没有待审批请求。';
            } catch (error) {
                listEl.innerHTML = '<div class="ocp-empty">加载待审批请求失败。</div>';
                resultEl.textContent = error?.message || String(error);
            } finally {
                refreshBtn.disabled = false;
                approveBtn.disabled = false;
            }
        };

        refreshBtn.onclick = refreshPairingList;
        approveBtn.onclick = async () => {
            const code = String(codeInput?.value || '').trim().toUpperCase();
            if (!code) {
                resultEl.textContent = '请输入配对码。';
                return;
            }
            approveBtn.disabled = true;
            refreshBtn.disabled = true;
            resultEl.textContent = '正在审批...';
            try {
                const result = await window.api.approvePairingRequest({
                    channel: pairingChannel,
                    code,
                    notify: !!profile.pairingNotify
                });
                if (!result?.ok) throw new Error(result?.error || '审批失败');
                resultEl.textContent = `已审批 ${code}`;
                if (codeInput) codeInput.value = '';
                await refreshPairingList();
            } catch (error) {
                resultEl.textContent = error?.message || String(error);
            } finally {
                approveBtn.disabled = false;
                refreshBtn.disabled = false;
            }
        };

        const cached = ensureObject(pairingCache[pairingChannel]);
        const cachedRequests = normalizePairingRequests(cached.requests);
        if (cachedRequests.length) {
            renderRequests(cachedRequests);
            resultEl.textContent = `已加载 ${cachedRequests.length} 条待审批请求`;
        } else {
            listEl.innerHTML = '<div class="ocp-empty">点击“刷新”后再加载待审批请求。</div>';
            resultEl.textContent = '待手动刷新';
        }
    }

    function decorateChannelDialogModal(profile, options = {}) {
        const modal = getLatestChannelDialogModal();
        if (!modal) return null;
        const statusEl = modal.querySelector('[data-role="status"]');
        if (!statusEl) return modal;
        modal.classList.add('ocp-channel-dialog-enhanced');
        modal.querySelectorAll('[data-role="channel-dialog-top"],[data-role="channel-dialog-bottom"]').forEach((node) => node.remove());
        const topBlocks = [];
        const bottomBlocks = [];
        if (options.banner) {
            topBlocks.push(`
                <div class="ocp-channel-dialog-block ocp-channel-dialog-banner ${esc(options.banner.tone || 'info')}">
                    ${esc(options.banner.text)}
                </div>
            `);
        }
        if (ensureArray(options.contextItems).length) {
            topBlocks.push(buildChannelDialogContextBlock(options.contextItems, {
                title: options.contextTitle,
                description: options.contextDescription
            }));
        }
        if (options.showGuide !== false) {
            topBlocks.push(buildChannelGuideBlock(profile, { collapsed: options.guideCollapsed }));
        }
        if (options.pairingChannel && profile?.pairing) {
            bottomBlocks.push(`
                <div class="ocp-channel-dialog-block">
                    <div class="ocp-card-title">配对审批</div>
                    <div class="ocp-row-meta">保存后如果渠道支持配对审批，可以直接在弹窗里查看待审批请求或输入配对码。</div>
                    <div class="ocp-channel-dialog-toolbar">
                        <input class="ocp-dialog-input" data-role="channel-dialog-pairing-code" placeholder="输入配对码">
                        <button type="button" class="ocp-dialog-btn" data-role="channel-dialog-pairing-refresh">刷新</button>
                        <button type="button" class="ocp-dialog-btn primary" data-role="channel-dialog-pairing-approve">审批</button>
                    </div>
                    <div class="ocp-channel-dialog-result" data-role="channel-dialog-pairing-result"></div>
                    <div class="ocp-channel-dialog-list" data-role="channel-dialog-pairing-list"></div>
                </div>
            `);
        }
        if (topBlocks.length) {
            const leadEl = modal.querySelector('.ocp-dialog-lead');
            const titleEl = modal.querySelector('.ocp-dialog-title');
            const anchor = leadEl || titleEl;
            anchor?.insertAdjacentHTML('afterend', `<div data-role="channel-dialog-top">${topBlocks.join('')}</div>`);
        }
        if (bottomBlocks.length) {
            statusEl.insertAdjacentHTML('beforebegin', `<div data-role="channel-dialog-bottom">${bottomBlocks.join('')}</div>`);
        }
        if (options.pairingChannel && profile?.pairing) {
            attachChannelDialogPairing(modal, options.pairingChannel, profile, {
                pairingCache: options.pairingCache,
                onSavePairingCache: options.onSavePairingCache
            });
        }
        return modal;
    }

    function renderChannelDetailActionRow(state, channelName, options = {}) {
        const profile = options.profile || getChannelProfile(channelName, options.channelConfig || {});
        const channelConfig = ensureObject(options.channelConfig || state.config?.channels?.[channelName]);
        const actionState = options.actionState || getChannelAccessActionState(state, channelName, {
            profile,
            channelConfig,
            probe: options.probe || getChannelAccessProbe(state, channelName)
        });
        const isWeixinChannel = isWeixinPersonalChannel(channelName);
        const bindingComplete = isWeixinChannel && isWeixinBindingCompleteFromState(state, channelName);
        const configured = Object.keys(channelConfig).length > 0;
        const actionLabel = getChannelActionButtonLabel(state, actionState, channelName);
        const canManage = configured && !isWeixinChannel;
        const toggleLabel = channelConfig.enabled === false ? '启用' : '停用';

        return `
            <div class="ocp-detail-group">
                <div class="ocp-card-title">当前操作</div>
                <div class="ocp-row-meta">${esc(actionState.hint || '主按钮只保留一个，其他动作降级到次按钮。')}</div>
                <div class="ocp-toolbar" style="flex-wrap:wrap;gap:8px">
                    <button class="ocp-btn primary" data-channel-main-action="${esc(channelName)}" data-channel-main-kind="${esc(actionState.action || (configured ? 'edit' : 'create'))}" ${isInstallingChannelState(state, channelName) ? 'disabled' : ''}>${esc(actionLabel)}</button>
                    ${isWeixinChannel
                        ? (bindingComplete ? '<button class="ocp-btn" id="channelStatusBtn">状态</button>' : '')
                        : `
                        <button class="ocp-btn" id="channelStatusBtn">状态</button>
                        ${configured ? '<button class="ocp-btn" id="channelLoginBtn">登录</button>' : ''}
                    `}
                </div>
                ${canManage ? `
                    <div class="ocp-toolbar" style="margin-top:10px;flex-wrap:wrap;gap:8px">
                        <button class="ocp-btn" data-channel-toggle="${esc(channelName)}">${esc(toggleLabel)}</button>
                        <button class="ocp-btn danger" data-channel-remove="${esc(channelName)}">删除</button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    function renderChannelConfigSummary(channelName, options = {}) {
        const profile = options.profile || getChannelProfile(channelName);
        const channelConfig = ensureObject(options.channelConfig || {});
        const boundAgent = String(options.boundAgent || 'main').trim() || 'main';
        const fields = ensureArray(profile.fields);
        const fieldSummary = fields.length
            ? fields.map((field) => `${field.label}=${getFieldValue(channelConfig, field) || '未填写'}`).join(' · ')
            : '当前平台没有专属字段。';
        return `
            <div class="ocp-detail-group">
                <div class="ocp-card-title">配置摘要</div>
                <div class="ocp-row-meta">绑定 Agent：${esc(boundAgent)}</div>
                <div class="ocp-row-meta">平台字段：${esc(fieldSummary)}</div>
                <div class="ocp-row-meta">${esc(profile.desc || '平台配置与绑定信息')}</div>
            </div>
        `;
    }

    async function chooseChannelInstallSource(channelName) {
        const defaultOptions = [
            { value: 'npmmirror', label: 'npmmirror（推荐）', registry: 'https://registry.npmmirror.com', hint: '国内访问通常更稳定。' },
            { value: 'taobao', label: '淘宝源', registry: 'https://registry.npmmirror.com', hint: '淘宝源现已并入 npmmirror，会使用同一镜像地址。' },
            { value: 'npm', label: 'npm 官方', registry: 'https://registry.npmjs.org', hint: '官方源，网络受限时可能较慢。' },
            { value: 'huawei', label: '华为云', registry: 'https://repo.huaweicloud.com/repository/npm/', hint: '华为云 npm 镜像。' }
        ];
        const response = typeof window.api?.getChannelInstallSources === 'function'
            ? await window.api.getChannelInstallSources({ channel: channelName })
            : null;
        const options = ensureArray(response?.options).length ? ensureArray(response.options) : defaultOptions;
        const defaultValue = String(
            response?.defaultValue
            || options.find((item) => item?.recommended)?.value
            || options[0]?.value
            || 'npmmirror'
        );

        if (typeof window.showFormDialog !== 'function') {
            const selected = options.find((item) => item?.value === defaultValue) || options[0] || null;
            return selected ? {
                value: String(selected.value || ''),
                label: String(selected.label || ''),
                registry: String(selected.registry || '')
            } : null;
        }

        return await new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            window.showFormDialog({
                title: `选择 ${getChannelProfile(channelName).label || channelName} 安装源`,
                confirmText: '继续安装',
                cancelText: '取消',
                fields: [
                    {
                        name: 'installSource',
                        label: '安装源',
                        type: 'select',
                        value: defaultValue,
                        options: options.map((item) => ({
                            value: String(item.value || ''),
                            label: `${String(item.label || item.value || '')} · ${String(item.registry || '')}`
                        })),
                        hint: '安装前可切换镜像源；推荐优先使用 npmmirror。'
                    }
                ],
                onConfirm: async (values, dialog) => {
                    const selected = options.find((item) => String(item?.value || '') === String(values.installSource || '')) || options[0] || null;
                    if (!selected) {
                        dialog.setStatus('没有可用的安装源');
                        return;
                    }
                    finish({
                        value: String(selected.value || ''),
                        label: String(selected.label || ''),
                        registry: String(selected.registry || '')
                    });
                    dialog.close();
                },
                onClose: () => finish(null)
            });
        });
    }

    function renderPrimaryChannelCards(state, channelKeys) {
        const selectedSet = new Set(ensureArray(channelKeys));
        return PRIMARY_CHANNEL_ORDER.map(channelName => {
            const profile = getChannelProfile(channelName);
            const storedKey = resolveChannelStorageKey(channelName, state.config);
            const channelConfig = ensureObject(state.config?.channels?.[storedKey]);
            const isConfigured = selectedSet.has(channelName) || selectedSet.has(storedKey);
            const isSelected = normalizeChannelKey(state.selected) === normalizeChannelKey(storedKey);
            const agentId = getBoundAgent(state.config, storedKey);
            const actionState = getChannelAccessActionState(state, storedKey, {
                profile,
                channelConfig,
                probe: state.channelAccess?.[storedKey] || state.channelAccess?.[channelName]
            });
            const installing = isInstallingChannelState(state, storedKey);
            const fieldSummary = ensureArray(profile.fields)
                .slice(0, 3)
                .map(field => {
                    const value = String(getFieldValue(channelConfig, field) || '').trim();
                    if (!value) return `${field.label}：未填`;
                    if (field.kind === 'list') return `${field.label}：已填`;
                    if (field.type === 'select') return `${field.label}：${value}`;
                    return `${field.label}：已填`;
                })
                .join(' · ');

            return `
                <div class="ocp-card ocp-clickable ${isSelected ? 'is-selected' : ''}" data-channel-select="${esc(storedKey)}" style="padding:16px;display:flex;flex-direction:column;gap:10px;min-height:100%;">
                    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
                        <div style="min-width:0">
                            <div class="ocp-card-title" style="margin-bottom:4px">${esc(profile.label || channelName)} 配置</div>
                            <div class="ocp-row-meta">${esc(profile.desc || channelName)}</div>
                        </div>
                        <span class="ocp-pill ${actionState.tone}">${esc(actionState.badge)}</span>
                    </div>
                    <div class="ocp-row-meta">${esc(actionState.detail)}</div>
                    <div class="ocp-row-meta">${fieldSummary || '点击卡片后，右侧会切换到对应平台说明。'}</div>
                    <div class="ocp-row-meta">绑定 Agent：${esc(agentId || 'main')}</div>
                    <div class="ocp-toolbar" style="margin-top:auto">
                        <button class="ocp-btn ${['edit', 'install'].includes(actionState.action) ? 'primary' : ''}" data-channel-main-action="${esc(storedKey)}" data-channel-main-kind="${esc(actionState.action)}" ${installing ? 'disabled' : ''}>${esc(getChannelActionButtonLabel(state, actionState, storedKey))}</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderChannelConfiguredCards(state, channelKeys) {
        return channelKeys.length ? channelKeys.map(channelName => {
            const profile = getChannelProfile(channelName);
            const channelConfig = ensureObject(state.config.channels[channelName]);
            const isEnabled = channelConfig.enabled !== false;
            const cardAgent = getBoundAgent(state.config, channelName);
            const isWeixinChannel = isWeixinPersonalChannel(channelName);
            return `
                <div class="ocp-list-row ocp-clickable ${normalizeChannelKey(state.selected) === normalizeChannelKey(channelName) ? 'is-selected' : ''}" data-channel-select="${esc(channelName)}">
                    <div style="min-width:0;flex:1 1 auto">
                        <div class="ocp-row-title">${esc(profile.label || channelName)}</div>
                        <div class="ocp-row-meta">${esc(profile.desc || channelName)}</div>
                        <div class="ocp-row-meta">绑定 Agent：${esc(cardAgent)}</div>
                    </div>
                    <div class="ocp-toolbar" style="justify-content:flex-end;flex:0 0 auto">
                        <span class="ocp-pill ${isEnabled ? 'success' : 'muted'}">${isEnabled ? '已启用' : '已停用'}</span>
                        <button class="ocp-btn sm" data-channel-edit="${esc(channelName)}">编辑</button>
                        ${isWeixinChannel ? '' : `
                            <button class="ocp-btn sm" data-channel-toggle="${esc(channelName)}">${isEnabled ? '停用' : '启用'}</button>
                            <button class="ocp-btn sm danger" data-channel-remove="${esc(channelName)}">删除</button>
                        `}
                    </div>
                </div>
            `;
        }).join('') : '<div class="ocp-empty">还没有已接入平台。先从右侧或下方卡片完成接入。</div>';
    }

    function renderChannelAvailableCards(state, profileKeys) {
        return profileKeys.map(channelName => {
            const profile = getChannelProfile(channelName);
            const storedKey = resolveChannelStorageKey(channelName, state.config);
            const channelConfig = ensureObject(state.config?.channels?.[storedKey]);
            const configured = Object.keys(channelConfig).length > 0;
            const isSelected = normalizeChannelKey(state.selected) === normalizeChannelKey(storedKey);
            const cardAgent = configured ? getBoundAgent(state.config, storedKey) : '';
            const actionState = getChannelAccessActionState(state, storedKey, {
                profile,
                channelConfig,
                probe: state.channelAccess?.[storedKey] || state.channelAccess?.[channelName]
            });
            const installing = isInstallingChannelState(state, storedKey);
            return `
                <div class="ocp-card ocp-clickable ${isSelected ? 'is-selected' : ''}" data-channel-select="${esc(storedKey)}" style="padding:16px;display:flex;flex-direction:column;gap:12px;min-height:100%;">
                    <div class="ocp-card-title" style="margin-bottom:0">${esc(profile.label || channelName)}</div>
                    <div class="ocp-row-meta">${esc(profile.desc || '')}</div>
                    <div class="ocp-row-meta">${esc(actionState.detail)}</div>
                    <div class="ocp-row-meta">${configured ? `绑定 Agent：${esc(cardAgent || 'main')}` : '点击主按钮可直接打开接入弹窗。'}</div>
                    <div class="ocp-toolbar" style="margin-top:auto;justify-content:flex-start">
                        <span class="ocp-pill ${actionState.tone}">${esc(actionState.badge)}</span>
                        <button class="ocp-btn ${['edit', 'install'].includes(actionState.action) ? 'primary' : ''}" data-channel-main-action="${esc(storedKey)}" data-channel-main-kind="${esc(actionState.action)}" ${installing ? 'disabled' : ''}>${esc(getChannelActionButtonLabel(state, actionState, storedKey))}</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderChannelFieldControls(profile, selectedConfig) {
        return profile.fields.length ? profile.fields.map(field => {
            const fieldId = `channelField_${field.key}`;
            const value = getFieldValue(selectedConfig, field);
            if (field.type === 'select') {
                return `
                    <label class="ocp-field">
                        <span>${esc(field.label)}</span>
                        <select id="${fieldId}" data-channel-field="${esc(field.key)}">
                            ${(field.options || []).map(option => {
                                const optionValue = Array.isArray(option) ? option[0] : option?.value;
                                const optionLabel = Array.isArray(option) ? option[1] : option?.label;
                                return `<option value="${esc(optionValue)}" ${String(value) === String(optionValue) ? 'selected' : ''}>${esc(optionLabel)}</option>`;
                            }).join('')}
                        </select>
                        ${field.placeholder ? `<div class="ocp-row-meta">${esc(field.placeholder)}</div>` : ''}
                    </label>
                `;
            }
            return `
                <label class="ocp-field">
                    <span>${esc(field.label)}</span>
                    <input id="${fieldId}" data-channel-field="${esc(field.key)}" type="${field.secret ? 'password' : 'text'}" value="${esc(value)}" placeholder="${esc(field.placeholder || '')}">
                    ${field.required ? '<div class="ocp-row-meta">必填项</div>' : ''}
                </label>
            `;
        }).join('') : '<div class="ocp-empty">当前平台没有专属字段，直接补全基础信息后即可保存。</div>';
    }

    async function renderChannelsPage(container) {
        container.innerHTML = `<div class="ocp-shell">${renderHeader('通信接入', '优先对齐 QQ 机器人、飞书机器人、钉钉机器人接入，绑定 Agent 并处理配对审批。')}<div class="ocp-card">加载中...</div></div>`;
        const state = {
            config: {},
            agents: ['main'],
            selected: '',
            pairing: [],
            pairingChannel: '',
            pairingLoading: false,
            pairingCache: loadChannelPairingCache(),
            pairingRequestId: 0,
            status: '',
            channelAccess: {},
            channelAccessLoading: false,
            channelAccessRefreshToken: 0,
            channelAgentsTimer: null,
            channelAccessTimer: null,
            channelAccessBackgroundTimer: null,
            channelPairingTimer: null,
            channelDialogResumeTimer: null,
            installingChannel: '',
            installingRequestId: '',
            installLogs: {},
            weixinLoginFlow: '',
            weixinLoginPhase: 'idle',
            weixinLoginSummary: '自动安装流与手动回退流都支持在此页完成扫码。',
            weixinLoginDetail: '推荐优先先安装/升级插件，再在当前弹窗里完成扫码登录。',
            weixinLoginTone: 'muted',
            weixinLoginLink: '',
            weixinLoginAsciiQr: '',
            weixinLoginImageQrDataUrl: '',
            weixinLoginImageQrSource: '',
            weixinLoginImageQrLoading: false,
            weixinLoginImageQrError: '',
            weixinLoginImageQrRequestSeq: 0,
            weixinLoginRawLog: '',
            weixinStatusCheckRawLog: '',
            weixinLoginSessionId: '',
            weixinStatusCheckSessionId: '',
            weixinRestartSessionId: '',
            weixinLoginStartedAt: 0,
            weixinLoginExpired: false,
            weixinLoginFinished: false,
            weixinLoginAutoCheckScheduled: false,
            weixinLoginTimeoutTimer: null,
            weixinLoginStatusCheckTimer: null,
            weixinLoginObserverDispose: null,
            weixinRuntimePulseTimer: null,
            weixinRuntimePulseKind: '',
            weixinRuntimeHeartbeatBucket: '',
            weixinSilentFollowupTriggered: false,
            weixinPluginStatus: null,
            weixinPluginStatusLoading: false,
            channelInstallLogRevealKey: '',
            weixinLogRevealKey: ''
        };
        try {
            state.config = await readConfig();
        } catch (error) {
            container.innerHTML = `<div class="ocp-shell"><div class="ocp-card ocp-danger">${esc(error.message || error)}</div></div>`;
            return;
        }
        if (!document.body.contains(container) || container.style.display === 'none') {
            return;
        }

        const presets = getChannelPresets();
        const presetKeys = () => sortChannelKeys(Object.keys(presets));
        const getChannelKeys = () => sortChannelKeys(Object.keys(ensureObject(state.config.channels)));
        const getAvailableKeys = () => sortChannelKeys(Object.keys(CHANNEL_REGISTRY));
        state.selected = getChannelKeys()[0] || getAvailableKeys()[0] || 'qqbot';

        function getPreferredDashboardRestartMode() {
            try {
                return window.localStorage?.getItem('openclaw.dashboard.startMode') === 'npm'
                    ? 'npm'
                    : 'official';
            } catch (_) {
                return 'official';
            }
        }

        function createChannelInstallRequestId(channelName) {
            return `${normalizeChannelKey(channelName) || 'channel'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }

        function getChannelInstallLogState(channelName, requestId = '') {
            const key = normalizeChannelKey(channelName);
            if (!key) return {};
            const nextRequestId = String(requestId || '').trim();
            const current = ensureObject(state.installLogs[key]);
            if (!current.requestId || (nextRequestId && current.requestId !== nextRequestId)) {
                state.installLogs[key] = {
                    channel: key,
                    requestId: nextRequestId || current.requestId || '',
                    text: '',
                    sourceLabel: current.sourceLabel || '',
                    phase: 'idle',
                    done: false,
                    updatedAt: 0
                };
            }
            return state.installLogs[key];
        }

        function trimChannelInstallLogText(text) {
            const value = String(text || '');
            const maxChars = 24000;
            if (value.length <= maxChars) return value;
            return `...\n${value.slice(-maxChars)}`;
        }

        function buildChannelInstallLogMeta(channelName) {
            const entry = ensureObject(state.installLogs[normalizeChannelKey(channelName)]);
            if (!entry.requestId) {
                return '点击“安装并配置”后，这里会实时显示安装输出。';
            }
            const parts = [];
            if (entry.sourceLabel) parts.push(`安装源：${entry.sourceLabel}`);
            parts.push(entry.done ? '安装日志已结束' : '安装日志实时更新中');
            if (entry.updatedAt) {
                const absolute = formatDateTime(entry.updatedAt);
                const relative = formatRelative(entry.updatedAt);
                parts.push(relative ? `${absolute} · ${relative}` : absolute);
            }
            return parts.join(' · ');
        }

        function hasChannelInstallLog(channelName = state.selected) {
            const entry = ensureObject(state.installLogs[normalizeChannelKey(channelName)]);
            return Boolean(String(entry.requestId || '').trim() || String(entry.text || '').trim());
        }

        function scrollChannelLogElement(logEl, options = {}) {
            if (!logEl) return;
            logEl.scrollTop = logEl.scrollHeight;
            if (options.reveal === true) {
                const target = logEl.closest('.ocp-card') || logEl;
                try {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } catch (_) {
                    target.scrollIntoView();
                }
            }
        }

        function isChannelsViewActive() {
            return document.body.contains(container) && container.style.display !== 'none';
        }

        function isWeixinBindingComplete(channelName = state.selected) {
            return isWeixinBindingCompleteFromState(state, channelName);
        }

        function shouldShowWeixinLoginConsole() {
            if (!isWeixinPersonalChannel(state.selected)) return false;
            const hasQr = Boolean(state.weixinLoginAsciiQr);
            const hasLink = Boolean(state.weixinLoginLink);
            const hasLog = Boolean(String(getCombinedWeixinRuntimeLog() || '').trim());
            return state.weixinLoginPhase !== 'success' && (state.weixinLoginPhase !== 'idle' || hasQr || hasLink || hasLog);
        }

        function cleanupChannelsRefreshTimers() {
            if (state.channelAgentsTimer) {
                clearTimeout(state.channelAgentsTimer);
                state.channelAgentsTimer = null;
            }
            if (state.channelAccessTimer) {
                clearTimeout(state.channelAccessTimer);
                state.channelAccessTimer = null;
            }
            if (state.channelAccessBackgroundTimer) {
                clearTimeout(state.channelAccessBackgroundTimer);
                state.channelAccessBackgroundTimer = null;
            }
            if (state.channelPairingTimer) {
                clearTimeout(state.channelPairingTimer);
                state.channelPairingTimer = null;
            }
            if (state.channelDialogResumeTimer) {
                clearTimeout(state.channelDialogResumeTimer);
                state.channelDialogResumeTimer = null;
            }
            state.channelAccessRefreshToken += 1;
            state.pairingRequestId += 1;
        }

        function suspendChannelsRefreshForDialog() {
            cleanupChannelsRefreshTimers();
            state.channelAccessLoading = false;
        }

        function resumeChannelsRefreshAfterDialog(options = {}) {
            if (state.channelDialogResumeTimer) {
                clearTimeout(state.channelDialogResumeTimer);
                state.channelDialogResumeTimer = null;
            }
            state.channelDialogResumeTimer = window.setTimeout(() => {
                state.channelDialogResumeTimer = null;
                if (!isChannelsViewActive() || document.querySelector('.ocp-dialog-form')) return;
                scheduleDeferredChannelsRefresh({
                    refreshAgents: false,
                    selectedOnly: true,
                    backgroundFullRefresh: true,
                    ...options
                });
            }, 180);
        }

        function deferChannelDialogWork(callback) {
            if (typeof callback !== 'function') return;
            window.requestAnimationFrame(() => {
                window.setTimeout(() => {
                    if (!document.querySelector('.ocp-dialog-form')) return;
                    callback();
                }, 0);
            });
        }

        function cleanupChannelsPageLifecycle() {
            cleanupChannelsRefreshTimers();
            if (state.weixinLoginTimeoutTimer) {
                clearTimeout(state.weixinLoginTimeoutTimer);
                state.weixinLoginTimeoutTimer = null;
            }
            if (state.weixinLoginStatusCheckTimer) {
                clearTimeout(state.weixinLoginStatusCheckTimer);
                state.weixinLoginStatusCheckTimer = null;
            }
            if (state.weixinRuntimePulseTimer) {
                clearTimeout(state.weixinRuntimePulseTimer);
                state.weixinRuntimePulseTimer = null;
            }
            if (typeof state.weixinLoginObserverDispose === 'function') {
                state.weixinLoginObserverDispose();
                state.weixinLoginObserverDispose = null;
            }
        }

        container.__openclawCleanupChannelsPage = cleanupChannelsPageLifecycle;

        function updateChannelInstallLogPanel(channelName = state.selected, options = {}) {
            const key = normalizeChannelKey(channelName);
            if (!key || normalizeChannelKey(state.selected) !== key) return;
            const logEl = container.querySelector('#channelInstallLog');
            const metaEl = container.querySelector('#channelInstallLogMeta');
            if (!logEl || !metaEl) return;
            const entry = ensureObject(state.installLogs[key]);
            metaEl.textContent = buildChannelInstallLogMeta(key);
            logEl.textContent = String(entry.text || '').trim() || '等待安装日志...';
            scrollChannelLogElement(logEl, options);
        }

        if (typeof window.api?.onChannelInstallStream === 'function') {
            window.api.onChannelInstallStream((payload) => {
                const channelName = normalizeChannelKey(payload?.channel || '');
                const requestId = String(payload?.requestId || '').trim();
                if (!channelName || !requestId) return;
                const entry = getChannelInstallLogState(channelName, requestId);
                entry.updatedAt = Date.now();
                entry.phase = String(payload?.phase || entry.phase || 'stream');
                entry.done = payload?.done === true || entry.done === true;
                if (payload?.sourceLabel) {
                    entry.sourceLabel = String(payload.sourceLabel || '').trim();
                }
                const text = String(payload?.text || '');
                if (text) {
                    entry.text = trimChannelInstallLogText(`${entry.text || ''}${text}`);
                }
                const revealKey = `${channelName}:${requestId}`;
                const shouldReveal = state.channelInstallLogRevealKey !== revealKey;
                if (shouldReveal) {
                    state.channelInstallLogRevealKey = revealKey;
                }
                if (isWeixinPersonalChannel(channelName)) {
                    updateWeixinLoginView({
                        weixinLoginPhase: 'installing',
                        weixinLoginSummary: '正在安装 / 升级个人微信插件',
                        weixinLoginDetail: entry.done === true
                            ? '安装日志已结束，正在刷新插件状态。'
                            : '正在执行个人微信插件直装升级命令；完成后会自动刷新插件状态。',
                        weixinLoginRawLog: String(entry.text || ''),
                        weixinLoginLink: '',
                        weixinLoginAsciiQr: ''
                    });
                    refreshWeixinDialogRuntimeUI();
                }
                updateChannelInstallLogPanel(channelName, { reveal: shouldReveal });
            });
        }

        function resetWeixinLoginState(options = {}) {
            if (state.weixinLoginTimeoutTimer) {
                clearTimeout(state.weixinLoginTimeoutTimer);
                state.weixinLoginTimeoutTimer = null;
            }
            if (state.weixinLoginStatusCheckTimer) {
                clearTimeout(state.weixinLoginStatusCheckTimer);
                state.weixinLoginStatusCheckTimer = null;
            }
            if (state.weixinRuntimePulseTimer) {
                clearTimeout(state.weixinRuntimePulseTimer);
                state.weixinRuntimePulseTimer = null;
            }
            state.weixinLoginFlow = String(options.flow || '').trim();
            state.weixinLoginPhase = options.phase || 'idle';
            state.weixinLoginSummary = options.summary || '自动安装流与手动回退流都支持在此页完成扫码。';
            state.weixinLoginDetail = options.detail || '推荐优先先安装/升级插件，再在当前弹窗里完成扫码登录。';
            state.weixinLoginTone = options.tone || getWeixinLoginTone(state.weixinLoginPhase);
            state.weixinLoginLink = options.keepArtifacts ? state.weixinLoginLink : '';
            state.weixinLoginAsciiQr = options.keepArtifacts ? state.weixinLoginAsciiQr : '';
            state.weixinLoginImageQrDataUrl = options.keepArtifacts ? state.weixinLoginImageQrDataUrl : '';
            state.weixinLoginImageQrSource = options.keepArtifacts ? state.weixinLoginImageQrSource : '';
            state.weixinLoginImageQrLoading = false;
            state.weixinLoginImageQrError = '';
            state.weixinLoginRawLog = options.keepArtifacts ? state.weixinLoginRawLog : String(options.rawLog || '');
            state.weixinStatusCheckRawLog = '';
            state.weixinLoginSessionId = options.sessionId || '';
            state.weixinStatusCheckSessionId = '';
            state.weixinRestartSessionId = '';
            state.weixinLoginStartedAt = options.startedAt || 0;
            state.weixinLoginExpired = false;
            state.weixinLoginFinished = false;
            state.weixinLoginAutoCheckScheduled = false;
            state.weixinRuntimePulseKind = '';
            state.weixinRuntimeHeartbeatBucket = '';
            state.weixinSilentFollowupTriggered = false;
            state.weixinBindingSuccessDialogShown = false;
        }

        function updateWeixinLoginView(patch = {}) {
            Object.assign(state, patch);
            state.weixinLoginTone = patch.weixinLoginTone || getWeixinLoginTone(state.weixinLoginPhase);
            if (isChannelsViewActive() && isWeixinPersonalChannel(state.selected)) {
                render();
                const logEl = container.querySelector('#channelWeixinConsoleLog') || container.querySelector('#channelWeixinLogContent');
                if (logEl) {
                    scrollChannelLogElement(logEl, { reveal: patch.revealLog === true });
                }
            }
            refreshWeixinDialogRuntimeUI();
        }

        async function ensureWeixinLinkImageQr(link = '') {
            const normalizedLink = String(link || '').trim();
            if (!normalizedLink) {
                if (state.weixinLoginImageQrDataUrl || state.weixinLoginImageQrSource || state.weixinLoginImageQrLoading || state.weixinLoginImageQrError) {
                    state.weixinLoginImageQrDataUrl = '';
                    state.weixinLoginImageQrSource = '';
                    state.weixinLoginImageQrLoading = false;
                    state.weixinLoginImageQrError = '';
                    refreshWeixinDialogRuntimeUI();
                }
                return;
            }
            if (state.weixinLoginImageQrSource === normalizedLink) {
                if (state.weixinLoginImageQrDataUrl || state.weixinLoginImageQrLoading) {
                    return;
                }
            }
            if (typeof window.api?.generateQrCodeDataUrl !== 'function') {
                state.weixinLoginImageQrDataUrl = '';
                state.weixinLoginImageQrSource = normalizedLink;
                state.weixinLoginImageQrLoading = false;
                state.weixinLoginImageQrError = '当前环境不支持本地图片二维码生成。';
                refreshWeixinDialogRuntimeUI();
                return;
            }

            const requestSeq = Number(state.weixinLoginImageQrRequestSeq || 0) + 1;
            state.weixinLoginImageQrRequestSeq = requestSeq;
            state.weixinLoginImageQrSource = normalizedLink;
            state.weixinLoginImageQrDataUrl = '';
            state.weixinLoginImageQrLoading = true;
            state.weixinLoginImageQrError = '';
            refreshWeixinDialogRuntimeUI();

            try {
                const result = await window.api.generateQrCodeDataUrl({
                    text: normalizedLink,
                    width: 320,
                    margin: 2,
                    darkColor: '#101418',
                    lightColor: '#ffffffff'
                });
                if (state.weixinLoginImageQrRequestSeq !== requestSeq || state.weixinLoginImageQrSource !== normalizedLink) {
                    return;
                }
                if (result?.ok && result.dataUrl) {
                    state.weixinLoginImageQrDataUrl = String(result.dataUrl || '');
                    state.weixinLoginImageQrLoading = false;
                    state.weixinLoginImageQrError = '';
                } else {
                    state.weixinLoginImageQrDataUrl = '';
                    state.weixinLoginImageQrLoading = false;
                    state.weixinLoginImageQrError = String(result?.error || '图片二维码生成失败');
                }
            } catch (error) {
                if (state.weixinLoginImageQrRequestSeq !== requestSeq || state.weixinLoginImageQrSource !== normalizedLink) {
                    return;
                }
                state.weixinLoginImageQrDataUrl = '';
                state.weixinLoginImageQrLoading = false;
                state.weixinLoginImageQrError = error?.message || String(error);
            }
            refreshWeixinDialogRuntimeUI();
        }

        function buildWeixinQrVisualHtml(options = {}) {
            const link = String(options.link || '').trim();
            const asciiQr = String(options.asciiQr || '').trim();
            const placeholder = String(options.placeholder || '').trim() || '等待二维码输出...';
            const imageReady = Boolean(link && state.weixinLoginImageQrSource === link && state.weixinLoginImageQrDataUrl);
            const imageLoading = Boolean(link && state.weixinLoginImageQrSource === link && state.weixinLoginImageQrLoading);
            const imageError = link && state.weixinLoginImageQrSource === link
                ? String(state.weixinLoginImageQrError || '').trim()
                : '';

            const imageShell = imageReady
                ? `
                    <div class="ocp-channel-image-qr-card">
                        <img class="ocp-channel-image-qr" src="${esc(state.weixinLoginImageQrDataUrl)}" alt="个人微信扫码二维码">
                    </div>
                `
                : imageLoading
                    ? `<div class="ocp-channel-image-qr-placeholder">正在生成图片二维码...</div>`
                    : imageError
                        ? `<div class="ocp-channel-image-qr-placeholder">${esc(imageError)}</div>`
                        : `<div class="ocp-empty">${esc(placeholder)}</div>`;

            return `
                <div class="ocp-channel-qr-visual">
                    <div class="ocp-channel-qr-primary">
                        ${imageShell}
                    </div>
                    ${asciiQr ? `
                        <details class="ocp-channel-qr-fallback">
                            <summary>查看终端文本二维码</summary>
                            <pre class="ocp-channel-login-qr">${esc(asciiQr)}</pre>
                        </details>
                    ` : ''}
                </div>
            `;
        }

        function buildWeixinRuntimeLog(baseText, note) {
            const current = String(baseText || '').trim();
            const extra = String(note || '').trim();
            if (!extra) return current;
            return current ? `${current}\n${extra}` : extra;
        }

        function mergeWeixinRuntimeLog(baseText, nextText) {
            const current = String(baseText || '').trim();
            const next = String(nextText || '').trim();
            if (!next) return current;
            if (!current) return next;
            if (current === next || current.endsWith(next) || current.includes(`\n${next}`)) {
                return current;
            }
            if (next.endsWith(current) || next.includes(`\n${current}`)) {
                return next;
            }
            return `${current}\n${next}`;
        }

        function getCombinedWeixinRuntimeLog(snapshotText = '') {
            const loginLog = String(state.weixinLoginRawLog || '').trim();
            const statusLog = String(state.weixinStatusCheckRawLog || '').trim();
            const fallback = String(snapshotText || '').trim();
            let combined = '';
            if (loginLog) {
                combined = mergeWeixinRuntimeLog(combined, loginLog);
            }
            if (statusLog && statusLog !== loginLog) {
                combined = mergeWeixinRuntimeLog(combined, statusLog);
            }
            if (fallback) {
                combined = mergeWeixinRuntimeLog(combined, fallback);
            }
            return combined;
        }

        function clearWeixinRuntimePulse() {
            if (state.weixinRuntimePulseTimer) {
                clearTimeout(state.weixinRuntimePulseTimer);
                state.weixinRuntimePulseTimer = null;
            }
            state.weixinRuntimePulseKind = '';
            state.weixinRuntimeHeartbeatBucket = '';
        }

        function formatWeixinRuntimeElapsed(ms) {
            const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            if (minutes > 0) {
                return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
            }
            return `${Math.max(1, seconds)}秒`;
        }

        function getActiveWeixinRuntimeSnapshot() {
            const preferChecking = state.weixinLoginPhase === 'checking'
                || Boolean(state.weixinStatusCheckSessionId)
                || Boolean(state.weixinRestartSessionId);
            const ids = (
                preferChecking
                    ? [state.weixinStatusCheckSessionId, state.weixinRestartSessionId, state.weixinLoginSessionId]
                    : [state.weixinLoginSessionId, state.weixinRestartSessionId, state.weixinStatusCheckSessionId]
            ).map((value) => String(value || '').trim()).filter(Boolean);
            for (const id of ids) {
                const snapshot = window.__openclawGetCommandSessionSnapshot?.(id);
                if (snapshot?.status === 'running') {
                    return snapshot;
                }
            }
            for (const id of ids) {
                const snapshot = window.__openclawGetCommandSessionSnapshot?.(id);
                if (snapshot) {
                    return snapshot;
                }
            }
            return null;
        }

        function isWeixinRuntimeLocallyActive(kind = 'login') {
            if (kind === 'checking') {
                return Boolean(state.weixinStatusCheckSessionId)
                    && state.weixinLoginPhase === 'checking'
                    && !['success', 'failure', 'expired', 'idle'].includes(state.weixinLoginPhase);
            }
            return Boolean(state.weixinLoginSessionId)
                && !state.weixinLoginFinished
                && !state.weixinLoginExpired
                && !['success', 'failure', 'expired'].includes(state.weixinLoginPhase)
                && ['installing', 'waiting-scan', 'scanned', 'checking'].includes(state.weixinLoginPhase);
        }

        function scheduleWeixinRuntimePulse(kind = 'login') {
            clearWeixinRuntimePulse();
            state.weixinRuntimePulseKind = kind;
            const tick = () => {
                if (!isChannelsViewActive() || !isWeixinPersonalChannel(state.selected)) {
                    clearWeixinRuntimePulse();
                    return;
                }
                const sessionId = kind === 'checking'
                    ? state.weixinStatusCheckSessionId
                    : state.weixinLoginSessionId;
                const snapshot = sessionId
                    ? window.__openclawGetCommandSessionSnapshot?.(sessionId)
                    : null;
                const snapshotRunning = snapshot?.status === 'running';
                const runtimeActive = snapshotRunning || isWeixinRuntimeLocallyActive(kind);
                if (!runtimeActive) {
                    clearWeixinRuntimePulse();
                    return;
                }
                const currentRawLog = kind === 'checking'
                    ? String(state.weixinStatusCheckRawLog || '')
                    : String(state.weixinLoginRawLog || '');
                const syncedRawLog = mergeWeixinRuntimeLog(currentRawLog, snapshot?.logText || '');
                const syncPatch = kind === 'checking'
                    ? { weixinStatusCheckRawLog: syncedRawLog }
                    : { weixinLoginRawLog: syncedRawLog };
                if (kind === 'login') {
                    const parsedSignal = parseWeixinLoginSignal(snapshot?.logText || syncedRawLog);
                    if (parsedSignal.link && !state.weixinLoginLink) {
                        syncPatch.weixinLoginLink = parsedSignal.link;
                    }
                    if (parsedSignal.asciiQr && !state.weixinLoginAsciiQr) {
                        syncPatch.weixinLoginAsciiQr = parsedSignal.asciiQr;
                    }
                }
                if (
                    syncedRawLog !== currentRawLog
                    || syncPatch.weixinLoginLink
                    || syncPatch.weixinLoginAsciiQr
                ) {
                    updateWeixinLoginView(syncPatch);
                }
                const elapsed = Date.now() - Number(snapshot?.startedAt || state.weixinLoginStartedAt || Date.now());
                const heartbeatBucket = `${kind}:${Math.floor(elapsed / 4000)}`;
                if (heartbeatBucket !== state.weixinRuntimeHeartbeatBucket) {
                    state.weixinRuntimeHeartbeatBucket = heartbeatBucket;
                    const note = kind === 'checking'
                        ? `[状态检查] 命令仍在运行，已等待 ${formatWeixinRuntimeElapsed(elapsed)}；当前尚未返回新的 CLI 输出。`
                        : `[扫码登录] 命令仍在运行，已等待 ${formatWeixinRuntimeElapsed(elapsed)}；当前尚未输出二维码或链接。`;
                    updateWeixinLoginView({
                        ...(kind === 'checking'
                            ? {
                                weixinStatusCheckRawLog: buildWeixinRuntimeLog(
                                    syncedRawLog,
                                    note
                                )
                            }
                            : {
                                weixinLoginRawLog: buildWeixinRuntimeLog(
                                    syncedRawLog,
                                    note
                                )
                            }),
                        weixinLoginSummary: kind === 'checking'
                            ? '正在确认连接状态'
                            : '扫码命令仍在运行',
                        weixinLoginDetail: kind === 'checking'
                            ? '状态检查命令已发出，当前仍在等待明确结果。'
                            : '扫码登录命令已经启动；如果 CLI 长时间静默，界面会自动继续跟进状态检查。'
                    });
                }
                if (
                    kind === 'login'
                    && !state.weixinSilentFollowupTriggered
                    && elapsed >= 6000
                ) {
                    state.weixinSilentFollowupTriggered = true;
                    updateWeixinLoginView({
                        weixinLoginRawLog: buildWeixinRuntimeLog(
                            state.weixinLoginRawLog || snapshot?.logText || '',
                            '[扫码登录] 已等待数秒仍未收到二维码输出，正在自动补发一次连接状态检查。'
                        ),
                        weixinLoginSummary: '扫码命令仍在运行',
                        weixinLoginDetail: '当前命令尚未输出二维码或链接，系统正在自动追加状态检查确认是否已经进入登录流程。'
                    });
                    scheduleWeixinStatusCheck(0, 'auto');
                }
                state.weixinRuntimePulseTimer = window.setTimeout(tick, 1800);
            };
            state.weixinRuntimePulseTimer = window.setTimeout(tick, 1800);
        }

        function getWeixinRuntimeDisplayState() {
            const snapshot = getActiveWeixinRuntimeSnapshot();
            const logPreview = String(getCombinedWeixinRuntimeLog(snapshot?.logText || '') || '').trim();
            const runtimeActive = (snapshot?.status === 'running')
                || isWeixinRuntimeLocallyActive('checking')
                || isWeixinRuntimeLocallyActive('login');
            const elapsedMs = runtimeActive
                ? Math.max(0, Date.now() - Number(snapshot?.startedAt || state.weixinLoginStartedAt || Date.now()))
                : 0;
            const runningWithoutLogs = runtimeActive && !logPreview;
            const runningWithoutArtifacts = runtimeActive
                && !String(state.weixinLoginLink || '').trim()
                && !String(state.weixinLoginAsciiQr || '').trim();
            const linkPlaceholder = state.weixinLoginPhase === 'checking'
                ? '当前执行的是连接状态检查，不会生成扫码链接。'
                : state.weixinLoginPhase === 'installing' && state.weixinLoginFlow === 'install'
                    ? '当前执行的是插件安装 / 升级命令，不会生成扫码链接。'
                    : state.weixinLoginPhase === 'success'
                        ? '最近一次操作已完成，当前没有新的扫码链接。'
                        : runningWithoutArtifacts
                            ? '扫码命令已启动，但当前还没有输出链接；部分 CLI 版本不会实时回显扫码链接。'
                        : '扫码登录命令生成链接后，会显示在这里。';
            const qrPlaceholder = state.weixinLoginPhase === 'checking'
                ? '当前执行的是连接状态检查，不会生成二维码。'
                : state.weixinLoginPhase === 'installing' && state.weixinLoginFlow === 'install'
                    ? '当前执行的是插件安装 / 升级命令，不会生成二维码。'
                    : state.weixinLoginPhase === 'success'
                        ? '最近一次操作已完成，当前没有新的二维码。'
                        : state.weixinLoginPhase === 'scanned'
                            ? '已检测到扫码动作，等待手机侧确认；如已确认，可继续点“检查状态”。'
                            : runningWithoutArtifacts
                                ? '扫码命令已启动，但当前还没有输出二维码；若长时间无变化，请直接点“检查状态”。'
                            : '执行扫码登录后，这里会显示可直接扫码的二维码内容。';
            const logPlaceholder = state.weixinLoginPhase === 'checking'
                ? '状态检查命令已启动，正在等待返回输出...'
                : state.weixinLoginPhase === 'installing' && state.weixinLoginFlow === 'install'
                    ? '安装 / 升级命令已启动，正在等待输出...'
                    : state.weixinLoginPhase === 'success'
                        ? '最近一次操作已完成，没有新的运行日志。'
                        : state.weixinLoginPhase === 'failure'
                            ? '命令已结束，但没有拿到更多日志输出。'
                            : runningWithoutLogs
                                ? '扫码命令已启动，当前尚未收到 CLI 日志输出...'
                            : '等待操作日志输出...';
            return {
                snapshot,
                logPreview,
                runtimeActive,
                elapsedMs,
                linkPlaceholder,
                qrPlaceholder,
                logPlaceholder
            };
        }

        function getWeixinRuntimeStageCopy(options = {}) {
            const hasLink = Boolean(String(options.link || '').trim());
            const phase = String(state.weixinLoginPhase || 'idle').trim();
            const runtimeActive = Boolean(options.runtimeActive);
            const elapsedMs = Math.max(0, Number(options.elapsedMs || 0));

            if (phase === 'success') {
                return {
                    tone: 'success',
                    badge: '已接入',
                    title: '个人微信已经接入完成',
                    detail: '当前不需要继续扫码；如果后续要重绑，再点击上方按钮重新生成二维码。'
                };
            }
            if (phase === 'scanned') {
                return {
                    tone: 'success',
                    badge: '已扫码',
                    title: '已检测到扫码动作，请在手机上确认',
                    detail: '确认完成后，界面会继续检查连接状态；如果长时间没变化，可以点“检查状态”。'
                };
            }
            if (phase === 'checking') {
                return {
                    tone: 'info',
                    badge: '确认中',
                    title: '正在检查微信是否已经接入成功',
                    detail: '这一步不会生成新的二维码。请等待结果，或在必要时重新发起扫码。'
                };
            }
            if (phase === 'installing') {
                return {
                    tone: 'info',
                    badge: '运行中',
                    title: '正在准备插件或自动接入流程',
                    detail: '如果是自动安装流，二维码会在安装器准备完成后出现在这里；当前不是卡住，而是在继续运行。'
                };
            }
            if (phase === 'failure' || phase === 'expired') {
                return {
                    tone: 'danger',
                    badge: phase === 'expired' ? '已过期' : '失败',
                    title: phase === 'expired' ? '二维码已过期，需要重新生成' : '这次扫码没有确认成功',
                    detail: '可以重新点击“扫描接入微信”；如果手机上已经操作过，也可以先点“检查状态”。'
                };
            }
            if (hasLink) {
                return {
                    tone: 'info',
                    badge: '请扫码',
                    title: '请直接扫描下方二维码接入微信',
                    detail: '二维码和扫码链接已经准备好，直接用微信扫描；扫码后继续看这里的状态变化。'
                };
            }
            if (runtimeActive) {
                if (elapsedMs >= 5000) {
                    return {
                        tone: 'warning',
                        badge: '未回显',
                        title: 'CLI 还没返回二维码，但命令仍在运行',
                        detail: '这不是页面卡住。当前只收到了启动级日志，你可以继续等待几秒，或直接点击“检查状态”。'
                    };
                }
                return {
                    tone: 'info',
                    badge: '生成中',
                    title: '正在生成二维码，请直接看这个区域',
                    detail: '命令已经启动，当前还没有回显二维码时，这里会持续显示运行状态，不代表页面卡住。'
                };
            }
            return {
                tone: 'muted',
                badge: '未开始',
                title: '点击上方“扫描接入微信”开始接入',
                detail: '扫码按钮点下去以后，二维码、链接和运行状态都会显示在这里。'
            };
        }

        function shouldShowWeixinDialogRuntimeWindow(options = {}) {
            const phase = String(options.phase || state.weixinLoginPhase || 'idle').trim();
            if (phase && phase !== 'idle') return true;
            if (options.runtimeActive) return true;
            return Boolean(options.hasRuntimeArtifacts);
        }

        function getWeixinDialogRuntimeWindowState(options = {}) {
            const phase = String(options.phase || state.weixinLoginPhase || 'idle').trim();
            const hasQr = Boolean(String(options.qr || '').trim());
            const hasLink = Boolean(String(options.link || '').trim());
            const runtimeActive = Boolean(options.runtimeActive);
            const elapsedMs = Math.max(0, Number(options.elapsedMs || 0));

            if (phase === 'success') {
                return {
                    tone: 'success',
                    title: '接入完成',
                    label: '已完成',
                    percent: 100
                };
            }
            if (phase === 'failure') {
                return {
                    tone: 'danger',
                    title: '执行失败',
                    label: '失败',
                    percent: 100
                };
            }
            if (phase === 'expired') {
                return {
                    tone: 'warning',
                    title: '二维码已过期',
                    label: '过期',
                    percent: 100
                };
            }
            if (phase === 'checking') {
                return {
                    tone: 'info',
                    title: '正在执行',
                    label: '确认中',
                    percent: 96
                };
            }
            if (phase === 'scanned') {
                return {
                    tone: 'success',
                    title: '正在执行',
                    label: '已扫码',
                    percent: 96
                };
            }
            if (phase === 'waiting-scan') {
                if (hasQr || hasLink) {
                    return {
                        tone: 'info',
                        title: '正在执行',
                        label: '请扫码',
                        percent: 90
                    };
                }
                if (runtimeActive && elapsedMs >= 5000) {
                    return {
                        tone: 'warning',
                        title: '正在执行',
                        label: '等待回显',
                        percent: 42
                    };
                }
                return {
                    tone: 'info',
                    title: '正在执行',
                    label: '启动中',
                    percent: 36
                };
            }
            if (phase === 'installing') {
                return {
                    tone: 'info',
                    title: '正在执行',
                    label: '执行中',
                    percent: state.weixinLoginFlow === 'install' ? 28 : 34
                };
            }
            return {
                tone: 'muted',
                title: '等待执行',
                label: '待开始',
                percent: 0
            };
        }

        function scrollWeixinDialogRuntimeIntoView(options = {}) {
            const modal = getWeixinDialogModal();
            if (!modal) return;
            const target = modal.querySelector('[data-role="weixin-runtime-section"]') || modal.querySelector('[data-role="weixin-runtime-qr"]');
            if (!target) return;
            try {
                target.scrollIntoView({
                    behavior: options.instant === true ? 'auto' : 'smooth',
                    block: 'start'
                });
            } catch (_) {
                target.scrollIntoView();
            }
        }

        function getWeixinDialogModal() {
            const modal = getLatestChannelDialogModal();
            if (!modal) return null;
            return modal.dataset.channelDialogKind === 'weixin' ? modal : null;
        }

        function collectChannelDialogValues(modal) {
            const values = {};
            if (!modal) return values;
            modal.querySelectorAll('[data-field]').forEach((field) => {
                values[field.dataset.field] = field.type === 'checkbox' ? field.checked : field.value;
            });
            return values;
        }

        function createDialogStatusProxy(modal, dialogApi = null) {
            if (typeof dialogApi?.setStatus === 'function') {
                return dialogApi;
            }
            return {
                setStatus(message) {
                    const statusEl = modal?.querySelector('[data-role="weixin-action-status"]');
                    if (statusEl) {
                        statusEl.textContent = String(message || '');
                    }
                }
            };
        }

        function getChannelsSmokeApiOverride(name) {
            const overrides = ensureObject(window.__openclawSmokeApiOverrides);
            const candidate = overrides?.[name];
            return typeof candidate === 'function' ? candidate : null;
        }

        async function invokeChannelsApi(name, ...args) {
            const override = getChannelsSmokeApiOverride(name);
            if (override) {
                return await override(...args);
            }
            if (typeof window.api?.[name] !== 'function') {
                return null;
            }
            return await window.api[name](...args);
        }

        async function persistWeixinDialogConfig(channelName, modal, dialogApi = null, options = {}) {
            const statusApi = createDialogStatusProxy(modal, dialogApi);
            if (!(await ensureChannelInstalledBeforeSave(channelName, statusApi))) {
                return null;
            }
            const currentConfig = ensureObject(state.config?.channels?.[channelName]);
            const values = collectChannelDialogValues(modal);
            const next = clone(state.config);
            next.channels = ensureObject(next.channels);
            const draft = buildChannelDraft(channelName, currentConfig);
            draft.enabled = String(values.enabled) !== 'false';
            next.channels[channelName] = serializeChannelDraft(channelName, currentConfig, draft);
            setSingleChannelBinding(next, channelName, String(values.agentBinding || '__unbound__'));

            const result = await invokeChannelsApi('writeOpenClawConfig', next);
            if (!result?.ok) throw new Error(result?.error || '保存失败');

            state.config = next;
            state.selected = channelName;
            state.status = '已保存个人微信接入配置';
            if (typeof dialogApi?.setStatus === 'function') {
                dialogApi.setStatus('已保存个人微信接入配置', '#a9dc76');
            }
            if (options.refresh !== false) {
                render();
                await refreshChannelAccessStates();
                render();
            }
            refreshWeixinDialogRuntimeUI();
            return next;
        }

        function refreshWeixinDialogRuntimeUI() {
            const modal = getWeixinDialogModal();
            if (!modal) return;

            const pluginStatusEl = modal.querySelector('[data-role="weixin-plugin-status"]');
            const actionStatusEl = modal.querySelector('[data-role="weixin-action-status"]');
            const installBtn = modal.querySelector('[data-role="weixin-dialog-install"]');
            const loginBtn = modal.querySelector('[data-role="weixin-dialog-login"]');
            const checkBtn = modal.querySelector('[data-role="weixin-dialog-status-check"]');
            const runtimeSectionEl = modal.querySelector('[data-role="weixin-runtime-section"]');
            const runtimeSummaryEl = modal.querySelector('[data-role="weixin-runtime-summary"]');
            const runtimeDetailEl = modal.querySelector('[data-role="weixin-runtime-detail"]');
            const runtimeLinkEl = modal.querySelector('[data-role="weixin-runtime-link"]');
            const runtimeQrEl = modal.querySelector('[data-role="weixin-runtime-qr"]');
            const runtimeLogEl = modal.querySelector('[data-role="weixin-runtime-log"]');
            const runtimeBadgeEl = modal.querySelector('[data-role="weixin-runtime-badge"]');
            const runtimeWindowTitleEl = modal.querySelector('[data-role="weixin-runtime-window-title"]');
            const runtimeProgressPercentEl = modal.querySelector('[data-role="weixin-runtime-progress-percent"]');
            const runtimeProgressFillEl = modal.querySelector('[data-role="weixin-runtime-progress-fill"]');
            const runtimeGuideTitleEl = modal.querySelector('[data-role="weixin-runtime-guide-title"]');
            const runtimeGuideDetailEl = modal.querySelector('[data-role="weixin-runtime-guide-detail"]');
            const runtimeScanCopyEl = modal.querySelector('[data-role="weixin-runtime-scan-copy"]');
            const statusField = modal.querySelector('[data-field="status"]');
            const plugin = ensureObject(state.weixinPluginStatus);
            const runtimeDisplay = getWeixinRuntimeDisplayState();
            const runtimeLogSource = getCombinedWeixinRuntimeLog(runtimeDisplay.snapshot?.logText || '');
            const visibleLoginLink = state.weixinLoginLink || extractLatestLoginLink(runtimeLogSource);
            const visibleAsciiQr = state.weixinLoginAsciiQr || extractLatestAsciiQr(runtimeLogSource);
            const runtimeLogPreview = runtimeDisplay.logPreview;
            const runtimeActive = Boolean(runtimeDisplay.runtimeActive);
            const currentConfig = ensureObject(state.config?.channels?.[state.selected]);
            const hasSavedConfig = Object.keys(currentConfig).length > 0;
            const hasRuntimeArtifacts = Boolean(
                String(visibleLoginLink || '').trim()
                || String(visibleAsciiQr || '').trim()
                || runtimeLogPreview
            );
            const runtimeStageCopy = getWeixinRuntimeStageCopy({
                link: visibleLoginLink,
                runtimeActive,
                elapsedMs: runtimeDisplay.elapsedMs
            });
            const runtimeWindowState = getWeixinDialogRuntimeWindowState({
                phase: state.weixinLoginPhase,
                runtimeActive,
                elapsedMs: runtimeDisplay.elapsedMs,
                link: visibleLoginLink,
                qr: visibleAsciiQr
            });
            const userFacingRuntimeLog = buildWeixinUserFacingRuntimeLog(runtimeLogSource, {
                runtimeActive,
                elapsedMs: runtimeDisplay.elapsedMs,
                phase: state.weixinLoginPhase
            });
            const showRuntimeWindow = shouldShowWeixinDialogRuntimeWindow({
                phase: state.weixinLoginPhase,
                runtimeActive,
                hasRuntimeArtifacts
            });

            if (pluginStatusEl) {
                if (state.weixinPluginStatusLoading) {
                    pluginStatusEl.textContent = '正在检测个人微信插件状态...';
                } else if (plugin.error) {
                    pluginStatusEl.textContent = plugin.error;
                } else if (plugin.compatibilityIssue) {
                    const bits = [`已安装 ${plugin.installedVersion ? `v${plugin.installedVersion}` : '插件'}`, plugin.compatibilityIssue];
                    if (plugin.extensionDir) {
                        bits.push(`目录：${plugin.extensionDir}`);
                    }
                    pluginStatusEl.textContent = bits.join(' · ');
                } else if (plugin.installed) {
                    const bits = [`已安装 ${plugin.installedVersion ? `v${plugin.installedVersion}` : '插件'}`];
                    if (plugin.updateAvailable && plugin.latestVersion) {
                        bits.push(`可升级到 v${plugin.latestVersion}`);
                    } else if (plugin.latestVersion) {
                        bits.push(`当前已是最新版本 (${plugin.latestVersion})`);
                    }
                    if (plugin.extensionDir) {
                        bits.push(`目录：${plugin.extensionDir}`);
                    }
                    pluginStatusEl.textContent = bits.join(' · ');
                } else {
                    pluginStatusEl.textContent = plugin.latestVersion
                        ? `当前未安装个人微信插件 · 最新版本 ${plugin.latestVersion}`
                        : '当前未检测到个人微信插件，请先安装。';
                }
            }

            if (installBtn) {
                installBtn.textContent = plugin.compatibilityIssue
                    ? '升级到兼容版'
                    : (plugin.installed && plugin.updateAvailable ? '升级插件' : '安装插件');
            }
            if (loginBtn) {
                loginBtn.textContent = isWeixinBindingComplete(state.selected)
                    ? '重新扫描接入微信'
                    : '扫描接入微信';
            }

            const isRunning = Boolean(
                runtimeDisplay.snapshot?.status === 'running'
                && ['installing', 'waiting-scan', 'scanned', 'checking'].includes(state.weixinLoginPhase)
            );
            if (installBtn) installBtn.disabled = isRunning;
            if (loginBtn) loginBtn.disabled = isRunning;
            if (checkBtn) checkBtn.disabled = isRunning;

            if (statusField) {
                statusField.value = isWeixinBindingComplete(state.selected)
                    ? '微信已接入'
                    : (state.weixinLoginPhase === 'installing'
                        ? '插件处理中'
                        : state.weixinLoginPhase === 'waiting-scan'
                            ? '等待扫码'
                            : state.weixinLoginPhase === 'scanned'
                                ? '已扫码，待确认'
                                : state.weixinLoginPhase === 'checking'
                                    ? '正在确认状态'
                                    : state.weixinLoginPhase === 'success'
                                        ? '微信已接入'
                                        : state.weixinLoginPhase === 'failure'
                                            ? '登录失败'
                                            : state.weixinLoginPhase === 'expired'
                                                ? '二维码已过期'
                                                : (hasSavedConfig ? '等待扫码绑定' : '等待写入接入配置'));
            }

            if (actionStatusEl) {
                actionStatusEl.textContent = plugin.compatibilityIssue
                    ? plugin.compatibilityIssue
                    : isWeixinBindingComplete(state.selected)
                    ? '当前个人微信 V1 已完成接入；如需重绑，可重新执行扫码登录。'
                    : runtimeActive && !hasRuntimeArtifacts && runtimeDisplay.elapsedMs >= 5000
                        ? '命令仍在运行，但 CLI 暂未回显二维码；这不是页面卡住，可以继续等待，或直接点击“检查状态”。'
                        : '点击“扫描接入微信”后，当前窗口会直接展开运行日志和二维码区域。';
            }
            if (runtimeSectionEl) {
                runtimeSectionEl.className = `ocp-channel-dialog-block ocp-channel-runtime-window ${showRuntimeWindow ? 'is-visible' : 'is-hidden'} tone-${runtimeWindowState.tone || 'muted'}`;
            }
            if (runtimeWindowTitleEl) {
                runtimeWindowTitleEl.textContent = runtimeWindowState.title || '正在执行';
            }
            if (runtimeSummaryEl) {
                runtimeSummaryEl.textContent = state.weixinLoginSummary || '等待操作';
            }
            if (runtimeDetailEl) {
                runtimeDetailEl.textContent = state.weixinLoginDetail || '日志、二维码和状态会在这里实时更新。';
            }
            if (runtimeProgressPercentEl) {
                runtimeProgressPercentEl.textContent = `${Math.max(0, Math.min(100, Number(runtimeWindowState.percent || 0)))}%`;
            }
            if (runtimeProgressFillEl) {
                runtimeProgressFillEl.style.width = `${Math.max(0, Math.min(100, Number(runtimeWindowState.percent || 0)))}%`;
            }
            if (runtimeBadgeEl) {
                runtimeBadgeEl.className = `ocp-pill ${esc(runtimeStageCopy.tone || 'muted')}`;
                runtimeBadgeEl.textContent = runtimeStageCopy.badge || '等待操作';
            }
            if (runtimeGuideTitleEl) {
                runtimeGuideTitleEl.textContent = runtimeStageCopy.title || '点击上方按钮开始扫码';
            }
            if (runtimeGuideDetailEl) {
                runtimeGuideDetailEl.textContent = runtimeStageCopy.detail || '二维码、扫码链接和运行状态会在这里继续显示。';
            }
            if (runtimeScanCopyEl) {
                runtimeScanCopyEl.textContent = visibleLoginLink
                    ? '二维码已经准备好，请直接使用微信扫描下方图片。'
                    : runtimeDisplay.qrPlaceholder;
            }
            if (runtimeLinkEl) {
                if (visibleLoginLink) {
                    runtimeLinkEl.innerHTML = `
                        <div class="ocp-channel-runtime-link-copy">如果二维码未能成功展示，请用浏览器打开以下链接扫码：</div>
                        <a class="ocp-channel-runtime-link-url" href="${esc(visibleLoginLink)}" target="_blank" rel="noreferrer">${esc(visibleLoginLink)}</a>
                        <div class="ocp-channel-runtime-link-status">${esc(
                            state.weixinLoginPhase === 'scanned'
                                ? '已检测到扫码，等待手机确认...'
                                : state.weixinLoginPhase === 'checking'
                                    ? '正在确认连接结果...'
                                    : '等待连接结果...'
                        )}</div>
                    `;
                } else {
                    runtimeLinkEl.innerHTML = `
                        <div class="ocp-channel-runtime-link-copy">${esc(runtimeDisplay.linkPlaceholder)}</div>
                        <div class="ocp-channel-runtime-link-status">${esc(
                            runtimeActive ? '命令正在运行，等待连接结果...' : '等待你点击“扫描接入微信”后开始执行。'
                        )}</div>
                    `;
                }
            }
            if (runtimeQrEl) {
                runtimeQrEl.innerHTML = buildWeixinQrVisualHtml({
                    link: visibleLoginLink,
                    asciiQr: visibleAsciiQr,
                    placeholder: runtimeDisplay.qrPlaceholder
                });
            }
            if (runtimeLogEl) {
                runtimeLogEl.textContent = userFacingRuntimeLog
                    || runtimeDisplay.logPlaceholder;
            }
            void ensureWeixinLinkImageQr(visibleLoginLink);
        }

        async function refreshWeixinPluginStatus(options = {}) {
            if (typeof window.api?.checkWeixinPluginStatus !== 'function' && !getChannelsSmokeApiOverride('checkWeixinPluginStatus')) return null;
            state.weixinPluginStatusLoading = true;
            refreshWeixinDialogRuntimeUI();
            try {
                const status = await invokeChannelsApi('checkWeixinPluginStatus', {
                    includeLatestVersion: options.includeLatestVersion !== false,
                    refresh: options.refresh === true
                });
                state.weixinPluginStatus = status || {};
                return state.weixinPluginStatus;
            } catch (error) {
                state.weixinPluginStatus = {
                    installed: false,
                    installedVersion: '',
                    latestVersion: '',
                    updateAvailable: false,
                    error: error?.message || String(error)
                };
                return state.weixinPluginStatus;
            } finally {
                state.weixinPluginStatusLoading = false;
                refreshWeixinDialogRuntimeUI();
            }
        }

        function attachWeixinDialogActions(channelName) {
            const modal = getWeixinDialogModal();
            if (!modal) return;
            const installBtn = modal.querySelector('[data-role="weixin-dialog-install"]');
            const loginBtn = modal.querySelector('[data-role="weixin-dialog-login"]');
            const checkBtn = modal.querySelector('[data-role="weixin-dialog-status-check"]');
            const actionStatusEl = modal.querySelector('[data-role="weixin-action-status"]');

            if (installBtn) {
                installBtn.onclick = async () => {
                    const currentModal = getWeixinDialogModal() || modal;
                    const currentInstallBtn = currentModal?.querySelector('[data-role="weixin-dialog-install"]') || installBtn;
                    const currentActionStatusEl = currentModal?.querySelector('[data-role="weixin-action-status"]') || actionStatusEl;
                    if (currentInstallBtn?.disabled) return;
                    if (currentActionStatusEl) {
                        currentActionStatusEl.textContent = '正在执行官方自动安装流，稍后会直接生成扫码二维码...';
                    }
                    const started = beginWeixinLoginFlow(
                        'auto',
                        WEIXIN_AUTO_INSTALL_COMMAND,
                        '个人微信自动安装与扫码接入',
                        '正在执行个人微信官方自动安装流；它会自动安装或升级插件、输出二维码，并在扫码成功后自动重启 Gateway。'
                    );
                    if (!started && currentActionStatusEl) {
                        currentActionStatusEl.textContent = '个人微信自动安装流未能启动，请检查当前命令桥接或稍后重试。';
                    }
                    refreshWeixinDialogRuntimeUI();
                    scrollWeixinDialogRuntimeIntoView();
                };
            }

            if (loginBtn) {
                loginBtn.onclick = async () => {
                    const currentModal = getWeixinDialogModal() || modal;
                    const currentLoginBtn = currentModal?.querySelector('[data-role="weixin-dialog-login"]') || loginBtn;
                    const currentActionStatusEl = currentModal?.querySelector('[data-role="weixin-action-status"]') || actionStatusEl;
                    if (currentLoginBtn?.disabled) return;
                    const pluginStatus = await refreshWeixinPluginStatus({
                        refresh: true,
                        includeLatestVersion: false
                    });
                    if (pluginStatus?.compatibilityIssue) {
                        if (currentActionStatusEl) {
                            currentActionStatusEl.textContent = pluginStatus.compatibilityIssue;
                        }
                        return;
                    }
                    if (!pluginStatus?.installed) {
                        if (currentActionStatusEl) {
                            currentActionStatusEl.textContent = '请先安装个人微信插件，再执行扫码登录。';
                        }
                        return;
                    }
                    updateWeixinLoginView({
                        weixinLoginFlow: 'manual',
                        weixinLoginPhase: 'installing',
                        weixinLoginSummary: '正在准备扫码登录',
                        weixinLoginDetail: '正在保存接入配置并准备生成二维码，当前窗口会继续显示执行进度。',
                        weixinLoginRawLog: buildWeixinRuntimeLog(
                            '',
                            '[扫码登录] 已收到扫码指令，正在保存接入配置并准备生成二维码...'
                        ),
                        weixinLoginStartedAt: Date.now(),
                        weixinStatusCheckRawLog: '',
                        weixinStatusCheckSessionId: '',
                        weixinLoginExpired: false,
                        weixinLoginFinished: false
                    });
                    refreshWeixinDialogRuntimeUI();
                    scrollWeixinDialogRuntimeIntoView({ instant: true });
                    try {
                        const savedConfig = await persistWeixinDialogConfig(channelName, currentModal, null, { refresh: false });
                        if (!savedConfig) {
                            updateWeixinLoginView({
                                weixinLoginPhase: 'idle',
                                weixinLoginSummary: '等待扫码接入',
                                weixinLoginDetail: '接入配置尚未保存完成，请先处理上方提示后再继续扫码。'
                            });
                            refreshWeixinDialogRuntimeUI();
                            return;
                        }
                        if (currentActionStatusEl) {
                            currentActionStatusEl.textContent = '已保存接入配置，正在生成扫码二维码...';
                        }
                        beginWeixinLoginFlow(
                            'manual',
                            WEIXIN_LOGIN_COMMAND,
                            '个人微信扫码登录',
                            '正在执行参考项目同款扫码登录命令，请直接在当前窗口查看二维码并使用微信扫码。'
                        );
                        void refreshChannelAccessStates({ selectedOnly: true, background: true }).catch(() => {});
                        refreshWeixinDialogRuntimeUI();
                        scrollWeixinDialogRuntimeIntoView();
                    } catch (error) {
                        updateWeixinLoginView({
                            weixinLoginPhase: 'failure',
                            weixinLoginSummary: '扫码准备失败',
                            weixinLoginDetail: error?.message || String(error)
                        });
                        if (currentActionStatusEl) {
                            currentActionStatusEl.textContent = error?.message || String(error);
                        }
                    }
                };
            }

            if (checkBtn) {
                checkBtn.onclick = async () => {
                    const currentModal = getWeixinDialogModal() || modal;
                    const currentCheckBtn = currentModal?.querySelector('[data-role="weixin-dialog-status-check"]') || checkBtn;
                    const currentActionStatusEl = currentModal?.querySelector('[data-role="weixin-action-status"]') || actionStatusEl;
                    if (currentCheckBtn?.disabled) return;
                    const pluginStatus = await refreshWeixinPluginStatus({
                        refresh: true,
                        includeLatestVersion: false
                    });
                    if (pluginStatus?.compatibilityIssue) {
                        if (currentActionStatusEl) {
                            currentActionStatusEl.textContent = pluginStatus.compatibilityIssue;
                        }
                        return;
                    }
                    if (currentActionStatusEl) {
                        currentActionStatusEl.textContent = '正在检查当前个人微信连接状态...';
                    }
                    runWeixinStatusCheck('manual');
                    refreshWeixinDialogRuntimeUI();
                    scrollWeixinDialogRuntimeIntoView();
                };
            }
        }

        function openWeixinBindingDialog(channelName = WEIXIN_PERSONAL_CHANNEL_KEY, options = {}) {
            if (typeof window.showFormDialog !== 'function') return false;
            const currentConfig = ensureObject(state.config?.channels?.[channelName]);
            const configured = getChannelKeys().includes(channelName);
            const mode = options.mode === 'success' ? 'success' : 'connect';
            const agentOptions = [
                { value: '__unbound__', label: '未绑定' },
                ...state.agents.map((agentId) => ({ value: agentId, label: agentId }))
            ];
            const bindingComplete = isWeixinBindingComplete(channelName);
            const title = mode === 'success' ? '个人微信接入完成' : '编辑个人微信接入';

            const fields = mode === 'success'
                ? [
                    {
                        name: 'status',
                        label: '当前状态',
                        value: '微信已接入',
                        readonly: true,
                        hint: '微信绑定完成，可以退出窗口。'
                    },
                    {
                        name: 'detail',
                        label: '说明',
                        type: 'textarea',
                        value: '当前个人微信 V1 已完成扫码接入。后续如需重新绑定，可再次点击“编辑接入”。',
                        readonly: true
                    }
                ]
                : [
                    {
                        name: 'enabled',
                        label: '启用状态',
                        type: 'select',
                        value: currentConfig.enabled === false ? 'false' : 'true',
                        options: [
                            { value: 'true', label: '启用' },
                            { value: 'false', label: '停用' }
                        ],
                        hint: '扫码接入完成后立即生效。'
                    },
                    {
                        name: 'agentBinding',
                        label: '绑定 Agent',
                        type: 'select',
                        value: getBoundAgent(state.config, channelName) || '__unbound__',
                        options: agentOptions,
                        hint: '当前 V1 只保留最小接入能力；后续如需多账号会在 V2 扩展。'
                    }
                ];

            window.showFormDialog({
                title,
                description: mode === 'success'
                    ? '扫码与绑定已经完成，这里仅保留状态确认。'
                    : '安装插件、升级插件、扫码登录都可以直接在这个窗口完成；底部“保存接入配置”只负责保存 enabled 与 Agent 绑定。',
                confirmText: mode === 'success' ? '完成' : '保存接入配置',
                cancelText: mode === 'success' ? '关闭' : '取消',
                fields,
                onConfirm: async (values, dialog) => {
                    if (mode === 'success') {
                        dialog.close();
                        return;
                    }
                    const modal = getWeixinDialogModal();
                    const savedConfig = await persistWeixinDialogConfig(channelName, modal, dialog, { refresh: true });
                    if (!savedConfig) {
                        return;
                    }
                    refreshWeixinDialogRuntimeUI();
                },
                onClose: () => {
                    refreshWeixinDialogRuntimeUI();
                    resumeChannelsRefreshAfterDialog();
                }
            });
            const modal = getLatestChannelDialogModal();
            if (modal) {
                modal.dataset.channelDialogKind = 'weixin';
                modal.dataset.channelKey = channelName;
                if (mode !== 'success') {
                    const firstField = modal.querySelector('.ocp-dialog-field');
                    firstField?.insertAdjacentHTML('beforebegin', `
                        <div class="ocp-channel-dialog-block ocp-channel-dialog-primary-entry">
                            <div class="ocp-card-title">扫码接入</div>
                            <div class="ocp-row-meta">先点击下面这个主按钮开始接入微信。二维码会直接显示在当前窗口，不需要跳转到别的页面。</div>
                            <div class="ocp-channel-dialog-primary-action">
                                <button type="button" class="ocp-dialog-btn primary ocp-channel-dialog-scan-btn" data-role="weixin-dialog-login">扫描接入微信</button>
                                <div class="ocp-row-meta">如果按钮不可用，先看下方“插件状态”和“辅助操作”中的安装提示。</div>
                            </div>
                        </div>
                    `);
                }
                const statusEl = modal.querySelector('[data-role="status"]');
                statusEl?.insertAdjacentHTML('beforebegin', `
                    <div data-role="weixin-dialog-bottom">
                        <div class="ocp-channel-dialog-block">
                            <div class="ocp-card-title">插件状态</div>
                            <div class="ocp-row-meta" data-role="weixin-plugin-status">正在检测个人微信插件状态...</div>
                        </div>
                        <div class="ocp-channel-dialog-block">
                            <div class="ocp-card-title">辅助操作</div>
                            <div class="ocp-row-meta">安装插件和检查状态放在这里，避免和主扫码入口混在一起。</div>
                            <div class="ocp-channel-dialog-action-grid">
                                <button type="button" class="ocp-dialog-btn" data-role="weixin-dialog-install">安装插件</button>
                                <button type="button" class="ocp-dialog-btn" data-role="weixin-dialog-status-check">检查状态</button>
                            </div>
                            <div class="ocp-channel-dialog-result" data-role="weixin-action-status">主入口已经移到上方“扫码接入”；这里只保留安装插件和状态确认。</div>
                        </div>
                        <div class="ocp-channel-dialog-block ocp-channel-runtime-window is-hidden tone-muted" data-role="weixin-runtime-section">
                            <div class="ocp-channel-runtime-window-head">
                                <div class="ocp-channel-runtime-window-copy">
                                    <div class="ocp-card-title" data-role="weixin-runtime-window-title">正在执行</div>
                                    <div class="ocp-row-meta" data-role="weixin-runtime-guide-title">点击“扫描接入微信”后，这里会展开执行窗口。</div>
                                </div>
                                <div class="ocp-channel-runtime-window-meta">
                                    <span class="ocp-pill muted" data-role="weixin-runtime-badge">未开始</span>
                                    <span class="ocp-row-meta" data-role="weixin-runtime-progress-percent">0%</span>
                                </div>
                            </div>
                            <div class="ocp-channel-runtime-progress" aria-hidden="true">
                                <div class="ocp-channel-runtime-progress-fill" data-role="weixin-runtime-progress-fill" style="width:0%"></div>
                            </div>
                            <div class="ocp-channel-runtime-guide" data-role="weixin-runtime-guide-detail">二维码、扫码链接和运行状态会在这里持续更新，不需要切到别的地方。</div>
                            <div class="ocp-row-meta" data-role="weixin-runtime-summary">等待操作</div>
                            <div class="ocp-row-meta" data-role="weixin-runtime-detail">日志、二维码和状态会在这里实时更新。</div>
                            <div class="ocp-channel-login-surface ocp-channel-runtime-output">
                                <div class="ocp-channel-runtime-scan-head">
                                    <div class="ocp-card-title">请扫这里</div>
                                    <div class="ocp-row-meta" data-role="weixin-runtime-scan-copy">二维码生成后会直接显示在这里。</div>
                                </div>
                                <div data-role="weixin-runtime-qr"></div>
                                <div data-role="weixin-runtime-link" class="ocp-channel-runtime-link-card">扫码链接生成后会显示在这里。</div>
                                <div class="ocp-channel-runtime-log-head">
                                    <div class="ocp-row-meta">运行状态</div>
                                </div>
                                <pre class="ocp-channel-login-log" data-role="weixin-runtime-log">等待操作日志输出...</pre>
                            </div>
                        </div>
                    </div>
                `);
                attachWeixinDialogActions(channelName);
                refreshWeixinDialogRuntimeUI();
                deferChannelDialogWork(() => {
                    const dialogStateItems = getChannelStateDescriptors(state, channelName, {
                        profile: getChannelProfile(channelName, currentConfig),
                        channelConfig: currentConfig,
                        probe: getChannelAccessProbe(state, channelName)
                    });
                    decorateChannelDialogModal(getChannelProfile(channelName, currentConfig), {
                        banner: {
                            tone: mode === 'success' ? 'success' : 'info',
                            text: mode === 'success'
                                ? '当前个人微信 V1 已完成绑定，后续如需重绑可再次进入这个窗口。'
                                : '参考 clawpanel-main 的消息渠道微信：安装插件、升级插件、扫码登录都收敛在这个编辑窗口里。'
                        },
                        contextTitle: '当前状态',
                        contextDescription: mode === 'success'
                            ? '绑定完成后这里只保留复查和重绑入口，不再额外展开无关说明。'
                            : '先确认插件和绑定状态，再决定是先安装、直接扫码，还是做状态确认。',
                        contextItems: dialogStateItems,
                        showGuide: false,
                        pairingCache: state.pairingCache,
                        onSavePairingCache: savePairingToCache
                    });
                    void refreshWeixinPluginStatus({ includeLatestVersion: false });
                    window.setTimeout(() => {
                        if (!getWeixinDialogModal()) return;
                        void refreshWeixinPluginStatus({ includeLatestVersion: true });
                    }, 220);
                });
            }
            return true;
        }

        function scheduleWeixinLoginTimeout(flow = 'manual') {
            if (state.weixinLoginTimeoutTimer) {
                clearTimeout(state.weixinLoginTimeoutTimer);
            }
            const timeoutMs = flow === 'install'
                ? 2 * 60 * 1000
                : flow === 'auto'
                    ? 3 * 60 * 1000
                    : 90 * 1000;
            state.weixinLoginTimeoutTimer = window.setTimeout(() => {
                state.weixinLoginTimeoutTimer = null;
                if (state.weixinLoginPhase === 'success' || state.weixinLoginPhase === 'failure') return;
                updateWeixinLoginView({
                    weixinLoginPhase: 'expired',
                    weixinLoginSummary: '二维码已过期',
                    weixinLoginDetail: '本轮扫码已超时。你可以重新生成二维码，或改用手动回退流继续处理。',
                    weixinLoginExpired: true
                });
            }, timeoutMs);
        }

        function runWeixinStatusCheck(reason = 'manual') {
            if (!isChannelsViewActive()) return;
            if (state.weixinLoginStatusCheckTimer) {
                clearTimeout(state.weixinLoginStatusCheckTimer);
                state.weixinLoginStatusCheckTimer = null;
            }
            const sessionId = window.__openclawRunCommand?.(WEIXIN_CHANNEL_STATUS_COMMAND, {
                title: '个人微信状态确认',
                sourceLabel: '消息渠道',
                autoReveal: false,
                commandOptions: {
                    lightweight: true
                }
            });
            if (!sessionId) return;
            updateWeixinLoginView({
                weixinStatusCheckSessionId: sessionId,
                weixinLoginStartedAt: Date.now(),
                weixinLoginPhase: 'checking',
                weixinLoginSummary: '正在确认连接状态',
                weixinLoginDetail: reason === 'auto'
                    ? '已检测到扫码成功迹象，正在追加一次渠道状态确认。'
                    : '正在主动检查个人微信渠道是否已经连接成功。',
                weixinStatusCheckRawLog: buildWeixinRuntimeLog(
                    state.weixinStatusCheckRawLog || '',
                    reason === 'auto'
                        ? '[状态检查] 已自动发起连接确认，等待命令输出...'
                        : '[状态检查] 已手动发起连接确认，等待命令输出...'
                )
            });
            scheduleWeixinRuntimePulse('checking');
        }

        function scheduleWeixinStatusCheck(delayMs = 1200, reason = 'auto') {
            if (state.weixinLoginAutoCheckScheduled) return;
            state.weixinLoginAutoCheckScheduled = true;
            if (state.weixinLoginStatusCheckTimer) {
                clearTimeout(state.weixinLoginStatusCheckTimer);
            }
            state.weixinLoginStatusCheckTimer = window.setTimeout(() => {
                state.weixinLoginStatusCheckTimer = null;
                state.weixinLoginAutoCheckScheduled = false;
                runWeixinStatusCheck(reason);
            }, Math.max(0, Number(delayMs || 0)));
        }

        function applyWeixinLoginSignal(logText, options = {}) {
            const parsed = parseWeixinLoginSignal(logText);
            const patch = {
                weixinLoginRawLog: String(logText || ''),
                weixinLoginLink: parsed.link || state.weixinLoginLink,
                weixinLoginAsciiQr: parsed.asciiQr || state.weixinLoginAsciiQr
            };

            if (parsed.expired) {
                Object.assign(patch, {
                    weixinLoginPhase: 'expired',
                    weixinLoginSummary: '二维码已过期',
                    weixinLoginDetail: '请重新生成二维码，或点击“已完成扫码，检查状态”确认是否其实已经登录成功。',
                    weixinLoginExpired: true,
                    status: '个人微信二维码已过期，请重新生成后再扫码。'
                });
                updateWeixinLoginView(patch);
                return parsed;
            }

            if (parsed.hardFailure) {
                Object.assign(patch, {
                    weixinLoginPhase: 'failure',
                    weixinLoginSummary: '扫码登录失败',
                    weixinLoginDetail: '命令输出中出现了明确失败信息，请检查上方日志后重试。',
                    status: '个人微信扫码登录失败，请查看日志后重试。'
                });
                updateWeixinLoginView(patch);
                return parsed;
            }

            if (parsed.loginSuccess || parsed.restartSeen) {
                Object.assign(patch, {
                    weixinLoginPhase: 'checking',
                    weixinLoginSummary: '已完成扫码，正在确认连接',
                    weixinLoginDetail: '已检测到登录成功或网关重启标志，正在追加一次状态确认。',
                    status: '已识别到个人微信扫码成功，正在自动确认连接状态。'
                });
                updateWeixinLoginView(patch);
                if (options.allowAutoCheck !== false) {
                    scheduleWeixinStatusCheck(1200, 'auto');
                }
                return parsed;
            }

            if (parsed.scanned) {
                Object.assign(patch, {
                    weixinLoginPhase: 'scanned',
                    weixinLoginSummary: '已扫码，请在手机上确认登录',
                    weixinLoginDetail: '已识别到扫码动作。手机确认后系统会继续检查状态；如果你已经确认，也可以主动点“检查状态”。',
                    status: '个人微信已扫码，请在手机上完成确认。'
                });
                updateWeixinLoginView(patch);
                return parsed;
            }

            if (parsed.link || parsed.asciiQr || parsed.hasQrPrompt) {
                Object.assign(patch, {
                    weixinLoginPhase: 'waiting-scan',
                    weixinLoginSummary: '请使用微信扫码',
                    weixinLoginDetail: parsed.link
                        ? '已提取到扫码链接；如果二维码区域显示完整，也可以直接扫码。'
                        : '二维码已生成。专用二维码区域会保持不换行，避免扫码时错位。'
                });
                updateWeixinLoginView(patch);
                return parsed;
            }

            if (state.weixinLoginPhase === 'installing' || state.weixinLoginPhase === 'idle') {
                Object.assign(patch, {
                    weixinLoginPhase: 'installing',
                    weixinLoginSummary: '正在准备扫码环境',
                    weixinLoginDetail: '命令已经启动，正在等待安装、更新或二维码生成输出。'
                });
                updateWeixinLoginView(patch);
            } else {
                updateWeixinLoginView(patch);
            }
            return parsed;
        }

        function handleWeixinStatusCheckResult(logText, code) {
            clearWeixinRuntimePulse();
            const parsed = parseWeixinRuntimeStatus(logText);
            const compatibilityMessage = getWeixinPluginCompatibilityMessage(state.weixinPluginStatus, logText);
            const patch = {
                weixinStatusCheckRawLog: String(logText || state.weixinStatusCheckRawLog || ''),
                weixinStatusCheckSessionId: ''
            };
            if (!String(logText || '').trim()) {
                patch.weixinStatusCheckRawLog = buildWeixinRuntimeLog(
                    patch.weixinStatusCheckRawLog,
                    `[状态检查] 命令已结束（退出码 ${code ?? 'unknown'}），未返回更多输出。`
                );
            }

            if (parsed.connected) {
                Object.assign(patch, {
                    weixinLoginPhase: 'success',
                    weixinLoginSummary: '个人微信已连接成功',
                    weixinLoginDetail: '状态检查已确认当前渠道处于可用状态。',
                    status: '个人微信已确认接入成功。'
                });
                updateWeixinLoginView(patch);
                if (!state.weixinBindingSuccessDialogShown && isChannelsViewActive() && isWeixinPersonalChannel(state.selected)) {
                    state.weixinBindingSuccessDialogShown = true;
                    setTimeout(() => {
                        if (!isChannelsViewActive() || !isWeixinPersonalChannel(state.selected)) return;
                        openWeixinBindingDialog(state.selected, { mode: 'success' });
                    }, 120);
                }
                return;
            }

            if (compatibilityMessage) {
                Object.assign(patch, {
                    weixinLoginPhase: 'failure',
                    weixinLoginSummary: '插件版本不兼容',
                    weixinLoginDetail: compatibilityMessage,
                    status: '个人微信插件与当前 OpenClaw 不兼容，请先升级插件后再重试。'
                });
                updateWeixinLoginView(patch);
                return;
            }

            if (parsed.missingFromStatus) {
                Object.assign(patch, {
                    weixinLoginPhase: 'idle',
                    weixinLoginSummary: '个人微信尚未接入',
                    weixinLoginDetail: '这次状态输出里没有发现 openclaw-weixin，说明当前还没完成扫码绑定，或网关尚未加载个人微信渠道。',
                    status: '个人微信尚未接入，请先扫码绑定后再检查状态。'
                });
                updateWeixinLoginView(patch);
                return;
            }

            if (parsed.disconnected || (!(code === 0 || code === '0') && parsed.mentionsWeixin)) {
                Object.assign(patch, {
                    weixinLoginPhase: 'failure',
                    weixinLoginSummary: '连接确认未通过',
                    weixinLoginDetail: '已执行状态检查，但仍未确认个人微信连接成功。你可以重新生成二维码或手动重启 Gateway 后再试。',
                    status: '个人微信状态检查未通过，请重新扫码或稍后重试。'
                });
                updateWeixinLoginView(patch);
                return;
            }

            Object.assign(patch, {
                weixinLoginPhase: 'checking',
                weixinLoginSummary: '仍在等待连接确认',
                weixinLoginDetail: '已执行状态检查，但当前还没有拿到明确的成功标志。可以稍后再检查一次。',
                status: '个人微信正在等待连接确认。'
            });
            updateWeixinLoginView(patch);
        }

        function beginWeixinLoginFlow(flow, command, title, detail) {
            const sessionId = window.__openclawRunCommand?.(command, {
                title,
                sourceLabel: '消息渠道',
                interactive: flow !== 'install',
                autoReveal: false,
                commandOptions: {
                    lightweight: true
                }
            });
            if (!sessionId) {
                updateWeixinLoginView({
                    weixinLoginPhase: 'failure',
                    weixinLoginSummary: '登录命令未能启动',
                    weixinLoginDetail: '当前环境无法创建扫码登录会话，请检查 Electron 命令桥接是否可用。'
                });
                return false;
            }
            resetWeixinLoginState({
                flow,
                phase: flow === 'install' ? 'installing' : flow === 'auto' ? 'installing' : 'waiting-scan',
                summary: flow === 'install'
                    ? '正在安装 / 升级个人微信插件'
                    : flow === 'auto'
                        ? '正在准备自动安装流程'
                        : '正在生成手动登录二维码',
                detail,
                rawLog: flow === 'install'
                    ? '[安装] 命令已启动，正在等待插件安装 / 升级输出...'
                    : '[扫码登录] 命令已启动，正在等待 OpenClaw CLI 输出二维码或链接；如果长时间没有输出，请直接点“检查状态”确认是否已经进入登录流程。',
                sessionId,
                startedAt: Date.now()
            });
            state.weixinLogRevealKey = '';
            scheduleWeixinLoginTimeout(flow);
            if (flow !== 'install') {
                scheduleWeixinRuntimePulse('login');
            }
            render();
            const logEl = container.querySelector('#channelWeixinConsoleLog') || container.querySelector('#channelWeixinLogContent');
            if (logEl) {
                scrollChannelLogElement(logEl, { reveal: true });
            }
            return true;
        }

        function renderWeixinLoginConsoleCard() {
            const hasQr = Boolean(state.weixinLoginAsciiQr);
            const hasLink = Boolean(state.weixinLoginLink);
            const runtimeDisplay = getWeixinRuntimeDisplayState();
            const runtimeLogSource = getCombinedWeixinRuntimeLog(runtimeDisplay.snapshot?.logText || '');
            const rawLogPreview = runtimeLogSource
                ? runtimeLogSource.split('\n').slice(-180).join('\n')
                : runtimeDisplay.logPlaceholder;
            const digestLog = buildWeixinUserFacingRuntimeLog(runtimeLogSource, {
                runtimeActive: runtimeDisplay.runtimeActive,
                elapsedMs: runtimeDisplay.elapsedMs,
                phase: state.weixinLoginPhase
            });
            const runtimeNotice = getWeixinRuntimeNoticeState(state);
            return `
                <div class="ocp-card" style="margin-bottom:16px">
                    <div class="ocp-card-title">扫码日志 · 个人微信 V1</div>
                    <div class="ocp-row-meta">${esc(state.weixinLoginSummary || '等待扫码')}</div>
                    <div class="ocp-row-meta">${esc(state.weixinLoginDetail || '扫码日志会实时显示在这里。')}</div>
                    ${runtimeNotice ? `
                        <div class="ocp-channel-runtime-notice tone-${esc(runtimeNotice.tone)}">
                            <div class="ocp-channel-runtime-eyebrow">${esc(runtimeNotice.eyebrow)}</div>
                            <div class="ocp-channel-runtime-title">${esc(runtimeNotice.title)}</div>
                            <div class="ocp-channel-runtime-detail">${esc(runtimeNotice.detail)}</div>
                        </div>
                    ` : ''}
                    <div class="ocp-channel-login-surface" style="margin-top:10px">
                        <div class="ocp-row-meta">${hasLink ? `扫码链接：${esc(state.weixinLoginLink)}` : esc(runtimeDisplay.linkPlaceholder)}</div>
                        ${hasLink ? `<a class="ocp-link-button" href="${esc(state.weixinLoginLink)}" target="_blank" rel="noreferrer">打开扫码链接</a>` : ''}
                        ${buildWeixinQrVisualHtml({
                            link: state.weixinLoginLink,
                            asciiQr: state.weixinLoginAsciiQr,
                            placeholder: runtimeDisplay.qrPlaceholder
                        })}
                        <div class="ocp-channel-log-section">
                            <div class="ocp-channel-log-heading">关键进展</div>
                            <pre class="ocp-channel-login-digest">${esc(digestLog || runtimeDisplay.logPlaceholder)}</pre>
                        </div>
                        <details class="ocp-channel-login-raw">
                            <summary>查看原始日志</summary>
                            <pre class="ocp-channel-login-log" id="channelWeixinConsoleLog">${esc(rawLogPreview)}</pre>
                        </details>
                    </div>
                </div>
            `;
        }

        function renderWeixinLoginPanel() {
            const bindingComplete = isWeixinBindingComplete(state.selected);
            return `
                <div class="ocp-detail-group ocp-channel-login-shell" id="channelWeixinLoginPanel">
                    <div class="ocp-card-title">个人微信接入状态</div>
                    <div class="ocp-inline-status tone-${esc(state.weixinLoginTone)}">${esc(state.weixinLoginSummary)}</div>
                    <div class="ocp-row-meta">${esc(bindingComplete ? '微信已接入 / 微信绑定完成，可以直接关闭编辑窗口。' : '请点击“编辑接入”打开统一接入弹窗，在弹窗里直接完成安装、升级和扫码登录。')}</div>
                    <div class="ocp-row-meta">${esc(bindingComplete ? '当前 V1 仅保留单账号接入；后续 V2 会扩展多账号能力。' : state.weixinLoginDetail)}</div>
                </div>
            `;
        }

        function handleWeixinCommandObserver(event) {
            if (!event?.id) return;
            const snapshot = event.session || window.__openclawGetCommandSessionSnapshot?.(event.id);
            const logText = String(snapshot?.logText || '');

            if (event.id === state.weixinLoginSessionId) {
                if (state.weixinLoginFlow === 'install') {
                    if (logText) {
                        const shouldReveal = state.weixinLogRevealKey !== event.id;
                        if (shouldReveal) {
                            state.weixinLogRevealKey = event.id;
                        }
                        updateWeixinLoginView({
                            weixinLoginRawLog: logText,
                            weixinLoginPhase: event.type === 'finished'
                                ? ((event.code === 0 || event.code === '0') ? 'success' : 'failure')
                                : 'installing',
                            weixinLoginSummary: event.type === 'finished'
                                ? ((event.code === 0 || event.code === '0') ? '个人微信插件安装完成' : '个人微信插件安装失败')
                                : '正在安装 / 升级个人微信插件',
                            weixinLoginDetail: event.type === 'finished'
                                ? ((event.code === 0 || event.code === '0')
                                    ? '参考项目同款安装命令已执行完成，插件状态已重新检测。'
                                    : '安装命令已经结束，但没有成功完成，请检查上方日志。')
                                : '正在执行 npx -y @tencent-weixin/openclaw-weixin-cli@latest install',
                            revealLog: shouldReveal
                        });
                    }
                    if (event.type === 'finished') {
                        clearWeixinRuntimePulse();
                        state.weixinLoginFinished = true;
                        void refreshWeixinPluginStatus();
                    }
                    return;
                }
                if (event.type === 'started' && !logText) {
                    updateWeixinLoginView({
                        weixinLoginRawLog: buildWeixinRuntimeLog(
                            state.weixinLoginRawLog,
                            state.weixinLoginFlow === 'auto'
                                ? '[自动安装] 命令已启动，当前尚未收到 CLI 输出；安装器通常会先检查环境，再继续输出二维码或登录状态。'
                                : '[扫码登录] 命令已启动，当前尚未收到 CLI 输出；如果长时间没有日志，请直接点“检查状态”。'
                        ),
                        weixinLoginPhase: state.weixinLoginFlow === 'auto' ? 'installing' : 'waiting-scan',
                        weixinLoginSummary: state.weixinLoginFlow === 'auto' ? '正在准备自动安装流程' : '扫码命令已启动',
                        weixinLoginDetail: state.weixinLoginFlow === 'auto'
                            ? '当前正在等待安装器输出环境检查、二维码或后续状态信号。'
                            : '当前正在等待 OpenClaw CLI 输出二维码、链接或后续状态信号。'
                    });
                    scheduleWeixinRuntimePulse('login');
                }
                if (logText) {
                    const shouldReveal = state.weixinLogRevealKey !== event.id;
                    if (shouldReveal) {
                        state.weixinLogRevealKey = event.id;
                    }
                    applyWeixinLoginSignal(logText, {
                        allowAutoCheck: event.type === 'stream' || event.type === 'finished',
                        revealLog: shouldReveal
                    });
                }
                if (event.type === 'finished') {
                    clearWeixinRuntimePulse();
                    state.weixinLoginFinished = true;
                    if (!(event.code === 0 || event.code === '0') && state.weixinLoginPhase !== 'expired') {
                        updateWeixinLoginView({
                            weixinLoginPhase: 'failure',
                            weixinLoginSummary: state.weixinLoginFlow === 'auto' ? '自动安装流已结束，但未确认成功' : '扫码命令已结束，但未确认成功',
                            weixinLoginDetail: state.weixinLoginFlow === 'auto'
                                ? '安装器命令已经退出，但没有拿到明确成功信号。请检查日志后重试，或改用“扫码登录”手动回退流。'
                                : '命令已经退出且没有拿到明确成功信号，请检查日志后重试，或使用手动回退流。'
                        });
                    } else if (['waiting-scan', 'scanned'].includes(state.weixinLoginPhase)) {
                        updateWeixinLoginView({
                            weixinLoginPhase: 'expired',
                            weixinLoginSummary: '二维码已结束等待',
                            weixinLoginDetail: state.weixinLoginFlow === 'auto'
                                ? '自动安装流已经结束。你可以重新执行“安装插件”，或先点击“检查状态”确认是否其实已经登录成功。'
                                : '当前命令已经结束。你可以重新生成二维码，或先点击“已完成扫码，检查状态”确认是否其实已经登录成功。'
                        });
                    }
                }
                return;
            }

            if (event.id === state.weixinStatusCheckSessionId) {
                if (event.type === 'finished') {
                    handleWeixinStatusCheckResult(logText, event.code);
                } else if (event.type === 'started' && !logText) {
                    updateWeixinLoginView({
                        weixinStatusCheckRawLog: buildWeixinRuntimeLog(
                            state.weixinStatusCheckRawLog,
                            '[状态检查] 命令已启动，当前尚未收到 CLI 输出；界面会继续轮询运行状态。'
                        ),
                        weixinLoginPhase: 'checking',
                        weixinLoginSummary: '正在确认连接状态',
                        weixinLoginDetail: '状态检查命令已发出，正在等待明确结果。'
                    });
                    scheduleWeixinRuntimePulse('checking');
                } else if (logText) {
                    const shouldReveal = state.weixinLogRevealKey !== event.id;
                    if (shouldReveal) {
                        state.weixinLogRevealKey = event.id;
                    }
                    updateWeixinLoginView({
                        weixinStatusCheckRawLog: mergeWeixinRuntimeLog(state.weixinStatusCheckRawLog, logText),
                        weixinLoginPhase: 'checking',
                        weixinLoginSummary: '正在确认连接状态',
                        weixinLoginDetail: '状态检查命令已启动，正在等待明确结果。',
                        revealLog: shouldReveal
                    });
                }
                return;
            }

            if (event.id === state.weixinRestartSessionId) {
                if (logText) {
                    const shouldReveal = state.weixinLogRevealKey !== event.id;
                    if (shouldReveal) {
                        state.weixinLogRevealKey = event.id;
                    }
                    updateWeixinLoginView({
                        weixinStatusCheckRawLog: mergeWeixinRuntimeLog(state.weixinStatusCheckRawLog, logText),
                        weixinLoginPhase: 'checking',
                        weixinLoginSummary: '正在等待 Gateway 重启完成',
                        weixinLoginDetail: '重启命令已执行，完成后会自动继续检查个人微信连接状态。',
                        revealLog: shouldReveal
                    });
                }
                if (event.type === 'finished') {
                    if (event.code === 0 || event.code === '0') {
                        scheduleWeixinStatusCheck(1500, 'manual');
                    } else {
                        updateWeixinLoginView({
                            weixinLoginPhase: 'failure',
                            weixinLoginSummary: '网关重启失败',
                            weixinLoginDetail: '已经尝试重启 Gateway，但命令没有成功完成，请先查看日志。'
                        });
                    }
                }
            }
        }

        if (typeof window.__openclawRegisterCommandSessionObserver === 'function') {
            state.weixinLoginObserverDispose = window.__openclawRegisterCommandSessionObserver((event) => {
                handleWeixinCommandObserver(event);
            });
        }

        async function refreshChannelAccessStates(options = {}) {
            if (!isChannelsViewActive()) return;
            const probeNames = [
                'getChannelEnvironmentStatus',
                'getChannelInstallStatus',
                'getChannelAccessStatus',
                'getChannelBootstrapStatus'
            ].filter((name) => typeof window.api?.[name] === 'function');

            const background = options?.background === true;
            const finalizeLoading = () => {
                if (!background) {
                    state.channelAccessLoading = false;
                }
                if (document.body.contains(container) && !document.querySelector('.ocp-dialog-form') && isChannelsViewActive()) {
                    render();
                }
            };

            if (!probeNames.length) {
                state.channelAccess = {};
                finalizeLoading();
                return;
            }

            const selectedOnly = options?.selectedOnly === true && state.selected;
            const channelList = selectedOnly
                ? [state.selected]
                : Array.from(new Set([
                    ...PRIMARY_CHANNEL_ORDER,
                    ...getAvailableKeys(),
                    ...getChannelKeys(),
                    ...ensureArray(state.selected ? [state.selected] : [])
                ]));

            const refreshToken = ++state.channelAccessRefreshToken;
            if (!background) {
                state.channelAccessLoading = true;
            }
            if (!background && document.body.contains(container) && !document.querySelector('.ocp-dialog-form')) {
                render();
            }
            const nextAccess = {};
            try {
                if (probeNames.includes('getChannelEnvironmentStatus')) {
                    try {
                        if (selectedOnly) {
                            const selectedChannel = String(state.selected || '').trim();
                            const storedKey = resolveChannelStorageKey(selectedChannel, state.config);
                            const singleResult = await window.api.getChannelEnvironmentStatus({
                                mode: 'channel',
                                channel: storedKey,
                                deepProbe: false,
                                localOnly: true
                            });
                            const normalized = normalizeChannelAccessProbeResult(singleResult?.channel, storedKey);
                            if (normalized) {
                                nextAccess[storedKey] = normalized;
                                if (storedKey !== selectedChannel) {
                                    nextAccess[selectedChannel] = normalized;
                                }
                            }
                        } else {
                            const bulkResult = await window.api.getChannelEnvironmentStatus({
                                mode: 'channel',
                                deepProbe: false,
                                localOnly: true
                            });
                            const bulkChannels = ensureObject(bulkResult?.channels);
                            channelList.forEach((channelName) => {
                                const storedKey = resolveChannelStorageKey(channelName, state.config);
                                const raw = bulkChannels[storedKey] || bulkChannels[channelName];
                                const normalized = normalizeChannelAccessProbeResult(raw, storedKey);
                                if (normalized) {
                                    nextAccess[storedKey] = normalized;
                                    if (storedKey !== channelName) {
                                        nextAccess[channelName] = normalized;
                                    }
                                }
                            });
                        }
                    } catch (_) {}
                }

                const fallbackProbeNames = probeNames.filter((name) => name !== 'getChannelEnvironmentStatus');
                if (!Object.keys(nextAccess).length && fallbackProbeNames.length) {
                    await Promise.all(channelList.map(async (channelName) => {
                        const profile = getChannelProfile(channelName);
                        const storedKey = resolveChannelStorageKey(channelName, state.config);
                        const payload = {
                            channel: storedKey,
                            platform: channelName,
                            preset: channelName,
                            profile: profile.label || channelName,
                            mode: 'channel',
                            deepProbe: false,
                            localOnly: true
                        };

                        for (const probeName of fallbackProbeNames) {
                            try {
                                const result = await window.api[probeName](payload);
                                const normalized = normalizeChannelAccessProbeResult(result, storedKey);
                                if (normalized) {
                                    nextAccess[storedKey] = normalized;
                                    if (storedKey !== channelName) {
                                        nextAccess[channelName] = normalized;
                                    }
                                    return;
                                }
                            } catch (_) {}
                        }
                    }));
                }

                if (refreshToken !== state.channelAccessRefreshToken || !isChannelsViewActive()) return;
                state.channelAccess = nextAccess;
            } finally {
                if (refreshToken === state.channelAccessRefreshToken) {
                    finalizeLoading();
                } else if (!background) {
                    state.channelAccessLoading = false;
                }
            }
        }

        function getSelectedPairingChannel(channelName = state.selected) {
            const profile = getChannelProfile(channelName);
            return profile.pairingChannel || channelName;
        }

        function loadPairingFromCache(channelName = state.selected) {
            if (!supportsPairing(channelName)) return false;
            const pairingChannel = getSelectedPairingChannel(channelName);
            const cached = ensureObject(state.pairingCache[pairingChannel]);
            const cachedRequests = normalizePairingRequests(cached.requests);
            if (!cachedRequests.length) return false;
            state.pairing = cachedRequests;
            state.pairingChannel = pairingChannel;
            return true;
        }

        function savePairingToCache(channelName, requests) {
            const pairingChannel = getSelectedPairingChannel(channelName);
            state.pairingCache[pairingChannel] = {
                updatedAt: Date.now(),
                requests: normalizePairingRequests(requests)
            };
            saveChannelPairingCache(state.pairingCache);
        }

        async function ensureChannelInstalledBeforeSave(channelName, dialog) {
            if (typeof window.api?.getChannelEnvironmentStatus !== 'function' && !getChannelsSmokeApiOverride('getChannelEnvironmentStatus')) {
                return true;
            }
            const statusResult = await invokeChannelsApi('getChannelEnvironmentStatus', {
                channel: channelName,
                localOnly: true
            });
            const channelStatus = ensureObject(statusResult?.channel || statusResult?.channels?.[channelName]);
            const normalizedState = String(channelStatus.state || channelStatus.status || '').trim().toLowerCase();
            const needsInstall = channelStatus.needsInstallation === true
                || channelStatus.installed === false
                || /needs-install|missing|repair|absent|uninstalled|not installed/.test(normalizedState);
            if (!needsInstall) {
                return true;
            }
            const profile = getChannelProfile(channelName);
            dialog?.setStatus?.(`请先安装 ${profile.label || channelName} 插件环境，再保存配置，避免未安装先写配置。`);
            state.status = `已阻止 ${profile.label || channelName} 在未安装环境下写入配置`;
            if (isChannelsViewActive()) render();
            return false;
        }

        function openChannelEditorDialog(channelName) {
            if (isWeixinPersonalChannel(channelName)) {
                return openWeixinBindingDialog(channelName, { mode: 'connect' });
            }
            if (typeof window.showFormDialog !== 'function') return false;
            const currentConfig = ensureObject(state.config?.channels?.[channelName]);
            const profile = getChannelProfile(channelName, currentConfig);
            const isConfigured = getChannelKeys().includes(channelName);
            const draft = buildChannelDraft(channelName, currentConfig);
            const agentOptions = [
                { value: '__unbound__', label: '未绑定' },
                ...state.agents.map((agentId) => ({ value: agentId, label: agentId }))
            ];

            window.showFormDialog({
                title: `${isConfigured ? '编辑' : '接入'} ${profile.label || channelName}`,
                description: '先确认当前状态和 Agent 绑定，再按单列字段顺序填写渠道参数；需要的话可以在底部先做凭证校验。',
                confirmText: isConfigured ? '保存' : '接入并保存',
                fields: [
                    {
                        name: 'enabled',
                        label: '启用状态',
                        type: 'select',
                        value: currentConfig.enabled === false ? 'false' : 'true',
                        options: [
                            { value: 'true', label: '启用' },
                            { value: 'false', label: '停用' }
                        ],
                        hint: '保存后直接生效。'
                    },
                    {
                        name: 'agentBinding',
                        label: '绑定 Agent',
                        type: 'select',
                        value: getBoundAgent(state.config, channelName) || '__unbound__',
                        options: agentOptions,
                        hint: '不绑定时会使用默认 Agent。'
                    },
                ...profile.fields.map((field) => ({
                    ...field,
                    name: field.key,
                    value: getFieldValue(draft, field)
                }))
                ],
                onConfirm: async (values, dialog) => {
                    if (!(await ensureChannelInstalledBeforeSave(channelName, dialog))) {
                        return;
                    }
                    const next = clone(state.config);
                    next.channels = ensureObject(next.channels);
                    const nextDraft = buildChannelDraft(channelName, currentConfig);
                    nextDraft.enabled = String(values.enabled) !== 'false';
                    profile.fields.forEach((field) => applyFieldValue(nextDraft, field, values[field.key]));
                    const storageKey = resolveChannelStorageKey(channelName, next);
                    next.channels[storageKey] = serializeChannelDraft(storageKey, currentConfig, nextDraft);
                    if (storageKey !== channelName) {
                        delete next.channels[channelName];
                    }
                    setSingleChannelBinding(next, storageKey, String(values.agentBinding || '__unbound__'));

                    const result = await window.api.writeOpenClawConfig(next);
                    if (!result?.ok) throw new Error(result?.error || '保存失败');

                    state.config = next;
                    state.selected = storageKey;
                    state.pairing = [];
                    state.pairingChannel = '';
                    state.status = `${isConfigured ? '已更新' : '已接入'} ${storageKey}`;
                    dialog.close();
                    render();
                    await refreshChannelAccessStates();
                    render();
                },
                onClose: () => {
                    resumeChannelsRefreshAfterDialog();
                }
            });
            deferChannelDialogWork(() => {
                const dialogStateItems = getChannelStateDescriptors(state, channelName, {
                    profile,
                    channelConfig: currentConfig,
                    probe: getChannelAccessProbe(state, channelName)
                });
                decorateChannelDialogModal(profile, {
                    banner: {
                        tone: isConfigured ? 'info' : 'warning',
                        text: isConfigured
                            ? '当前渠道已存在配置，修改后会直接覆盖并保留已有绑定。'
                            : '当前渠道还未完成接入，建议先按引导核对字段，再保存。'
                    },
                    contextTitle: '当前状态',
                    contextDescription: '先确认环境、配置和连接状态，再决定是直接保存、先校验，还是回到主按钮继续补齐。',
                    contextItems: dialogStateItems,
                    showGuide: false,
                    pairingChannel: isConfigured ? channelName : '',
                    pairingCache: state.pairingCache,
                    onSavePairingCache: savePairingToCache
                });
                wireChannelCredentialVerifyButton(() => channelName);
            });
            return true;
        }

        function openChannelCreateDialog(presetKey = '') {
            if (typeof window.showFormDialog !== 'function') return false;
            const resolvedPreset = normalizeChannelKey(presetKey) === 'dingtalk-connector'
                ? 'dingtalk'
                : (normalizeChannelKey(presetKey) || presetKeys()[0] || 'qqbot');
            const agentOptions = [
                { value: '__unbound__', label: '未绑定' },
                ...state.agents.map((agentId) => ({ value: agentId, label: agentId }))
            ];

            const buildCreateFields = (selectedPreset, carryValues = {}) => {
                const profile = getChannelProfile(selectedPreset);
                const previewDraft = buildChannelDraft(selectedPreset, presets[selectedPreset] || {});
                const isWeixinPreset = isWeixinPersonalChannel(selectedPreset);
                ensureArray(profile.fields).forEach((field) => {
                    if (Object.prototype.hasOwnProperty.call(carryValues, field.key)) {
                        applyFieldValue(previewDraft, field, carryValues[field.key]);
                    }
                });
                return [
                    {
                        name: 'channelId',
                        label: '平台 ID',
                        value: resolveCreateChannelIdForPreset(selectedPreset, carryValues.channelId || ''),
                        placeholder: isWeixinPreset ? WEIXIN_PERSONAL_CHANNEL_KEY : '例如 telegram / feishu / qqbot',
                        hint: isWeixinPreset
                            ? '个人微信 V1 当前使用固定单账号 ID：openclaw-weixin。后续 V2 会支持“新增账号”多开接入。'
                            : '平台 ID 会作为配置键保存。',
                        readonly: isWeixinPreset,
                        required: true
                    },
                    {
                        name: 'presetKey',
                        label: '平台模板',
                        type: 'select',
                        value: selectedPreset,
                        options: getAvailableKeys().map((key) => ({
                            value: key,
                            label: getChannelProfile(key).label || key
                        })),
                        hint: '模板决定默认字段结构。'
                    },
                    {
                        name: 'agentBinding',
                        label: '绑定 Agent',
                        type: 'select',
                        value: String(carryValues.agentBinding || getBoundAgent(state.config, selectedPreset) || '__unbound__'),
                        options: agentOptions,
                        hint: '不绑定时会使用默认 Agent。'
                    },
                    {
                        name: 'enabled',
                        label: '启用状态',
                        type: 'select',
                        value: String(carryValues.enabled || 'true'),
                        options: [
                            { value: 'true', label: '启用' },
                            { value: 'false', label: '停用' }
                        ]
                    },
                    ...profile.fields.map((field) => ({
                        ...field,
                        name: field.key,
                        value: Object.prototype.hasOwnProperty.call(carryValues, field.key)
                            ? carryValues[field.key]
                            : getFieldValue(previewDraft, field)
                    }))
                ];
            };

            window.showFormDialog({
                title: `新建 ${getChannelProfile(resolvedPreset).label || resolvedPreset}`,
                description: '先选择平台模板，再按单列字段填写接入参数；保存前可先做凭证校验。',
                confirmText: '创建并保存',
                fields: buildCreateFields(resolvedPreset),
                onConfirm: async (values, dialog) => {
                    const selectedPreset = normalizeChannelKey(values.presetKey || resolvedPreset);
                    const normalizedPreset = selectedPreset === 'dingtalk-connector' ? 'dingtalk' : selectedPreset;
                    if (!(await ensureChannelInstalledBeforeSave(normalizedPreset, dialog))) {
                        return;
                    }
                    const trimmedId = resolveCreateChannelIdForPreset(normalizedPreset, values.channelId || '');
                    const selectedProfile = getChannelProfile(normalizedPreset);
                    if (!trimmedId) {
                        dialog.setStatus('平台 ID 不能为空');
                        return;
                    }
                    if (getChannelKeys().includes(trimmedId)) {
                        dialog.setStatus(`平台 ${trimmedId} 已存在`);
                        return;
                    }

                    const next = clone(state.config);
                    next.channels = ensureObject(next.channels);
                    const draft = buildChannelDraft(normalizedPreset || trimmedId, presets[normalizedPreset] || {});
                    draft.enabled = String(values.enabled) !== 'false';
                    ensureArray(selectedProfile.fields).forEach((field) => applyFieldValue(draft, field, values[field.key]));
                    const storageKey = resolveChannelStorageKey(trimmedId, next);
                    next.channels[storageKey] = serializeChannelDraft(storageKey, {}, draft);
                    if (storageKey !== trimmedId) {
                        delete next.channels[trimmedId];
                    }
                    setSingleChannelBinding(next, storageKey, String(values.agentBinding || '__unbound__'));

                    const result = await window.api.writeOpenClawConfig(next);
                    if (!result?.ok) throw new Error(result?.error || '创建失败');

                    state.config = next;
                    state.selected = storageKey;
                    state.pairing = [];
                    state.pairingChannel = '';
                    state.status = isWeixinPersonalChannel(normalizedPreset)
                        ? '已写入个人微信 V1 接入配置，可继续扫码绑定。'
                        : `已创建 ${storageKey}`;
                    dialog.close();
                    render();
                    await refreshChannelAccessStates();
                    render();
                    if (isWeixinPersonalChannel(normalizedPreset)) {
                        setTimeout(() => {
                            if (!isChannelsViewActive() || !isWeixinPersonalChannel(state.selected)) return;
                            openWeixinBindingDialog(trimmedId, { mode: 'connect' });
                        }, 60);
                    }
                }
            });
            wireChannelCredentialVerifyButton((values) => values.presetKey || resolvedPreset);
            const dialogs = Array.from(document.querySelectorAll('.ocp-dialog-form'));
            const modal = dialogs[dialogs.length - 1];
            if (!modal) return true;
            const titleEl = modal.querySelector('.ocp-dialog-title');
            const statusEl = modal.querySelector('[data-role="status"]');
            const actionsEl = modal.querySelector('.ocp-dialog-actions');
            const applyCreateDialogDecorations = (selectedPreset) => {
                const normalizedPreset = normalizeChannelKey(selectedPreset) === 'dingtalk-connector' ? 'dingtalk' : normalizeChannelKey(selectedPreset);
                const profile = getChannelProfile(normalizedPreset);
                decorateChannelDialogModal(profile, {
                    banner: {
                        tone: 'info',
                        text: isWeixinPersonalChannel(normalizedPreset)
                            ? '个人微信 V1 使用固定平台 ID，保存后会继续进入扫码接入流。'
                            : '先按模板补齐凭证和 Agent 绑定，再保存为新的消息渠道。'
                    },
                    contextTitle: '接入节奏',
                    contextDescription: '创建新渠道时只保留一个主完成动作，校验和模板说明作为辅助操作存在。',
                    contextItems: [
                        {
                            label: '模板',
                            value: profile.label || normalizedPreset,
                            detail: profile.desc || '当前模板决定字段结构与接入方式。',
                            tone: 'info'
                        },
                        {
                            label: '下一步',
                            value: isWeixinPersonalChannel(normalizedPreset) ? '安装并扫码' : '填写并校验',
                            detail: isWeixinPersonalChannel(normalizedPreset)
                                ? '保存后会继续进入个人微信扫码绑定，不会把你停留在空白页。'
                                : '建议先补齐关键凭证，再用“校验凭证”确认后保存。',
                            tone: 'warning'
                        },
                        {
                            label: '保存后',
                            value: '写入渠道配置',
                            detail: '保存只会写入当前渠道和 Agent 绑定，不会触发额外的重型页面刷新。',
                            tone: 'success'
                        }
                    ],
                    showGuide: true,
                    guideCollapsed: true,
                    pairingCache: state.pairingCache,
                    onSavePairingCache: savePairingToCache
                });
            };

            const rebuildDynamicFields = () => {
                const values = {};
                modal.querySelectorAll('[data-field]').forEach((field) => {
                    values[field.dataset.field] = field.value;
                });
                const selectedPreset = normalizeChannelKey(values.presetKey || resolvedPreset) || resolvedPreset;
                values.channelId = '';
                const fields = buildCreateFields(selectedPreset, values);
                const fieldHtml = fields.map((field) => {
                    const labelHtml = `<label class="ocp-dialog-label">${esc(field.label)}</label>`;
                    const descriptionHtml = (field.description || field.hint)
                        ? `<div class="ocp-dialog-field-copy">${esc(field.description || field.hint)}</div>`
                        : '';
                    const errorHtml = `<div class="ocp-dialog-field-error" data-role="field-error" data-field-error="${esc(field.name)}"></div>`;
                    if (field.type === 'select') {
                        return `
                            <div class="ocp-dialog-field">
                                ${labelHtml}
                                ${descriptionHtml}
                                <select data-field="${esc(field.name)}" ${field.readonly ? 'disabled' : ''} class="ocp-dialog-input ocp-dialog-select">
                                    ${(field.options || []).map(option => `<option value="${esc(option.value)}" ${String(option.value) === String(field.value) ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}
                                </select>
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
                                data-field="${esc(field.name)}"
                                type="${esc(inputType)}"
                                value="${esc(field.value ?? '')}"
                                placeholder="${esc(field.placeholder ?? '')}"
                                ${field.readonly ? 'readonly' : ''}
                                class="ocp-dialog-input ${field.readonly ? 'is-readonly' : ''}">
                            ${errorHtml}
                        </div>
                    `;
                }).join('');

                modal.querySelectorAll('.ocp-dialog-field').forEach((node) => node.remove());
                actionsEl.insertAdjacentHTML('beforebegin', fieldHtml);
                const nextPreset = normalizeChannelKey(selectedPreset) === 'dingtalk-connector' ? 'dingtalk' : selectedPreset;
                if (titleEl) {
                    titleEl.textContent = `新建 ${getChannelProfile(nextPreset).label || nextPreset}`;
                }
                if (statusEl) {
                    statusEl.textContent = '';
                    statusEl.style.color = '#8f98ab';
                }
                const nextPresetSelect = modal.querySelector('[data-field="presetKey"]');
                if (nextPresetSelect) {
                    nextPresetSelect.onchange = rebuildDynamicFields;
                }
                applyCreateDialogDecorations(nextPreset);
            };

            const presetSelect = modal.querySelector('[data-field="presetKey"]');
            if (presetSelect && actionsEl) {
                presetSelect.onchange = rebuildDynamicFields;
            }
            applyCreateDialogDecorations(resolvedPreset);
            return true;
        }

        async function installChannelEnvironmentFlow(channelName, actionState = null, options = {}) {
            if (typeof window.api?.installChannelEnvironment !== 'function') {
                state.status = '当前版本不支持自动安装渠道环境';
                render();
                return false;
            }

            const profile = getChannelProfile(channelName);
            const isBuiltIn = profile?.builtIn === true;
            const source = isBuiltIn
                ? { value: 'builtin', label: '内置渠道', registry: '' }
                : await chooseChannelInstallSource(channelName);
            if (!source) return false;

            const requestId = createChannelInstallRequestId(channelName);
            const logState = getChannelInstallLogState(channelName, requestId);
            logState.text = '';
            logState.done = false;
            logState.phase = 'start';
            logState.updatedAt = Date.now();
            logState.sourceLabel = source.label || source.registry || '所选源';
            state.channelInstallLogRevealKey = '';
            state.installingChannel = channelName;
            state.installingRequestId = requestId;
            state.status = isBuiltIn
                ? `正在校验 ${profile.label || channelName} 的内置渠道环境...`
                : `正在通过 ${source.label || source.registry || '所选源'} 安装 ${profile.label || channelName} 渠道环境...`;
            render();
            updateChannelInstallLogPanel(channelName, { reveal: true });

            let result = null;
            try {
                result = await window.api.installChannelEnvironment({
                    channel: channelName,
                    registryChoice: source.value,
                    registry: source.registry,
                    requestId,
                    restartMode: getPreferredDashboardRestartMode(),
                    force: options.force === true
                });
                state.config = await readConfig();
                await refreshChannelAccessStates({ selectedOnly: true });
            } catch (error) {
                result = {
                    ok: false,
                    error: error.message || String(error)
                };
            } finally {
                state.installingChannel = '';
                state.installingRequestId = '';
                getChannelInstallLogState(channelName, requestId).done = true;
            }

            if (result?.ok) {
                state.status = result?.message
                    ? `${result.message}（${source.label || source.registry || '所选源'}）`
                    : `${profile.label || channelName} 环境安装完成（${source.label || source.registry || '所选源'}）`;
                const gatewayCheck = ensureObject(result?.gatewayCheck);
                const verification = ensureObject(result?.verification);
                if (gatewayCheck.restart || gatewayCheck.status) {
                    const gatewayBits = [];
                    if (gatewayCheck.restart) {
                        gatewayBits.push(gatewayCheck.restart.ok ? '网关已自动重启' : '网关自动重启失败');
                    }
                    if (gatewayCheck.status) {
                        gatewayBits.push(gatewayCheck.status.ok ? '状态检查通过' : '状态检查未通过');
                    }
                    if (gatewayBits.length) {
                        state.status = `${state.status}；${gatewayBits.join('，')}`;
                    }
                }
                if (verification.plugin || verification.doctor || verification.channels) {
                    const verifyBits = [];
                    if (verification.plugin) {
                        verifyBits.push(verification.plugin.ok ? '插件检测通过' : '插件检测未通过');
                    }
                    if (verification.doctor) {
                        verifyBits.push(verification.doctor.ok ? 'doctor 通过' : 'doctor 未通过');
                    }
                    if (verification.channels) {
                        verifyBits.push(verification.channels.ok ? '渠道状态已探测' : '渠道状态未探测');
                    }
                    if (verifyBits.length) {
                        state.status = `${state.status}；${verifyBits.join('，')}`;
                    }
                }
                state.status = `${state.status}；插件安装完成后不会自动打开配置弹窗，请手动继续配置。`;
                render();
                if (isWeixinPersonalChannel(channelName)) {
                    const pluginStatus = await refreshWeixinPluginStatus({ refresh: true });
                    const compatibilityMessage = getWeixinPluginCompatibilityMessage(pluginStatus, '');
                    state.status = compatibilityMessage || '个人微信插件安装完成，请继续扫码接入。';
                    if (options.inlineWeixin === true) {
                        updateWeixinLoginView({
                            weixinLoginPhase: compatibilityMessage ? 'failure' : 'idle',
                            weixinLoginSummary: compatibilityMessage ? '插件版本不兼容' : '插件安装完成',
                            weixinLoginDetail: compatibilityMessage || '插件已升级到兼容版本，请继续执行扫码登录。',
                            weixinLoginLink: '',
                            weixinLoginAsciiQr: '',
                            status: state.status
                        });
                        refreshWeixinDialogRuntimeUI();
                    }
                    render();
                    scheduleDeferredChannelsRefresh({
                        refreshAgents: false,
                        selectedOnly: true,
                        backgroundFullRefresh: true
                    });
                    if (options.reopenWeixinDialog !== false) {
                        setTimeout(() => {
                            if (!isChannelsViewActive() || !isWeixinPersonalChannel(state.selected)) return;
                            openWeixinBindingDialog(channelName, { mode: 'connect' });
                        }, 80);
                    }
                }
                return true;
            }

            const hintText = String(result?.installHint || '').trim();
            const errorText = String(result?.error || '').trim();
            const sourceText = source.label || source.registry || '所选源';
            const logEntry = getChannelInstallLogState(channelName, requestId);
            const attemptOutput = Array.isArray(result?.attempts)
                ? result.attempts
                    .map((item) => String(item?.output || '').trim())
                    .filter(Boolean)
                    .join('\n\n')
                : '';
            const finalErrorLog = [errorText, attemptOutput]
                .map((item) => String(item || '').trim())
                .filter(Boolean)
                .join('\n\n');
            if (finalErrorLog) {
                const currentText = String(logEntry.text || '').trim();
                logEntry.text = trimChannelInstallLogText(currentText
                    ? `${currentText}\n\n[FINAL ERROR]\n${finalErrorLog}`
                    : `[FINAL ERROR]\n${finalErrorLog}`);
                logEntry.updatedAt = Date.now();
                logEntry.phase = 'done';
            }
            const extraHint = /CERT_HAS_EXPIRED/i.test(errorText) && String(source.value || '') === 'taobao'
                ? ' 淘宝源当前已映射到 npmmirror；如果依旧失败，请改用 npm 官方或华为云后重试。'
                : /Package not found on npm:/i.test(errorText)
                    ? ' 当前安装包在所选源中不存在，请确认插件包名或更换为正确的官方安装命令。'
                    : '';
            state.status = hintText
                ? `${errorText || `${profile.label || channelName} 环境安装失败`}（${sourceText}） ${hintText}${extraHint}`
                : `${errorText || `${profile.label || channelName} 环境安装失败`}（${sourceText}）${extraHint}`;
            if (isWeixinPersonalChannel(channelName) && options.inlineWeixin === true) {
                updateWeixinLoginView({
                    weixinLoginPhase: 'failure',
                    weixinLoginSummary: '个人微信插件安装失败',
                    weixinLoginDetail: state.status,
                    status: state.status
                });
                refreshWeixinDialogRuntimeUI();
            }
            render();
            updateChannelInstallLogPanel(channelName);
            return false;
        }

        function wireChannelCredentialVerifyButton(platformResolver) {
            if (typeof window.api?.verifyChannelCredentials !== 'function') return;

            const attach = () => {
                const dialogs = Array.from(document.querySelectorAll('.ocp-dialog-form'));
                const modal = dialogs[dialogs.length - 1];
                if (!modal || modal.querySelector('[data-channel-verify]')) return;

                const actions = modal.querySelector('.ocp-dialog-actions');
                const statusEl = modal.querySelector('[data-role="status"]');
                const confirmBtn = modal.querySelector('[data-action="confirm"]');
                if (!actions || !statusEl || !confirmBtn) return;

                const verifyBtn = document.createElement('button');
                verifyBtn.type = 'button';
                verifyBtn.className = 'ocp-dialog-btn';
                verifyBtn.dataset.channelVerify = '1';
                verifyBtn.textContent = '校验凭证';

                verifyBtn.onclick = async () => {
                    if (verifyBtn.disabled) return;
                    const values = {};
                    modal.querySelectorAll('[data-field]').forEach((field) => {
                        values[field.dataset.field] = field.value;
                    });

                    const resolvedPlatform = typeof platformResolver === 'function'
                        ? platformResolver(values)
                        : platformResolver;
                    const platform = normalizeChannelKey(resolvedPlatform) === 'dingtalk-connector'
                        ? 'dingtalk'
                        : normalizeChannelKey(resolvedPlatform);
                    const profile = getChannelProfile(platform);
                    const missingField = ensureArray(profile.fields).find((field) => field.required && !String(values[field.key] || '').trim());
                    if (missingField) {
                        statusEl.style.color = '#fc9867';
                        statusEl.textContent = `请先填写“${missingField.label}”再校验`;
                        return;
                    }

                    verifyBtn.disabled = true;
                    confirmBtn.disabled = true;
                    statusEl.style.color = '#8f98ab';
                    statusEl.textContent = '校验中...';

                    try {
                        const result = await window.api.verifyChannelCredentials({ platform, form: values });
                        const detailText = [
                            ...(Array.isArray(result?.details) ? result.details : []),
                            ...(Array.isArray(result?.warnings) ? result.warnings : [])
                        ].filter(Boolean).join('；');
                        if (result?.valid) {
                            statusEl.style.color = '#7ee081';
                            statusEl.textContent = detailText ? `校验通过：${detailText}` : '校验通过';
                        } else {
                            statusEl.style.color = '#ff8080';
                            const errorText = Array.isArray(result?.errors) ? result.errors.filter(Boolean).join('；') : '';
                            statusEl.textContent = errorText ? `校验失败：${errorText}` : '校验失败';
                        }
                    } catch (error) {
                        statusEl.style.color = '#ff8080';
                        statusEl.textContent = error?.message || String(error);
                    } finally {
                        verifyBtn.disabled = false;
                        confirmBtn.disabled = false;
                    }
                };

                actions.insertBefore(verifyBtn, actions.firstChild);
            };

            requestAnimationFrame(attach);
            setTimeout(attach, 0);
        }

        const refreshPairing = async (options = {}) => {
            if (!state.selected) return;
            const selectedProfile = getChannelProfile(state.selected);
            const pairingChannel = selectedProfile.pairingChannel || state.selected;
            if (!supportsPairing(state.selected)) {
                state.pairing = [];
                state.pairingChannel = state.selected;
                if (!options.background) render();
                return;
            }
            const requestId = ++state.pairingRequestId;
            if (!options.force && loadPairingFromCache(state.selected) && !options.background) {
                render();
            }
            try {
                const selectedChannel = state.selected;
                const result = await window.api.listPairingRequests({ channel: pairingChannel });
                if (!isChannelsViewActive()) return;
                if (requestId !== state.pairingRequestId || selectedChannel !== state.selected) return;
                state.pairing = result?.ok ? normalizePairingRequests(result.requests) : [];
                state.pairingChannel = pairingChannel;
                if (result?.ok) {
                    savePairingToCache(selectedChannel, state.pairing);
                }
                if (!result?.ok) state.status = result?.error || '加载配对请求失败';
                if (isChannelsViewActive()) render();
            } catch (error) {
                if (!state.selected || requestId !== state.pairingRequestId || !isChannelsViewActive()) return;
                state.pairing = [];
                state.pairingChannel = getChannelProfile(state.selected).pairingChannel || state.selected;
                state.status = error.message || String(error);
                if (isChannelsViewActive()) render();
            }
        };

        const render = () => {
            const channelKeys = getChannelKeys();
            const availableKeys = getAvailableKeys();
            const selectedProfile = getChannelProfile(state.selected);
            const selectedConfig = ensureObject(state.config?.channels?.[state.selected]);
            const selectedProbe = getChannelAccessProbe(state, state.selected);
            const boundAgent = state.selected ? getBoundAgent(state.config, state.selected) : 'main';
            const pairingSupported = supportsPairing(state.selected);
            const isWeixinChannel = isWeixinPersonalChannel(state.selected);
            const selectedActionState = state.selected
                ? getChannelAccessActionState(state, state.selected, {
                    profile: selectedProfile,
                    channelConfig: selectedConfig,
                    probe: selectedProbe
                })
                : null;
            const showInstallLog = hasChannelInstallLog(state.selected);
            const showWeixinConsole = shouldShowWeixinLoginConsole();
            const availableListKeys = availableKeys.filter((key) => !channelKeys.includes(key));
            const statusText = state.channelAccessLoading
                ? `${state.status || '正在检测渠道环境状态...'}`
                : (state.status || '');

            container.innerHTML = `
                <div class="ocp-shell">
                    ${renderHeader('通信接入', '统一管理消息渠道接入、Agent 绑定与配对审批。')}
                    ${renderChannelsOverview(state, {
                        channelKeys,
                        availableListKeys,
                        selectedChannel: state.selected,
                        selectedProfile,
                        selectedActionState
                    })}
                    <div class="ocp-toolbar ocp-channel-toolbar">
                        <div class="ocp-channel-toolbar-copy">
                            <div class="ocp-row-meta">页面状态</div>
                            <span class="${statusClass(state.status ? 'info' : 'muted')}" id="channelsStatus">${esc(statusText || '已完成当前通信接入状态整理。')}</span>
                        </div>
                    </div>
                    ${showWeixinConsole ? renderWeixinLoginConsoleCard() : (showInstallLog ? `
                        <div class="ocp-card" style="margin-bottom:16px">
                            <div class="ocp-card-title">安装日志${state.selected ? ` · ${esc(selectedProfile.label || state.selected)}` : ''}</div>
                            <div class="ocp-row-meta" id="channelInstallLogMeta">${esc(buildChannelInstallLogMeta(state.selected))}</div>
                            <pre id="channelInstallLog" style="margin:8px 0 0;padding:12px;max-height:260px;overflow:auto;border-radius:12px;background:#0b1220;color:#d7e3ff;font:12px/1.5 Consolas,'Courier New',monospace;white-space:pre-wrap;word-break:break-word;">${esc(String(ensureObject(state.installLogs[normalizeChannelKey(state.selected)])?.text || '').trim())}</pre>
                        </div>
                    ` : '')}
                    <section class="ocp-card ocp-channel-surface">
                        <div class="ocp-channel-surface-head">
                            <div class="ocp-channel-surface-eyebrow">Connected</div>
                            <div class="ocp-card-title">已接入渠道</div>
                            <div class="ocp-row-meta">先看当前已生效的消息渠道，再决定继续编辑、停用或移除。</div>
                        </div>
                        ${renderChannelListSection(
                            '当前已写入配置的渠道',
                            '点击卡片可高亮当前渠道；主按钮用于继续编辑或补全接入。',
                            channelKeys,
                            state,
                            '当前还没有已接入的平台。'
                        )}
                    </section>
                    <section class="ocp-card ocp-channel-surface">
                        <div class="ocp-channel-surface-head">
                            <div class="ocp-channel-surface-eyebrow">Available</div>
                            <div class="ocp-card-title">可接入渠道</div>
                            <div class="ocp-row-meta">从模板里直接选择渠道开始接入，优先打开对应的编辑弹窗，不再堆额外说明区。</div>
                        </div>
                        ${renderChannelListSection(
                            '可直接接入的平台模板',
                            '选择模板后可直接打开弹窗开始填写接入参数。',
                            availableListKeys,
                            state,
                            '当前没有可直接接入的平台。',
                            { variant: 'available' }
                        )}
                    </section>
                </div>
            `;

            const statusEl = container.querySelector('#channelsStatus');
            container.querySelectorAll('[data-channel-select]').forEach(card => {
                card.onclick = () => {
                    const channelName = card.getAttribute('data-channel-select');
                    state.selected = channelName;
                    state.pairing = [];
                    state.pairingChannel = '';
                    loadPairingFromCache(channelName);
                    render();
                };
            });
            container.querySelectorAll('[data-channel-open]').forEach(button => {
                button.onclick = () => {
                    const channelName = button.getAttribute('data-channel-open');
                    state.selected = channelName;
                    state.pairing = [];
                    state.pairingChannel = '';
                    loadPairingFromCache(channelName);
                    render();
                };
            });
            container.querySelectorAll('[data-channel-main-action]').forEach(button => {
                button.onclick = async (event) => {
                    event?.stopPropagation?.();
                    const channelName = button.getAttribute('data-channel-main-action');
                    const actionKind = button.getAttribute('data-channel-main-kind') || 'create';
                    state.selected = channelName;
                    state.pairing = [];
                    state.pairingChannel = '';
                    loadPairingFromCache(channelName);
                    const actionState = getChannelAccessActionState(state, channelName, {
                        profile: getChannelProfile(channelName),
                        channelConfig: ensureObject(state.config?.channels?.[channelName]),
                        probe: getChannelAccessProbe(state, channelName)
                    });
                    if (actionKind === 'install') {
                        await installChannelEnvironmentFlow(channelName, actionState);
                        return;
                    }
                    suspendChannelsRefreshForDialog();
                    const opened = isWeixinPersonalChannel(channelName)
                        ? openWeixinBindingDialog(channelName, { mode: 'connect' })
                        : (actionKind === 'edit'
                            ? openChannelEditorDialog(channelName)
                            : openChannelCreateDialog(channelName));
                    if (!opened) {
                        resumeChannelsRefreshAfterDialog();
                        state.status = '当前环境不支持弹窗表单';
                        render();
                    }
                };
            });
            container.querySelectorAll('[data-channel-edit]').forEach(button => {
                button.onclick = (event) => {
                    event?.stopPropagation?.();
                    const channelName = button.getAttribute('data-channel-edit');
                    state.selected = channelName;
                    state.pairing = [];
                    state.pairingChannel = '';
                    loadPairingFromCache(channelName);
                    suspendChannelsRefreshForDialog();
                    if (!openChannelEditorDialog(channelName)) {
                        resumeChannelsRefreshAfterDialog();
                        render();
                    }
                };
            });
            container.querySelectorAll('[data-channel-create]').forEach(button => {
                button.onclick = (event) => {
                    event?.stopPropagation?.();
                    const presetKey = button.getAttribute('data-channel-create');
                    state.selected = presetKey;
                    state.pairing = [];
                    state.pairingChannel = '';
                    loadPairingFromCache(presetKey);
                    const opened = isWeixinPersonalChannel(presetKey)
                        ? openWeixinBindingDialog(resolveCreateChannelIdForPreset(presetKey, ''), { mode: 'connect' })
                        : openChannelCreateDialog(presetKey);
                    if (!opened) {
                        render();
                    }
                };
            });
            container.querySelectorAll('[data-channel-toggle]').forEach(button => {
                button.onclick = async (event) => {
                    event?.stopPropagation?.();
                    const channelName = button.getAttribute('data-channel-toggle');
                    const next = clone(state.config);
                    next.channels = ensureObject(next.channels);
                    const current = ensureObject(next.channels[channelName]);
                    current.enabled = current.enabled === false;
                    next.channels[channelName] = current;
                    setSingleChannelBinding(next, channelName, getBoundAgent(next, channelName));
                    const result = await window.api.writeOpenClawConfig(next);
                    if (!result?.ok) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = result?.error || '切换状态失败';
                        return;
                    }
                    state.config = next;
                    state.status = `${channelName} 已更新`;
                    await refreshChannelAccessStates();
                    render();
                };
            });
            container.querySelectorAll('[data-channel-remove]').forEach(button => {
                button.onclick = async (event) => {
                    event?.stopPropagation?.();
                    const channelName = button.getAttribute('data-channel-remove');
                    const yes = typeof window.showConfirmDialog === 'function'
                        ? await window.showConfirmDialog(`确认移除消息渠道 ${channelName}？`, { confirmText: '移除' })
                        : window.confirm(`确认移除消息渠道 ${channelName}？`);
                    if (!yes) return;
                    const next = clone(state.config);
                    delete ensureObject(next.channels)[channelName];
                    setSingleChannelBinding(next, channelName, '__unbound__');
                    const result = await window.api.writeOpenClawConfig(next);
                    if (!result?.ok) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = result?.error || '移除失败';
                        return;
                    }
                    state.config = next;
                    state.selected = getChannelKeys()[0] || getAvailableKeys()[0] || 'qqbot';
                    state.pairing = [];
                    state.pairingChannel = '';
                    loadPairingFromCache(state.selected);
                    state.status = `已移除 ${channelName}`;
                    await refreshChannelAccessStates();
                    render();
                };
            });
            container.querySelector('#channelsReloadBtn').onclick = async () => {
                try {
                    state.config = await readConfig();
                    await refreshChannelAccessStates();
                    state.status = '已刷新';
                    state.pairing = [];
                    state.pairingChannel = '';
                    if (!getChannelKeys().includes(state.selected)) state.selected = getChannelKeys()[0] || getAvailableKeys()[0] || 'qqbot';
                    loadPairingFromCache(state.selected);
                    render();
                } catch (error) {
                    statusEl.className = statusClass('danger');
                    statusEl.textContent = error.message || String(error);
                }
            };
            container.querySelector('#channelsAddBtn').onclick = async () => {
                openChannelCreateDialog(state.selected || presetKeys()[0] || 'qqbot');
            };

            const expectedPairingChannel = getSelectedPairingChannel();
            if (state.selected && state.pairingChannel !== expectedPairingChannel && !state.pairingLoading) {
                state.pairingLoading = true;
                void refreshPairing({ background: state.pairing.length > 0 }).finally(() => {
                    state.pairingLoading = false;
                });
            }

            updateChannelInstallLogPanel(state.selected);
        };

        function scheduleDeferredChannelsRefresh(options = {}) {
            cleanupChannelsPageLifecycle();
            loadPairingFromCache(state.selected);
            state.channelAccessLoading = true;
            if (isChannelsViewActive() && !document.querySelector('.ocp-dialog-form')) {
                render();
            }

            const channelProbeDelayMs = channelEnvironmentColdProbePending ? 1200 : 900;
            const refreshAgents = options.refreshAgents !== false;
            const selectedOnly = options.selectedOnly === true;
            const backgroundFullRefresh = options.backgroundFullRefresh === true;
            const forcePairingRefresh = options.forcePairingRefresh === true;
            const channelAgentsDelayMs = 520;
            const channelPairingDelayMs = 480;
            const channelBackgroundProbeDelayMs = Math.max(channelProbeDelayMs + 1300, 2200);
            channelEnvironmentColdProbePending = false;

            if (refreshAgents) {
                state.channelAgentsTimer = window.setTimeout(() => {
                    state.channelAgentsTimer = null;
                    if (!isChannelsViewActive()) return;
                    void listAgents().then((agents) => {
                        if (!isChannelsViewActive()) return;
                        state.agents = ensureArray(agents).length ? agents : ['main'];
                        if (isChannelsViewActive() && !document.querySelector('.ocp-dialog-form')) {
                            render();
                        }
                    }).catch(() => {});
                }, channelAgentsDelayMs);
            }

            state.channelAccessTimer = window.setTimeout(() => {
                state.channelAccessTimer = null;
                if (!isChannelsViewActive()) return;
                void refreshChannelAccessStates({ selectedOnly }).then(() => {
                    if (isChannelsViewActive() && !document.querySelector('.ocp-dialog-form')) {
                        render();
                    }
                });
            }, channelProbeDelayMs);

            if (backgroundFullRefresh && selectedOnly) {
                state.channelAccessBackgroundTimer = window.setTimeout(() => {
                    state.channelAccessBackgroundTimer = null;
                    if (!isChannelsViewActive()) return;
                    void refreshChannelAccessStates({ background: true });
                }, channelBackgroundProbeDelayMs);
            }

            const expectedPairingChannel = state.selected
                ? (getChannelProfile(state.selected).pairingChannel || state.selected)
                : '';
            if (state.selected && (forcePairingRefresh || state.pairingChannel !== expectedPairingChannel) && !state.pairingLoading) {
                state.channelPairingTimer = window.setTimeout(() => {
                    state.channelPairingTimer = null;
                    if (!isChannelsViewActive()) return;
                    void refreshPairing({ background: state.pairing.length > 0 });
                }, channelPairingDelayMs);
            }
        }

        container.dataset.channelsMounted = '1';
        container.__openclawResumeChannelsPage = () => {
            if (!document.body.contains(container)) return;
            render();
            scheduleDeferredChannelsRefresh({
                selectedOnly: true,
                refreshAgents: !ensureArray(state.agents).length,
                backgroundFullRefresh: true,
                forcePairingRefresh: true
            });
        };

        scheduleDeferredChannelsRefresh();
    }
    async function renderMemoryCenterPage(container) {
        container.innerHTML = `<div class="ocp-shell">${renderHeader('记忆文件', '按 Agent 管理 memory、archive 和 core 文件。')}<div class="ocp-card">加载中...</div></div>`;
        const state = {
            agentId: 'main',
            category: 'memory',
            agents: ['main'],
            files: [],
            currentPath: '',
            content: '',
            dirty: false,
            contentCache: {},
            memoryCache: loadMemoryViewCache(),
            status: ''
        };
        try {
            state.agents = await listAgents();
            state.agentId = state.agents[0] || 'main';
        } catch (_) {}

        const memoryCacheKey = () => `${state.agentId}::${state.category}`;

        const loadMemoryFromCache = (preferredFile = '') => {
            const cached = ensureObject(state.memoryCache[memoryCacheKey()]);
            const files = ensureArray(cached.files);
            if (!files.length) return false;

            state.files = files;
            state.contentCache = ensureObject(cached.contents);
            const candidate = preferredFile && files.includes(preferredFile)
                ? preferredFile
                : (state.currentPath && files.includes(state.currentPath) ? state.currentPath : cached.currentPath);

            if (candidate && files.includes(candidate)) {
                state.currentPath = candidate;
                state.content = String(state.contentCache[candidate] || '');
            } else {
                state.currentPath = '';
                state.content = '';
            }
            state.dirty = false;
            return true;
        };

        const saveMemoryToCache = () => {
            const nextEntry = {
                updatedAt: Date.now(),
                files: ensureArray(state.files),
                currentPath: state.currentPath,
                contents: ensureObject(state.contentCache)
            };
            state.memoryCache[memoryCacheKey()] = nextEntry;
            saveMemoryViewCache(state.memoryCache);
        };

        const openFile = async (filePath, options = {}) => {
            const cachedContent = state.contentCache[filePath];
            if (options.preferCache && typeof cachedContent === 'string') {
                state.currentPath = filePath;
                state.content = cachedContent;
                state.dirty = false;
                render();
                if (!options.background) return;
            }
            try {
                const result = await window.api.readMemoryFile({ agentName: state.agentId, path: filePath });
                if (!result?.ok) {
                    state.status = result?.error || '读取失败';
                    render();
                    return;
                }
                state.currentPath = filePath;
                state.content = result.content || '';
                state.contentCache[filePath] = state.content;
                state.dirty = false;
                saveMemoryToCache();
                render();
            } catch (error) {
                state.status = error.message || String(error);
                render();
            }
        };

        const refreshFiles = async (preferredFile = '', options = {}) => {
            try {
                const result = await window.api.listMemoryFiles({ agentName: state.agentId, category: state.category });
                state.files = result?.ok ? ensureArray(result.files) : [];
                state.contentCache = Object.fromEntries(
                    Object.entries(ensureObject(state.contentCache)).filter(([filePath]) => state.files.includes(filePath))
                );
                if (preferredFile && state.files.includes(preferredFile)) {
                    saveMemoryToCache();
                    await openFile(preferredFile, { preferCache: true, background: options.background });
                    return;
                }
                if (!state.files.includes(state.currentPath)) {
                    state.currentPath = '';
                    state.content = '';
                    state.dirty = false;
                }
                saveMemoryToCache();
                render();
            } catch (error) {
                state.files = [];
                state.currentPath = '';
                state.content = '';
                state.dirty = false;
                state.contentCache = {};
                state.status = error.message || String(error);
                render();
            }
        };

        const render = () => {
            container.innerHTML = `
                <div class="ocp-shell">
                    ${renderHeader('记忆文件', '按 Agent 管理 memory、archive 和 core 文件。')}
                    <div class="ocp-toolbar">
                        <label class="ocp-field compact">
                            <span>Agent</span>
                            <select id="memoryAgentSelect">${state.agents.map(agentId => `<option value="${esc(agentId)}" ${agentId === state.agentId ? 'selected' : ''}>${esc(agentId)}</option>`).join('')}</select>
                        </label>
                        <label class="ocp-field compact">
                            <span>分区</span>
                            <select id="memoryCategorySelect">
                                <option value="memory" ${state.category === 'memory' ? 'selected' : ''}>memory</option>
                                <option value="archive" ${state.category === 'archive' ? 'selected' : ''}>archive</option>
                                <option value="core" ${state.category === 'core' ? 'selected' : ''}>core</option>
                            </select>
                        </label>
                        <button class="ocp-btn primary" id="memoryNewBtn">新建</button>
                        <button class="ocp-btn" id="memoryExportBtn">导出 zip</button>
                        <span class="${statusClass('info')}" id="memoryStatus">${esc(state.status || '')}</span>
                    </div>
                    <div class="ocp-grid sidebar ocp-workbench">
                        <section class="ocp-card ocp-sidebar-list ocp-workbench-sidebar">
                            <div class="ocp-card-title">文件列表</div>
                            <div class="ocp-row-meta">从左侧选择文件，右侧直接编辑。</div>
                            <div class="ocp-stack">
                                ${state.files.length ? state.files.map(filePath => `
                                    <button class="ocp-list-item ${filePath === state.currentPath ? 'active' : ''}" data-file="${esc(filePath)}">
                                        <span class="ocp-row-title">${esc(filePath.split('/').pop())}</span>
                                        <span class="ocp-row-meta">${esc(filePath)}</span>
                                    </button>
                                `).join('') : '<div class="ocp-empty">当前分区没有文件。</div>'}
                            </div>
                        </section>
                        <section class="ocp-card ocp-detail-panel">
                            <div class="ocp-detail-header">
                                <div class="ocp-detail-heading">
                                    <div class="ocp-card-title">${esc(state.currentPath || '请选择文件')}</div>
                                    <div class="ocp-row-meta">右侧编辑区会直接保存到当前 Agent 的分区文件中。</div>
                                </div>
                                <span class="ocp-pill ${state.dirty ? 'warning' : 'muted'}">${state.currentPath ? (state.dirty ? '未保存' : '已同步') : '待选择'}</span>
                            </div>
                            <div class="ocp-detail-group">
                                <div class="ocp-toolbar split ocp-detail-actions">
                                    <div class="ocp-toolbar">
                                        <button class="ocp-btn primary" id="memorySaveBtn" ${state.currentPath ? '' : 'disabled'}>${state.dirty ? '保存修改' : '保存'}</button>
                                        <button class="ocp-btn danger" id="memoryDeleteBtn" ${state.currentPath ? '' : 'disabled'}>删除</button>
                                    </div>
                                </div>
                            </div>
                            <div class="ocp-detail-group">
                                <label class="ocp-field ocp-detail-editor">
                                    <span>文件内容</span>
                                    <textarea id="memoryEditor" ${state.currentPath ? '' : 'disabled'}>${esc(state.content || '')}</textarea>
                                </label>
                            </div>
                        </section>
                    </div>
                </div>
            `;

            const statusEl = container.querySelector('#memoryStatus');
            container.querySelector('#memoryAgentSelect').onchange = async (event) => {
                const nextAgentId = event.target.value;
                if (state.dirty && nextAgentId !== state.agentId) {
                    const yes = await confirmDiscardChanges(`切换到 ${nextAgentId} 前放弃未保存修改吗？`);
                    if (!yes) {
                        event.target.value = state.agentId;
                        return;
                    }
                }
                state.agentId = nextAgentId;
                state.currentPath = '';
                state.content = '';
                state.dirty = false;
                state.contentCache = {};
                if (loadMemoryFromCache()) {
                    state.status = '已显示缓存文件，正在后台刷新...';
                    render();
                }
                await refreshFiles('', { background: state.files.length > 0 });
            };
            container.querySelector('#memoryCategorySelect').onchange = async (event) => {
                const nextCategory = event.target.value;
                if (state.dirty && nextCategory !== state.category) {
                    const yes = await confirmDiscardChanges(`切换到 ${nextCategory} 前放弃未保存修改吗？`);
                    if (!yes) {
                        event.target.value = state.category;
                        return;
                    }
                }
                state.category = nextCategory;
                state.currentPath = '';
                state.content = '';
                state.dirty = false;
                state.contentCache = {};
                if (loadMemoryFromCache()) {
                    state.status = '已显示缓存文件，正在后台刷新...';
                    render();
                }
                await refreshFiles('', { background: state.files.length > 0 });
            };
            container.querySelector('#memoryNewBtn').onclick = async () => {
                if (window.__openclawSmoke && typeof window.prompt === 'function') {
                    const fileName = window.prompt('新文件名', 'notes.md');
                    const trimmedName = String(fileName || '').trim();
                    if (!trimmedName) {
                        state.status = '文件名不能为空';
                        render();
                        return;
                    }
                    if (state.dirty) {
                        const yes = await confirmDiscardChanges('创建新文件前放弃未保存修改吗？');
                        if (!yes) return;
                    }
                    try {
                        const result = await window.api.writeMemoryFile({
                            agentName: state.agentId,
                            category: state.category,
                            path: trimmedName,
                            content: `# ${trimmedName}\n\n`
                        });
                        if (!result?.ok) {
                            statusEl.className = statusClass('danger');
                            statusEl.textContent = result?.error || '创建失败';
                            return;
                        }
                        state.status = `已创建 ${trimmedName}`;
                        await refreshFiles(trimmedName);
                    } catch (error) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = error.message || String(error);
                    }
                    return;
                }

                window.showFormDialog({
                    title: '新建记忆文件',
                    confirmText: '创建',
                    fields: [
                        {
                            name: 'fileName',
                            label: '文件名',
                            value: 'notes.md',
                            placeholder: '如 notes.md',
                            hint: '建议使用 .md 后缀，文件会保存到当前分类目录下。'
                        }
                    ],
                    onConfirm: async (values, dialog) => {
                        const trimmedName = String(values.fileName || '').trim();
                        if (!trimmedName) {
                            dialog.setStatus('文件名不能为空');
                            return;
                        }
                        if (state.dirty) {
                            const yes = await confirmDiscardChanges('创建新文件前放弃未保存修改吗？');
                            if (!yes) return;
                        }
                        const result = await window.api.writeMemoryFile({
                            agentName: state.agentId,
                            category: state.category,
                            path: trimmedName,
                            content: `# ${trimmedName}\n\n`
                        });
                        if (!result?.ok) {
                            throw new Error(result?.error || '创建失败');
                        }
                        state.status = `已创建 ${trimmedName}`;
                        dialog.close();
                        await refreshFiles(trimmedName);
                    }
                });
            };
            container.querySelector('#memoryExportBtn').onclick = async () => {
                try {
                    const result = await window.api.exportMemoryZip({ agentName: state.agentId, category: state.category });
                    if (!result?.ok) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = result?.error || '导出失败';
                        return;
                    }
                    state.status = `导出包：${result.path}`;
                    render();
                } catch (error) {
                    statusEl.className = statusClass('danger');
                    statusEl.textContent = error.message || String(error);
                }
            };
            container.querySelectorAll('[data-file]').forEach(button => {
                button.onclick = async () => {
                    const filePath = button.getAttribute('data-file');
                    if (state.dirty && filePath !== state.currentPath) {
                        const yes = await confirmDiscardChanges(`打开 ${filePath} 前放弃未保存修改吗？`);
                        if (!yes) return;
                    }
                    await openFile(filePath);
                };
            });
            const editor = container.querySelector('#memoryEditor');
            editor.oninput = () => {
                state.content = editor.value;
                state.dirty = true;
            };
            container.querySelector('#memorySaveBtn').onclick = async () => {
                if (!state.currentPath) return;
                try {
                    const result = await window.api.writeMemoryFile({
                        agentName: state.agentId,
                        category: state.category,
                        path: state.currentPath,
                        content: editor.value
                    });
                    if (!result?.ok) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = result?.error || '保存失败';
                        return;
                    }
                    state.content = editor.value;
                    state.contentCache[state.currentPath] = state.content;
                    state.dirty = false;
                    state.status = `已保存 ${state.currentPath}`;
                    saveMemoryToCache();
                    render();
                } catch (error) {
                    statusEl.className = statusClass('danger');
                    statusEl.textContent = error.message || String(error);
                }
            };
            container.querySelector('#memoryDeleteBtn').onclick = async () => {
                if (!state.currentPath) return;
                if (state.dirty) {
                    const yes = await confirmDiscardChanges(`删除 ${state.currentPath} 前放弃未保存修改吗？`);
                    if (!yes) return;
                }
                const yes = typeof window.showConfirmDialog === 'function'
                    ? await window.showConfirmDialog(`删除 ${state.currentPath}？`, { confirmText: '删除' })
                    : window.confirm(`删除 ${state.currentPath}？`);
                if (!yes) return;
                try {
                    const result = await window.api.deleteMemoryFile({ agentName: state.agentId, path: state.currentPath });
                    if (!result?.ok) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = result?.error || '删除失败';
                        return;
                    }
                    state.status = `已删除 ${state.currentPath}`;
                    delete state.contentCache[state.currentPath];
                    state.currentPath = '';
                    state.content = '';
                    state.dirty = false;
                    await refreshFiles();
                } catch (error) {
                    statusEl.className = statusClass('danger');
                    statusEl.textContent = error.message || String(error);
                }
            };
        };

        if (loadMemoryFromCache()) {
            state.status = '已显示缓存文件，正在后台刷新...';
            render();
        }
        await refreshFiles('', { background: state.files.length > 0 });
    }

    function scheduleSummary(schedule) {
        const kind = String(schedule?.kind || '').trim().toLowerCase();
        if (kind === 'cron' || schedule?.expr) return schedule?.expr ? `cron: ${schedule.expr}` : 'cron';
        if (kind === 'every' || kind === 'interval') {
            const ms = Number(schedule?.everyMs || 0);
            if (!ms) return 'interval';
            if (ms % 3600000 === 0) return `every ${ms / 3600000}h`;
            if (ms % 60000 === 0) return `every ${ms / 60000}m`;
            return `every ${Math.round(ms / 1000)}s`;
        }
        if (kind === 'at' || schedule?.at) return schedule?.at ? `at ${schedule.at}` : 'at';
        return '未知';
    }

    function everyMsToText(value) {
        const ms = Number(value || 0);
        if (!ms) return '';
        if (ms % 86400000 === 0) return `${ms / 86400000}d`;
        if (ms % 3600000 === 0) return `${ms / 3600000}h`;
        if (ms % 60000 === 0) return `${ms / 60000}m`;
        return `${Math.round(ms / 1000)}s`;
    }

    function jobToForm(job) {
        const schedule = ensureObject(job?.schedule);
        const payload = ensureObject(job?.payload);
        let scheduleMode = 'cron';
        let scheduleValue = '';
        if (schedule?.at) {
            scheduleMode = 'at';
            scheduleValue = schedule.at;
        } else if (schedule?.everyMs) {
            scheduleMode = 'every';
            scheduleValue = everyMsToText(schedule.everyMs);
        } else {
            scheduleMode = 'cron';
            scheduleValue = schedule?.expr || '';
        }
        return {
            id: String(job?.id || ''),
            name: String(job?.name || ''),
            description: String(job?.description || ''),
            message: String(payload?.message || payload?.text || ''),
            scheduleMode,
            scheduleValue,
            tz: String(schedule?.tz || ''),
            agentId: String(job?.agentId || ''),
            model: String(job?.raw?.model || ''),
            thinking: String(job?.raw?.thinking || 'medium'),
            channel: String(job?.delivery?.channel || ''),
            to: String(job?.delivery?.to || ''),
            sessionTarget: String(job?.sessionTarget || 'main'),
            announce: job?.delivery?.mode === 'announce' || job?.raw?.deliver === true,
            enabled: job?.enabled !== false
        };
    }

    function blankJobForm() {
        return {
            id: '',
            name: '',
            description: '',
            message: '',
            scheduleMode: 'cron',
            scheduleValue: '0 9 * * *',
            tz: '',
            agentId: '',
            model: '',
            thinking: 'medium',
            channel: '',
            to: '',
            sessionTarget: 'main',
            announce: false,
            enabled: true
        };
    }

    async function renderCronPage(container) {
        const cachedView = loadCronViewCache();
        const cachedJobs = ensureArray(cachedView.jobs);
        const cachedCronStatus = cachedView.updatedAt
            ? (cachedJobs.length ? '已显示缓存任务，正在后台刷新...' : '当前还没有定时任务')
            : '';
        const state = container.__openclawCronPageState || {
            jobs: cachedJobs,
            status: cachedCronStatus,
            error: '',
            loading: cachedJobs.length === 0,
            refreshing: false,
            lastFetchedAt: Number(cachedView.updatedAt || 0),
            refreshToken: 0,
            refreshPromise: null
        };
        container.__openclawCronPageState = state;
        container.dataset.cronMounted = '1';
        container.dataset.cronActive = '1';

        if (!state.jobs.length && cachedJobs.length) {
            state.jobs = cachedJobs;
        }
        if (!state.lastFetchedAt && cachedView.updatedAt) {
            state.lastFetchedAt = Number(cachedView.updatedAt || 0);
        }

        const isCronViewActive = () => container.dataset.cronActive === '1' && document.body.contains(container);
        const cleanupCronPageLifecycle = () => {
            container.dataset.cronActive = '0';
        };
        const renderLoading = () => {
            if (!isCronViewActive()) return;
            container.innerHTML = `<div class="ocp-shell">${renderHeader('定时任务', '通过 OpenClaw CLI 创建、编辑、执行和删除定时任务。')}<div class="ocp-card">加载中...</div></div>`;
        };

        container.__openclawCleanupCronPage = cleanupCronPageLifecycle;

        const buildCronPayload = (values = {}, existingId = '') => {
            const scheduleMode = String(values.scheduleMode || 'cron').trim().toLowerCase();
            const scheduleValue = String(values.scheduleValue || '').trim();
            const payload = {
                id: String(existingId || values.id || '').trim(),
                name: String(values.name || '').trim(),
                description: String(values.description || '').trim(),
                message: String(values.message || '').trim(),
                scheduleMode,
                agentId: String(values.agentId || '').trim(),
                thinking: String(values.thinking || 'medium').trim() || 'medium',
                model: String(values.model || '').trim(),
                tz: String(values.tz || '').trim(),
                channel: String(values.channel || '').trim(),
                to: String(values.to || '').trim(),
                sessionTarget: String(values.sessionTarget || 'main').trim() || 'main',
                announce: values.announce === true || values.announce === 'true',
                enabled: values.enabled !== false && values.enabled !== 'false'
            };

            if (scheduleMode === 'cron') payload.cron = scheduleValue;
            if (scheduleMode === 'every') payload.every = scheduleValue;
            if (scheduleMode === 'at') payload.at = scheduleValue;
            return payload;
        };

        const openCronJobDialog = (job = null) => {
            if (typeof window.showFormDialog !== 'function') return false;
            const form = job ? jobToForm(job) : blankJobForm();
            window.showFormDialog({
                title: form.id ? `编辑任务 ${form.id}` : '新建任务',
                confirmText: form.id ? '保存修改' : '创建任务',
                fields: [
                    ...(form.id ? [{
                        name: 'id',
                        label: '任务 ID',
                        value: form.id,
                        readonly: true,
                        hint: '任务 ID 创建后不可修改。'
                    }] : []),
                    {
                        name: 'name',
                        label: '名称',
                        value: form.name,
                        placeholder: '如：每日上午汇总',
                        hint: '用于列表展示和识别。'
                    },
                    {
                        name: 'description',
                        label: '描述',
                        value: form.description,
                        placeholder: '可选，用于说明任务用途'
                    },
                    {
                        name: 'scheduleMode',
                        label: '调度模式',
                        type: 'select',
                        value: form.scheduleMode,
                        options: [
                            { value: 'cron', label: 'cron 表达式' },
                            { value: 'every', label: '间隔执行' },
                            { value: 'at', label: '指定时间' }
                        ]
                    },
                    {
                        name: 'scheduleValue',
                        label: '调度值',
                        value: form.scheduleValue,
                        placeholder: form.scheduleMode === 'every' ? '如 30m' : form.scheduleMode === 'at' ? '如 2026-03-20 21:00' : '如 0 9 * * *',
                        hint: 'cron / every / at 三种模式都在这里填写对应值。'
                    },
                    {
                        name: 'agentId',
                        label: 'Agent',
                        value: form.agentId,
                        placeholder: '如 main'
                    },
                    {
                        name: 'thinking',
                        label: '思考级别',
                        type: 'select',
                        value: form.thinking,
                        options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((item) => ({ value: item, label: item }))
                    },
                    {
                        name: 'model',
                        label: '模型',
                        value: form.model,
                        placeholder: '可选'
                    },
                    {
                        name: 'tz',
                        label: '时区',
                        value: form.tz,
                        placeholder: 'Asia/Shanghai'
                    },
                    {
                        name: 'channel',
                        label: '渠道',
                        value: form.channel,
                        placeholder: '如 telegram'
                    },
                    {
                        name: 'to',
                        label: '接收对象',
                        value: form.to,
                        placeholder: '如 用户 ID / 群组 ID'
                    },
                    {
                        name: 'sessionTarget',
                        label: '会话模式',
                        type: 'select',
                        value: form.sessionTarget,
                        options: [
                            { value: 'main', label: 'main' },
                            { value: 'isolated', label: 'isolated' }
                        ]
                    },
                    {
                        name: 'announce',
                        label: '公告结果',
                        type: 'checkbox',
                        value: form.announce,
                        hint: '勾选后会把执行结果直接投递到目标渠道。'
                    },
                    {
                        name: 'enabled',
                        label: '启用任务',
                        type: 'checkbox',
                        value: form.enabled,
                        hint: '取消勾选会创建/保存为停用状态。'
                    },
                    {
                        name: 'message',
                        label: '提示词',
                        type: 'textarea',
                        value: form.message,
                        placeholder: '填写定时任务运行时要执行的提示词',
                        hint: '这里填写定时任务实际执行的内容。'
                    }
                ],
                onConfirm: async (values, dialog) => {
                    const payload = buildCronPayload(values, form.id);
                    if (!payload.name) {
                        dialog.setStatus('名称不能为空');
                        return;
                    }
                    if (!payload.message) {
                        dialog.setStatus('提示词不能为空');
                        return;
                    }
                    if (!payload.cron && !payload.every && !payload.at) {
                        dialog.setStatus('调度值不能为空');
                        return;
                    }

                    const result = payload.id
                        ? await window.api.updateCronJob(payload)
                        : await window.api.createCronJob(payload);
                    if (!result?.ok) {
                        dialog.setStatus(result?.error || '保存失败');
                        return;
                    }

                    state.status = payload.id ? '已更新' : '已创建';
                    state.error = '';
                    await refreshJobs({ background: state.jobs.length > 0 });
                    dialog.close();
                }
            });
            return true;
        };

        const refreshJobs = async ({ background = state.jobs.length > 0 } = {}) => {
            if (state.refreshing) return state.refreshPromise;
            const refreshToken = ++state.refreshToken;
            state.refreshing = true;
            if (background && state.jobs.length) {
                state.status = '正在后台刷新任务列表...';
                state.error = '';
            } else {
                state.loading = state.jobs.length === 0;
                state.error = '';
            }
            render();

            state.refreshPromise = (async () => {
                try {
                    const result = await window.api.listCronJobs({});
                    if (!result?.ok) {
                        throw new Error(result?.error || '加载失败');
                    }
                    if (refreshToken !== state.refreshToken) return;
                    state.jobs = ensureArray(result.jobs);
                    saveCronViewCache(state.jobs);
                    state.error = '';
                    state.lastFetchedAt = Date.now();
                    state.status = result?.source === 'local-store'
                        ? '已从本地任务文件刷新'
                        : result?.source === 'local-store-fallback'
                            ? '网关响应异常，已回退到本地任务文件'
                            : result?.source === 'local-store-empty'
                                ? '当前还没有定时任务'
                            : '任务列表已刷新';
                } catch (error) {
                    if (refreshToken !== state.refreshToken) return;
                    if (state.jobs.length) {
                        state.status = '刷新失败，已保留缓存任务';
                        state.error = '';
                    } else {
                        state.error = error.message || String(error);
                        state.status = '';
                    }
                } finally {
                    if (refreshToken !== state.refreshToken) return;
                    state.loading = false;
                    state.refreshing = false;
                    state.refreshPromise = null;
                    render();
                }
            })();

            return state.refreshPromise;
        };

        const render = () => {
            if (!isCronViewActive()) return;
            const activeCount = state.jobs.filter(job => job.enabled !== false).length;
            const failedCount = state.jobs.filter(job => String(job?.state?.lastStatus || '').toLowerCase() === 'error').length;
            const statusText = state.error || state.status || (state.loading ? '正在加载任务列表...' : '');
            const listHint = state.loading
                ? '任务列表正在加载...'
                : '列表默认优先读取本地任务文件；任务较多时可直接滚轮上下查看。';
            const listBody = state.loading && !state.jobs.length
                ? '<div class="ocp-empty">正在拉取定时任务列表...</div>'
                : state.jobs.length
                    ? state.jobs.map(job => `
                                    <div class="ocp-job-card cron-job-card">
                                        <div class="ocp-job-head">
                                            <div>
                                                <div class="ocp-row-title">${esc(job.name || job.id)}</div>
                                                <div class="ocp-row-meta">${esc(scheduleSummary(job.schedule))} · ${job.enabled !== false ? '启用' : '停用'}</div>
                                            </div>
                                            <div class="ocp-pill ${job.enabled !== false ? 'success' : 'muted'}">${job.enabled !== false ? '启用' : '停用'}</div>
                                        </div>
                                        <div class="ocp-row-meta">${esc(job.payload?.message || job.payload?.text || job.description || '')}</div>
                                        <div class="ocp-row-meta">上次运行：${esc(formatDateTime(job?.state?.lastRunAtMs || job?.state?.lastRunAt))} ${job?.state?.lastStatus ? `· ${esc(String(job.state.lastStatus))}` : ''}</div>
                                        <div class="ocp-toolbar">
                                            <button class="ocp-btn sm" data-cron-edit="${esc(job.id)}">编辑</button>
                                            <button class="ocp-btn sm" data-cron-toggle="${esc(job.id)}">${job.enabled !== false ? '停用' : '启用'}</button>
                                            <button class="ocp-btn sm" data-cron-run="${esc(job.id)}">立即执行</button>
                                            <button class="ocp-btn sm danger" data-cron-delete="${esc(job.id)}">删除</button>
                                        </div>
                                    </div>
                                `).join('')
                    : '<div class="ocp-empty">当前没有定时任务，创建后会显示在这里。</div>';
            container.innerHTML = `
                <div class="ocp-shell">
                    ${renderHeader('定时任务', '通过 OpenClaw CLI 创建、编辑、执行和删除定时任务。')}
                    <div class="ocp-toolbar">
                        <button class="ocp-btn primary" id="cronRefreshBtn">刷新</button>
                        <button class="ocp-btn sm" id="cronNewBtn">+ 新建</button>
                        <span class="${statusClass(state.error ? 'danger' : 'info')}" id="cronStatus">${esc(statusText)}</span>
                    </div>
                    <div class="ocp-stats">
                        <div class="ocp-stat-card"><span>总数</span><strong>${formatNumber(state.jobs.length)}</strong></div>
                        <div class="ocp-stat-card"><span>启用</span><strong>${formatNumber(activeCount)}</strong></div>
                        <div class="ocp-stat-card"><span>失败</span><strong>${formatNumber(failedCount)}</strong></div>
                    </div>
                    <section class="ocp-card">
                        <div class="ocp-card-title">任务列表</div>
                        <div class="ocp-row-meta">${esc(listHint)}</div>
                        <div class="ocp-stack cron-job-list">
                            ${listBody}
                        </div>
                    </section>
                </div>
            `;

            const statusEl = container.querySelector('#cronStatus');
            container.querySelector('#cronRefreshBtn').onclick = () => refreshJobs({ background: state.jobs.length > 0 });
            container.querySelector('#cronNewBtn').onclick = () => {
                if (!openCronJobDialog()) {
                    statusEl.className = statusClass('danger');
                    statusEl.textContent = '当前环境不支持弹窗表单';
                }
            };
            container.querySelectorAll('[data-cron-edit]').forEach(button => {
                button.onclick = () => {
                    const job = state.jobs.find(item => item.id === button.getAttribute('data-cron-edit'));
                    if (!job) {
                        state.status = 'Cron job not found';
                        render();
                        return;
                    }
                    if (!openCronJobDialog(job)) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = '当前环境不支持弹窗表单';
                    }
                };
            });
            container.querySelectorAll('[data-cron-toggle]').forEach(button => {
                button.onclick = async () => {
                    const job = state.jobs.find(item => item.id === button.getAttribute('data-cron-toggle'));
                    if (!job) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = 'Cron job not found';
                        return;
                    }
                    const result = await window.api.toggleCronJob({ id: job.id, enabled: job.enabled === false });
                    if (!result?.ok) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = result?.error || 'Toggle failed';
                        return;
                    }
                    state.status = `${job.id} toggled`;
                    await refreshJobs({ background: state.jobs.length > 0 });
                };
            });
            container.querySelectorAll('[data-cron-run]').forEach(button => {
                button.onclick = async () => {
                    const jobId = button.getAttribute('data-cron-run');
                    if (!jobId) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = 'Cron job not found';
                        return;
                    }
                    const result = await window.api.runCronJob({ id: jobId });
                    if (!result?.ok) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = result?.error || 'Run failed';
                        return;
                    }
                    state.status = 'Triggered';
                    await refreshJobs({ background: true });
                };
            });
            container.querySelectorAll('[data-cron-delete]').forEach(button => {
                button.onclick = async () => {
                    const jobId = button.getAttribute('data-cron-delete');
                    if (!jobId) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = 'Cron job not found';
                        return;
                    }
                    const yes = typeof window.showConfirmDialog === 'function' ? await window.showConfirmDialog(`删除定时任务 ${jobId}？`, { confirmText: '删除' }) : window.confirm(`删除定时任务 ${jobId}？`);
                    if (!yes) return;
                    const result = await window.api.removeCronJob({ id: jobId });
                    if (!result?.ok) {
                        statusEl.className = statusClass('danger');
                        statusEl.textContent = result?.error || 'Delete failed';
                        return;
                    }
                    state.status = `${jobId} deleted`;
                    await refreshJobs({ background: state.jobs.length > 0 });
                };
            });
        };

        container.__openclawResumeCronPage = () => {
            if (!document.body.contains(container)) return;
            container.dataset.cronActive = '1';
            if (state.jobs.length || state.error || state.status || state.lastFetchedAt) {
                render();
            } else {
                renderLoading();
            }
            if (!state.lastFetchedAt || Date.now() - state.lastFetchedAt > 30000) {
                void refreshJobs({ background: state.jobs.length > 0 });
            }
        };

        if (state.jobs.length || state.error || state.status || state.lastFetchedAt) {
            render();
        } else {
            renderLoading();
        }
        if (!state.lastFetchedAt || Date.now() - state.lastFetchedAt > 30000) {
            void refreshJobs({ background: state.jobs.length > 0 });
        }
    }

    async function renderUsagePage(container) {
        const state = container.__openclawUsagePageState || {
            days: 7,
            report: null,
            error: '',
            lastFetchedAt: 0
        };
        container.__openclawUsagePageState = state;

        const renderTopList = (title, items, labelKey, formatter) => `
            <section class="ocp-card">
                <div class="ocp-card-title">${esc(title)}</div>
                <div class="ocp-stack compact">
                    ${ensureArray(items).slice(0, 5).map(item => {
                        const safeItem = ensureObject(item);
                        return `
                        <div class="ocp-list-row">
                            <div><div class="ocp-row-title">${esc(labelKey(safeItem))}</div></div>
                            <div class="ocp-row-meta">${esc(formatter(safeItem))}</div>
                        </div>
                    `;
                    }).join('') || '<div class="ocp-empty">暂无数据</div>'}
                </div>
            </section>
        `;

        const renderLoading = () => {
            container.innerHTML = `<div class="ocp-shell">${renderHeader('使用情况', '查看本地 OpenClaw 会话 JSONL 的 Token、费用与模型统计。')}<div class="ocp-card">加载中...</div></div>`;
        };

        const refresh = async (options = {}) => {
            try {
                const result = await window.api.getUsageReport({
                    days: state.days,
                    forceRefresh: options.forceRefresh === true
                });
                if (!result?.ok) {
                    state.error = result?.error || '加载失败';
                    render();
                    return;
                }
                state.error = '';
                state.report = result.report;
                state.lastFetchedAt = Date.now();
                render();
            } catch (error) {
                state.error = error.message || String(error);
                render();
            }
        };

        const render = () => {
            if (state.error) {
                container.innerHTML = `
                    <div class="ocp-shell">
                        ${renderHeader('使用情况', '查看本地 OpenClaw 会话 JSONL 的 Token、费用与模型统计。')}
                        <div class="ocp-toolbar">
                            <button class="ocp-btn primary" id="usageRetryBtn">重试</button>
                            <span class="${statusClass('danger')}">${esc(state.error)}</span>
                        </div>
                        <div class="ocp-card ocp-danger">${esc(state.error)}</div>
                    </div>
                `;
                container.querySelector('#usageRetryBtn').onclick = () => refresh({ forceRefresh: true });
                return;
            }
            const report = state.report || {};
            const totals = ensureObject(report.totals);
            const aggregates = ensureObject(report.aggregates);
            const daily = ensureArray(aggregates.daily);
            const hasDailyTokenData = daily.some(item => Number(item?.tokens || 0) > 0);
            const maxDailyTokens = Math.max(1, ...daily.map(item => Number(item.tokens || 0)));
            container.innerHTML = `
                <div class="ocp-shell">
                    ${renderHeader('使用情况', '查看本地 OpenClaw 会话 JSONL 的 Token、费用与模型统计。')}
                    <div class="ocp-toolbar">
                        ${[1, 7, 30].map(days => `<button class="ocp-btn ${days === state.days ? 'primary' : ''}" data-usage-days="${days}">${days === 1 ? '今天' : `${days}天`}</button>`).join('')}
                        <button class="ocp-btn" id="usageRefreshBtn">刷新</button>
                        <span class="${statusClass('info')}">${esc(report.startDate || '-')} ~ ${esc(report.endDate || '-')}</span>
                    </div>
                    <div class="ocp-stats">
                        <div class="ocp-stat-card"><span>Token 总量</span><strong>${formatTokens(totals.totalTokens)}</strong></div>
                        <div class="ocp-stat-card"><span>输入 Token</span><strong>${formatTokens(totals.input)}</strong></div>
                        <div class="ocp-stat-card"><span>输出 Token</span><strong>${formatTokens(totals.output)}</strong></div>
                        <div class="ocp-stat-card"><span>费用</span><strong>${formatCost(totals.totalCost)}</strong></div>
                        <div class="ocp-stat-card"><span>消息数</span><strong>${formatNumber(aggregates?.messages?.total || 0)}</strong></div>
                        <div class="ocp-stat-card"><span>工具调用</span><strong>${formatNumber(aggregates?.tools?.totalCalls || 0)}</strong></div>
                    </div>
                    <div class="ocp-card">
                        <div class="ocp-card-title">每日 Token 趋势</div>
                        ${hasDailyTokenData ? `
                            <div class="ocp-chart">
                                ${daily.map(item => `
                                    <div class="ocp-bar-wrap" data-usage-tooltip="${esc(buildUsageDailyTooltip(item))}">
                                        <div class="ocp-bar-track" data-usage-tooltip="${esc(buildUsageDailyTooltip(item))}">
                                            <div class="ocp-bar" style="height:${Math.max(6, Math.round((Number(item.tokens || 0) / maxDailyTokens) * 100))}%"></div>
                                        </div>
                                        <span>${esc(String(item.date || '').slice(5))}</span>
                                    </div>
                                `).join('')}
                            </div>
                        ` : '<div class="ocp-empty">该时间段暂无 Token 数据。</div>'}
                    </div>
                    <div class="ocp-grid three">
                        ${renderTopList('热门模型', aggregates.byModel, item => `${item.provider || '未知'}/${item.model || '未知'}`, item => `${formatTokens(item.totals?.totalTokens)} · ${formatCost(item.totals?.totalCost)}`)}
                        ${renderTopList('热门服务商', aggregates.byProvider, item => item.provider || '未知', item => `${formatTokens(item.totals?.totalTokens)} · ${formatCost(item.totals?.totalCost)}`)}
                        ${renderTopList('热门智能体', aggregates.byAgent, item => item.agentId || 'main', item => `${formatTokens(item.totals?.totalTokens)} · ${formatCost(item.totals?.totalCost)}`)}
                    </div>
                    <div class="ocp-grid two">
                        ${renderTopList('热门渠道', aggregates.byChannel, item => formatUsageChannelLabel(item.channel), item => `${formatTokens(item.totals?.totalTokens)} · ${formatCost(item.totals?.totalCost)}`)}
                        ${renderTopList('热门工具', aggregates?.tools?.tools, item => item.name || '未知', item => `${formatNumber(item.count)} 次`)}
                    </div>
                    <section class="ocp-card">
                        <div class="ocp-card-title">最近会话</div>
                        <div class="ocp-stack">
                            ${ensureArray(report.sessions).map(session => `
                                <div class="ocp-list-row">
                                    <div>
                                        <div class="ocp-row-title">${esc(buildUsageSessionTitle(session))}</div>
                                        <div class="ocp-row-meta">${esc(`${session.provider || 'unknown'}/${session.model || 'unknown'}`)}${session.channel && session.channel !== 'unknown' ? ` · ${esc(formatUsageChannelLabel(session.channel))}` : ''} · ${esc(formatDateTime(session.updatedAt))} · ${esc(formatRelative(session.updatedAt))}</div>
                                    </div>
                                    <div class="ocp-row-meta">${formatTokens(session?.usage?.totalTokens)} · ${formatCost(session?.usage?.totalCost)}</div>
                                </div>
                            `).join('') || '<div class="ocp-empty">该时间段暂无会话数据。</div>'}
                        </div>
                    </section>
                </div>
            `;
            container.querySelectorAll('[data-usage-days]').forEach(button => {
                button.onclick = async () => {
                    state.days = Number(button.getAttribute('data-usage-days')) || 7;
                    await refresh();
                };
            });
            container.querySelector('#usageRefreshBtn').onclick = () => refresh({ forceRefresh: true });
            bindUsageChartTooltips(container);
        };

        container.dataset.usageMounted = '1';
        container.__openclawRefreshUsagePage = refresh;
        container.__openclawResumeUsagePage = () => {
            if (!document.body.contains(container)) return;
            if (state.report || state.error) {
                render();
            } else {
                renderLoading();
            }
            if (!state.lastFetchedAt || Date.now() - state.lastFetchedAt > 30000) {
                void refresh();
            }
        };

        if (state.report || state.error) {
            render();
            if (!state.lastFetchedAt || Date.now() - state.lastFetchedAt > 30000) {
                void refresh();
            }
            return;
        }

        renderLoading();
        await refresh();
    }

    window.OpenClawPanelPages = {
        renderChannelsPage,
        renderMemoryCenterPage,
        renderCronPage,
        renderUsagePage
    };
})();
