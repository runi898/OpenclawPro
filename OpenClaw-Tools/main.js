const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const iconv = require('iconv-lite');
const QRCode = require('qrcode');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { buildUsageReport } = require('./usage-report');
const { checkPm2RuntimeInstalled, ensurePm2RuntimeInstalled } = require('./pm2-runtime-installer');
const { checkPm2ServiceInstalled, ensurePm2ServiceInstalled } = require('./pm2-service-installer');
const { DESKTOP_PLUGIN_PARAMETER_FILE, parsePluginParameterText } = require('./channel-setup-shared');
const { registerPlatformIpcHandlers } = require('./main/ipc/platform-ipc');
const { registerCommandIpcHandlers } = require('./main/ipc/command-ipc');
const { registerConfigIpcHandlers } = require('./main/ipc/config-ipc');
const { registerLogIpcHandlers } = require('./main/ipc/log-ipc');
const { registerModelIpcHandlers } = require('./main/ipc/model-ipc');
const { registerMemoryIpcHandlers } = require('./main/ipc/memory-ipc');
const { registerUsageIpcHandlers } = require('./main/ipc/usage-ipc');
const { registerAgentIpcHandlers } = require('./main/ipc/agent-ipc');
const { registerMultiAgentIpcHandlers } = require('./main/ipc/multi-agent-orchestration-ipc');
const { registerCronIpcHandlers } = require('./main/ipc/cron-ipc');
const { registerPairingIpcHandlers } = require('./main/ipc/pairing-ipc');
const { registerDashboardIpcHandlers } = require('./main/ipc/dashboard-ipc');
const { createMainWindow, bootstrapAppLifecycle } = require('./main/lifecycle/app-lifecycle');

let JSON5 = null;
try {
    JSON5 = require('json5');
} catch (_) {}

let mainWindow = null;

const isSmokeTest = process.env.OPENCLAW_SMOKE_TEST === '1';
const openClawHomeDir = path.resolve(process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'));
const configPath = path.join(openClawHomeDir, 'openclaw.json');
const configHealthPath = path.join(openClawHomeDir, 'config-health.json');
const configSnapshotDir = path.join(openClawHomeDir, 'config-history');
const agentsRootPath = path.join(openClawHomeDir, 'agents');
const smokeResultPath = path.resolve(
    process.env.OPENCLAW_SMOKE_RESULT_PATH || path.join(openClawHomeDir, 'smoke-result.json')
);
const editableAgentFiles = new Set([
    'IDENTITY.md',
    'SOUL.md',
    'USER.md',
    'AGENTS.md',
    'TOOLS.json',
    'BOOTSTRAP.md',
    'HEARTBEAT.md',
    'MEMORY.md',
    'TOOLS.md'
]);
const openAIApiBaseUrl = 'https://api.openai.com/v1';
const openAICodexBaseUrl = 'https://chatgpt.com/backend-api';
const openAICodexBuiltinModels = Object.freeze([
    {
        id: 'gpt-5.4',
        name: 'gpt-5.4',
        api: 'openai-codex-responses',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1050000,
        maxTokens: 128000
    },
    {
        id: 'gpt-5.3-codex',
        name: 'gpt-5.3-codex',
        api: 'openai-codex-responses',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 262144,
        maxTokens: 65536
    },
    {
        id: 'gpt-5.3-codex-spark',
        name: 'gpt-5.3-codex-spark',
        api: 'openai-codex-responses',
        reasoning: true,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 128000
    },
    {
        id: 'gpt-5.2-codex',
        name: 'gpt-5.2-codex',
        api: 'openai-codex-responses',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 262144,
        maxTokens: 65536
    },
    {
        id: 'gpt-5.1-codex',
        name: 'gpt-5.1-codex',
        api: 'openai-codex-responses',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 262144,
        maxTokens: 65536
    }
]);

const activeProcesses = new Map();
const dashboardFollowProcesses = new Map();
const OPENCLAW_CONFIG_CACHE_EMPTY = Object.freeze({ key: '', config: null });
const USAGE_REPORT_CACHE_TTL_MS = 30000;
let openClawConfigCache = { ...OPENCLAW_CONFIG_CACHE_EMPTY };
const usageReportCache = new Map();
const startupFolderPath = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup'
);
const startupVbsPath = path.join(startupFolderPath, 'OpenClawSilent.vbs');
let cachedOpenClawCli = null;
let cachedPm2ServiceRuntime = null;
let cachedOpenClawPluginInventory = null;
let appLaunchBootstrapPromise = null;
let configHealthCheckTimer = null;
let configHealthCheckPromise = null;
let lastObservedConfigHash = '';
let activeChannelInstallOperation = null;

let lastGoodConfig = null;
const MAX_CONFIG_SNAPSHOTS = 12;
const CHANNEL_PLUGIN_INVENTORY_CACHE_TTL_MS = 15000;
const CHANNEL_INSTALL_RETRY_DELAY_MS = 1600;

function resetCachedPm2ServiceRuntime() {
    cachedPm2ServiceRuntime = null;
}

if (process.platform === 'win32' && app.isPackaged) {
    // Packaged Windows builds on this machine can crash during GPU process startup.
    // Disable hardware acceleration and GPU compositing before any window is created.
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('disable-direct-composition');
}

function ensureDirectory(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

function beginChannelInstallOperation(channelKey = '', requestId = '') {
    const token = {
        channelKey: String(channelKey || '').trim(),
        requestId: String(requestId || '').trim(),
        startedAt: Date.now()
    };
    activeChannelInstallOperation = token;
    invalidateDashboardProbeCaches();
    return token;
}

function finishChannelInstallOperation(token = null) {
    if (!token || activeChannelInstallOperation === token) {
        activeChannelInstallOperation = null;
        invalidateDashboardProbeCaches();
    }
}

function getActiveChannelInstallOperation() {
    return activeChannelInstallOperation && typeof activeChannelInstallOperation === 'object'
        ? activeChannelInstallOperation
        : null;
}

function isRetryableNodeHostWriteFailure(text = '') {
    const normalized = stripAnsi(String(text || ''));
    if (!normalized) return false;
    return /EPERM:\s*operation not permitted,\s*rename\s+['"].*node\.json[^'"]*['"]\s*->\s*['"].*node\.json['"]/i.test(normalized)
        || (/node\.json/i.test(normalized) && /saveNodeHostConfig|ensureNodeHostConfig|runNodeHost/i.test(normalized));
}

function expandHomePath(inputPath) {
    if (!inputPath) return '';
    if (inputPath === '~') return os.homedir();
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(os.homedir(), inputPath.slice(2));
    }
    return inputPath;
}

function parseConfigText(text) {
    if (JSON5) return JSON5.parse(text);
    return JSON.parse(text);
}

function readJsonFile(filePath, fallback = null) {
    if (!fs.existsSync(filePath)) return fallback;
    return parseConfigText(fs.readFileSync(filePath, 'utf8'));
}

function cloneJsonValue(value) {
    if (value === undefined) return {};
    return JSON.parse(JSON.stringify(value));
}

function clearOpenClawConfigCache() {
    openClawConfigCache = { ...OPENCLAW_CONFIG_CACHE_EMPTY };
}

function buildFileStatCacheEntry(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return {
            key: `${Number(stat.mtimeMs || 0)}:${Number(stat.size || 0)}`,
            stat
        };
    } catch (_) {
        return {
            key: '',
            stat: null
        };
    }
}

function updateOpenClawConfigCache(config, fileStat = null) {
    const cacheEntry = fileStat
        ? {
            key: `${Number(fileStat.mtimeMs || 0)}:${Number(fileStat.size || 0)}`,
            stat: fileStat
        }
        : buildFileStatCacheEntry(configPath);

    openClawConfigCache = {
        key: cacheEntry.key,
        config: cloneJsonValue(config || {})
    };
}

function readUsageReportCache(days) {
    const cacheKey = Number(days || 0) || 7;
    const cached = usageReportCache.get(cacheKey);
    if (!cached) return null;
    if (Date.now() - Number(cached.updatedAt || 0) > USAGE_REPORT_CACHE_TTL_MS) {
        usageReportCache.delete(cacheKey);
        return null;
    }
    return cloneJsonValue(cached.report);
}

function writeUsageReportCache(days, report) {
    const cacheKey = Number(days || 0) || 7;
    usageReportCache.set(cacheKey, {
        updatedAt: Date.now(),
        report: cloneJsonValue(report)
    });
    return report;
}

function createStableHash(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function createTimestampTag(dateValue = new Date()) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join('');
}

function readConfigHealthStateSync() {
    const raw = readJsonFile(configHealthPath, {}) || {};
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function writeConfigHealthStateSync(state) {
    return writeJsonFileSync(configHealthPath, state && typeof state === 'object' ? state : {});
}

function appendConfigAuditLog(entry = {}) {
    try {
        const logPath = resolveServiceLogPath('config-audit');
        if (!logPath) return;
        ensureDirectory(path.dirname(logPath));
        fs.appendFileSync(logPath, `${JSON.stringify({
            time: new Date().toISOString(),
            ...entry
        })}\n`, 'utf8');
    } catch (error) {
        console.warn('[Config] Failed to append audit log:', error.message);
    }
}

function normalizeToolsProfile(value) {
    if (value === 'limited' || value === 'restricted') return 'limited';
    if (value === 'none' || value === 'disabled') return 'none';
    return 'full';
}

function sanitizeProviderModels(models) {
    if (!Array.isArray(models)) {
        return {
            models: [],
            changed: models !== undefined
        };
    }

    let changed = false;
    const nextModels = models.map((model) => {
        if (!model || typeof model !== 'object' || Array.isArray(model)) {
            return cloneJsonValue(model);
        }

        const nextModel = cloneJsonValue(model);
        if (Object.prototype.hasOwnProperty.call(nextModel, 'baseUrl')) {
            delete nextModel.baseUrl;
            changed = true;
        }
        return nextModel;
    });

    return { models: nextModels, changed };
}

function sanitizeProviderConfig(provider) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        return {
            provider: {},
            changed: Boolean(provider)
        };
    }

    const nextProvider = cloneJsonValue(provider);
    let changed = false;

    if (!Array.isArray(nextProvider.models)) {
        if (nextProvider.models !== undefined) {
            changed = true;
        }
        nextProvider.models = [];
    }

    const sanitizedModels = sanitizeProviderModels(nextProvider.models);
    nextProvider.models = sanitizedModels.models;
    if (sanitizedModels.changed) changed = true;

    return { provider: nextProvider, changed };
}

function resolveGatewayPassword(config = {}) {
    const gateway = config?.gateway || {};
    const candidates = [
        gateway?.auth?.password,
        gateway?.password,
        gateway?.controlUi?.password,
        gateway?.controlUi?.auth?.password,
        gateway?.control_ui?.password,
        gateway?.control_ui?.auth?.password
    ];
    return candidates
        .map((value) => String(value || '').trim())
        .find(Boolean) || '';
}

function collectConfiguredModelIds(config = {}) {
    const modelIds = new Set();
    const providers = config?.models?.providers;
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
        Object.entries(providers).forEach(([providerKey, providerValue]) => {
            const models = Array.isArray(providerValue?.models) ? providerValue.models : [];
            models.forEach((model) => {
                const modelId = typeof model === 'string' ? model : model?.id;
                const normalizedModelId = String(modelId || '').trim();
                if (normalizedModelId) {
                    modelIds.add(`${providerKey}/${normalizedModelId}`);
                }
            });
        });
    }

    const defaultModels = config?.agents?.defaults?.models;
    if (defaultModels && typeof defaultModels === 'object' && !Array.isArray(defaultModels)) {
        Object.keys(defaultModels).forEach((modelId) => {
            const normalizedModelId = String(modelId || '').trim();
            if (normalizedModelId) {
                modelIds.add(normalizedModelId);
            }
        });
    }

    return modelIds;
}

function collectConfiguredAgentIds(config = {}) {
    const agentIds = new Set(['main']);
    const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    list.forEach((item) => {
        const id = String(item?.id || '').trim();
        if (id) agentIds.add(id);
    });
    return agentIds;
}

function validateKnownChannelConfig(channelName, channelConfig = {}, errors = [], warnings = []) {
    const normalized = String(channelName || '').trim().toLowerCase();
    const cfg = channelConfig && typeof channelConfig === 'object' && !Array.isArray(channelConfig) ? channelConfig : {};
    const requireField = (ok, message) => {
        if (!ok) errors.push(message);
    };

    if (normalized === 'telegram') {
        requireField(Boolean(String(cfg.botToken || cfg.token || '').trim()), 'Telegram is missing a Bot Token.');
        if (!Array.isArray(cfg.allowFrom) || !cfg.allowFrom.length) {
            warnings.push('Telegram allowFrom is empty; access control may not work as expected.');
        }
        return;
    }

    if (normalized === 'qqbot') {
        const appId = String(cfg.appId || '').trim();
        const appSecret = String(cfg.appSecret || cfg.clientSecret || '').trim();
        const legacyToken = String(cfg.token || '').trim();
        requireField(Boolean((appId && appSecret) || (legacyToken && legacyToken.includes(':'))), 'QQ bot is missing AppID/AppSecret.');
        return;
    }

    if (normalized === 'feishu' || normalized === 'lark') {
        const appId = String(cfg.appId || '').trim();
        const appSecret = String(cfg.appSecret || '').trim();
        const accounts = cfg.accounts && typeof cfg.accounts === 'object' && !Array.isArray(cfg.accounts) ? cfg.accounts : {};
        const hasAccount = Object.values(accounts).some((item) => String(item?.appId || '').trim() && String(item?.appSecret || '').trim());
        requireField(Boolean((appId && appSecret) || hasAccount), 'Feishu bot is missing App ID/App Secret.');
        return;
    }

    if (normalized === 'wecom') {
        const botId = String(cfg.botId || cfg.appId || '').trim();
        const secret = String(cfg.secret || cfg.clientSecret || cfg.appSecret || '').trim();
        requireField(Boolean(botId && secret), 'WeCom bot is missing Bot ID/Secret.');
        return;
    }

    if (normalized === 'dingtalk' || normalized === 'dingtalk-connector') {
        const clientId = String(cfg.clientId || cfg.appId || '').trim();
        const clientSecret = String(cfg.clientSecret || cfg.appSecret || '').trim();
        requireField(Boolean(clientId && clientSecret), 'DingTalk bot is missing Client ID/Client Secret.');
        return;
    }
}

function validateOpenClawConfig(configJson) {
    const config = configJson && typeof configJson === 'object' && !Array.isArray(configJson) ? configJson : {};
    const errors = [];
    const warnings = [];
    const gateway = config.gateway && typeof config.gateway === 'object' && !Array.isArray(config.gateway) ? config.gateway : {};
    const gatewayPort = Number.parseInt(String(gateway.port || ''), 10);
    const gatewayMode = String(gateway.mode || 'local').trim();
    const gatewayAuthMode = String(gateway?.auth?.mode || '').trim().toLowerCase();

    if (gateway.port !== undefined && (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535)) {
        errors.push('Gateway port must be an integer between 1 and 65535.');
    }

    if (gatewayMode && !['local', 'remote'].includes(gatewayMode)) {
        errors.push('Gateway mode only supports local or remote.');
    }

    if (gatewayMode === 'remote' && !String(gateway?.remote?.url || '').trim()) {
        errors.push('Gateway remote mode requires remote.url.');
    }

    if (gatewayAuthMode && !['none', 'token', 'password'].includes(gatewayAuthMode)) {
        warnings.push(`Gateway auth mode ${gatewayAuthMode} is not recognized by this panel.`);
    }

    if (gatewayAuthMode === 'token' && !resolveGatewayAuthToken(config)) {
        errors.push('Gateway auth mode is token but token is missing.');
    }

    if (gatewayAuthMode === 'password' && !resolveGatewayPassword(config)) {
        errors.push('Gateway auth mode is password but password is missing.');
    }

    const providers = config?.models?.providers;
    if (providers !== undefined && (!providers || typeof providers !== 'object' || Array.isArray(providers))) {
        errors.push('models.providers must be an object.');
    }

    const configuredModelIds = collectConfiguredModelIds(config);
    const primaryModel = String(config?.agents?.defaults?.model?.primary || '').trim();
    if (primaryModel && configuredModelIds.size && !configuredModelIds.has(primaryModel)) {
        errors.push(`Primary model ${primaryModel} was not found in configured models.`);
    }

    const fallbackModels = Array.isArray(config?.agents?.defaults?.model?.fallbacks)
        ? config.agents.defaults.model.fallbacks
        : [];
    fallbackModels.forEach((modelId) => {
        const normalizedModelId = String(modelId || '').trim();
        if (normalizedModelId && configuredModelIds.size && !configuredModelIds.has(normalizedModelId)) {
            warnings.push(`Fallback model ${normalizedModelId} was not found in configured models.`);
        }
    });

    const channels = config.channels;
    if (channels !== undefined && (!channels || typeof channels !== 'object' || Array.isArray(channels))) {
        errors.push('channels must be an object.');
    } else if (channels && typeof channels === 'object') {
        Object.entries(channels).forEach(([channelName, channelConfig]) => {
            if (!channelConfig || typeof channelConfig !== 'object' || Array.isArray(channelConfig)) {
                errors.push(`Channel ${channelName} config must be an object.`);
                return;
            }
            validateKnownChannelConfig(channelName, channelConfig, errors, warnings);
        });
    }

    const agentIds = collectConfiguredAgentIds(config);
    const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
    bindings.forEach((binding, index) => {
        const agentId = String(binding?.agentId || '').trim();
        const matchChannel = String(binding?.match?.channel || '').trim();
        if (agentId && !agentIds.has(agentId)) {
            errors.push(`bindings[${index}] references a missing Agent: ${agentId}`);
        }
        if (!matchChannel) {
            warnings.push(`bindings[${index}] is missing match.channel.`);
        }
    });

    return {
        ok: errors.length === 0,
        errors,
        warnings
    };
}

function sanitizeOpenClawConfig(configJson) {
    const config = cloneJsonValue(configJson || {});
    let changed = false;

    if (Object.prototype.hasOwnProperty.call(config, 'dashboard')) {
        delete config.dashboard;
        changed = true;
    }

    if (!config.gateway || typeof config.gateway !== 'object') {
        config.gateway = {};
        changed = true;
    }

    if (config.gateway.bind === 'all') {
        config.gateway.bind = 'lan';
        changed = true;
    }

    const legacyGatewayMode = config.gateway.mode;
    if (legacyGatewayMode === 'lan' || legacyGatewayMode === 'public') {
        config.gateway.mode = 'local';
        if (!config.gateway.bind) {
            config.gateway.bind = 'lan';
        }
        changed = true;
    } else if (legacyGatewayMode === 'remote' && !config.gateway?.remote?.url) {
        config.gateway.mode = 'local';
        if (!config.gateway.bind) {
            config.gateway.bind = 'lan';
        }
        changed = true;
    } else if (legacyGatewayMode && !['local', 'remote'].includes(legacyGatewayMode)) {
        config.gateway.mode = 'local';
        changed = true;
    }

    if (!config.gateway.mode) {
        config.gateway.mode = 'local';
        changed = true;
    }

    if (!config.tools || typeof config.tools !== 'object') {
        config.tools = {};
        changed = true;
    }

    const defaults = config?.agents?.defaults;
    if (defaults && typeof defaults === 'object') {
        const legacyToolsMode = defaults.tools_mode;
        const legacyToolsEnabled = defaults.tools_enabled;

        if (!config.tools.profile && (legacyToolsMode || legacyToolsEnabled !== undefined)) {
            if (legacyToolsMode) {
                config.tools.profile = normalizeToolsProfile(legacyToolsMode);
            } else if (legacyToolsEnabled === false) {
                config.tools.profile = 'none';
            } else {
                config.tools.profile = 'full';
            }
            changed = true;
        }

        if (Object.prototype.hasOwnProperty.call(defaults, 'tools_mode')) {
            delete defaults.tools_mode;
            changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(defaults, 'tools_enabled')) {
            delete defaults.tools_enabled;
            changed = true;
        }
    }

    if (config.tools.profile) {
        const normalizedProfile = normalizeToolsProfile(config.tools.profile);
        if (normalizedProfile !== config.tools.profile) {
            config.tools.profile = normalizedProfile;
            changed = true;
        }
    }

    if (config.models && typeof config.models === 'object') {
        if (config.models.providers && typeof config.models.providers === 'object' && !Array.isArray(config.models.providers)) {
            for (const providerKey of Object.keys(config.models.providers)) {
                const sanitizedProvider = sanitizeProviderConfig(config.models.providers[providerKey]);
                config.models.providers[providerKey] = sanitizedProvider.provider;
                if (sanitizedProvider.changed) {
                    changed = true;
                }
            }
        }
    }

    if (config.cron && typeof config.cron === 'object' && !Array.isArray(config.cron)) {
        if (Object.prototype.hasOwnProperty.call(config.cron, 'jobs')) {
            delete config.cron.jobs;
            changed = true;
        }
        if (Object.keys(config.cron).length === 0) {
            delete config.cron;
            changed = true;
        }
    }

    return { config, changed };
}

function pruneConfigSnapshotsSync() {
    try {
        if (!fs.existsSync(configSnapshotDir)) return;
        const files = fs.readdirSync(configSnapshotDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && /^openclaw\.json\.bak-\d{8}-\d{6}-[0-9a-f]{12}\.json$/i.test(entry.name))
            .map((entry) => ({
                name: entry.name,
                path: path.join(configSnapshotDir, entry.name),
                mtimeMs: fs.statSync(path.join(configSnapshotDir, entry.name)).mtimeMs
            }))
            .sort((left, right) => right.mtimeMs - left.mtimeMs);

        files.slice(MAX_CONFIG_SNAPSHOTS).forEach((item) => {
            try {
                fs.unlinkSync(item.path);
            } catch (_) {}
        });
    } catch (error) {
        console.warn('[Config] Failed to prune snapshots:', error.message);
    }
}

function createConfigSnapshotSync(rawText, reason = 'snapshot') {
    const payload = String(rawText || '').trim();
    if (!payload) return '';

    try {
        ensureDirectory(configSnapshotDir);
        const fileName = `openclaw.json.bak-${createTimestampTag()}-${createStableHash(payload).slice(0, 12)}.json`;
        const snapshotPath = path.join(configSnapshotDir, fileName);
        fs.writeFileSync(snapshotPath, payload, 'utf8');
        pruneConfigSnapshotsSync();
        appendConfigAuditLog({
            action: 'config-snapshot',
            reason,
            snapshotPath
        });
        return snapshotPath;
    } catch (error) {
        console.warn('[Config] Failed to create snapshot:', error.message);
        return '';
    }
}

function markConfigKnownGoodSync(configJson, options = {}) {
    const rawText = typeof configJson === 'string' ? configJson : JSON.stringify(configJson || {}, null, 2);
    const hash = createStableHash(rawText);
    const snapshotPath = createConfigSnapshotSync(rawText, options.reason || 'known-good');
    const state = readConfigHealthStateSync();
    const nextState = {
        ...state,
        lastKnownGoodHash: hash,
        lastKnownGoodSnapshotPath: snapshotPath || state.lastKnownGoodSnapshotPath || '',
        lastValidatedAt: new Date().toISOString(),
        lastValidationSource: options.source || 'unknown',
        lastBootStatus: 'healthy',
        lastBootReason: options.reason || 'validated',
        pendingHash: '',
        pendingSnapshotPath: '',
        pendingSource: '',
        pendingAt: ''
    };
    writeConfigHealthStateSync(nextState);
    lastGoodConfig = rawText;
    lastObservedConfigHash = hash;
    appendConfigAuditLog({
        action: 'config-known-good',
        source: options.source || 'unknown',
        reason: options.reason || 'validated',
        hash
    });
    return nextState;
}

function markConfigPendingSync(configJson, options = {}) {
    const rawText = typeof configJson === 'string' ? configJson : JSON.stringify(configJson || {}, null, 2);
    const hash = createStableHash(rawText);
    const snapshotPath = createConfigSnapshotSync(rawText, options.reason || 'pending');
    const state = readConfigHealthStateSync();
    const nextState = {
        ...state,
        pendingHash: hash,
        pendingSnapshotPath: snapshotPath || '',
        pendingSource: options.source || 'unknown',
        pendingAt: new Date().toISOString(),
        lastBootStatus: state.lastBootStatus || 'unknown'
    };
    writeConfigHealthStateSync(nextState);
    lastObservedConfigHash = hash;
    appendConfigAuditLog({
        action: 'config-pending',
        source: options.source || 'unknown',
        reason: options.reason || 'pending',
        hash
    });
    return nextState;
}

function rollbackConfigToLastKnownGoodSync(reason = 'rollback') {
    const state = readConfigHealthStateSync();
    const candidates = [
        state.lastKnownGoodSnapshotPath,
        path.join(openClawHomeDir, 'openclaw.json.bak')
    ].filter(Boolean);
    let rawText = '';

    for (const candidate of candidates) {
        try {
            if (candidate && fs.existsSync(candidate)) {
                rawText = fs.readFileSync(candidate, 'utf8');
                if (rawText.trim()) break;
            }
        } catch (_) {}
    }

    if (!rawText && lastGoodConfig) {
        rawText = String(lastGoodConfig);
    }

    if (!rawText.trim()) {
        return {
            ok: false,
            error: 'No recent known-good config snapshot was found.'
        };
    }

    fs.writeFileSync(configPath, rawText, 'utf8');
    const hash = createStableHash(rawText);
    const nextState = {
        ...state,
        pendingHash: '',
        pendingSnapshotPath: '',
        pendingSource: '',
        pendingAt: '',
        lastBootStatus: 'rolled-back',
        lastBootReason: reason,
        lastValidatedAt: new Date().toISOString()
    };
    writeConfigHealthStateSync(nextState);
    lastGoodConfig = rawText;
    lastObservedConfigHash = hash;
    appendConfigAuditLog({
        action: 'config-rollback',
        reason,
        hash
    });
    return {
        ok: true,
        hash,
        sourcePath: state.lastKnownGoodSnapshotPath || ''
    };
}

function getManualConfigRestorePathSync() {
    const state = readConfigHealthStateSync();
    const candidates = [
        state.lastKnownGoodSnapshotPath,
        path.join(openClawHomeDir, 'openclaw.json.bak')
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            if (candidate && fs.existsSync(candidate)) {
                return candidate;
            }
        } catch (_) {}
    }

    return '';
}

function buildManualConfigRestoreHint() {
    const restorePath = getManualConfigRestorePathSync();
    if (restorePath) {
        return `系统未自动恢复，请确认后手动恢复最近可用快照：${restorePath}`;
    }
    return 'System did not auto-restore. Please inspect openclaw.json before choosing manual restore.';
}

function persistSanitizedConfig(configJson) {
    ensureDirectory(openClawHomeDir);
    try {
        if (fs.existsSync(configPath)) {
            fs.copyFileSync(configPath, path.join(openClawHomeDir, 'openclaw.json.bak'));
        }
    } catch (error) {
        console.warn('[Config] Failed to create backup:', error.message);
    }

    const payload = writeJsonFileSync(configPath, configJson || {});
    lastGoodConfig = payload;
    lastObservedConfigHash = createStableHash(payload);
    return payload;
}

function captureKnownGoodBaselineIfNeeded() {
    const state = readConfigHealthStateSync();
    if (state.lastKnownGoodHash) return;
    if (!fs.existsSync(configPath)) return;

    try {
        const rawText = fs.readFileSync(configPath, 'utf8');
        const parsed = parseConfigText(rawText);
        const { config } = sanitizeOpenClawConfig(parsed);
        const validation = validateOpenClawConfig(config);
        if (!validation.ok) return;
        markConfigKnownGoodSync(config, {
            source: 'bootstrap',
            reason: 'initial-baseline'
        });
    } catch (_) {}
}

function readOpenClawConfigSync() {
    if (!fs.existsSync(configPath)) {
        clearOpenClawConfigCache();
        return {};
    }

    const cacheEntry = buildFileStatCacheEntry(configPath);
    if (openClawConfigCache.config && cacheEntry.key && openClawConfigCache.key === cacheEntry.key) {
        return cloneJsonValue(openClawConfigCache.config);
    }

    const raw = readJsonFile(configPath, {}) || {};
    const { config, changed } = sanitizeOpenClawConfig(raw);
    if (changed) {
        persistSanitizedConfig(config);
    }
    updateOpenClawConfigCache(
        config,
        changed ? buildFileStatCacheEntry(configPath).stat : cacheEntry.stat
    );
    return cloneJsonValue(config);
}

function writeJsonFileSync(filePath, value) {
    ensureDirectory(path.dirname(filePath));
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(value, null, 2);
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, filePath);
    return payload;
}

function writeOpenClawConfigSync(configJson) {
    captureKnownGoodBaselineIfNeeded();
    const { config } = sanitizeOpenClawConfig(configJson || {});
    const validation = validateOpenClawConfig(config);
    if (!validation.ok) {
        appendConfigAuditLog({
            action: 'config-save-rejected',
            source: 'app-save',
            errors: validation.errors,
            warnings: validation.warnings
        });
        return {
            ok: false,
            error: validation.errors[0] || '配置校验失败',
            errors: validation.errors,
            warnings: validation.warnings
        };
    }

    const payload = persistSanitizedConfig(config);
    updateOpenClawConfigCache(config, buildFileStatCacheEntry(configPath).stat);
    markConfigPendingSync(payload, {
        source: 'app-save',
        reason: 'validated-write'
    });
    syncAgentModelsFromConfig(config);
    scheduleConfigHealthCheck('app-save', 1800);
    return {
        ok: true,
        warnings: validation.warnings
    };
}

function normalizeAgentName(value) {
    const agentName = String(value || '').trim().toLowerCase();
    if (!agentName) throw new Error('Agent ID 不能为空');
    if (!/^[a-z0-9_-]+$/.test(agentName)) {
        throw new Error('Agent ID 仅支持小写字母、数字、下划线和连字符');
    }
    return agentName;
}

function normalizeAgentFileName(fileName) {
    const normalized = path.basename(String(fileName || '').trim());
    if (!editableAgentFiles.has(normalized)) {
        throw new Error(`不支持的 Agent 文件: ${normalized}`);
    }
    return normalized;
}

function resolveAbsolute(inputPath) {
    return path.resolve(expandHomePath(String(inputPath || '')));
}

function isSubPath(targetPath, basePath) {
    const target = path.resolve(targetPath);
    const base = path.resolve(basePath);
    return target === base || target.startsWith(base + path.sep);
}

function replaceRootPrefix(inputPath, fromRoot, toRoot) {
    if (!inputPath) return inputPath;
    const absoluteInput = resolveAbsolute(inputPath);
    const absoluteFrom = path.resolve(fromRoot);
    if (!isSubPath(absoluteInput, absoluteFrom)) {
        return inputPath;
    }
    return path.join(toRoot, path.relative(absoluteFrom, absoluteInput));
}

function getAgentsRootPath() {
    return ensureDirectory(agentsRootPath);
}

function getAgentRootPath(agentName) {
    return path.join(getAgentsRootPath(), normalizeAgentName(agentName));
}

function getAgentSessionsPath(agentName) {
    return path.join(getAgentRootPath(agentName), 'sessions');
}

function getConfiguredAgentEntries(config) {
    const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    return list
        .filter(item => item && typeof item === 'object')
        .map(item => ({ ...item }))
        .filter(item => {
            try {
                item.id = normalizeAgentName(item.id);
                return true;
            } catch (_) {
                return false;
            }
        });
}

function getAgentConfigEntry(config, agentName) {
    const normalized = normalizeAgentName(agentName);
    return getConfiguredAgentEntries(config).find(item => item.id === normalized) || null;
}

function getDefaultWorkspacePath(config) {
    const configured = config?.agents?.defaults?.workspace;
    if (configured) return resolveAbsolute(configured);
    return path.join(openClawHomeDir, 'workspace');
}

function getAgentWorkspacePath(config, agentName) {
    const normalized = normalizeAgentName(agentName);
    const entry = getAgentConfigEntry(config, normalized);
    if (entry?.workspace) return resolveAbsolute(entry.workspace);
    if (normalized === 'main') return getDefaultWorkspacePath(config);
    return path.join(getAgentRootPath(normalized), 'workspace');
}

function getAgentMetadataDir(config, agentName) {
    const normalized = normalizeAgentName(agentName);
    const entry = getAgentConfigEntry(config, normalized);
    if (entry?.agentDir) return resolveAbsolute(entry.agentDir);
    return path.join(getAgentRootPath(normalized), 'agent');
}

function hasAgentRootMarkers(agentRootPath) {
    const resolvedRoot = String(agentRootPath || '').trim();
    if (!resolvedRoot || !fs.existsSync(resolvedRoot)) return false;

    const markers = [
        'workspace',
        'agent',
        'sessions',
        'IDENTITY.md',
        'SOUL.md',
        'USER.md',
        'AGENTS.md',
        'TOOLS.json'
    ];

    return markers.some((marker) => fs.existsSync(path.join(resolvedRoot, marker)));
}

function mergeAgentIds(config) {
    const ids = new Set(['main']);

    for (const entry of getConfiguredAgentEntries(config)) {
        ids.add(entry.id);
    }

    if (Array.isArray(config?.bindings)) {
        for (const binding of config.bindings) {
            if (!binding?.agentId) continue;
            try {
                ids.add(normalizeAgentName(binding.agentId));
            } catch (_) {}
        }
    }

    if (fs.existsSync(agentsRootPath)) {
        for (const entry of fs.readdirSync(agentsRootPath, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            try {
                const normalizedId = normalizeAgentName(entry.name);
                if (normalizedId === 'main' || hasAgentRootMarkers(path.join(agentsRootPath, entry.name))) {
                    ids.add(normalizedId);
                }
            } catch (_) {}
        }
    }

    return Array.from(ids).sort((a, b) => {
        if (a === 'main') return -1;
        if (b === 'main') return 1;
        return a.localeCompare(b, 'zh-CN');
    });
}

function getAgentFileCandidates(config, agentName, fileName) {
    const normalizedFile = normalizeAgentFileName(fileName);
    const normalizedAgent = normalizeAgentName(agentName);
    const candidates = [];
    const seen = new Set();

    const pushCandidate = candidatePath => {
        if (!candidatePath) return;
        const resolved = path.resolve(candidatePath);
        if (seen.has(resolved)) return;
        seen.add(resolved);
        candidates.push(resolved);
    };

    pushCandidate(path.join(getAgentWorkspacePath(config, normalizedAgent), normalizedFile));
    pushCandidate(path.join(getAgentRootPath(normalizedAgent), normalizedFile));
    pushCandidate(path.join(getAgentMetadataDir(config, normalizedAgent), normalizedFile));

    return candidates;
}

function resolveAgentFilePath(config, agentName, fileName) {
    const candidates = getAgentFileCandidates(config, agentName, fileName);
    const existing = candidates.find(candidate => fs.existsSync(candidate));
    return existing || candidates[0];
}

function ensureAgentWorkspaceFiles(agentId, workspacePath, displayName = agentId) {
    const normalizedAgent = normalizeAgentName(agentId);
    const resolvedWorkspace = resolveAbsolute(workspacePath);
    ensureDirectory(resolvedWorkspace);

    const fileTemplates = {
        'IDENTITY.md': `# ${displayName}\n\n你是 Agent「${normalizedAgent}」。\n`,
        'SOUL.md': `# ${displayName} Soul\n\n在这里记录这个 Agent 的风格、偏好和长期约束。\n`,
        'USER.md': '# User Context\n\n在这里记录这个 Agent 面向的用户背景和协作约定。\n',
        'AGENTS.md': `# ${displayName} Workspace Notes\n\n在这里补充 Agent 运行所需的额外说明。\n`,
        'TOOLS.json': '{}\n',
        'BOOTSTRAP.md': '# Session Bootstrap\n\n在这里记录这个 Agent 每次开工前都应遵守的默认流程。\n',
        'HEARTBEAT.md': '# HEARTBEAT.md Template\n\n# Keep this file empty (or with only comments) to skip heartbeat API calls.\n',
        'MEMORY.md': '# MEMORY\n\n在这里记录这个 Agent 的长期偏好、决策和持续事项。\n',
        'TOOLS.md': '# TOOLS.md - Local Notes\n\n在这里记录这个 Agent 的本地工具、环境和协作备忘。\n'
    };

    for (const [fileName, template] of Object.entries(fileTemplates)) {
        const target = path.join(resolvedWorkspace, fileName);
        if (!fs.existsSync(target)) {
            fs.writeFileSync(target, template, 'utf8');
        }
    }
}

function copyFileIfMissing(sourcePath, targetPath, fallbackContent) {
    if (fs.existsSync(targetPath)) return;
    ensureDirectory(path.dirname(targetPath));

    if (sourcePath && fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, targetPath);
        return;
    }

    fs.writeFileSync(targetPath, fallbackContent, 'utf8');
}

function normalizeModelApiType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return 'openai-completions';
    if (normalized === 'google-gemini') return 'google-generative-ai';
    return normalized;
}

function isOpenAIApiBaseUrl(baseUrl) {
    const trimmed = String(baseUrl || '').trim();
    if (!trimmed) return false;
    return /^https?:\/\/api\.openai\.com\/v1\/?$/i.test(trimmed);
}

function isOpenAICodexBaseUrl(baseUrl) {
    const trimmed = String(baseUrl || '').trim();
    if (!trimmed) return false;
    return /^https?:\/\/chatgpt\.com\/backend-api\/?$/i.test(trimmed);
}

function normalizeOpenAICodexTransport(providerKey, apiType, baseUrl) {
    const normalizedApi = normalizeModelApiType(apiType);
    const normalizedProvider = String(providerKey || '').trim().toLowerCase();
    const trimmedBaseUrl = String(baseUrl || '').trim();
    const targetsCodex = normalizedProvider === 'openai-codex' || normalizedApi === 'openai-codex-responses';

    if (!targetsCodex) {
        return {
            api: normalizedApi,
            baseUrl: trimmedBaseUrl
        };
    }

    const nextApi = (!trimmedBaseUrl || isOpenAIApiBaseUrl(trimmedBaseUrl) || isOpenAICodexBaseUrl(trimmedBaseUrl))
        && normalizedApi === 'openai-responses'
        ? 'openai-codex-responses'
        : normalizedApi;

    const nextBaseUrl = nextApi === 'openai-codex-responses' && (!trimmedBaseUrl || isOpenAIApiBaseUrl(trimmedBaseUrl))
        ? openAICodexBaseUrl
        : trimmedBaseUrl;

    return {
        api: nextApi,
        baseUrl: nextBaseUrl
    };
}

function getProviderPreset(providerKey) {
    const key = String(providerKey || '').trim().toLowerCase();
    const presets = {
        openai: { api: 'openai-completions', baseUrl: openAIApiBaseUrl },
        'openai-codex': { api: 'openai-codex-responses', baseUrl: openAICodexBaseUrl },
        codex: { api: 'openai-completions', baseUrl: openAIApiBaseUrl },
        anthropic: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1' },
        claude: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1' },
        google: { api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
        gemini: { api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
        ollama: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:11434/v1' }
    };
    return presets[key] || null;
}

function getDefaultModelBaseUrl(apiType, providerKey = '') {
    const normalizedApi = normalizeModelApiType(apiType);
    const preset = getProviderPreset(providerKey);
    if (preset?.baseUrl) return preset.baseUrl;
    if (normalizedApi === 'openai-codex-responses') return openAICodexBaseUrl;
    if (normalizedApi === 'anthropic-messages') return 'https://api.anthropic.com/v1';
    if (normalizedApi === 'google-generative-ai') return 'https://generativelanguage.googleapis.com/v1beta';
    return openAIApiBaseUrl;
}

function isOpenAICodexProvider(providerKey, apiType, authProfile = null) {
    const normalizedProvider = String(providerKey || '').trim().toLowerCase();
    const normalizedApi = normalizeModelApiType(apiType);
    const normalizedAuthType = normalizeAuthProfileType(authProfile);
    return normalizedProvider === 'openai-codex'
        || normalizedApi === 'openai-codex-responses'
        || (normalizedProvider === 'openai-codex' && normalizedAuthType === 'oauth');
}

function getBuiltInProviderModels(providerKey, provider = {}, authProfile = null) {
    if (!isOpenAICodexProvider(providerKey, provider?.api, authProfile)) {
        return [];
    }

    const transport = normalizeOpenAICodexTransport(
        providerKey,
        provider?.api || 'openai-codex-responses',
        trimTrailingSlash(provider?.baseUrl || openAICodexBaseUrl)
    );

    return cloneJsonValue(openAICodexBuiltinModels).map((model) => ({
        ...model,
        api: transport.api,
        baseUrl: transport.baseUrl
    }));
}

function normalizeModelEntry(model, fallbackApi) {
    if (!model) return null;
    if (typeof model === 'string') {
        const modelId = String(model).trim();
        if (!modelId) return null;
        return {
            id: modelId,
            name: modelId,
            api: normalizeModelApiType(fallbackApi)
        };
    }

    if (typeof model !== 'object') return null;

    const modelId = String(model.id || model.name || '').trim();
    if (!modelId) return null;

    const next = cloneJsonValue(model);
    next.id = modelId;
    if (!next.name) next.name = modelId;
    if (fallbackApi && !next.api) next.api = normalizeModelApiType(fallbackApi);
    return next;
}

function mergeModelEntries(primaryModels = [], secondaryModels = [], fallbackApi) {
    const merged = new Map();

    for (const model of secondaryModels || []) {
        const normalized = normalizeModelEntry(model, fallbackApi);
        if (!normalized) continue;
        merged.set(normalized.id, normalized);
    }

    for (const model of primaryModels || []) {
        const normalized = normalizeModelEntry(model, fallbackApi);
        if (!normalized) continue;
        merged.set(normalized.id, {
            ...(merged.get(normalized.id) || {}),
            ...normalized
        });
    }

    return Array.from(merged.values());
}

function normalizeProviderEntry(providerKey, provider = {}, defaults = {}) {
    const preset = getProviderPreset(providerKey) || {};
    const normalizedApi = normalizeModelApiType(provider?.api || defaults.api || preset.api);
    const baseUrl = String(provider?.baseUrl || defaults.baseUrl || preset.baseUrl || '').trim()
        || getDefaultModelBaseUrl(normalizedApi, providerKey);
    const normalizedTransport = normalizeOpenAICodexTransport(providerKey, normalizedApi, baseUrl);

    return {
        ...cloneJsonValue(provider || {}),
        api: normalizedTransport.api,
        baseUrl: normalizedTransport.baseUrl,
        models: mergeModelEntries(provider?.models || [], defaults.models || [], normalizedTransport.api)
    };
}

function mergeProviderEntries(primaryProvider, secondaryProvider, providerKey) {
    if (!primaryProvider && !secondaryProvider) {
        return normalizeProviderEntry(providerKey, {}, {});
    }

    if (!secondaryProvider) {
        return normalizeProviderEntry(providerKey, primaryProvider || {}, {});
    }

    if (!primaryProvider) {
        return normalizeProviderEntry(providerKey, secondaryProvider || {}, {});
    }

    const mergedProvider = {
        ...cloneJsonValue(secondaryProvider),
        ...cloneJsonValue(primaryProvider),
        api: normalizeModelApiType(primaryProvider.api || secondaryProvider.api),
        baseUrl: String(primaryProvider.baseUrl || secondaryProvider.baseUrl || '').trim()
            || getDefaultModelBaseUrl(primaryProvider.api || secondaryProvider.api, providerKey)
    };

    mergedProvider.models = mergeModelEntries(
        primaryProvider.models || [],
        secondaryProvider.models || [],
        mergedProvider.api
    );

    return normalizeProviderEntry(providerKey, mergedProvider, {});
}

function readAgentMetadataJson(config, agentName, fileName, fallback) {
    try {
        const targetPath = path.join(getAgentMetadataDir(config, agentName), fileName);
        return readJsonFile(targetPath, fallback);
    } catch (_) {
        return fallback;
    }
}

function readAgentModelsCatalog(config, agentName = 'main') {
    const payload = readAgentMetadataJson(config, agentName, 'models.json', { providers: {} }) || { providers: {} };
    if (!payload.providers || typeof payload.providers !== 'object') {
        payload.providers = {};
    }
    return payload;
}

function mergeAuthProfileMaps(...sources) {
    const merged = {
        version: 1,
        profiles: {},
        lastGood: {},
        usageStats: {}
    };

    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        if (source.profiles && typeof source.profiles === 'object') {
            Object.assign(merged.profiles, cloneJsonValue(source.profiles));
        }
        if (source.lastGood && typeof source.lastGood === 'object') {
            Object.assign(merged.lastGood, cloneJsonValue(source.lastGood));
        }
        if (source.usageStats && typeof source.usageStats === 'object') {
            Object.assign(merged.usageStats, cloneJsonValue(source.usageStats));
        }
    }

    return merged;
}

function readAgentAuthProfiles(config, agentName = 'main') {
    const rootAuth = config?.auth && typeof config.auth === 'object' ? config.auth : {};
    const metadataAuth = readAgentMetadataJson(config, agentName, 'auth-profiles.json', {
        version: 1,
        profiles: {},
        lastGood: {},
        usageStats: {}
    }) || {
        version: 1,
        profiles: {},
        lastGood: {},
        usageStats: {}
    };

    return mergeAuthProfileMaps(rootAuth, metadataAuth);
}

function collectReferencedProviderModels(config) {
    const referenced = new Map();
    const defaults = config?.agents?.defaults || {};
    const defaultModel = defaults?.model || {};
    const declaredModels = defaults?.models && typeof defaults.models === 'object'
        ? defaults.models
        : {};

    const resolveReferencedProviderKey = (fullModelId, fallbackProviderKey) => {
        const declared = declaredModels[String(fullModelId || '').trim()];
        const alias = String(declared?.alias || '').trim();
        if (!alias) return fallbackProviderKey;

        if (alias.includes('/')) {
            const slashIndex = alias.indexOf('/');
            const providerFromAlias = alias.slice(0, slashIndex).trim();
            return providerFromAlias || fallbackProviderKey;
        }

        return alias;
    };

    const pushModel = (fullModelId) => {
        const raw = String(fullModelId || '').trim();
        if (!raw || !raw.includes('/')) return;

        const slashIndex = raw.indexOf('/');
        const providerKey = resolveReferencedProviderKey(raw, raw.slice(0, slashIndex).trim());
        const modelId = raw.slice(slashIndex + 1).trim();
        if (!providerKey || !modelId) return;

        if (!referenced.has(providerKey)) {
            referenced.set(providerKey, []);
        }

        referenced.get(providerKey).push({
            id: modelId,
            name: modelId
        });
    };
    pushModel(defaultModel.primary);

    if (Array.isArray(defaultModel.fallbacks)) {
        defaultModel.fallbacks.forEach(pushModel);
    }

    if (defaults.models && typeof defaults.models === 'object') {
        Object.keys(defaults.models).forEach(pushModel);
    }

    if (Array.isArray(config?.agents?.list)) {
        for (const entry of config.agents.list) {
            pushModel(entry?.model);
        }
    }

    return referenced;
}

function normalizeAuthProfileType(profile) {
    const raw = String(profile?.type || profile?.mode || '').trim().toLowerCase();
    if (raw === 'api_key' || raw === 'api-key') return 'api_key';
    if (raw === 'oauth') return 'oauth';
    return raw || 'unknown';
}

function getAuthProfileProviderCandidates(providerKey, provider = null) {
    const normalizedProviderKey = String(providerKey || '').trim();
    const normalizedApiType = normalizeModelApiType(provider?.api);
    const candidates = [normalizedProviderKey];

    if (normalizedApiType === 'openai-codex-responses') {
        candidates.push('openai-codex', 'codex');
    }

    return Array.from(new Set(candidates.filter(Boolean)));
}

function getPreferredAuthProfile(authData, providerKey, provider = null) {
    const profiles = authData?.profiles && typeof authData.profiles === 'object'
        ? authData.profiles
        : {};
    const providerCandidates = getAuthProfileProviderCandidates(providerKey, provider);

    const matches = Object.entries(profiles)
        .filter(([, profile]) => providerCandidates.includes(String(profile?.provider || '').trim()))
        .map(([id, profile]) => ({ id, ...cloneJsonValue(profile) }));

    if (!matches.length) return null;

    for (const candidateKey of providerCandidates) {
        const preferredId = authData?.lastGood?.[candidateKey];
        if (!preferredId) continue;
        const match = matches.find(item => item.id === preferredId);
        if (match) return match;
    }

    return matches[0];
}

function buildRuntimeModelCatalog(config, agentName = 'main') {
    const configProviders = cloneJsonValue(config?.models?.providers || {});
    const agentModels = readAgentModelsCatalog(config, agentName);
    const authData = readAgentAuthProfiles(config, agentName);
    const referencedModels = collectReferencedProviderModels(config);

    const providerKeys = new Set([
        ...Object.keys(configProviders),
        ...Object.keys(agentModels.providers || {}),
        ...Object.keys(authData.profiles || {}).map((profileId) => {
            const provider = authData?.profiles?.[profileId]?.provider;
            return String(provider || '').trim();
        }).filter(Boolean),
        ...Array.from(referencedModels.keys())
    ]);

    const providers = Array.from(providerKeys).map((providerKey) => {
        const configProvider = configProviders[providerKey] || null;
        const agentProvider = agentModels.providers?.[providerKey] || null;
        const mergedProvider = mergeProviderEntries(configProvider, agentProvider, providerKey);
        mergedProvider.models = mergeModelEntries(
            mergedProvider.models || [],
            referencedModels.get(providerKey) || [],
            mergedProvider.api
        );

        const authProfile = getPreferredAuthProfile(authData, providerKey, mergedProvider);
        mergedProvider.models = mergeModelEntries(
            mergedProvider.models || [],
            getBuiltInProviderModels(providerKey, mergedProvider, authProfile),
            mergedProvider.api
        );
        const authType = normalizeAuthProfileType(authProfile);
        const hasConfigKey = Boolean(String(configProvider?.apiKey || mergedProvider?.apiKey || '').trim());
        const credentialMode = hasConfigKey
            ? 'config-key'
            : authType === 'oauth'
                ? 'oauth'
                : authType === 'api_key'
                    ? 'auth-api-key'
                    : 'none';

        const sourceKey = configProvider
            ? 'config'
            : authType === 'oauth'
                ? 'auth-oauth'
                : authType === 'api_key'
                    ? 'auth-key'
                    : agentProvider
                        ? 'runtime'
                        : 'reference';

        return {
            key: providerKey,
            api: mergedProvider.api,
            baseUrl: mergedProvider.baseUrl,
            models: mergedProvider.models || [],
            editable: Boolean(configProvider),
            inConfig: Boolean(configProvider),
            hasAgentMetadata: Boolean(agentProvider),
            authProfileId: authProfile?.id || '',
            credentialMode,
            sourceKey
        };
    });

    const groupOrder = {
        config: 0,
        'auth-oauth': 1,
        'auth-key': 2,
        runtime: 3,
        reference: 4
    };

    providers.sort((a, b) => {
        const orderA = groupOrder[a.sourceKey] ?? 99;
        const orderB = groupOrder[b.sourceKey] ?? 99;
        if (orderA !== orderB) return orderA - orderB;
        return a.key.localeCompare(b.key, 'zh-CN');
    });

    return { providers };
}

function buildModelsPayload(config, agentName = 'main') {
    const runtimeCatalog = buildRuntimeModelCatalog(config, agentName);
    const existingCatalog = readAgentModelsCatalog(config, agentName);
    return {
        providers: runtimeCatalog.providers.reduce((acc, provider) => {
            const shouldPersist = provider.inConfig
                || provider.sourceKey === 'auth-oauth'
                || provider.sourceKey === 'auth-key'
                || provider.sourceKey === 'reference';

            if (!shouldPersist) {
                return acc;
            }

            acc[provider.key] = {
                api: provider.api,
                baseUrl: provider.baseUrl,
                models: sanitizeProviderModels(provider.models || []).models
            };

            if (provider.inConfig) {
                const configProvider = config?.models?.providers?.[provider.key] || {};
                if (configProvider.apiKey) {
                    acc[provider.key].apiKey = configProvider.apiKey;
                }
            } else if (provider.hasAgentMetadata) {
                const metadataProvider = existingCatalog?.providers?.[provider.key] || {};
                if (metadataProvider.apiKey) {
                    acc[provider.key].apiKey = metadataProvider.apiKey;
                }
            }

            return acc;
        }, {})
    };
}

function ensureAgentMetadataFiles(config, agentName) {
    const metadataDir = getAgentMetadataDir(config, agentName);
    const mainMetadataDir = path.join(getAgentRootPath('main'), 'agent');
    ensureDirectory(metadataDir);

    copyFileIfMissing(
        path.join(mainMetadataDir, 'auth-profiles.json'),
        path.join(metadataDir, 'auth-profiles.json'),
        JSON.stringify({ version: 1, profiles: {}, lastGood: {}, usageStats: {} }, null, 2)
    );

    copyFileIfMissing(
        path.join(mainMetadataDir, 'models.json'),
        path.join(metadataDir, 'models.json'),
        JSON.stringify(buildModelsPayload(config, agentName), null, 2)
    );
}

function syncAgentModelsFromConfig(config) {
    for (const agentId of mergeAgentIds(config)) {
        const metadataDir = getAgentMetadataDir(config, agentId);
        ensureDirectory(metadataDir);
        const payload = buildModelsPayload(config, agentId);
        fs.writeFileSync(path.join(metadataDir, 'models.json'), JSON.stringify(payload, null, 2), 'utf8');
        ensureAgentMetadataFiles(config, agentId);
    }
}

function parseFullModelId(fullModelId) {
    const raw = String(fullModelId || '').trim();
    if (!raw) return null;
    const slashIndex = raw.indexOf('/');
    if (slashIndex <= 0 || slashIndex === raw.length - 1) return null;
    return {
        full: raw,
        providerKey: raw.slice(0, slashIndex).trim(),
        modelId: raw.slice(slashIndex + 1).trim()
    };
}

function buildInvalidModelGroups(models = []) {
    const fullIds = new Set();
    const byProvider = new Map();

    for (const item of models || []) {
        const parsed = parseFullModelId(item);
        if (!parsed?.providerKey || !parsed.modelId) continue;
        fullIds.add(parsed.full);
        if (!byProvider.has(parsed.providerKey)) {
            byProvider.set(parsed.providerKey, new Set());
        }
        byProvider.get(parsed.providerKey).add(parsed.modelId);
    }

    return { fullIds, byProvider };
}

function filterProviderModels(models = [], invalidIds = new Set()) {
    if (!Array.isArray(models)) return [];
    return models.filter((model) => {
        const modelId = typeof model === 'string' ? model : model?.id;
        return !invalidIds.has(String(modelId || '').trim());
    });
}

function removeInvalidModelReferences(config, fullIds) {
    if (!config?.agents || typeof config.agents !== 'object') return;
    if (!config.agents.defaults || typeof config.agents.defaults !== 'object') {
        config.agents.defaults = {};
    }
    if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
        config.agents.defaults.model = {};
    }

    const defaultModel = config.agents.defaults.model;
    if (fullIds.has(String(defaultModel.primary || '').trim())) {
        defaultModel.primary = '';
    }

    if (Array.isArray(defaultModel.fallbacks)) {
        defaultModel.fallbacks = defaultModel.fallbacks.filter((item) => !fullIds.has(String(item || '').trim()));
    }

    if (config.agents.defaults.models && typeof config.agents.defaults.models === 'object') {
        Object.keys(config.agents.defaults.models).forEach((key) => {
            if (fullIds.has(String(key || '').trim())) {
                delete config.agents.defaults.models[key];
            }
        });
    }

    if (Array.isArray(config.agents.list)) {
        for (const agent of config.agents.list) {
            if (fullIds.has(String(agent?.model || '').trim())) {
                delete agent.model;
            }
        }
    }
}

function pruneInvalidModelsFromConfig(config, models = []) {
    const nextConfig = cloneJsonValue(config || {});
    const { fullIds, byProvider } = buildInvalidModelGroups(models);
    if (!fullIds.size) {
        return { config: nextConfig, removed: [] };
    }

    if (!nextConfig.models || typeof nextConfig.models !== 'object') nextConfig.models = {};
    if (!nextConfig.models.providers || typeof nextConfig.models.providers !== 'object') nextConfig.models.providers = {};

    for (const [providerKey, invalidIds] of byProvider.entries()) {
        const provider = nextConfig.models.providers?.[providerKey];
        if (!provider || !Array.isArray(provider.models)) continue;
        provider.models = filterProviderModels(provider.models, invalidIds);
    }

    removeInvalidModelReferences(nextConfig, fullIds);
    return {
        config: nextConfig,
        removed: Array.from(fullIds)
    };
}

function pruneInvalidModelsFromAgentCatalog(config, agentName, models = []) {
    const { byProvider } = buildInvalidModelGroups(models);
    if (!byProvider.size) return;

    const catalog = readAgentModelsCatalog(config, agentName);
    if (!catalog.providers || typeof catalog.providers !== 'object') {
        catalog.providers = {};
    }

    for (const [providerKey, invalidIds] of byProvider.entries()) {
        const provider = catalog.providers?.[providerKey];
        if (!provider || !Array.isArray(provider.models)) continue;
        provider.models = filterProviderModels(provider.models, invalidIds);
    }

    ensureDirectory(getAgentMetadataDir(config, agentName));
    writeJsonFileSync(path.join(getAgentMetadataDir(config, agentName), 'models.json'), catalog);
}

function pruneInvalidModelsFromAllAgents(config, models = []) {
    for (const agentId of mergeAgentIds(config)) {
        pruneInvalidModelsFromAgentCatalog(config, agentId, models);
    }
}

function ensureMainOpenClawLayout(config = {}) {
    ensureDirectory(openClawHomeDir);
    ensureDirectory(getAgentsRootPath());
    ensureDirectory(getAgentRootPath('main'));
    ensureDirectory(getAgentSessionsPath('main'));
    ensureDirectory(getAgentMetadataDir(config, 'main'));
    ensureAgentWorkspaceFiles('main', getDefaultWorkspacePath(config), 'main');
    ensureAgentMetadataFiles(config, 'main');
    syncAgentModelsFromConfig(config);
}

function readTail(filePath, linesCount = 200) {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split(/\r?\n/).slice(-linesCount).join('\n');
}

function getGatewayPortFromConfig(configJson = null) {
    const config = configJson && typeof configJson === 'object'
        ? configJson
        : readOpenClawConfigSync();
    const rawPort = Number.parseInt(String(config?.gateway?.port ?? ''), 10);
    return Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 18789;
}

function getGatewayAuthTokenFromConfig(configJson = null) {
    const config = configJson && typeof configJson === 'object'
        ? configJson
        : readOpenClawConfigSync();
    const token = String(config?.gateway?.auth?.token ?? '').trim();
    return token || '';
}

function buildDashboardLogFollowArgs() {
    const config = readOpenClawConfigSync();
    const port = getGatewayPortFromConfig(config);
    const args = ['logs', '--follow', '--plain', '--url', `ws://127.0.0.1:${port}`];
    const token = getGatewayAuthTokenFromConfig(config);
    if (token) {
        args.push('--token', token);
    }
    return args;
}

function buildPm2DashboardLogFollowSpawnRequest() {
    const runtime = resolveNpmDashboardRuntime({
        requireConfig: false,
        requirePm2: true
    });
    if (!runtime.ok) {
        throw new Error(runtime.error || 'PM2 runtime was not detected.');
    }

    return {
        spawnRequest: {
            command: runtime.nodeExe,
            args: [runtime.pm2Cli, 'logs', runtime.appName || 'openclaw-gateway', '--lines', '50', '--raw'],
            options: {
                windowsHide: true,
                env: {
                    ...getSafeEnv(),
                    PM2_DISABLE_COLORS: '1'
                }
            }
        },
        label: `pm2 logs ${runtime.appName || 'openclaw-gateway'} --lines 50 --raw`
    };
}

function resolveServiceLogPath(logKey) {
    const candidatesMap = {
        gateway: [
            path.join(openClawHomeDir, 'logs', 'gateway.log'),
            path.join(openClawHomeDir, 'gateway.log')
        ],
        'gateway-err': [
            path.join(openClawHomeDir, 'logs', 'gateway.err.log'),
            path.join(openClawHomeDir, 'gateway.err.log')
        ],
        guardian: [
            path.join(openClawHomeDir, 'logs', 'guardian.log'),
            path.join(openClawHomeDir, 'guardian.log')
        ],
        'guardian-backup': [
            path.join(openClawHomeDir, 'logs', 'backup.log'),
            path.join(openClawHomeDir, 'logs', 'commands.log'),
            path.join(openClawHomeDir, 'commands.log')
        ],
        'config-audit': [
            path.join(openClawHomeDir, 'logs', 'config-audit.jsonl'),
            path.join(openClawHomeDir, 'config-audit.jsonl')
        ]
    };

    const candidates = candidatesMap[logKey] || [];
    return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0] || null;
}

function getDashboardGatewayLogPath() {
    return resolveServiceLogPath('gateway') || path.join(openClawHomeDir, 'logs', 'gateway.log');
}

function formatPidList(pids = []) {
    return pids
        .filter(pid => Number.isInteger(pid) && pid > 0)
        .map(String)
        .join(', ');
}

function parseWindowsListeningPids(output, port) {
    const portSuffix = `:${port}`;
    const pids = new Set();

    for (const rawLine of String(output || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        const parts = line.split(/\s+/);
        if (parts.length < 5) continue;

        const protocol = String(parts[0] || '').toUpperCase();
        const localAddress = String(parts[1] || '');
        const foreignAddress = String(parts[2] || '');
        const state = String(parts[3] || '');
        const pid = Number.parseInt(parts[4], 10);

        if (!protocol.startsWith('TCP')) continue;
        if (!localAddress.endsWith(portSuffix)) continue;

        const looksLikeListeningState = /(LISTENING|侦听|監聽|监听)/i.test(state);
        const looksLikeListeningSocket = /^(?:0\.0\.0\.0:0|\*:0|\[::\]:0)$/i.test(foreignAddress);
        if (!looksLikeListeningState && !looksLikeListeningSocket) continue;

        if (Number.isInteger(pid) && pid > 0) {
            pids.add(pid);
        }
    }

    return [...pids].sort((a, b) => a - b);
}

function inspectWindowsListeningPortSnapshot(port = getGatewayPortFromConfig()) {
    const request = buildSpawnRequest('netstat', ['-ano']);
    const result = spawnSync(request.command, request.args, {
        ...request.options,
        timeout: 2000
    });

    if (result.error) {
        return { pids: [], error: result.error };
    }

    const output = `${result.stdout ? decodeOutputChunk(result.stdout, 'cp936') : ''}\n${result.stderr ? decodeOutputChunk(result.stderr, 'cp936') : ''}`;
    return {
        pids: parseWindowsListeningPids(output, port),
        error: null
    };
}

function looksLikeGatewayCommandLine(commandLine) {
    const text = String(commandLine || '').toLowerCase();
    return text.includes('openclaw') && text.includes('gateway');
}

function readWindowsProcessCommandLine(pid) {
    const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
        'if ($p) { [Console]::Out.Write($p.CommandLine) }'
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
        windowsHide: true,
        timeout: 5000
    });

    if (result.error || result.status !== 0) return '';
    return result.stdout ? decodeOutputChunk(result.stdout, 'utf8').trim() : '';
}

function inspectWindowsPortOwners(port = getGatewayPortFromConfig()) {
    const request = buildSpawnRequest('netstat', ['-ano']);
    const result = spawnSync(request.command, request.args, {
        ...request.options,
        timeout: 5000
    });

    if (result.error) {
        return { gatewayPids: [], foreignPids: [], error: result.error };
    }

    const output = `${result.stdout ? decodeOutputChunk(result.stdout, 'cp936') : ''}\n${result.stderr ? decodeOutputChunk(result.stderr, 'cp936') : ''}`;
    const listeningPids = parseWindowsListeningPids(output, port);
    const gatewayPids = [];
    const foreignPids = [];

    for (const pid of listeningPids) {
        const commandLine = readWindowsProcessCommandLine(pid);
        if (looksLikeGatewayCommandLine(commandLine)) {
            gatewayPids.push(pid);
        } else if (commandLine) {
            foreignPids.push(pid);
        } else {
            gatewayPids.push(pid);
        }
    }

    return {
        gatewayPids: [...new Set(gatewayPids)].sort((a, b) => a - b),
        foreignPids: [...new Set(foreignPids)].sort((a, b) => a - b),
        error: null
    };
}

function getPm2GatewaySnapshotSync() {
    const runtime = resolvePm2ServiceRuntimeSync({ requireConfig: false });
    if (!runtime?.ok || !runtime.nodeExe || !runtime.pm2Cli) {
        return {
            appName: runtime?.appName || 'openclaw-gateway',
            online: false,
            pids: []
        };
    }

    const appName = runtime.appName || 'openclaw-gateway';
    const apps = readPm2SnapshotAppsSync(runtime.nodeExe, runtime.pm2Cli);
    const matchedApps = apps.filter((app) => String(app?.name || '').trim().toLowerCase() === appName.toLowerCase());
    const onlineApps = matchedApps.filter((app) => String(app?.pm2_env?.status || '').toLowerCase() === 'online');
    const pids = onlineApps
        .map((app) => Number.parseInt(String(app?.pid || ''), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);

    return {
        appName,
        online: onlineApps.length > 0,
        pids
    };
}

function killWindowsProcessIdsSync(pids = []) {
    const uniquePids = [...new Set(
        (Array.isArray(pids) ? pids : [])
            .map((pid) => Number.parseInt(String(pid), 10))
            .filter((pid) => Number.isInteger(pid) && pid > 0)
    )];

    const killed = [];
    const failed = [];

    for (const pid of uniquePids) {
        try {
            const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                windowsHide: true,
                encoding: 'utf8',
                timeout: 10000
            });
            if (result.status === 0) {
                killed.push(pid);
            } else {
                failed.push({
                    pid,
                    error: String(result.stderr || result.stdout || 'taskkill failed').trim()
                });
            }
        } catch (error) {
            failed.push({
                pid,
                error: error.message
            });
        }
    }

    return { killed, failed };
}

async function resolveNpmDashboardPreflight(action) {
    if (process.platform !== 'win32') {
        return { requestOverride: null, preamble: '' };
    }

    const portStatus = await probeOpenClawGatewayStatus({ allowFallbackCli: false });
    const pm2Snapshot = getPm2GatewaySnapshotSync();
    const gatewayPid = Number.parseInt(String(portStatus?.pid || ''), 10);
    const pm2Pids = new Set(pm2Snapshot.pids || []);
    const unmanagedPids = gatewayPid && !pm2Pids.has(gatewayPid) ? [gatewayPid] : [];

    if (action === 'start' && unmanagedPids.length) {
        return {
            requestOverride: {
                mode: 'npm',
                action,
                previewCommand: `pm2 start <skipped: gateway already running on port ${portStatus?.port || getGatewayPortFromConfig()}>`,
                alreadyRunning: true,
                finishCode: 0,
                infoMessages: [
                    `[INFO] 检测到未托管的 OpenClaw Gateway 已在运行 (PID: ${formatPidList(unmanagedPids)})。\n`,
                    '[INFO] 为避免 PM2 与前台实例争抢同一端口，本次不重复启动。\n'
                ]
            },
            preamble: ''
        };
    }

    if ((action === 'stop' || action === 'restart') && unmanagedPids.length) {
        const cleanup = killWindowsProcessIdsSync(unmanagedPids);
        const messages = [];

        if (cleanup.killed.length) {
            messages.push(`[INFO] 已先停止未托管的 Gateway 进程 (PID: ${formatPidList(cleanup.killed)})。\n`);
        }
        if (cleanup.failed.length) {
            messages.push(`[WARN] 未托管 Gateway 进程停止失败：${cleanup.failed.map((item) => `${item.pid} (${item.error})`).join('; ')}\n`);
        }

        return {
            requestOverride: null,
            preamble: messages.join('')
        };
    }

    return {
        requestOverride: null,
        preamble: ''
    };
}

function inspectLinuxGatewayPort(port = getGatewayPortFromConfig()) {
    const ssResult = spawnSync('sh', ['-lc', `ss -tlnp 'sport = :${port}' 2>/dev/null || true`], {
        windowsHide: true,
        timeout: 3000
    });
    const ssOutput = `${ssResult.stdout ? decodeOutputChunk(ssResult.stdout, 'utf8') : ''}\n${ssResult.stderr ? decodeOutputChunk(ssResult.stderr, 'utf8') : ''}`.trim();
    if (ssOutput.includes(`:${port}`)) {
        const pidMatch = ssOutput.match(/pid=(\d+)/i);
        return {
            running: true,
            pid: pidMatch ? Number.parseInt(pidMatch[1], 10) || null : null,
            error: null
        };
    }

    const lsofResult = spawnSync('sh', ['-lc', `lsof -i :${port} -t 2>/dev/null || true`], {
        windowsHide: true,
        timeout: 3000
    });
    const lsofOutput = `${lsofResult.stdout ? decodeOutputChunk(lsofResult.stdout, 'utf8') : ''}`.trim();
    if (lsofOutput) {
        const pid = Number.parseInt(lsofOutput.split(/\r?\n/)[0], 10) || null;
        return { running: true, pid, error: null };
    }

    try {
        const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
        const tcp = fs.readFileSync('/proc/net/tcp', 'utf8');
        if (tcp.includes(`:${hexPort}`)) {
            return { running: true, pid: null, error: null };
        }
    } catch (_) {}

    return { running: false, pid: null, error: null };
}

function createGatewayStatusPayload({ online, confident = true, detail = '', latency = '', port = null, pid = null, source = 'port' } = {}) {
    return {
        online: Boolean(online),
        confident: Boolean(confident),
        statusText: online ? '在线' : '离线',
        detail,
        latency,
        port,
        pid,
        source
    };
}

function readFileSliceUtf8(filePath, startOffset, endOffset) {
    const start = Math.max(0, Number(startOffset) || 0);
    const end = Math.max(start, Number(endOffset) || 0);
    const length = end - start;
    if (length <= 0) return '';

    const fileHandle = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(fileHandle, buffer, 0, length, start);
        return bytesRead > 0 ? buffer.subarray(0, bytesRead).toString('utf8') : '';
    } finally {
        fs.closeSync(fileHandle);
    }
}

function pumpDashboardGatewayLog(meta, options = {}) {
    if (!meta?.sender) return;

    const nextPath = fs.existsSync(meta?.filePath || '')
        ? meta.filePath
        : getDashboardGatewayLogPath();
    if (nextPath && meta.filePath !== nextPath) {
        meta.filePath = nextPath;
        meta.offset = 0;
        meta.connected = false;
    }

    const targetPath = meta.filePath || getDashboardGatewayLogPath();
    meta.filePath = targetPath;

    if (!targetPath || !fs.existsSync(targetPath)) {
        meta.offset = 0;
        meta.connected = false;
        if (options.initial || !meta.waitingForFile) {
            meta.waitingForFile = true;
            safeSend(meta.sender, 'dashboard-log-state', {
                kind: 'info',
                message: `等待 Gateway 日志文件：${targetPath || '~/.openclaw/logs/gateway.log'}`
            });
        }
        return;
    }

    meta.waitingForFile = false;

    let stat = null;
    try {
        stat = fs.statSync(targetPath);
    } catch (error) {
        if (options.initial || meta.lastReadError !== error.message) {
            meta.lastReadError = error.message;
            safeSend(meta.sender, 'dashboard-log-state', {
                kind: 'error',
                message: `读取 Gateway 日志失败：${error.message}`
            });
        }
        return;
    }

    meta.lastReadError = '';

    if (!meta.connected) {
        const seed = stat.size > 0 ? readTail(targetPath, 200) : '';
        if (seed) {
            safeSend(meta.sender, 'dashboard-log-stream', {
                text: seed.endsWith('\n') ? seed : `${seed}\n`
            });
        }
        meta.offset = stat.size;
        meta.connected = true;
        safeSend(meta.sender, 'dashboard-log-state', {
            kind: 'success',
            message: `已连接实时日志：${targetPath}`
        });
        return;
    }

    if (stat.size < meta.offset) {
        meta.offset = 0;
        safeSend(meta.sender, 'dashboard-log-state', {
            kind: 'info',
            message: `Gateway 日志已轮转，重新跟随：${targetPath}`
        });
    }

    if (stat.size === meta.offset) return;

    try {
        const chunk = readFileSliceUtf8(targetPath, meta.offset, stat.size);
        meta.offset = stat.size;
        if (chunk) {
            safeSend(meta.sender, 'dashboard-log-stream', { text: chunk });
        }
    } catch (error) {
        safeSend(meta.sender, 'dashboard-log-state', {
            kind: 'error',
            message: `读取 Gateway 实时日志失败：${error.message}`
        });
    }
}

function trimTrailingSlash(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function resolveProviderCredentials(provider, authProfile) {
    const configKey = String(provider?.apiKey || '').trim();
    if (configKey) {
        return { type: 'config-key', value: configKey };
    }

    const authType = normalizeAuthProfileType(authProfile);
    if (authType === 'api_key' && authProfile?.key) {
        return { type: 'auth-api-key', value: String(authProfile.key).trim() };
    }

    if (authType === 'oauth' && authProfile?.access) {
        return { type: 'oauth', value: String(authProfile.access).trim() };
    }

    return { type: 'none', value: '' };
}

function resolveProviderContext(config, payload = {}) {
    const providerKey = String(payload.providerKey || '').trim();
    if (!providerKey) {
        throw new Error('Missing provider key');
    }

    const agentName = normalizeAgentName(payload.agentName || 'main');
    const runtimeCatalog = buildRuntimeModelCatalog(config, agentName);
    const runtimeProvider = runtimeCatalog.providers.find((item) => item.key === providerKey) || null;
    const overrideProvider = payload.provider && typeof payload.provider === 'object'
        ? normalizeProviderEntry(providerKey, payload.provider, runtimeProvider || {})
        : normalizeProviderEntry(providerKey, runtimeProvider || {}, {});

    const authData = readAgentAuthProfiles(config, agentName);
    const authProfile = getPreferredAuthProfile(authData, providerKey, overrideProvider);
    const credentials = resolveProviderCredentials(overrideProvider, authProfile);

    return {
        providerKey,
        agentName,
        provider: overrideProvider,
        authProfile,
        credentials
    };
}

function getOpenAIBaseCandidates(providerKey, provider) {
    const candidates = new Set();
    const normalizedTransport = normalizeOpenAICodexTransport(
        providerKey,
        normalizeModelApiType(provider?.api),
        trimTrailingSlash(provider?.baseUrl)
    );
    const baseUrl = trimTrailingSlash(normalizedTransport.baseUrl);
    if (baseUrl) {
        candidates.add(baseUrl);
    }

    if (!candidates.size) {
        candidates.add(trimTrailingSlash(getDefaultModelBaseUrl(normalizedTransport.api, providerKey)));
    }

    return Array.from(candidates);
}

function buildOpenAICodexUsageHeaders(context) {
    const token = String(context?.credentials?.value || '').trim();
    if (!token) {
        throw new Error('Missing OAuth access token');
    }

    const headers = {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'CodexBar',
        Accept: 'application/json'
    };

    const accountId = String(context?.authProfile?.accountId || '').trim();
    if (accountId) {
        headers['ChatGPT-Account-Id'] = accountId;
    }

    return headers;
}

function formatCodexPlanLabel(data) {
    const parts = [];
    const planType = String(data?.plan_type || '').trim();
    if (planType) {
        parts.push(planType);
    }

    const rawBalance = data?.credits?.balance;
    if (rawBalance !== undefined && rawBalance !== null && String(rawBalance).trim()) {
        const numericBalance = Number(rawBalance);
        parts.push(Number.isFinite(numericBalance) ? `$${numericBalance.toFixed(2)}` : String(rawBalance).trim());
    }

    return parts.join(' ');
}

async function probeOpenAICodexUsage(context, modelId, timeoutMs = 15000) {
    const startedAt = Date.now();

    if (isSmokeTest) {
        if (/invalid/i.test(String(modelId || ''))) {
            throw new Error('Smoke invalid model');
        }

        return {
            ok: true,
            elapsed: Date.now() - startedAt,
            label: 'Auth 有效 | smoke'
        };
    }

    const baseCandidates = getOpenAIBaseCandidates(context?.providerKey, {
        ...(context?.provider || {}),
        api: 'openai-codex-responses'
    });
    const data = await trySequentialRequests(baseCandidates, async (candidateBase) => {
        return fetchJsonWithTimeout(`${trimTrailingSlash(candidateBase)}/wham/usage`, {
            method: 'GET',
            headers: buildOpenAICodexUsageHeaders(context)
        }, timeoutMs);
    });

    if (data?.rate_limit?.allowed === false) {
        throw new Error('Auth 有效，但当前额度或速率受限');
    }

    const elapsed = Date.now() - startedAt;
    const elapsedLabel = `${(elapsed / 1000).toFixed(1)}s`;
    const planLabel = formatCodexPlanLabel(data);
    return {
        ok: true,
        elapsed,
        label: planLabel ? `Auth 有效 | ${planLabel} | ${elapsedLabel}` : `Auth 有效 | ${elapsedLabel}`
    };
}

function normalizeRemoteModelItem(item, fallbackApi) {
    if (!item || typeof item !== 'object') return null;

    const rawId = String(item.id || item.name || item.model || '').trim();
    if (!rawId) return null;

    const modelId = rawId.replace(/^models\//, '');
    const contextWindow = Number(
        item.contextWindow
        || item.context_window
        || item.inputTokenLimit
        || item.max_context_window_tokens
        || item.context_length
        || 0
    ) || undefined;
    const maxTokens = Number(item.maxTokens || item.outputTokenLimit || item.max_output_tokens || 0) || undefined;
    const reasoning = Boolean(item.reasoning || /(codex|reason|thinking|o1|o3|o4)/i.test(modelId));

    return {
        id: modelId,
        name: String(item.display_name || item.name || item.id || modelId).replace(/^models\//, ''),
        api: normalizeModelApiType(item.api || fallbackApi),
        reasoning,
        contextWindow,
        maxTokens
    };
}

async function readJsonResponse(response) {
    const text = await response.text();
    let data = null;

    if (text) {
        try {
            data = JSON.parse(text);
        } catch (_) {
            data = null;
        }
    }

    if (!response.ok) {
        const snippet = (text || `HTTP ${response.status}`).slice(0, 220);
        throw new Error(snippet);
    }

    return data || {};
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return await readJsonResponse(response);
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error('Request timed out');
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchJsonWithTimeoutAllowErrors(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        const text = await response.text();
        let data = null;

        if (text) {
            try {
                data = JSON.parse(text);
            } catch (_) {
                data = null;
            }
        }

        return {
            ok: response.ok,
            status: response.status,
            data,
            text
        };
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error('Request timed out');
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function createNetworkProxyAgent(proxyUrl = '') {
    const normalized = String(proxyUrl || '').trim();
    if (!normalized) return null;

    let parsed;
    try {
        parsed = new URL(normalized);
    } catch (_) {
        throw new Error('代理地址格式无效');
    }

    const protocol = String(parsed.protocol || '').toLowerCase();
    if (protocol === 'http:' || protocol === 'https:') {
        return new HttpsProxyAgent(normalized);
    }
    if (protocol.startsWith('socks')) {
        return new SocksProxyAgent(normalized);
    }
    throw new Error('仅支持 http / https / socks 代理');
}

async function fetchJsonWithProxyAllowErrors(url, options = {}, timeoutMs = 15000) {
    const requestUrl = new URL(url);
    const client = requestUrl.protocol === 'http:' ? http : https;
    const headers = { ...(options.headers || {}) };
    const body = options.body == null
        ? null
        : (Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body), 'utf8'));
    const agent = createNetworkProxyAgent(options.proxyUrl || '');

    if (body && headers['Content-Length'] == null && headers['content-length'] == null) {
        headers['Content-Length'] = String(body.length);
    }

    return await new Promise((resolve, reject) => {
        const req = client.request(requestUrl, {
            method: String(options.method || 'GET').toUpperCase(),
            headers,
            agent
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = null;
                if (text) {
                    try {
                        data = JSON.parse(text);
                    } catch (_) {
                        data = null;
                    }
                }
                resolve({
                    ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
                    status: response.statusCode || 0,
                    data,
                    text
                });
            });
        });

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error('Request timed out'));
        });
        req.on('error', (error) => reject(error));

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

function normalizeMessagingPlatform(platform) {
    const value = String(platform || '').trim().toLowerCase();
    if (value === 'dingtalk-connector') return 'dingtalk';
    return value;
}

function buildCredentialCheckResult({ valid, errors = [], warnings = [], details = [] }) {
    return {
        valid: Boolean(valid),
        errors: errors.filter(Boolean),
        warnings: warnings.filter(Boolean),
        details: details.filter(Boolean)
    };
}

async function verifyMessagingPlatformCredentials(payload = {}) {
    const platform = normalizeMessagingPlatform(payload?.platform);
    const form = payload?.form && typeof payload.form === 'object' ? payload.form : {};

    if (!platform) {
        throw new Error('platform 不能为空');
    }

    if (platform === 'qqbot') {
        const appId = String(form.appId || form.clientId || '').trim();
        const appSecret = String(form.appSecret || form.clientSecret || '').trim();
        if (!appId || !appSecret) {
            return buildCredentialCheckResult({
                valid: false,
                errors: ['AppID 和 AppSecret 不能为空']
            });
        }

        try {
            const result = await fetchJsonWithTimeoutAllowErrors('https://bots.qq.com/app/getAppAccessToken', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appId, clientSecret: appSecret })
            }, 15000);
            const body = result.data || {};

            if (result.ok && (body.access_token || body.accessToken)) {
                return buildCredentialCheckResult({
                    valid: true,
                    details: [`AppID: ${appId}`]
                });
            }

            return buildCredentialCheckResult({
                valid: false,
                errors: [body.message || body.msg || body.error || `QQ Bot API 连接失败: HTTP ${result.status}`]
            });
        } catch (error) {
            return buildCredentialCheckResult({
                valid: false,
                errors: [`QQ Bot API 连接失败: ${error?.message || error}`]
            });
        }
    }

    if (platform === 'telegram') {
        const botToken = String(form.botToken || form.token || '').trim();
        const proxyUrl = String(form.proxy || '').trim();
        if (!botToken) {
            return buildCredentialCheckResult({
                valid: false,
                errors: ['Bot Token 不能为空']
            });
        }

        try {
            const result = proxyUrl
                ? await fetchJsonWithProxyAllowErrors(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`, {
                    proxyUrl
                }, 15000)
                : await fetchJsonWithTimeoutAllowErrors(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`, {}, 15000);
            const body = result.data || {};

            if (result.ok && body.ok) {
                return buildCredentialCheckResult({
                    valid: true,
                    details: [
                        `Bot: @${body.result?.username || ''}`.trim(),
                        proxyUrl ? 'Proxy: enabled' : ''
                    ]
                });
            }

            return buildCredentialCheckResult({
                valid: false,
                errors: [body.description || `Telegram API 连接失败: HTTP ${result.status}`]
            });
        } catch (error) {
            return buildCredentialCheckResult({
                valid: false,
                errors: [`Telegram API 连接失败: ${error?.message || error}`]
            });
        }
    }

    if (platform === 'discord') {
        const token = String(form.token || form.botToken || '').trim();
        if (!token) {
            return buildCredentialCheckResult({
                valid: false,
                errors: ['Bot Token 不能为空']
            });
        }

        try {
            const result = await fetchJsonWithTimeoutAllowErrors('https://discord.com/api/v10/users/@me', {
                headers: { Authorization: `Bot ${token}` }
            }, 15000);
            const body = result.data || {};

            if (result.status === 401) {
                return buildCredentialCheckResult({
                    valid: false,
                    errors: ['Bot Token 无效']
                });
            }

            if (result.ok && body.bot) {
                return buildCredentialCheckResult({
                    valid: true,
                    details: [`Bot: @${body.username || ''}`.trim()]
                });
            }

            return buildCredentialCheckResult({
                valid: false,
                errors: [body.message || body.error || `Discord API 连接失败: HTTP ${result.status}`]
            });
        } catch (error) {
            return buildCredentialCheckResult({
                valid: false,
                errors: [`Discord API 连接失败: ${error?.message || error}`]
            });
        }
    }

    if (platform === 'feishu') {
        const appId = String(form.appId || '').trim();
        const appSecret = String(form.appSecret || '').trim();
        if (!appId || !appSecret) {
            return buildCredentialCheckResult({
                valid: false,
                errors: ['App ID 和 App Secret 不能为空']
            });
        }

        const domain = String(form.domain || '').trim().toLowerCase();
        const base = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';

        try {
            const result = await fetchJsonWithTimeoutAllowErrors(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ app_id: appId, app_secret: appSecret })
            }, 15000);
            const body = result.data || {};

            if (result.ok && (body.tenant_access_token || body.access_token)) {
                return buildCredentialCheckResult({
                    valid: true,
                    details: [`AppID: ${appId}`, `Domain: ${domain || 'feishu'}`]
                });
            }

            const apiMessage = body.msg || body.message || body.error || body.code_message;
            return buildCredentialCheckResult({
                valid: false,
                errors: [apiMessage || `飞书 API 连接失败: HTTP ${result.status}`]
            });
        } catch (error) {
            return buildCredentialCheckResult({
                valid: false,
                errors: [`飞书 API 连接失败: ${error?.message || error}`]
            });
        }
    }

    if (platform === 'wecom') {
        const botId = String(form.botId || form.appId || '').trim();
        const secret = String(form.secret || form.clientSecret || form.appSecret || '').trim();
        if (!botId || !secret) {
            return buildCredentialCheckResult({
                valid: false,
                errors: ['Bot ID 和 Secret 不能为空']
            });
        }

        return buildCredentialCheckResult({
            valid: true,
            warnings: ['WeCom plugin does not expose online credential verification yet; local field validation completed.'],
            details: [`Bot ID: ${botId}`]
        });
    }

    if (platform === 'dingtalk') {
        const clientId = String(form.clientId || form.appId || '').trim();
        const clientSecret = String(form.clientSecret || form.appSecret || '').trim();
        if (!clientId || !clientSecret) {
            return buildCredentialCheckResult({
                valid: false,
                errors: ['Client ID 和 Client Secret 不能为空']
            });
        }

        try {
            const result = await fetchJsonWithTimeoutAllowErrors('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appKey: clientId, appSecret: clientSecret })
            }, 15000);
            const body = result.data || {};

            if (result.ok && (body.accessToken || body.access_token || body.expireIn)) {
                return buildCredentialCheckResult({
                    valid: true,
                    details: [`Client ID: ${clientId}`]
                });
            }

            return buildCredentialCheckResult({
                valid: false,
                warnings: ['DingTalk online verification may not fully match the current channel field mapping; only a token exchange probe was attempted.'],
                errors: [body.message || body.msg || body.error || `钉钉 API 连接失败: HTTP ${result.status}`]
            });
        } catch (error) {
            return buildCredentialCheckResult({
                valid: false,
                warnings: ['DingTalk online verification is limited right now; only an API connectivity probe was attempted.'],
                errors: [`钉钉 API 连接失败: ${error?.message || error}`]
            });
        }
    }

    return buildCredentialCheckResult({
        valid: false,
        errors: [`暂不支持校验平台: ${platform}`]
    });
}

function normalizeChannelEnvironmentKey(value) {
    const normalized = normalizeMessagingPlatform(value);
    if (normalized === 'lark') return 'feishu';
    return normalized;
}

const CHANNEL_INSTALL_SOURCE_PRESETS = Object.freeze([
    {
        value: 'npmmirror',
        label: 'npmmirror',
        registry: 'https://registry.npmmirror.com',
        hint: '国内访问通常更稳定，推荐优先使用。'
    },
    {
        value: 'taobao',
        label: '淘宝源',
        registry: 'https://registry.npmmirror.com',
        hint: '淘宝源现已并入 npmmirror，安装时会使用同一镜像地址。'
    },
    {
        value: 'npm',
        label: 'npm 官方',
        registry: 'https://registry.npmjs.org',
        hint: '官方源，网络受限时可能较慢。'
    },
    {
        value: 'huawei',
        label: '华为云',
        registry: 'https://repo.huaweicloud.com/repository/npm/',
        hint: '华为云 npm 镜像。'
    }
]);

const CHANNEL_INSTALL_SOURCE_MAP = Object.freeze(
    Object.fromEntries(CHANNEL_INSTALL_SOURCE_PRESETS.map((item) => [item.value, item]))
);

function normalizeChannelInstallSourceChoice(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return '';
    if (['official', 'npm-official', 'npmjs', 'npmjs.org', 'registry.npmjs.org'].includes(text)) return 'npm';
    if (['npmmirror', 'npmmirror.com', 'registry.npmmirror.com'].includes(text)) return 'npmmirror';
    if (['taobao', 'taobao-mirror', 'registry.npm.taobao.org'].includes(text)) return 'taobao';
    if (['huawei', 'huaweicloud', 'repo.huaweicloud.com'].includes(text)) return 'huawei';
    return text;
}

function resolveChannelInstallSource(payload = {}, profile = null) {
    const choice = normalizeChannelInstallSourceChoice(payload?.registryChoice || payload?.source);
    if (choice && CHANNEL_INSTALL_SOURCE_MAP[choice]) {
        return CHANNEL_INSTALL_SOURCE_MAP[choice];
    }

    const registry = String(payload?.registry || profile?.installRegistry || '').trim();
    if (registry) {
        const matched = CHANNEL_INSTALL_SOURCE_PRESETS.find((item) => item.registry === registry);
        return matched || {
            value: 'custom',
            label: registry,
            registry,
            hint: '自定义 registry 地址。'
        };
    }

    return CHANNEL_INSTALL_SOURCE_MAP.npmmirror;
}

function listChannelInstallSources() {
    return CHANNEL_INSTALL_SOURCE_PRESETS.map((item, index) => ({
        value: item.value,
        label: item.label,
        registry: item.registry,
        hint: item.hint,
        recommended: index === 0
    }));
}

function buildChannelInstallEnv(source = null) {
    const registry = String(source?.registry || '').trim();
    const env = {
        npm_config_legacy_peer_deps: 'true',
        NPM_CONFIG_LEGACY_PEER_DEPS: 'true',
        npm_config_audit: 'false',
        NPM_CONFIG_AUDIT: 'false',
        npm_config_fund: 'false',
        NPM_CONFIG_FUND: 'false'
    };
    if (!registry) return env;
    return {
        ...env,
        npm_config_registry: registry,
        NPM_CONFIG_REGISTRY: registry
    };
}

function normalizeChannelPluginCandidateToken(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/@latest$/i, '')
        .replace(/\\/g, '/');
}

function collectChannelPluginCandidateTokens(profile = null) {
    if (!profile) return [];

    const tokens = new Set();
    const values = [
        profile.key,
        ...(profile.configKeys || []),
        ...(profile.packageCandidates || []),
        ...(profile.installPackageCandidates || []),
        ...(profile.commandCandidates || [])
    ];

    for (const value of values) {
        const normalized = normalizeChannelPluginCandidateToken(value);
        if (!normalized) continue;
        const base = normalized.includes('/') ? normalized.split('/').pop() : normalized;
        [
            normalized,
            base,
            base.replace(/^openclaw-/, ''),
            base.replace(/-plugin$/, ''),
            base.replace(/^@/, '')
        ].forEach((item) => {
            const token = normalizeChannelPluginCandidateToken(item);
            if (token) tokens.add(token);
        });
    }

    return Array.from(tokens);
}

function invalidateOpenClawPluginInventoryCache() {
    cachedOpenClawPluginInventory = null;
}

async function fetchLatestNpmPackageVersion(packageName, options = {}) {
    const name = String(packageName || '').trim();
    if (!name) return '';
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 8000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`https://registry.npmjs.org/${name}/latest`, {
            headers: {
                Accept: 'application/json'
            },
            signal: controller.signal
        });
        if (!response.ok) return '';
        const data = await response.json().catch(() => null);
        return String(data?.version || '').trim();
    } catch (_) {
        return '';
    } finally {
        clearTimeout(timer);
    }
}

function compareLooseSemver(left, right) {
    const normalize = (value) => String(value || '')
        .split('.')
        .map((part) => Number.parseInt(String(part).replace(/[^\d].*$/, ''), 10))
        .map((part) => (Number.isFinite(part) ? part : 0));
    const a = normalize(left);
    const b = normalize(right);
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const av = a[index] ?? 0;
        const bv = b[index] ?? 0;
        if (av > bv) return 1;
        if (av < bv) return -1;
    }
    return 0;
}

const WEIXIN_PLUGIN_STATUS_CACHE_TTL_MS = 15000;
const weixinPluginStatusCache = {
    fast: null,
    fastAt: 0,
    full: null,
    fullAt: 0
};

async function getWeixinPluginStatus(options = {}) {
    const includeLatestVersion = options?.includeLatestVersion !== false;
    const forceRefresh = options?.refresh === true;
    const cacheKey = includeLatestVersion ? 'full' : 'fast';
    const cacheAtKey = includeLatestVersion ? 'fullAt' : 'fastAt';
    const now = Date.now();
    if (!forceRefresh && weixinPluginStatusCache[cacheKey] && (now - Number(weixinPluginStatusCache[cacheAtKey] || 0)) < WEIXIN_PLUGIN_STATUS_CACHE_TTL_MS) {
        return cloneJsonValue(weixinPluginStatusCache[cacheKey]);
    }

    const extensionDir = path.join(openClawHomeDir, 'extensions', 'openclaw-weixin');
    if (isSmokeTest) {
        const smokeStatus = {
            installed: true,
            installedVersion: '2.0.0-smoke',
            latestVersion: includeLatestVersion ? '2.0.0-smoke' : '',
            updateAvailable: false,
            compatibilityIssue: '',
            extensionDir
        };
        weixinPluginStatusCache[cacheKey] = smokeStatus;
        weixinPluginStatusCache[cacheAtKey] = now;
        if (includeLatestVersion) {
            weixinPluginStatusCache.fast = {
                ...smokeStatus,
                latestVersion: '',
                updateAvailable: false
            };
            weixinPluginStatusCache.fastAt = now;
        }
        return cloneJsonValue(smokeStatus);
    }

    const packageJsonPath = path.join(extensionDir, 'package.json');
    let installed = false;
    let installedVersion = '';

    if (fs.existsSync(packageJsonPath)) {
        installed = true;
        try {
            const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            installedVersion = String(parsed?.version || '').trim();
        } catch (_) {}
    }

    const latestVersion = includeLatestVersion
        ? await fetchLatestNpmPackageVersion('@tencent-weixin/openclaw-weixin')
        : '';
    const updateAvailable = Boolean(
        installed
        && installedVersion
        && latestVersion
        && compareLooseSemver(installedVersion, latestVersion) < 0
    );
    const compatibilityIssue = installed && /^1\./.test(String(installedVersion || '').trim())
        ? `当前安装的个人微信插件 v${installedVersion} 与当前 OpenClaw 运行时不兼容，请先升级到 ${latestVersion ? `v${latestVersion}` : '2.x 兼容版'}。`
        : '';

    const status = {
        installed,
        installedVersion,
        latestVersion,
        updateAvailable,
        compatibilityIssue,
        extensionDir
    };
    weixinPluginStatusCache[cacheKey] = status;
    weixinPluginStatusCache[cacheAtKey] = now;
    if (includeLatestVersion) {
        weixinPluginStatusCache.fast = {
            ...status,
            latestVersion: '',
            updateAvailable: false
        };
        weixinPluginStatusCache.fastAt = now;
    }
    return cloneJsonValue(status);
}

function prepareChannelExtensionUpgradeBackup(profile = null, extensionStatus = null) {
    if (!profile || profile.key !== 'openclaw-weixin') return null;
    const originalPath = String(
        extensionStatus?.evidence?.find((item) => item?.kind === 'extension-dir')?.path || ''
    ).trim();
    if (!originalPath || !fs.existsSync(originalPath)) return null;
    const backupPath = `${originalPath}.upgrade-backup-${Date.now()}`;
    if (fs.existsSync(backupPath)) {
        fs.rmSync(backupPath, { recursive: true, force: true });
    }
    fs.renameSync(originalPath, backupPath);
    return {
        originalPath,
        backupPath
    };
}

function finalizeChannelExtensionUpgradeBackup(backupInfo = null) {
    if (!backupInfo?.backupPath) return;
    if (fs.existsSync(backupInfo.backupPath)) {
        fs.rmSync(backupInfo.backupPath, { recursive: true, force: true });
    }
}

function restoreChannelExtensionUpgradeBackup(backupInfo = null) {
    if (!backupInfo?.backupPath || !backupInfo?.originalPath) return;
    if (!fs.existsSync(backupInfo.backupPath)) return;
    if (fs.existsSync(backupInfo.originalPath)) {
        fs.rmSync(backupInfo.originalPath, { recursive: true, force: true });
    }
    fs.renameSync(backupInfo.backupPath, backupInfo.originalPath);
}

function getOpenClawPluginInventorySync(options = {}) {
    const allowCache = options.refresh !== true;
    const now = Date.now();
    if (
        allowCache
        && cachedOpenClawPluginInventory
        && now - Number(cachedOpenClawPluginInventory.timestamp || 0) < CHANNEL_PLUGIN_INVENTORY_CACHE_TTL_MS
    ) {
        return cachedOpenClawPluginInventory.value;
    }

    try {
        const request = buildOpenClawCliSpawnRequest(['plugins', 'list', '--json'], {
            env: options.env || {}
        });
        const result = runHiddenSync(request.command, request.args, request.options);
        const output = String(result?.stdout || '').trim();
        const parsed = output ? JSON.parse(output) : {};
        const value = {
            ok: Array.isArray(parsed?.plugins),
            plugins: Array.isArray(parsed?.plugins) ? parsed.plugins : [],
            diagnostics: Array.isArray(parsed?.diagnostics) ? parsed.diagnostics : [],
            output: `${result?.stdout || ''}\n${result?.stderr || ''}`.trim(),
            error: result?.error?.message || ''
        };
        cachedOpenClawPluginInventory = {
            timestamp: now,
            value
        };
        return value;
    } catch (error) {
        const value = {
            ok: false,
            plugins: [],
            diagnostics: [],
            output: '',
            error: error?.message || String(error)
        };
        if (!allowCache) {
            cachedOpenClawPluginInventory = {
                timestamp: now,
                value
            };
        }
        return value;
    }
}

function collectChannelInstallOutputText(commandResult = {}) {
    return [
        String(commandResult?.stdout || '').trim(),
        String(commandResult?.stderr || '').trim(),
        String(commandResult?.error?.message || '').trim()
    ].filter(Boolean).join('\n').trim();
}

function emitChannelInstallStream(sender, payload = {}) {
    try {
        if (!sender || sender.isDestroyed?.()) return;
        sender.send('channel-install-stream', payload);
    } catch (_) {}
}

function isHardChannelInstallFailure(outputText = '') {
    const text = String(outputText || '');
    return [
        /unknown option/i,
        /Package not found on npm:/i,
        /npm pack failed/i,
        /\bE404\b/i,
        /CERT_HAS_EXPIRED/i,
        /No matching version found/i,
        /Unsupported URL Type/i
    ].some((pattern) => pattern.test(text));
}

function getChannelEnvironmentProfile(channelKey) {
    const normalizedKey = normalizeChannelEnvironmentKey(channelKey);
    const profiles = {
        telegram: {
            key: 'telegram',
            label: 'Telegram',
            configKeys: ['telegram'],
            packageCandidates: [],
            commandCandidates: [],
            requiredFields: ['botToken'],
            builtIn: true,
            installHint: 'Telegram is built in and does not require an extra plugin.'
        },
        qqbot: {
            key: 'qqbot',
            label: 'QQ Bot',
            configKeys: ['qqbot'],
            packageCandidates: ['@tencent-connect/openclaw-qqbot', 'qqbot', 'openclaw-qqbot', '@openclaw/qqbot', '@openclaw/qq-bot'],
            installPackageCandidates: ['@tencent-connect/openclaw-qqbot@latest'],
            commandCandidates: ['qqbot', 'openclaw-qqbot'],
            requiredFields: ['appId', 'appSecret'],
            installHint: 'Official install command: openclaw plugins install @tencent-connect/openclaw-qqbot@latest. Installation completes only after the gateway is restarted.'
        },
        feishu: {
            key: 'feishu',
            label: 'Feishu Bot',
            configKeys: ['feishu', 'lark'],
            packageCandidates: ['@openclaw/feishu', '@larksuite/openclaw-lark', 'openclaw-lark'],
            installPackageCandidates: ['@openclaw/feishu'],
            commandCandidates: ['openclaw-lark', 'feishu'],
            requiredFields: ['appId', 'appSecret'],
            builtIn: true,
            installHint: 'Feishu is bundled in current OpenClaw releases. If your build does not include it, install manually with openclaw plugins install @openclaw/feishu, then restart the gateway.'
        },
        wecom: {
            key: 'wecom',
            label: 'WeCom Bot',
            configKeys: ['wecom'],
            packageCandidates: ['@wecom/wecom-openclaw-plugin', 'wecom-openclaw-plugin'],
            installPackageCandidates: ['@wecom/wecom-openclaw-plugin', 'wecom-openclaw-plugin'],
            commandCandidates: ['wecom-openclaw-plugin', 'wecom'],
            requiredFields: ['botId', 'secret'],
            installHint: '安装时可选择 npmmirror、淘宝源、npm 官方或华为云镜像。安装完成后需要重启网关才会生效。'
        },
        'openclaw-weixin': {
            key: 'openclaw-weixin',
            label: 'Personal Weixin',
            configKeys: ['openclaw-weixin'],
            packageCandidates: ['@tencent-weixin/openclaw-weixin@latest', '@tencent-weixin/openclaw-weixin', 'openclaw-weixin'],
            installPackageCandidates: ['@tencent-weixin/openclaw-weixin@latest', '@tencent-weixin/openclaw-weixin'],
            commandCandidates: ['openclaw-weixin'],
            requiredFields: [],
            installHint: 'Recommended V1 install flow for current OpenClaw releases: npx -y @tencent-weixin/openclaw-weixin-cli install. Manual fallback: openclaw plugins install @tencent-weixin/openclaw-weixin, then run openclaw channels login --channel openclaw-weixin.'
        },
        dingtalk: {
            key: 'dingtalk',
            label: 'DingTalk Bot',
            configKeys: ['dingtalk-connector', 'dingtalk'],
            packageCandidates: ['@dingtalk-real-ai/dingtalk-connector', 'dingtalk-connector', '@soimy/dingtalk'],
            installPackageCandidates: ['@dingtalk-real-ai/dingtalk-connector'],
            commandCandidates: ['dingtalk-connector', 'dingtalk'],
            requiredFields: ['clientId', 'clientSecret'],
            installHint: 'Recommended install command: openclaw plugins install @dingtalk-real-ai/dingtalk-connector. Save config only after the plugin is present, and include gatewayToken/gatewayPassword when gateway auth is enabled.'
        }
    };

    return profiles[normalizedKey] || null;
}

function getConfiguredChannelEntry(config = {}, profile = null) {
    const channels = config && typeof config.channels === 'object' && !Array.isArray(config.channels)
        ? config.channels
        : {};
    const candidateKeys = [];
    if (profile?.key) candidateKeys.push(profile.key);
    if (Array.isArray(profile?.configKeys)) candidateKeys.push(...profile.configKeys);

    for (const key of candidateKeys) {
        if (channels[key] && typeof channels[key] === 'object' && !Array.isArray(channels[key])) {
            return {
                key,
                config: channels[key]
            };
        }
    }

    return {
        key: candidateKeys[0] || '',
        config: null
    };
}

function collectInstalledChannelArtifactsFromConfigSync(config = {}, profile = null) {
    const evidence = [];
    if (!profile) {
        return {
            installed: false,
            repairRequired: false,
            source: 'unknown',
            evidence
        };
    }

    if (profile.builtIn) {
        return {
            installed: true,
            repairRequired: false,
            source: 'builtin',
            evidence: [{
                kind: 'builtin',
                path: profile.key,
                name: profile.key
            }]
        };
    }

    if (isSmokeTest && profile.key === 'openclaw-weixin') {
        const configuredEntry = getConfiguredChannelEntry(config, profile);
        if (configuredEntry?.config && typeof configuredEntry.config === 'object' && !Array.isArray(configuredEntry.config)) {
            return {
                installed: true,
                repairRequired: false,
                source: 'smoke-config',
                evidence: [{
                    kind: 'smoke-config',
                    path: configuredEntry.key || profile.key,
                    name: profile.key
                }]
            };
        }
    }

    const plugins = config && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
        ? config.plugins
        : {};
    const installs = plugins.installs && typeof plugins.installs === 'object' && !Array.isArray(plugins.installs)
        ? plugins.installs
        : {};
    const entries = plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
        ? plugins.entries
        : {};
    const allowList = Array.isArray(plugins.allow) ? plugins.allow.map((item) => String(item || '').trim()).filter(Boolean) : [];
    const candidateKeys = Array.from(new Set([
        profile.key,
        ...(profile.configKeys || []),
        ...(profile.packageCandidates || []),
        ...(profile.packageCandidates || []).map((item) => {
            const value = String(item || '').trim();
            return value.includes('/') ? value.split('/').pop() : value;
        }),
        ...(profile.commandCandidates || [])
    ].filter(Boolean)));

    let installed = false;
    let repairRequired = false;

    for (const key of candidateKeys) {
        const installRecord = installs[key];
        if (installRecord && typeof installRecord === 'object' && !Array.isArray(installRecord)) {
            const installPath = String(installRecord.installPath || installRecord.sourcePath || '').trim();
            const pathExists = installPath ? fs.existsSync(installPath) : false;
            evidence.push({
                kind: 'config-install',
                path: installPath || key,
                name: key
            });
            if (installPath && !pathExists) {
                repairRequired = true;
            } else if (installPath && pathExists) {
                installed = true;
            }
        }

        const entryRecord = entries[key];
        if (entryRecord && typeof entryRecord === 'object' && !Array.isArray(entryRecord)) {
            evidence.push({
                kind: 'config-entry',
                path: key,
                name: key
            });
        }

        if (allowList.includes(key)) {
            evidence.push({
                kind: 'config-allow',
                path: key,
                name: key
            });
        }
    }

    return {
        installed,
        repairRequired,
        source: installed ? 'config-plugin' : (repairRequired ? 'config-plugin-missing-path' : 'none'),
        evidence
    };
}

function collectChannelPluginConfigCandidateKeys(profile = null) {
    if (!profile) return [];
    return Array.from(new Set([
        profile.key,
        ...(profile.configKeys || []),
        ...(profile.packageCandidates || []),
        ...(profile.installPackageCandidates || []),
        ...(profile.commandCandidates || [])
    ].flatMap((item) => {
        const value = String(item || '').trim();
        if (!value) return [];
        const base = value.includes('/') ? value.split('/').pop() : value;
        const normalized = base.replace(/@latest$/i, '').trim();
        return [
            value,
            base,
            normalized,
            normalized.replace(/^openclaw-/, ''),
            normalized.replace(/-plugin$/, ''),
            normalized.replace(/^@/, '')
        ].filter(Boolean);
    })));
}

function pruneStaleChannelPluginConfig(config = {}, profile = null, options = {}) {
    const nextConfig = cloneJsonValue(config || {});
    if (!profile) {
        return {
            changed: false,
            config: nextConfig,
            removedAllow: [],
            removedEntries: [],
            removedInstalls: []
        };
    }

    const plugins = nextConfig.plugins && typeof nextConfig.plugins === 'object' && !Array.isArray(nextConfig.plugins)
        ? nextConfig.plugins
        : {};
    const installs = plugins.installs && typeof plugins.installs === 'object' && !Array.isArray(plugins.installs)
        ? plugins.installs
        : {};
    const entries = plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
        ? plugins.entries
        : {};
    const allow = Array.isArray(plugins.allow) ? [...plugins.allow] : [];
    const candidateKeys = collectChannelPluginConfigCandidateKeys(profile);
    const force = options?.force === true;

    let changed = false;
    const removedAllow = [];
    const removedEntries = [];
    const removedInstalls = [];

    for (const key of candidateKeys) {
        const installRecord = installs[key];
        const installPath = String(installRecord?.installPath || installRecord?.sourcePath || '').trim();
        const pathExists = installPath ? fs.existsSync(installPath) : false;
        const shouldRemove = force || !pathExists;

        if (shouldRemove && Object.prototype.hasOwnProperty.call(installs, key)) {
            delete installs[key];
            removedInstalls.push(key);
            changed = true;
        }
        if (shouldRemove && Object.prototype.hasOwnProperty.call(entries, key)) {
            delete entries[key];
            removedEntries.push(key);
            changed = true;
        }
        const allowIndex = allow.indexOf(key);
        if (shouldRemove && allowIndex >= 0) {
            allow.splice(allowIndex, 1);
            removedAllow.push(key);
            changed = true;
        }
    }

    if (changed) {
        nextConfig.plugins = {
            ...plugins,
            allow,
            entries,
            installs
        };
    }

    return {
        changed,
        config: nextConfig,
        removedAllow,
        removedEntries,
        removedInstalls
    };
}

function collectInstalledChannelArtifactsFromCliSync(profile = null, options = {}) {
    const evidence = [];
    if (!profile || isSmokeTest) {
        return {
            installed: false,
            repairRequired: false,
            source: 'none',
            evidence,
            probed: false
        };
    }

    const inventory = getOpenClawPluginInventorySync(options);
    if (!inventory.ok) {
        if (inventory.error || inventory.output) {
            evidence.push({
                kind: 'cli-probe-error',
                path: 'openclaw plugins list --json',
                name: inventory.error || inventory.output
            });
        }
        return {
            installed: false,
            repairRequired: false,
            source: 'none',
            evidence,
            probed: false
        };
    }

    const candidateTokens = new Set(collectChannelPluginCandidateTokens(profile));
    const matchedPlugins = (Array.isArray(inventory.plugins) ? inventory.plugins : []).filter((plugin) => {
        const pluginTokens = new Set();
        const sourcePath = String(plugin?.source || '').trim();
        const sourceDir = sourcePath ? path.basename(path.dirname(sourcePath)) : '';
        const sourceFileBase = sourcePath ? path.basename(sourcePath, path.extname(sourcePath)) : '';
        [
            plugin?.id,
            plugin?.name,
            sourceDir,
            sourceFileBase,
            ...(Array.isArray(plugin?.channelIds) ? plugin.channelIds : [])
        ].forEach((item) => {
            const normalized = normalizeChannelPluginCandidateToken(item);
            if (normalized) pluginTokens.add(normalized);
        });
        return Array.from(candidateTokens).some((token) => pluginTokens.has(token));
    });

    for (const plugin of matchedPlugins) {
        evidence.push({
            kind: 'cli-plugin',
            path: String(plugin?.source || plugin?.id || '').trim(),
            name: String(plugin?.id || plugin?.name || profile.key || '').trim()
        });
    }

    const installed = matchedPlugins.length > 0;
    const primary = matchedPlugins[0] || null;
    return {
        installed,
        repairRequired: false,
        source: installed ? `cli-${String(primary?.origin || 'plugin').trim().toLowerCase() || 'plugin'}` : 'cli-none',
        evidence,
        probed: true
    };
}

function collectInstalledChannelArtifactsFromExtensionsSync(profile = null) {
    const evidence = [];
    if (!profile || profile.builtIn) {
        return {
            installed: false,
            repairRequired: false,
            source: 'none',
            evidence
        };
    }

    const extensionsDir = path.join(openClawHomeDir, 'extensions');
    if (!fs.existsSync(extensionsDir)) {
        return {
            installed: false,
            repairRequired: false,
            source: 'none',
            evidence
        };
    }

    const candidateKeys = Array.from(new Set([
        profile.key,
        ...(profile.configKeys || []),
        ...(profile.packageCandidates || []),
        ...(profile.installPackageCandidates || []),
        ...(profile.commandCandidates || [])
    ].map((item) => String(item || '').trim()).filter(Boolean)));

    const candidateDirs = Array.from(new Set(candidateKeys.flatMap((item) => {
        const base = item.includes('/') ? item.split('/').pop() : item;
        const normalized = base.replace(/@latest$/i, '').trim();
        return [
            normalized,
            normalized.replace(/^openclaw-/, ''),
            normalized.replace(/-plugin$/, ''),
            normalized.replace(/^@/, '')
        ].filter(Boolean);
    })));

    let installed = false;
    for (const dirName of candidateDirs) {
        const installPath = path.join(extensionsDir, dirName);
        if (fs.existsSync(installPath)) {
            evidence.push({
                kind: 'extension-dir',
                path: installPath,
                name: dirName
            });
            installed = true;
        }
    }

    return {
        installed,
        repairRequired: false,
        source: installed ? 'extensions-dir' : 'none',
        evidence
    };
}

function collectInstalledChannelArtifactsFromBundledSync(profile = null) {
    const evidence = [];
    if (!profile || profile.builtIn) {
        return {
            installed: false,
            repairRequired: false,
            source: 'none',
            evidence
        };
    }

    const cli = resolveOpenClawCliSync();
    const cliDir = path.dirname(String(cli.commandPath || '').trim());
    const candidateRoots = Array.from(new Set([
        path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'extensions'),
        path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw-cn', 'extensions'),
        cliDir ? path.join(cliDir, 'node_modules', 'openclaw', 'extensions') : '',
        cliDir ? path.join(cliDir, 'node_modules', 'openclaw-cn', 'extensions') : ''
    ].filter(Boolean)));

    const candidateKeys = Array.from(new Set([
        profile.key,
        ...(profile.configKeys || []),
        ...(profile.packageCandidates || []),
        ...(profile.installPackageCandidates || [])
    ].map((item) => String(item || '').trim()).filter(Boolean)));

    const candidateDirs = Array.from(new Set(candidateKeys.flatMap((item) => {
        const base = item.includes('/') ? item.split('/').pop() : item;
        const normalized = base.replace(/@latest$/i, '').trim();
        return [
            normalized,
            normalized.replace(/^openclaw-/, ''),
            normalized.replace(/-plugin$/, ''),
            normalized.replace(/^@/, '')
        ].filter(Boolean);
    })));

    let installed = false;
    for (const root of candidateRoots) {
        if (!fs.existsSync(root)) continue;
        for (const dirName of candidateDirs) {
            const installPath = path.join(root, dirName);
            if (fs.existsSync(installPath)) {
                evidence.push({
                    kind: 'bundled-extension-dir',
                    path: installPath,
                    name: dirName
                });
                installed = true;
            }
        }
    }

    return {
        installed,
        repairRequired: false,
        source: installed ? 'bundled-extension-dir' : 'none',
        evidence
    };
}

function collectInstalledChannelArtifactsSync(profile = null, config = {}, options = {}) {
    const evidence = [];
    if (!profile) {
        return {
            installed: false,
            repairRequired: false,
            source: 'unknown',
            evidence
        };
    }

    const configArtifacts = collectInstalledChannelArtifactsFromConfigSync(config, profile);
    evidence.push(...(configArtifacts.evidence || []));
    const localOnly = options?.localOnly === true;
    const shouldDeepProbe = options?.deepProbe === true;
    const extensionArtifacts = collectInstalledChannelArtifactsFromExtensionsSync(profile);
    evidence.push(...(extensionArtifacts.evidence || []));

    if (localOnly) {
        return {
            installed: Boolean(profile?.builtIn === true || configArtifacts.installed || extensionArtifacts.installed),
            repairRequired: profile?.builtIn === true ? false : Boolean(configArtifacts.repairRequired),
            source: profile?.builtIn === true
                ? 'built-in'
                : (extensionArtifacts.installed ? extensionArtifacts.source : (configArtifacts.source || 'none')),
            evidence
        };
    }

    const cliArtifacts = shouldDeepProbe ? collectInstalledChannelArtifactsFromCliSync(profile, options) : {
        installed: false,
        repairRequired: false,
        source: 'none',
        evidence: [],
        probed: false
    };
    evidence.push(...(cliArtifacts.evidence || []));
    const bundledArtifacts = collectInstalledChannelArtifactsFromBundledSync(profile);
    evidence.push(...(bundledArtifacts.evidence || []));

    if (shouldDeepProbe && cliArtifacts.probed) {
        return {
            installed: Boolean(cliArtifacts.installed || (profile?.builtIn === true)),
            repairRequired: profile?.builtIn === true ? false : Boolean(configArtifacts.repairRequired),
            source: cliArtifacts.installed ? cliArtifacts.source : (profile?.builtIn === true ? 'built-in' : 'none'),
            evidence
        };
    }

    if (!shouldDeepProbe || configArtifacts.installed || extensionArtifacts.installed || bundledArtifacts.installed || configArtifacts.repairRequired || isSmokeTest) {
        return {
            installed: Boolean(profile?.builtIn === true || configArtifacts.installed || extensionArtifacts.installed || bundledArtifacts.installed),
            repairRequired: profile?.builtIn === true ? false : Boolean(configArtifacts.repairRequired),
            source: profile?.builtIn === true
                ? 'built-in'
                : configArtifacts.installed
                ? configArtifacts.source
                : (bundledArtifacts.installed ? bundledArtifacts.source : (extensionArtifacts.source || configArtifacts.source || 'none')),
            evidence
        };
    }

    let moduleRoots = [];
    try {
        moduleRoots = resolveNpmGlobalModuleRootsSync();
    } catch (error) {
        evidence.push({
            kind: 'probe-error',
            path: 'npm root -g',
            name: error?.message || String(error)
        });
    }

    for (const root of moduleRoots) {
        for (const packageName of profile.packageCandidates || []) {
            const packagePath = path.join(root, ...String(packageName).split('/'));
            const packageJsonPath = path.join(packagePath, 'package.json');
            if (fs.existsSync(packagePath)) {
                evidence.push({
                    kind: 'package',
                    path: packagePath,
                    name: packageName
                });
            }
            if (fs.existsSync(packageJsonPath)) {
                evidence.push({
                    kind: 'package-json',
                    path: packageJsonPath,
                    name: packageName
                });
            }
        }
    }

    for (const commandName of profile.commandCandidates || []) {
        try {
            const matches = resolveCommandMatchesSync(commandName);
            for (const match of matches) {
                if (fs.existsSync(match)) {
                    evidence.push({
                        kind: 'command',
                        path: match,
                        name: commandName
                    });
                }
            }
        } catch (_) {}
    }

    const uniqueEvidence = [];
    const seen = new Set();
    for (const item of evidence) {
        const token = `${item.kind}:${item.path}`.toLowerCase();
        if (seen.has(token)) continue;
        seen.add(token);
        uniqueEvidence.push(item);
    }

    const packageMatch = uniqueEvidence.find((item) => item.kind === 'package' || item.kind === 'package-json');
    const commandMatch = uniqueEvidence.find((item) => item.kind === 'command');
    const extensionMatch = uniqueEvidence.find((item) => item.kind === 'extension-dir');
    const bundledMatch = uniqueEvidence.find((item) => item.kind === 'bundled-extension-dir');
    const installed = Boolean(profile?.builtIn === true || configArtifacts.installed || extensionArtifacts.installed || bundledArtifacts.installed || packageMatch || commandMatch || extensionMatch || bundledMatch);

    return {
        installed,
        repairRequired: Boolean(configArtifacts.repairRequired),
        source: profile?.builtIn === true
            ? 'built-in'
            : configArtifacts.installed
            ? configArtifacts.source
            : (bundledArtifacts.installed
                ? bundledArtifacts.source
                : (extensionArtifacts.installed
                ? extensionArtifacts.source
                : (packageMatch ? 'local-package' : (commandMatch ? 'local-command' : configArtifacts.source || 'none')))),
        evidence: uniqueEvidence
    };
}

async function resolveInstallGatewayRestartMode(options = {}) {
    const preferredMode = String(options?.preferredMode || '').trim().toLowerCase();
    if (preferredMode === 'npm' || preferredMode === 'official') {
        return {
            mode: preferredMode,
            reason: `preferred dashboard mode is ${preferredMode}`
        };
    }

    const portStatus = await probeOpenClawGatewayStatus({ allowFallbackCli: false });
    const pm2Snapshot = getPm2GatewaySnapshotSync();
    const gatewayPid = Number.parseInt(String(portStatus?.pid || ''), 10);
    const pm2Pids = new Set(Array.isArray(pm2Snapshot?.pids) ? pm2Snapshot.pids : []);

    if (gatewayPid > 0 && pm2Pids.has(gatewayPid)) {
        return {
            mode: 'npm',
            reason: `detected pm2-managed gateway pid ${gatewayPid}`
        };
    }

    if (pm2Snapshot?.online) {
        return {
            mode: 'npm',
            reason: `detected online pm2 app ${pm2Snapshot.appName || 'openclaw-gateway'}`
        };
    }

    return {
        mode: 'official',
        reason: gatewayPid > 0
            ? `gateway pid ${gatewayPid} is not managed by pm2`
            : 'pm2-managed gateway was not detected'
    };
}

async function restartGatewayUsingDashboardAction(timeoutMs = 180000, options = {}) {
    const onLog = typeof options?.onLog === 'function' ? options.onLog : null;
    const detected = await resolveInstallGatewayRestartMode({
        preferredMode: options?.preferredMode
    });
    let mode = detected.mode === 'npm' ? 'npm' : 'official';
    let request = resolveDashboardActionRequest('restart', mode);
    let preflightPreamble = '';
    const attempts = [];

    const pushLog = (stream, text) => {
        if (!onLog || !text) return;
        try {
            onLog(stream, text);
        } catch (_) {}
    };

    const runSingle = async (targetMode) => {
        let nextRequest = resolveDashboardActionRequest('restart', targetMode);
        let nextPreamble = '';

        if (targetMode === 'npm' && nextRequest && !nextRequest.error) {
            try {
                const preflight = await resolveNpmDashboardPreflight('restart');
                if (preflight?.requestOverride) {
                    nextRequest = preflight.requestOverride;
                }
                nextPreamble = String(preflight?.preamble || '');
            } catch (error) {
                nextPreamble = `[WARN] npm 管理预检查失败，继续按原流程执行：${error.message}\n`;
            }
        }

        if (!nextRequest) {
            return {
                ok: false,
                mode: targetMode,
                restart: { ok: false, code: -1, output: '' },
                status: { ok: false, code: -1, output: '' },
                error: `unsupported dashboard restart mode: ${targetMode}`
            };
        }

        if (nextRequest.error) {
            return {
                ok: false,
                mode: targetMode,
                restart: { ok: false, code: -1, output: '' },
                status: { ok: false, code: -1, output: '' },
                error: nextRequest.error
            };
        }

        if (nextPreamble) {
            pushLog('status', nextPreamble);
        }
        if (nextRequest.preamble) {
            pushLog('status', nextRequest.preamble);
        }
        pushLog('status', `[INFO] 自动重启将复用首页重启逻辑，模式：${targetMode === 'npm' ? 'PM2' : 'CLI'}。\n`);
        pushLog('status', `[INFO] 自动重启命令预览：${nextRequest.previewCommand || 'restart'}\n`);

        if (!nextRequest.spawnRequest) {
            return {
                ok: false,
                mode: targetMode,
                restart: { ok: false, code: -1, output: '' },
                status: { ok: false, code: -1, output: '' },
                error: `dashboard restart request has no spawnRequest for mode ${targetMode}`
            };
        }

        const restartTimeoutMs = Math.min(
            Math.max(10000, Number(nextRequest.timeoutMs || timeoutMs) || timeoutMs),
            30000
        );
        const restartResult = await runCapturedProcessWithRetries(nextRequest.spawnRequest, {
            timeoutMs: restartTimeoutMs,
            encoding: nextRequest.encoding || 'utf8',
            onStdout: (chunk) => pushLog('stdout', chunk),
            onStderr: (chunk) => pushLog('stderr', chunk),
            maxAttempts: 2,
            retryDelayMs: CHANNEL_INSTALL_RETRY_DELAY_MS
        });
        const restartOutput = collectChannelInstallOutputText(restartResult);

        if (!restartResult.ok) {
            return {
                ok: false,
                mode: targetMode,
                restart: {
                    ok: false,
                    code: restartResult.code,
                    output: restartOutput
                },
                status: { ok: false, code: -1, output: '' },
                error: String(restartResult.error?.message || `exit code ${restartResult.code}`).trim()
            };
        }

        const online = await waitForGatewayOnlineAfterLaunch({
            timeoutMs: Math.min(restartTimeoutMs, 30000),
            intervalMs: 500
        });
        const statusResult = await runOpenClawCliCaptured(['gateway', 'status'], {
            timeoutMs: Math.min(timeoutMs, 60000),
            onStdout: (chunk) => pushLog('stdout', chunk),
            onStderr: (chunk) => pushLog('stderr', chunk),
            maxAttempts: 2,
            retryDelayMs: CHANNEL_INSTALL_RETRY_DELAY_MS
        });
        const statusOutput = collectChannelInstallOutputText(statusResult);
        const statusOk = online.ok || statusResult.ok === true || /RPC probe: ok|Listening:|Gateway: bind=|Dashboard:/i.test(statusOutput);

        return {
            ok: restartResult.ok === true && statusOk,
            mode: targetMode,
            restart: {
                ok: restartResult.ok === true,
                code: restartResult.code,
                output: restartOutput
            },
            status: {
                ok: statusOk,
                code: statusResult.code,
                output: statusOutput
            },
            error: statusOk ? '' : 'gateway did not become online after restart'
        };
    };

    pushLog('status', `[INFO] 正在检测网关重启方式：${mode === 'npm' ? 'PM2' : 'CLI'}（${detected.reason}）。\n`);
    let result = await runSingle(mode);
    attempts.push(result);

    if (!result.ok && mode === 'npm') {
        pushLog('status', '[WARN] PM2 重启未通过，正在回退尝试官方 CLI 重启。\n');
        mode = 'official';
        request = resolveDashboardActionRequest('restart', mode);
        preflightPreamble = '';
        result = await runSingle(mode);
        attempts.push(result);
    }

    return {
        ...result,
        mode,
        request,
        preflightPreamble,
        attempts,
        detectedMode: detected.mode,
        detectedReason: detected.reason
    };
}

async function waitForChannelExtensionInstall(profile = null, options = {}) {
    const timeoutMs = Math.max(500, Number(options?.timeoutMs) || 6000);
    const intervalMs = Math.max(150, Number(options?.intervalMs) || 400);
    const deadline = Date.now() + timeoutMs;
    let lastStatus = collectInstalledChannelArtifactsFromExtensionsSync(profile);

    while (Date.now() <= deadline) {
        lastStatus = collectInstalledChannelArtifactsFromExtensionsSync(profile);
        if (lastStatus.installed) {
            return {
                ok: true,
                status: lastStatus
            };
        }
        await wait(intervalMs);
    }

    return {
        ok: false,
        status: lastStatus
    };
}

async function verifyChannelEnvironmentAfterInstall(profile = null, timeoutMs = 180000) {
    invalidateOpenClawPluginInventoryCache();
    const pluginStatus = collectInstalledChannelArtifactsFromCliSync(profile, { refresh: true });
    const doctorResult = await runOpenClawCliCaptured(['plugins', 'doctor'], {
        timeoutMs: Math.min(timeoutMs, 60000),
        maxAttempts: 2,
        retryDelayMs: CHANNEL_INSTALL_RETRY_DELAY_MS
    });
    const doctorOutput = collectChannelInstallOutputText(doctorResult);
    const doctorOk = doctorResult.ok === true || /No plugin issues detected\./i.test(doctorOutput);

    const channelsResult = await runOpenClawCliCaptured(['channels', 'status', '--probe'], {
        timeoutMs: Math.min(timeoutMs, 60000),
        maxAttempts: 2,
        retryDelayMs: CHANNEL_INSTALL_RETRY_DELAY_MS
    });
    const channelsOutput = collectChannelInstallOutputText(channelsResult);
    const channelsOk = channelsResult.ok === true || /Checking channel status|Config:|Mode:/i.test(channelsOutput);

    return {
        ok: Boolean(pluginStatus.installed && doctorOk),
        plugin: {
            ok: Boolean(pluginStatus.installed),
            source: pluginStatus.source || '',
            evidence: pluginStatus.evidence || []
        },
        doctor: {
            ok: doctorOk,
            code: doctorResult.code,
            output: doctorOutput
        },
        channels: {
            ok: channelsOk,
            code: channelsResult.code,
            output: channelsOutput
        }
    };
}

function summarizeChannelConfiguration(profile = null, entry = null) {
    if (!profile || !entry || typeof entry !== 'object') {
        return {
            configured: false,
            credentialReady: false,
            fields: [],
            missingFields: []
        };
    }

    const fields = Object.keys(entry).filter((key) => !['enabled', 'binding', 'agentBinding', 'agentId', 'agent', 'name'].includes(key));
    const accounts = entry.accounts && typeof entry.accounts === 'object' && !Array.isArray(entry.accounts)
        ? entry.accounts
        : {};
    const defaultAccountId = String(entry.defaultAccount || '').trim();
    const selectedAccount = (defaultAccountId && accounts[defaultAccountId]) || accounts.default || accounts.main || Object.values(accounts)[0] || {};
    const normalizedValues = {
        appId: String(entry.appId || entry.clientId || selectedAccount.appId || '').trim(),
        appSecret: String(entry.appSecret || entry.clientSecret || selectedAccount.appSecret || '').trim(),
        clientId: String(entry.clientId || entry.appId || '').trim(),
        clientSecret: String(entry.clientSecret || entry.appSecret || '').trim(),
        botToken: String(entry.botToken || entry.token || '').trim()
    };

    const missingFields = [];
    for (const field of profile.requiredFields || []) {
        if (field === 'appId' && !(normalizedValues.appId || normalizedValues.clientId)) missingFields.push('appId');
        if (field === 'appSecret' && !(normalizedValues.appSecret || normalizedValues.clientSecret)) missingFields.push('appSecret');
        if (field === 'clientId' && !(normalizedValues.clientId || normalizedValues.appId)) missingFields.push('clientId');
        if (field === 'clientSecret' && !(normalizedValues.clientSecret || normalizedValues.appSecret)) missingFields.push('clientSecret');
        if (field === 'botToken' && !normalizedValues.botToken) missingFields.push('botToken');
    }

    return {
        configured: Object.keys(entry).length > 0,
        credentialReady: missingFields.length === 0,
        fields,
        missingFields
    };
}

function buildChannelEnvironmentStatus(channelKey, configJson = null, options = {}) {
    const profile = getChannelEnvironmentProfile(channelKey);
    const config = configJson && typeof configJson === 'object' ? configJson : readOpenClawConfigSync();
    const entry = profile ? getConfiguredChannelEntry(config, profile) : { key: '', config: null };
    const configSummary = summarizeChannelConfiguration(profile, entry.config);
    const artifactSummary = collectInstalledChannelArtifactsSync(profile, config, options);

    const installed = Boolean(artifactSummary.installed);
    const configured = Boolean(configSummary.configured);
    const credentialReady = Boolean(configSummary.credentialReady);
    let state = 'missing';
    if (installed && credentialReady) {
        state = 'ready';
    } else if (installed) {
        state = 'needs-config';
    } else if (!installed && configured) {
        state = 'needs-install';
    }
    if (artifactSummary.repairRequired) {
        state = 'repair';
    }

    const evidence = [];
    if (entry.key) {
        evidence.push(`config:${entry.key}`);
    }
    for (const item of artifactSummary.evidence || []) {
        evidence.push(`${item.kind}:${item.name || ''}:${item.path}`);
    }

    return {
        key: profile?.key || normalizeChannelEnvironmentKey(channelKey),
        label: profile?.label || String(channelKey || ''),
        state,
        installed,
        configured,
        credentialReady,
        needsInstallation: !installed,
        needsConfiguration: installed && !credentialReady,
        repairRequired: Boolean(artifactSummary.repairRequired),
        source: artifactSummary.source,
        configKey: entry.key || '',
        configFields: configSummary.fields,
        missingFields: configSummary.missingFields,
        evidence,
        installHint: profile?.installHint || '',
        displayStatus: state === 'ready'
            ? 'Ready'
            : state === 'needs-install'
                ? 'Needs installation'
                : state === 'needs-config'
                    ? 'Needs configuration'
                    : configured
                        ? '仅有配置，未发现本地插件/环境'
                        : '未发现配置或插件'
    };
}

function buildAllChannelEnvironmentStatuses(configJson = null, options = {}) {
    const channels = ['telegram', 'qqbot', 'feishu', 'wecom', 'openclaw-weixin', 'dingtalk'];
    const config = configJson && typeof configJson === 'object' ? configJson : readOpenClawConfigSync();
    const statuses = {};
    for (const channelKey of channels) {
        statuses[channelKey] = buildChannelEnvironmentStatus(channelKey, config, options);
    }
    return statuses;
}

function buildOpenClawCliCommandText(args = []) {
    const cli = resolveOpenClawCliSync();
    const binary = cli.commandPath || cli.displayName || 'openclaw';
    return [binary, ...(args || []).map((item) => String(item))]
        .map(quoteWindowsCmdArg)
        .join(' ');
}

function getChannelInstallAttempts(profile = null, payload = {}) {
    if (!profile || profile.builtIn) return [];
    const source = resolveChannelInstallSource(payload, profile);
    const registry = String(source?.registry || '').trim();
    const installEnv = buildChannelInstallEnv(source);
    const packageNames = Array.from(new Set(
        (profile.installPackageCandidates || profile.packageCandidates || [])
            .map((item) => String(item || '').trim())
            .filter(Boolean)
    ));

    return packageNames.map((packageName) => {
        const args = ['plugins', 'install', packageName];
        return {
            kind: 'openclaw-plugin',
            packageName,
            args,
            commandText: buildOpenClawCliCommandText(args),
            env: installEnv,
            registry,
            registryChoice: source?.value || ''
        };
    });
}

async function installChannelEnvironment(payload = {}, options = {}) {
    const channelKey = normalizeChannelEnvironmentKey(payload?.channel || payload?.platform || payload?.key || '');
    const profile = getChannelEnvironmentProfile(channelKey);
    const sender = options?.sender || null;
    const requestId = String(payload?.requestId || '').trim();
    const pushInstallLog = (stream, text, extra = {}) => {
        emitChannelInstallStream(sender, {
            requestId,
            channel: channelKey,
            stream,
            text,
            ...extra
        });
    };
    if (!profile) {
        pushInstallLog('stderr', `不支持自动安装该渠道：${channelKey || 'unknown'}\n`, {
            phase: 'done',
            done: true
        });
        return {
            ok: false,
            installed: false,
            channel: channelKey,
            error: `暂不支持自动安装该渠道：${channelKey || 'unknown'}`
        };
    }

    const activeInstall = getActiveChannelInstallOperation();
    if (activeInstall && activeInstall.requestId !== requestId) {
        const busyLabel = getChannelEnvironmentProfile(activeInstall.channelKey)?.label || activeInstall.channelKey || '其他渠道';
        pushInstallLog('stderr', `${busyLabel} 正在安装中，请等待当前任务完成后再重试。\n`, {
            phase: 'busy',
            done: true
        });
        return {
            ok: false,
            installed: false,
            channel: profile.key,
            error: `${busyLabel} 安装任务仍在进行中，请稍后再试。`
        };
    }

    const installToken = beginChannelInstallOperation(channelKey, requestId);
    let extensionUpgradeBackup = null;
    let installFinished = false;
    try {

        let activeConfig = readOpenClawConfigSync();
        let beforeStatus = buildChannelEnvironmentStatus(channelKey, activeConfig, { localOnly: true });
        const beforeExtensionStatus = collectInstalledChannelArtifactsFromExtensionsSync(profile);
        if (profile.key === 'openclaw-weixin' && payload?.force === true && beforeExtensionStatus.installed) {
            try {
                extensionUpgradeBackup = prepareChannelExtensionUpgradeBackup(profile, beforeExtensionStatus);
                if (extensionUpgradeBackup) {
                    pushInstallLog('status', `[INFO] 已临时备份旧版个人微信插件目录：${extensionUpgradeBackup.backupPath}\n`, {
                        phase: 'install-backup'
                    });
                }
            } catch (error) {
                pushInstallLog('stderr', `[WARN] 旧版个人微信插件目录备份失败：${error?.message || String(error)}\n`, {
                    phase: 'install-backup'
                });
            }
        }
        if (!beforeExtensionStatus.installed) {
            const cleanup = pruneStaleChannelPluginConfig(activeConfig, profile, { force: true });
            if (cleanup.changed) {
                const writeResult = writeOpenClawConfigSync(cleanup.config);
                if (writeResult?.ok) {
                    activeConfig = cleanup.config;
                    beforeStatus = buildChannelEnvironmentStatus(channelKey, activeConfig, { localOnly: true });
                    const removedBits = [
                        cleanup.removedAllow.length ? `allow=${cleanup.removedAllow.join(',')}` : '',
                        cleanup.removedEntries.length ? `entries=${cleanup.removedEntries.join(',')}` : '',
                        cleanup.removedInstalls.length ? `installs=${cleanup.removedInstalls.join(',')}` : ''
                    ].filter(Boolean).join('；');
                    pushInstallLog('status', `检测到 ${profile.label} 的残留插件配置，已在安装前自动清理${removedBits ? `：${removedBits}` : ''}。\n`, {
                        phase: 'config-cleanup'
                    });
                } else {
                    pushInstallLog('stderr', `检测到 ${profile.label} 的残留插件配置，但自动清理失败：${writeResult?.error || 'unknown error'}\n`, {
                        phase: 'config-cleanup'
                    });
                }
            }
        }
        const source = resolveChannelInstallSource(payload, profile);
        pushInstallLog('status', `开始安装 ${profile.label}，安装源：${source?.label || source?.registry || '默认源'}\n`, {
            phase: 'start'
        });
        if (profile.builtIn) {
            pushInstallLog('status', `${profile.label} 为内置渠道，无需额外安装。\n`, {
                phase: 'done',
                done: true
            });
            installFinished = true;
            return {
                ok: true,
                installed: true,
                skipped: true,
                channel: profile.key,
                status: beforeStatus,
                message: `${profile.label} is built in and does not require installation.`
            };
        }

        if (beforeExtensionStatus.installed && payload?.force !== true) {
            pushInstallLog('status', `${profile.label} 本机插件已存在，跳过重复安装。\n`, {
                phase: 'done',
                done: true
            });
            installFinished = true;
            return {
                ok: true,
                installed: true,
                skipped: true,
                channel: profile.key,
                status: buildChannelEnvironmentStatus(channelKey, readOpenClawConfigSync(), { localOnly: true }),
                message: `${profile.label} is already available on this machine.`
            };
        }

        if (isSmokeTest && process.env.OPENCLAW_SMOKE_REAL_CHANNEL_INSTALL !== '1') {
        installFinished = true;
        const nextConfig = cloneJsonValue(activeConfig || {});
        if (!nextConfig.plugins || typeof nextConfig.plugins !== 'object' || Array.isArray(nextConfig.plugins)) {
            nextConfig.plugins = {};
        }
        if (!nextConfig.plugins.installs || typeof nextConfig.plugins.installs !== 'object' || Array.isArray(nextConfig.plugins.installs)) {
            nextConfig.plugins.installs = {};
        }
        if (!Array.isArray(nextConfig.plugins.allow)) {
            nextConfig.plugins.allow = [];
        }

        const installRoot = path.join(openClawHomeDir, 'plugins', profile.key);
        ensureDirectory(installRoot);
        fs.writeFileSync(
            path.join(installRoot, 'package.json'),
            JSON.stringify({
                name: profile.installPackageCandidates?.[0] || profile.key,
                version: '0.0.0-smoke'
            }, null, 2),
            'utf8'
        );

        nextConfig.plugins.installs[profile.key] = {
            source: 'npm',
            spec: profile.installPackageCandidates?.[0] || profile.key,
            installPath: installRoot,
            installedAt: new Date().toISOString(),
            version: '0.0.0-smoke',
            resolvedName: profile.installPackageCandidates?.[0]
                ? String(profile.installPackageCandidates[0]).replace(/@[^@]+$/, '')
                : profile.key,
            resolvedVersion: '0.0.0-smoke',
            resolvedSpec: profile.installPackageCandidates?.[0] || profile.key
        };
        if (!nextConfig.plugins.allow.includes(profile.key)) {
            nextConfig.plugins.allow.push(profile.key);
        }

        const writeResult = writeOpenClawConfigSync(nextConfig);
        if (writeResult?.ok === false) {
            return {
                ok: false,
                installed: false,
                channel: profile.key,
                status: beforeStatus,
                installHint: profile.installHint || '',
                registry: source?.registry || '',
                registryChoice: source?.value || '',
                error: writeResult.error || `${profile.label} smoke installation failed.`
            };
        }

        const currentStatus = buildChannelEnvironmentStatus(channelKey, readOpenClawConfigSync(), { deepProbe: true });
        const fakeAttempt = getChannelInstallAttempts(profile, payload)[0] || null;
        return {
            ok: true,
            installed: true,
            channel: profile.key,
            status: currentStatus,
            installHint: profile.installHint || '',
            registry: source?.registry || '',
            registryChoice: source?.value || '',
            command: fakeAttempt?.commandText || '',
            attempts: fakeAttempt ? [{
                command: fakeAttempt.commandText,
                packageName: fakeAttempt.packageName,
                ok: true,
                code: 0,
                output: 'smoke install success'
            }] : [],
            message: `${profile.label} environment installed successfully.`
        };
        }

        const attempts = getChannelInstallAttempts(profile, payload);
        if (!attempts.length) {
            pushInstallLog('stderr', `${profile.label} 未配置自动安装命令。\n`, {
                phase: 'done',
                done: true
            });
            return {
                ok: false,
                installed: false,
                channel: profile.key,
                status: beforeStatus,
                installHint: profile.installHint || '',
                registry: source?.registry || '',
                registryChoice: source?.value || '',
                error: `${profile.label} does not have an automatic installer configured.`
            };
        }

        const results = [];
        const timeoutMs = Math.max(30000, Number(payload?.timeoutMs) || 180000);

        for (const attempt of attempts) {
        let commandResult = null;
        try {
            pushInstallLog('status', `执行安装命令：${attempt.commandText}\n`, {
                phase: 'install-command'
            });
            commandResult = await runOpenClawCliCaptured(attempt.args, {
                timeoutMs,
                env: attempt.env || {},
                onStdout: (chunk) => pushInstallLog('stdout', chunk, { phase: 'install-output' }),
                onStderr: (chunk) => pushInstallLog('stderr', chunk, { phase: 'install-output' }),
                maxAttempts: 3,
                retryDelayMs: CHANNEL_INSTALL_RETRY_DELAY_MS
            });
        } catch (error) {
            commandResult = {
                ok: false,
                code: -1,
                stdout: '',
                stderr: '',
                error
            };
        }

        invalidateOpenClawPluginInventoryCache();
        const outputText = String(
            collectChannelInstallOutputText(commandResult)
        ).trim();

        results.push({
            command: attempt.commandText,
            packageName: attempt.packageName,
            ok: commandResult.ok === true,
            code: commandResult.code,
            output: outputText
        });

        const currentStatus = buildChannelEnvironmentStatus(channelKey, readOpenClawConfigSync(), { localOnly: true });
        let currentExtensionStatus = collectInstalledChannelArtifactsFromExtensionsSync(profile);
        const outputSuggestsInstalled = /Installed plugin:\s*\w+|Installing to\s+[A-Z]:\\.+\\extensions\\|Restart the gateway to load plugins\./i.test(outputText);
        if (!currentExtensionStatus.installed && (commandResult.ok || outputSuggestsInstalled)) {
            pushInstallLog('status', `安装命令已完成，正在确认 ${profile.label} 是否已落地到本机插件目录...\n`, {
                phase: 'install-verify'
            });
            const settled = await waitForChannelExtensionInstall(profile, {
                timeoutMs: 8000,
                intervalMs: 500
            });
            currentExtensionStatus = settled.status || currentExtensionStatus;
        }
        const installTransitioned = !beforeExtensionStatus.installed && currentExtensionStatus.installed;
        const softWarningOnly = /node host gateway connect failed|gateway connect failed|gateway closed \((1006|1008)\)|ECONNREFUSED|DeprecationWarning|punycode|pairing required/i.test(outputText);
        const installSucceeded = !isHardChannelInstallFailure(outputText) && (
            currentExtensionStatus.installed
            || installTransitioned
        ) && (
            commandResult.ok
            || installTransitioned
            || softWarningOnly
        );

        if (installSucceeded) {
            const installPath = String(currentExtensionStatus?.evidence?.[0]?.path || '').trim();
            if (installPath) {
                pushInstallLog('status', `已检测到本机插件目录：${installPath}\n`, {
                    phase: 'install-detected'
                });
            }
            pushInstallLog('status', '[INFO] 插件文件已落地，等待 Node Host 状态稳定后自动重启网关...\n', {
                phase: 'gateway-restart'
            });
            await wait(1200);
            const warningText = !commandResult.ok && outputText
                ? ' The plugin was installed, but the local gateway was not reachable during post-install checks.'
                : '';
            let gatewayCheck = null;
            let verification = null;
            let gatewayNote = ' Automatic gateway restart is pending.';
            let verificationNote = ' Configuration can be completed later from channel management.';
            try {
                gatewayCheck = await restartGatewayUsingDashboardAction(timeoutMs, {
                    preferredMode: payload?.restartMode,
                    onLog: (stream, text) => pushInstallLog(stream, text, { phase: 'gateway-restart' })
                });
            } catch (error) {
                gatewayCheck = {
                    ok: false,
                    mode: 'official',
                    restart: { ok: false, code: -1, output: error?.message || String(error) },
                    status: { ok: false, code: -1, output: '' },
                    error: error?.message || String(error)
                };
            }
            const shouldVerifyAfterInstall = payload?.verifyAfterInstall === true;
            if (gatewayCheck?.ok) {
                gatewayNote = ` Gateway restart completed via ${gatewayCheck.mode === 'npm' ? 'PM2' : 'CLI'} mode.`;
            } else {
                gatewayNote = ` Automatic gateway restart via ${gatewayCheck?.mode === 'npm' ? 'PM2' : 'CLI'} mode needs manual follow-up.`;
            }
            if (shouldVerifyAfterInstall) {
                try {
                    verification = await verifyChannelEnvironmentAfterInstall(profile, timeoutMs);
                } catch (error) {
                    verification = {
                        ok: false,
                        plugin: { ok: false, source: '', evidence: [] },
                        doctor: { ok: false, code: -1, output: error?.message || String(error) },
                        channels: { ok: false, code: -1, output: '' }
                    };
                }
                verificationNote = verification?.ok
                    ? ' Official plugin verification passed.'
                    : ' Official plugin verification needs manual follow-up.';
            }
            pushInstallLog('status', `${profile.label} 安装完成。\n`, {
                phase: 'done',
                done: true
            });
            if (extensionUpgradeBackup) {
                try {
                    finalizeChannelExtensionUpgradeBackup(extensionUpgradeBackup);
                    pushInstallLog('status', '[INFO] 旧版个人微信插件备份已清理。\n', {
                        phase: 'install-backup-cleanup'
                    });
                    extensionUpgradeBackup = null;
                } catch (error) {
                    pushInstallLog('stderr', `[WARN] 旧版个人微信插件备份清理失败：${error?.message || String(error)}\n`, {
                        phase: 'install-backup-cleanup'
                    });
                }
            }
            installFinished = true;
            return {
                ok: true,
                installed: true,
                channel: profile.key,
                status: currentStatus,
                installHint: profile.installHint || '',
                registry: attempt.registry || source?.registry || '',
                registryChoice: attempt.registryChoice || source?.value || '',
                command: attempt.commandText,
                attempts: results,
                gatewayCheck,
                verification,
                message: `${profile.label} environment installed successfully.${warningText}${gatewayNote}${verificationNote}`
            };
        }

        if ((commandResult.ok || softWarningOnly) && !currentExtensionStatus.installed) {
            const extensionsDir = path.join(openClawHomeDir, 'extensions');
            pushInstallLog('stderr', `安装命令已结束，但未在本机插件目录中发现 ${profile.label}：${extensionsDir}\n`, {
                phase: 'install-missing-extension'
            });
        }
        }

        let afterConfig = readOpenClawConfigSync();
        const cleanupAfterFailure = pruneStaleChannelPluginConfig(afterConfig, profile, { force: true });
        if (cleanupAfterFailure.changed) {
            const writeResult = writeOpenClawConfigSync(cleanupAfterFailure.config);
            if (writeResult?.ok) {
                afterConfig = cleanupAfterFailure.config;
                const removedBits = [
                    cleanupAfterFailure.removedAllow.length ? `allow=${cleanupAfterFailure.removedAllow.join(',')}` : '',
                    cleanupAfterFailure.removedEntries.length ? `entries=${cleanupAfterFailure.removedEntries.join(',')}` : '',
                    cleanupAfterFailure.removedInstalls.length ? `installs=${cleanupAfterFailure.removedInstalls.join(',')}` : ''
                ].filter(Boolean).join('；');
                pushInstallLog('status', `安装未完成，已自动清理 ${profile.label} 的残留插件配置${removedBits ? `：${removedBits}` : ''}。\n`, {
                    phase: 'config-cleanup'
                });
            }
        }
        const afterStatus = buildChannelEnvironmentStatus(channelKey, afterConfig, { localOnly: true });
        const afterExtensionStatus = collectInstalledChannelArtifactsFromExtensionsSync(profile);
        const lastOutput = results.length ? results[results.length - 1].output : '';
        pushInstallLog('status', `${profile.label} 安装未完成，请查看上方日志定位问题。\n`, {
            phase: 'done',
            done: true
        });
        return {
            ok: false,
            installed: afterExtensionStatus.installed === true,
            channel: profile.key,
            status: afterStatus,
            installHint: profile.installHint || '',
            registry: source?.registry || '',
            registryChoice: source?.value || '',
            attempts: results,
            error: lastOutput || `${profile.label} automatic installation failed.`
        };
    } finally {
        if (!installFinished && extensionUpgradeBackup) {
            try {
                restoreChannelExtensionUpgradeBackup(extensionUpgradeBackup);
                pushInstallLog('status', '[INFO] 安装未完成，已恢复旧版个人微信插件目录。\n', {
                    phase: 'install-restore'
                });
            } catch (error) {
                pushInstallLog('stderr', `[WARN] 旧版个人微信插件目录恢复失败：${error?.message || String(error)}\n`, {
                    phase: 'install-restore'
                });
            }
        }
        finishChannelInstallOperation(installToken);
    }
}

async function trySequentialRequests(candidates, runner) {
    let lastError = null;

    for (const candidate of candidates) {
        try {
            return await runner(candidate);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('No request candidates available');
}

async function listRemoteModelsForContext(context) {
    const apiType = normalizeModelApiType(context?.provider?.api);
    const baseUrl = trimTrailingSlash(context?.provider?.baseUrl || getDefaultModelBaseUrl(apiType, context?.providerKey));
    const credentialValue = String(context?.credentials?.value || '').trim();
    const builtInModels = getBuiltInProviderModels(context?.providerKey, context?.provider, context?.authProfile);

    if (isSmokeTest) {
        if (builtInModels.length) {
            return {
                models: builtInModels,
                source: 'builtin-smoke',
                note: 'Smoke mode: returned built-in auth models.'
            };
        }

        return {
            models: [
                {
                    id: 'smoke-model-1',
                    name: 'smoke-model-1',
                    api: apiType
                },
                {
                    id: 'smoke-model-2',
                    name: 'smoke-model-2',
                    api: apiType,
                    reasoning: true
                }
            ],
            source: 'smoke',
            note: 'Smoke mode: returned mock remote models.'
        };
    }

    if (apiType === 'google-generative-ai') {
        if (!credentialValue) throw new Error('Missing API key');

        const endpoint = new URL(`${baseUrl}/models`);
        endpoint.searchParams.set('key', credentialValue);
        const data = await fetchJsonWithTimeout(endpoint.toString(), {}, 15000);
        return {
            models: (Array.isArray(data?.models) ? data.models : [])
                .map((item) => normalizeRemoteModelItem(item, apiType))
                .filter(Boolean),
            source: 'provider-api',
            note: ''
        };
    }

    if (apiType === 'anthropic-messages') {
        if (!credentialValue) throw new Error('Missing API key');

        const data = await fetchJsonWithTimeout(`${baseUrl}/models`, {
            headers: {
                'x-api-key': credentialValue,
                'anthropic-version': '2023-06-01'
            }
        }, 15000);

        return {
            models: (Array.isArray(data?.data) ? data.data : [])
                .map((item) => normalizeRemoteModelItem(item, apiType))
                .filter(Boolean),
            source: 'provider-api',
            note: ''
        };
    }

    if (isOpenAICodexProvider(context?.providerKey, apiType, context?.authProfile) && context?.credentials?.type === 'oauth') {
        const headers = buildOpenAICodexUsageHeaders(context);
        let remoteError = null;

        try {
            const remoteModels = await trySequentialRequests(getOpenAIBaseCandidates(context?.providerKey, context?.provider), async (candidateBase) => {
                const data = await fetchJsonWithTimeout(`${trimTrailingSlash(candidateBase)}/models`, { headers }, 15000);
                return (Array.isArray(data?.data) ? data.data : [])
                    .map((item) => normalizeRemoteModelItem(item, apiType))
                    .filter(Boolean);
            });

            if (remoteModels.length) {
                return {
                    models: mergeModelEntries(remoteModels, builtInModels, apiType),
                    source: 'provider-api',
                    note: ''
                };
            }
        } catch (error) {
            remoteError = error;
        }

        await probeOpenAICodexUsage(context, builtInModels[0]?.id || 'gpt-5.4', 15000);
        return {
            models: mergeModelEntries(builtInModels, [], apiType),
            source: 'builtin-catalog',
            note: remoteError
                ? 'OpenAI Codex OAuth verified; ChatGPT backend-api does not expose a model catalog, so the built-in Codex catalog was used.'
                : 'OpenAI Codex OAuth verified; returned the built-in Codex catalog.'
        };
    }

    const baseCandidates = getOpenAIBaseCandidates(context?.providerKey, context?.provider);
    const models = await trySequentialRequests(baseCandidates, async (candidateBase) => {
        const headers = {};
        if (credentialValue) {
            headers.Authorization = `Bearer ${credentialValue}`;
        }

        const data = await fetchJsonWithTimeout(`${trimTrailingSlash(candidateBase)}/models`, { headers }, 15000);
        return (Array.isArray(data?.data) ? data.data : [])
            .map((item) => normalizeRemoteModelItem(item, apiType))
            .filter(Boolean);
    });
    return {
        models,
        source: 'provider-api',
        note: ''
    };
}

async function testProviderModelWithContext(context, modelId, timeoutMs = 15000) {
    const providerKey = context?.providerKey || '';
    const provider = context?.provider || {};
    const apiType = normalizeModelApiType(provider.api);
    const baseUrl = trimTrailingSlash(provider.baseUrl || getDefaultModelBaseUrl(apiType, providerKey));
    const credentialValue = String(context?.credentials?.value || '').trim();
    const startedAt = Date.now();

    if ((providerKey === 'openai-codex' || apiType === 'openai-codex-responses') && context?.credentials?.type === 'oauth') {
        return probeOpenAICodexUsage(context, modelId, timeoutMs);
    }

    if (apiType === 'google-generative-ai') {
        if (!credentialValue) throw new Error('Missing API key');

        const endpoint = new URL(`${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`);
        endpoint.searchParams.set('key', credentialValue);
        await fetchJsonWithTimeout(endpoint.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
                generationConfig: { maxOutputTokens: 1 }
            })
        }, timeoutMs);

        return {
            ok: true,
            elapsed: Date.now() - startedAt,
            label: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
        };
    }

    if (apiType === 'anthropic-messages') {
        if (!credentialValue) throw new Error('Missing API key');

        await fetchJsonWithTimeout(`${baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': credentialValue,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: modelId,
                max_tokens: 1,
                messages: [{ role: 'user', content: 'ping' }]
            })
        }, timeoutMs);

        return {
            ok: true,
            elapsed: Date.now() - startedAt,
            label: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
        };
    }

    const baseCandidates = getOpenAIBaseCandidates(providerKey, provider);
    const endpointCandidates = [];

    for (const candidateBase of baseCandidates) {
        const trimmedBase = trimTrailingSlash(candidateBase);
        if (apiType === 'openai-responses' || apiType === 'openai-codex-responses') {
            endpointCandidates.push({
                url: `${trimmedBase}/responses`,
                body: {
                    model: modelId,
                    input: 'ping',
                    max_output_tokens: 1
                }
            });
        }

        endpointCandidates.push({
            url: `${trimmedBase}/chat/completions`,
            body: {
                model: modelId,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1
            }
        });
    }

    await trySequentialRequests(endpointCandidates, async (candidate) => {
        const headers = { 'Content-Type': 'application/json' };
        if (credentialValue) {
            headers.Authorization = `Bearer ${credentialValue}`;
        }

        return fetchJsonWithTimeout(candidate.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(candidate.body)
        }, timeoutMs);
    });

    return {
        ok: true,
        elapsed: Date.now() - startedAt,
        label: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    };
}

let cachedWritableTempDir = '';

function canWriteToDirectory(directoryPath) {
    const target = String(directoryPath || '').trim();
    if (!target) return false;
    try {
        ensureDirectory(target);
        const probePath = path.join(target, `.openclaw-write-test-${process.pid}-${Date.now()}.tmp`);
        fs.writeFileSync(probePath, 'ok', 'utf8');
        fs.unlinkSync(probePath);
        return true;
    } catch (_) {
        return false;
    }
}

function resolveWritableTempDir() {
    if (cachedWritableTempDir && canWriteToDirectory(cachedWritableTempDir)) {
        return cachedWritableTempDir;
    }

    const userHomeDir = String(
        process.env.USERPROFILE
        || (process.env.HOMEDRIVE && process.env.HOMEPATH ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}` : '')
        || os.homedir()
        || ''
    ).trim();
    const localAppDataDir = String(
        process.env.LOCALAPPDATA
        || (userHomeDir ? path.join(userHomeDir, 'AppData', 'Local') : '')
        || ''
    ).trim();

    const candidates = [
        userHomeDir ? path.join(userHomeDir, '.openclaw', 'tmp') : '',
        path.join(openClawHomeDir, 'tmp'),
        localAppDataDir ? path.join(localAppDataDir, 'OpenClaw', 'tmp') : '',
        localAppDataDir ? path.join(localAppDataDir, 'Temp', 'OpenClaw') : ''
    ]
        .map((value) => String(value || '').trim())
        .filter(Boolean);

    for (const candidate of candidates) {
        if (canWriteToDirectory(candidate)) {
            cachedWritableTempDir = candidate;
            return candidate;
        }
    }

    cachedWritableTempDir = path.join(openClawHomeDir, 'tmp');
    ensureDirectory(cachedWritableTempDir);
    return cachedWritableTempDir;
}

function getSafeEnv() {
    const env = { ...process.env };
    const npmGlobalBin = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
    const writableTempDir = resolveWritableTempDir();

    if (env.PATH && !env.PATH.includes(npmGlobalBin)) {
        env.PATH = `${npmGlobalBin};${env.PATH}`;
    }
    if (env.Path && !env.Path.includes(npmGlobalBin)) {
        env.Path = `${npmGlobalBin};${env.Path}`;
    }

    // OpenClaw CLI treats OPENCLAW_HOME as the parent home directory and
    // appends ".openclaw" to derive the state dir. Passing the state dir here
    // makes it look for "<state>\\.openclaw\\openclaw.json", which breaks
    // gateway start, logs --follow, and status probes.
    delete env.OPENCLAW_HOME;
    env.OPENCLAW_STATE_DIR = openClawHomeDir;
    env.OPENCLAW_CONFIG_PATH = configPath;
    env.TMP = writableTempDir;
    env.TEMP = writableTempDir;
    env.TMPDIR = writableTempDir;
    env.TEMPDIR = writableTempDir;
    env.OPENCLAW_TMPDIR = writableTempDir;
    env.CLAWDBOT_TMPDIR = writableTempDir;
    if (!env.CODEX_HOME) {
        env.CODEX_HOME = path.join(os.homedir(), '.codex');
    }
    return env;
}

function runHiddenSync(command, args = [], options = {}) {
    return spawnSync(command, args, {
        windowsHide: true,
        encoding: 'utf8',
        ...options
    });
}

function collectStdoutLines(result) {
    return String(result?.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function resolveNodeExecutableSync() {
    const candidates = [];
    const seen = new Set();

    const pushCandidate = (candidate) => {
        const value = String(candidate || '').trim();
        if (!value) return;
        const resolved = path.resolve(value);
        if (seen.has(resolved)) return;
        seen.add(resolved);
        candidates.push(resolved);
    };

    try {
        collectStdoutLines(runHiddenSync('where', ['node'])).forEach(pushCandidate);
    } catch (_) {}

    pushCandidate(path.join(process.env.ProgramFiles || '', 'nodejs', 'node.exe'));
    pushCandidate(path.join(process.env['ProgramFiles(x86)'] || '', 'nodejs', 'node.exe'));
    pushCandidate(path.join(path.dirname(process.execPath || ''), 'node.exe'));

    for (const root of resolvePackagedInstallRootsSync()) {
        pushCandidate(path.join(root, 'node.exe'));
        pushCandidate(path.join(root, 'bin', 'node.exe'));
    }

    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function resolvePm2CliSync() {
    const candidates = [];
    const seen = new Set();

    const pushCandidate = (candidate) => {
        const value = String(candidate || '').trim();
        if (!value) return;
        const resolved = path.resolve(value);
        if (seen.has(resolved)) return;
        seen.add(resolved);
        candidates.push(resolved);
    };

    pushCandidate(path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'pm2', 'bin', 'pm2'));
    pushCandidate(path.join(process.env.ProgramFiles || '', 'nodejs', 'node_modules', 'pm2', 'bin', 'pm2'));
    pushCandidate(path.join(process.env['ProgramFiles(x86)'] || '', 'nodejs', 'node_modules', 'pm2', 'bin', 'pm2'));
    pushCandidate(path.join(path.dirname(process.execPath || ''), 'node_modules', 'pm2', 'bin', 'pm2'));

    for (const root of resolvePackagedInstallRootsSync()) {
        pushCandidate(path.join(root, 'node_modules', 'pm2', 'bin', 'pm2'));
        pushCandidate(path.join(root, 'bin', 'pm2'));
    }

    try {
        collectStdoutLines(runHiddenSync('where', ['pm2'])).forEach((match) => {
            pushCandidate(path.join(path.dirname(match), 'node_modules', 'pm2', 'bin', 'pm2'));
        });
    } catch (_) {}

    try {
        const npmRoot = collectStdoutLines(runHiddenSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm root -g'], {
            env: getSafeEnv()
        }))[0];
        if (npmRoot) {
            pushCandidate(path.join(npmRoot, 'pm2', 'bin', 'pm2'));
        }
    } catch (_) {}

    try {
        const npmPrefix = collectStdoutLines(runHiddenSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm config get prefix'], {
            env: getSafeEnv()
        }))[0];
        if (npmPrefix) {
            pushCandidate(path.join(npmPrefix, 'node_modules', 'pm2', 'bin', 'pm2'));
        }
    } catch (_) {}

    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function pushUniqueValue(bucket, seen, candidate) {
    const value = String(candidate || '').trim();
    if (!value) return;
    const normalized = /[\\/]/.test(value) || /^[a-zA-Z]:/.test(value)
        ? path.resolve(value)
        : value;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    bucket.push(normalized);
}

function rankWindowsCommandMatch(candidate, commandName = '') {
    if (process.platform !== 'win32') return 0;
    const target = String(commandName || '').trim().toLowerCase();
    const normalized = String(candidate || '').trim().toLowerCase();
    const ext = path.extname(normalized);
    let score = 0;

    if (target && normalized.endsWith(`\\${target}.cmd`)) score += 200;
    else if (target && normalized.endsWith(`\\${target}.exe`)) score += 180;
    else if (target && normalized.endsWith(`\\${target}.bat`)) score += 160;
    else if (target && normalized.endsWith(`\\${target}`)) score += 40;

    if (ext === '.cmd') score += 120;
    else if (ext === '.exe') score += 100;
    else if (ext === '.bat') score += 80;
    else if (ext === '.com') score += 60;
    else if (!ext) score += 10;

    return score;
}

function resolveCommandMatchesSync(commandName) {
    const matches = [];
    const seen = new Set();
    const command = String(commandName || '').trim();
    if (!command) return matches;

    try {
        collectStdoutLines(runHiddenSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `where ${command}`], {
            env: getSafeEnv()
        })).forEach((match) => {
            if (fs.existsSync(match)) {
                pushUniqueValue(matches, seen, match);
            }
        });
    } catch (_) {}

    if (process.platform === 'win32' && matches.length > 1) {
        matches.sort((left, right) => rankWindowsCommandMatch(right, command) - rankWindowsCommandMatch(left, command));
    }

    return matches;
}

function resolveNpmGlobalWrapperDirsSync() {
    const dirs = [];
    const seen = new Set();

    pushUniqueValue(dirs, seen, path.join(process.env.APPDATA || '', 'npm'));

    try {
        const npmRoot = collectStdoutLines(runHiddenSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm root -g'], {
            env: getSafeEnv()
        }))[0];
        if (npmRoot) {
            pushUniqueValue(dirs, seen, path.dirname(npmRoot));
        }
    } catch (_) {}

    try {
        const npmPrefix = collectStdoutLines(runHiddenSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm config get prefix'], {
            env: getSafeEnv()
        }))[0];
        if (npmPrefix) {
            pushUniqueValue(dirs, seen, npmPrefix);
        }
    } catch (_) {}

    return dirs.filter((dirPath) => fs.existsSync(dirPath));
}

function resolveNpmGlobalModuleRootsSync() {
    const roots = [];
    const seen = new Set();

    try {
        const npmRoot = collectStdoutLines(runHiddenSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm root -g'], {
            env: getSafeEnv()
        }))[0];
        if (npmRoot) {
            pushUniqueValue(roots, seen, npmRoot);
        }
    } catch (_) {}

    for (const wrapperDir of resolveNpmGlobalWrapperDirsSync()) {
        pushUniqueValue(roots, seen, path.join(wrapperDir, 'node_modules'));
    }

    return roots.filter((dirPath) => fs.existsSync(dirPath));
}

function resolveExistingDriveRootsSync() {
    const roots = [];
    const seen = new Set();
    const preferredRoots = [
        process.env.SystemDrive ? `${String(process.env.SystemDrive).replace(/[\\/]+$/, '')}\\` : '',
        'C:\\',
        'D:\\',
        'E:\\',
        'F:\\',
        'G:\\',
        'Z:\\'
    ];

    for (const root of preferredRoots) {
        const value = String(root || '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        if (fs.existsSync(value)) {
            roots.push(value);
        }
    }

    return roots;
}

function resolvePackagedInstallRootsSync() {
    const roots = [];
    const seen = new Set();
    const candidates = [
        process.resourcesPath || '',
        path.dirname(process.resourcesPath || ''),
        path.dirname(process.execPath || '')
    ];

    for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (!value || seen.has(value) || !fs.existsSync(value)) continue;
        seen.add(value);
        roots.push(value);
    }

    return roots;
}

function extractOpenClawPackageNameFromText(text = '') {
    const match = String(text || '')
        .replace(/\\/g, '/')
        .match(/(?:^|\/)node_modules\/(openclaw(?:-cn)?)(?:\/|$)/i);
    return match ? String(match[1] || '').toLowerCase() : '';
}

function resolveCandidatePath(baseDir, inputPath) {
    const value = String(inputPath || '').trim();
    if (!value) return '';
    if (path.isAbsolute(value)) return path.resolve(value);
    if (!baseDir) return '';
    return path.resolve(baseDir, value);
}

function normalizePm2Args(rawArgs) {
    if (Array.isArray(rawArgs)) {
        return rawArgs.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (rawArgs === undefined || rawArgs === null) return [];
    return [String(rawArgs).trim()].filter(Boolean);
}

function normalizePm2AppDescriptor(rawApp, options = {}) {
    if (!rawApp || typeof rawApp !== 'object') return null;

    const pm2Env = rawApp.pm2_env && typeof rawApp.pm2_env === 'object' ? rawApp.pm2_env : {};
    const env = pm2Env.env && typeof pm2Env.env === 'object' ? pm2Env.env : {};
    const argsList = normalizePm2Args(rawApp.args ?? pm2Env.args);
    const cwdValue = String(rawApp.cwd || pm2Env.pm_cwd || pm2Env.cwd || env.PWD || '').trim();
    const cwd = cwdValue ? path.resolve(cwdValue) : '';
    const configPath = resolveCandidatePath(cwd || options.configDir || '', rawApp.configPath || pm2Env.pm_conf || '');
    const serviceDir = cwd || (configPath ? path.dirname(configPath) : '');
    const outLogPath = resolveCandidatePath(serviceDir, rawApp.out_file || pm2Env.pm_out_log_path || '');
    const errLogPath = resolveCandidatePath(serviceDir, rawApp.error_file || pm2Env.pm_err_log_path || '');
    const serviceStartup = resolveCandidatePath(serviceDir, env.SERVICE_STARTUP_VBS || '');
    const startupFolder = String(env.STARTUP_DIR || startupFolderPath || '').trim() || startupFolderPath;
    const startupVbs = resolveCandidatePath(startupFolder, env.STARTUP_VBS || '') || startupVbsPath;
    const name = String(rawApp.name || pm2Env.name || '').trim();
    const script = String(rawApp.script || pm2Env.pm_exec_path || '').trim();
    const signalText = [
        name,
        cwd,
        script,
        argsList.join(' '),
        outLogPath,
        errLogPath,
        serviceStartup,
        JSON.stringify(env)
    ].join(' ');

    return {
        name,
        cwd,
        configPath,
        serviceDir,
        outLogPath,
        errLogPath,
        serviceStartupVbsPath: serviceStartup || (serviceDir ? path.join(serviceDir, 'OpenClawSilent.vbs') : ''),
        startupFolderPath: startupFolder,
        startupVbsPath: startupVbs,
        script,
        argsList,
        signalText,
        cliPackageName: extractOpenClawPackageNameFromText(signalText),
        env
    };
}

function scoreOpenClawPm2Descriptor(descriptor) {
    if (!descriptor) return -1;
    const signal = String(descriptor.signalText || '').toLowerCase();
    let score = 0;

    if (signal.includes('openclaw')) score += 12;
    if (signal.includes('openclaw-cn')) score += 4;
    if (/\bgateway\b/.test(signal)) score += 8;
    if (String(descriptor.name || '').toLowerCase().includes('gateway')) score += 10;
    if (descriptor.configPath) score += 4;
    if (descriptor.serviceDir) score += 3;
    if (descriptor.outLogPath || descriptor.errLogPath) score += 2;

    return score;
}

function pickBestOpenClawPm2Descriptor(descriptors = []) {
    let best = null;
    let bestScore = -1;

    for (const descriptor of descriptors) {
        const score = scoreOpenClawPm2Descriptor(descriptor);
        if (score > bestScore) {
            best = descriptor;
            bestScore = score;
        }
    }

    return bestScore > 0 ? best : null;
}

function readPm2SnapshotAppsSync(nodeExe, pm2Cli) {
    if (!nodeExe || !pm2Cli) return [];
    try {
        const result = runHiddenSync(nodeExe, [pm2Cli, 'jlist'], {
            env: getSafeEnv()
        });
        if (result.status !== 0) return [];
        const payload = String(result.stdout || '').trim();
        if (!payload) return [];
        const apps = JSON.parse(payload);
        return Array.isArray(apps) ? apps : [];
    } catch (_) {
        return [];
    }
}

function readPm2DumpAppsSync() {
    const dumpPath = path.join(os.homedir(), '.pm2', 'dump.pm2');
    if (!fs.existsSync(dumpPath)) return [];
    try {
        const payload = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
        return Array.isArray(payload) ? payload : [];
    } catch (_) {
        return [];
    }
}

function loadCommonJsModuleSync(filePath) {
    const resolvedPath = require.resolve(filePath);
    delete require.cache[resolvedPath];
    const loaded = require(resolvedPath);
    delete require.cache[resolvedPath];
    return loaded;
}

function loadPm2EcosystemDescriptorSync(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;

    try {
        const payload = loadCommonJsModuleSync(filePath);
        const apps = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.apps)
                ? payload.apps
                : [];
        if (!apps.length) return null;

        const configDir = path.dirname(filePath);
        const descriptors = apps
            .map((appConfig) => normalizePm2AppDescriptor({
                ...appConfig,
                configPath: filePath
            }, { configDir }))
            .filter(Boolean);
        const best = pickBestOpenClawPm2Descriptor(descriptors);
        if (!best) return null;

        return {
            ...best,
            configPath: path.resolve(filePath),
            source: 'ecosystem-config'
        };
    } catch (_) {
        return null;
    }
}

function collectPm2ConfigCandidatesSync(seedDescriptors = []) {
    const candidates = [];
    const seen = new Set();
    const preferredPm2ServiceDir = path.join(openClawHomeDir, 'pm2-service');
    const defaultWindowsServiceDir = process.platform === 'win32' ? 'C:\\openclaw-service' : '';

    if (process.env.OPENCLAW_PM2_CONFIG_PATH) {
        pushUniqueValue(candidates, seen, process.env.OPENCLAW_PM2_CONFIG_PATH);
    }

    pushUniqueValue(candidates, seen, path.join(preferredPm2ServiceDir, 'ecosystem.config.js'));
    pushUniqueValue(candidates, seen, path.join(preferredPm2ServiceDir, 'OpenClawSilent.vbs'));

    if (defaultWindowsServiceDir) {
        pushUniqueValue(candidates, seen, path.join(defaultWindowsServiceDir, 'ecosystem.config.js'));
        pushUniqueValue(candidates, seen, path.join(defaultWindowsServiceDir, 'OpenClawSilent.vbs'));
    }

    for (const root of resolvePackagedInstallRootsSync()) {
        pushUniqueValue(candidates, seen, path.join(root, 'ecosystem.config.js'));
        pushUniqueValue(candidates, seen, path.join(root, 'openclaw-service', 'ecosystem.config.js'));
        pushUniqueValue(candidates, seen, path.join(root, 'OpenClawSilent.vbs'));
        pushUniqueValue(candidates, seen, path.join(root, 'openclaw-service', 'OpenClawSilent.vbs'));
        try {
            const entries = fs.readdirSync(root, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (!/openclaw|service/i.test(entry.name)) continue;
                pushUniqueValue(candidates, seen, path.join(root, entry.name, 'ecosystem.config.js'));
                pushUniqueValue(candidates, seen, path.join(root, entry.name, 'OpenClawSilent.vbs'));
            }
        } catch (_) {}
    }

    for (const descriptor of seedDescriptors) {
        if (!descriptor) continue;
        if (descriptor.configPath) {
            pushUniqueValue(candidates, seen, descriptor.configPath);
        }
        if (descriptor.serviceDir) {
            pushUniqueValue(candidates, seen, path.join(descriptor.serviceDir, 'ecosystem.config.js'));
        }
        if (descriptor.serviceStartupVbsPath) {
            pushUniqueValue(candidates, seen, path.join(path.dirname(descriptor.serviceStartupVbsPath), 'ecosystem.config.js'));
        }
        if (descriptor.outLogPath) {
            pushUniqueValue(candidates, seen, path.join(path.dirname(descriptor.outLogPath), 'ecosystem.config.js'));
        }
        if (descriptor.errLogPath) {
            pushUniqueValue(candidates, seen, path.join(path.dirname(descriptor.errLogPath), 'ecosystem.config.js'));
        }
    }

    for (const root of resolveExistingDriveRootsSync()) {
        try {
            const entries = fs.readdirSync(root, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (!/openclaw/i.test(entry.name)) continue;
                pushUniqueValue(candidates, seen, path.join(root, entry.name, 'ecosystem.config.js'));
            }
        } catch (_) {}
    }

    return candidates.filter((candidate) => fs.existsSync(candidate));
}

function inferCliVariantFromModuleRootsSync() {
    const roots = resolveNpmGlobalModuleRootsSync();
    for (const root of roots) {
        if (fs.existsSync(path.join(root, 'openclaw-cn'))) {
            return 'openclaw-cn';
        }
    }
    for (const root of roots) {
        if (fs.existsSync(path.join(root, 'openclaw'))) {
            return 'openclaw';
        }
    }
    return '';
}

function resolvePm2ServiceRuntimeSync(options = {}) {
    const requireConfig = options.requireConfig !== false;
    const allowCache = options.refresh !== true;

    if (allowCache && cachedPm2ServiceRuntime?.ok) {
        const cached = cachedPm2ServiceRuntime;
        if (!requireConfig || cached.configPath) {
            return cached;
        }
    }

    const nodeExe = resolveNodeExecutableSync();
    const pm2Cli = resolvePm2CliSync();
    const liveDescriptor = pickBestOpenClawPm2Descriptor(readPm2SnapshotAppsSync(nodeExe, pm2Cli).map((app) => normalizePm2AppDescriptor(app)).filter(Boolean));
    const dumpDescriptor = pickBestOpenClawPm2Descriptor(readPm2DumpAppsSync().map((app) => normalizePm2AppDescriptor(app)).filter(Boolean));
    const seedDescriptors = [liveDescriptor, dumpDescriptor].filter(Boolean);

    let bestDescriptor = liveDescriptor || dumpDescriptor || null;
    const configCandidates = collectPm2ConfigCandidatesSync(seedDescriptors);
    for (const candidate of configCandidates) {
        const descriptor = loadPm2EcosystemDescriptorSync(candidate);
        if (descriptor) {
            bestDescriptor = descriptor;
            break;
        }
    }

    if (!bestDescriptor) {
        return {
            ok: false,
            error: 'OpenClaw PM2 service config or running instance was not detected.'
        };
    }

    const serviceDir = bestDescriptor.serviceDir
        || (bestDescriptor.configPath ? path.dirname(bestDescriptor.configPath) : '')
        || (bestDescriptor.outLogPath ? path.dirname(bestDescriptor.outLogPath) : '')
        || (bestDescriptor.errLogPath ? path.dirname(bestDescriptor.errLogPath) : '');

    const runtime = {
        ok: !requireConfig || Boolean(bestDescriptor.configPath),
        nodeExe,
        pm2Cli,
        appName: bestDescriptor.name || 'openclaw-gateway',
        configPath: bestDescriptor.configPath || (serviceDir ? path.join(serviceDir, 'ecosystem.config.js') : ''),
        serviceDir,
        outLogPath: bestDescriptor.outLogPath || (serviceDir ? path.join(serviceDir, 'out.log') : ''),
        errLogPath: bestDescriptor.errLogPath || (serviceDir ? path.join(serviceDir, 'error.log') : ''),
        serviceStartupVbsPath: bestDescriptor.serviceStartupVbsPath || (serviceDir ? path.join(serviceDir, 'OpenClawSilent.vbs') : ''),
        startupFolderPath: bestDescriptor.startupFolderPath || startupFolderPath,
        startupVbsPath: bestDescriptor.startupVbsPath || startupVbsPath,
        cliPackageName: bestDescriptor.cliPackageName || inferCliVariantFromModuleRootsSync(),
        source: bestDescriptor.source || 'pm2-runtime'
    };

    if (requireConfig && !runtime.configPath) {
        runtime.ok = false;
        runtime.error = 'OpenClaw PM2 ecosystem.config.js was not found.';
    }

    if (runtime.ok) {
        cachedPm2ServiceRuntime = runtime;
    }

    return runtime;
}

function resolveOpenClawCliSync(options = {}) {
    const allowCache = options.refresh !== true;
    if (allowCache && cachedOpenClawCli?.commandPath && fs.existsSync(cachedOpenClawCli.commandPath)) {
        return cachedOpenClawCli;
    }

    const candidates = [];
    const seen = new Set();
    const runtimeVariant = resolvePm2ServiceRuntimeSync({ requireConfig: false }).cliPackageName;
    const preferredVariant = String(process.env.OPENCLAW_CLI_VARIANT || '').trim().toLowerCase()
        || runtimeVariant
        || inferCliVariantFromModuleRootsSync();
    const preferredCommands = preferredVariant === 'openclaw'
        ? ['openclaw', 'openclaw-cn']
        : ['openclaw-cn', 'openclaw'];

    if (process.env.OPENCLAW_CLI_BIN) {
        const envCli = String(process.env.OPENCLAW_CLI_BIN).trim();
        if (fs.existsSync(envCli)) {
            pushUniqueValue(candidates, seen, envCli);
        } else {
            resolveCommandMatchesSync(envCli).forEach((match) => pushUniqueValue(candidates, seen, match));
        }
    }

    for (const commandName of preferredCommands) {
        resolveCommandMatchesSync(commandName).forEach((match) => pushUniqueValue(candidates, seen, match));
    }

    for (const root of resolvePackagedInstallRootsSync()) {
        for (const commandName of preferredCommands) {
            pushUniqueValue(candidates, seen, path.join(root, `${commandName}.cmd`));
            pushUniqueValue(candidates, seen, path.join(root, commandName));
            pushUniqueValue(candidates, seen, path.join(root, 'bin', `${commandName}.cmd`));
            pushUniqueValue(candidates, seen, path.join(root, 'bin', commandName));
        }
    }

    for (const wrapperDir of resolveNpmGlobalWrapperDirsSync()) {
        for (const commandName of preferredCommands) {
            pushUniqueValue(candidates, seen, path.join(wrapperDir, `${commandName}.cmd`));
            pushUniqueValue(candidates, seen, path.join(wrapperDir, commandName));
        }
    }

    const commandPath = candidates.find((candidate) => fs.existsSync(candidate)) || '';
    const commandBaseName = commandPath
        ? path.basename(commandPath).replace(/\.(cmd|bat|exe|com)$/i, '').toLowerCase()
        : '';
    const displayName = commandBaseName === 'openclaw-cn'
        ? 'openclaw-cn'
        : commandBaseName === 'openclaw'
            ? 'openclaw'
            : preferredVariant === 'openclaw-cn'
                ? 'openclaw-cn'
                : 'openclaw';
    const descriptor = {
        commandPath,
        displayName,
        packageName: preferredVariant || displayName
    };

    if (commandPath) {
        cachedOpenClawCli = descriptor;
    }

    return descriptor;
}

function formatOpenClawCliDisplayCommand(args = []) {
    const cli = resolveOpenClawCliSync();
    return [cli.displayName || 'openclaw', ...(args || []).map((item) => String(item))].join(' ');
}

function resolveNpmDashboardRuntime(options = {}) {
    const requireConfig = options.requireConfig !== false;
    const requirePm2 = options.requirePm2 !== false;

    const nodeExe = resolveNodeExecutableSync();
    if (!nodeExe) {
        return { ok: false, error: 'node.exe was not found. Please confirm Node.js is installed.' };
    }

    let pm2Cli = '';
    if (requirePm2) {
        pm2Cli = resolvePm2CliSync();
        if (!pm2Cli) {
            return { ok: false, error: 'PM2 CLI was not found. Please confirm pm2 is installed.' };
        }
    }

    const serviceRuntime = resolvePm2ServiceRuntimeSync({ requireConfig });
    if (!serviceRuntime.ok) {
        return {
            ok: false,
            error: serviceRuntime.error || 'OpenClaw PM2 runtime config was not detected.'
        };
    }

    return {
        ok: true,
        nodeExe,
        pm2Cli,
        appName: serviceRuntime.appName,
        configPath: serviceRuntime.configPath,
        outLogPath: serviceRuntime.outLogPath,
        errLogPath: serviceRuntime.errLogPath,
        serviceStartupVbsPath: serviceRuntime.serviceStartupVbsPath,
        startupFolderPath: serviceRuntime.startupFolderPath || startupFolderPath,
        startupVbsPath: serviceRuntime.startupVbsPath || startupVbsPath,
        cliPackageName: serviceRuntime.cliPackageName
    };
}

function createNodeRunnerSpawnRequest(nodeExe, scriptPath, scriptArgs = [], extraEnv = {}) {
    return {
        command: nodeExe,
        args: [scriptPath, ...scriptArgs],
        options: {
            cwd: extraEnv.OPENCLAW_SERVICE_DIR || openClawHomeDir,
            windowsHide: true,
            env: {
                ...getSafeEnv(),
                ...extraEnv
            }
        }
    };
}

function resolveDashboardRunnerScriptPathSync() {
    const candidates = [];
    const pushCandidate = (candidate) => {
        const value = String(candidate || '').trim();
        if (!value) return;
        const resolved = path.resolve(value);
        if (process.platform === 'win32' && /[\\/]app\.asar[\\/]/i.test(resolved)) {
            candidates.push(path.resolve(resolved.replace(/[\\/]app\.asar([\\/])/i, `${path.sep}app.asar.unpacked$1`)));
            return;
        }
        candidates.push(resolved);
    };

    const execDir = path.dirname(process.execPath || '');
    const preferUnpacked = app.isPackaged && process.platform === 'win32';

    if (preferUnpacked) {
        if (process.resourcesPath) {
            pushCandidate(path.join(process.resourcesPath, 'app.asar.unpacked', 'npm-dashboard-runner.js'));
            pushCandidate(path.join(process.resourcesPath, 'app.asar.unpacked', 'npm-dashboard-runner.cmd'));
            pushCandidate(path.join(process.resourcesPath, 'npm-dashboard-runner.js'));
            pushCandidate(path.join(process.resourcesPath, 'npm-dashboard-runner.cmd'));
        }

        pushCandidate(path.join(execDir, 'app.asar.unpacked', 'npm-dashboard-runner.js'));
        pushCandidate(path.join(execDir, 'app.asar.unpacked', 'npm-dashboard-runner.cmd'));
        pushCandidate(path.join(execDir, 'npm-dashboard-runner.js'));
        pushCandidate(path.join(execDir, 'npm-dashboard-runner.cmd'));
    }

    pushCandidate(path.join(__dirname, 'npm-dashboard-runner.js'));

    if (!preferUnpacked && process.resourcesPath) {
        pushCandidate(path.join(process.resourcesPath, 'app.asar.unpacked', 'npm-dashboard-runner.js'));
        pushCandidate(path.join(process.resourcesPath, 'app.asar.unpacked', 'npm-dashboard-runner.cmd'));
        pushCandidate(path.join(process.resourcesPath, 'npm-dashboard-runner.js'));
        pushCandidate(path.join(process.resourcesPath, 'npm-dashboard-runner.cmd'));
    }

    if (!preferUnpacked) {
        pushCandidate(path.join(execDir, 'app.asar.unpacked', 'npm-dashboard-runner.js'));
        pushCandidate(path.join(execDir, 'app.asar.unpacked', 'npm-dashboard-runner.cmd'));
        pushCandidate(path.join(execDir, 'npm-dashboard-runner.js'));
        pushCandidate(path.join(execDir, 'npm-dashboard-runner.cmd'));
    }

    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function resolveDashboardRunnerCmdPathSync() {
    const candidates = [];
    const pushCandidate = (candidate) => {
        const value = String(candidate || '').trim();
        if (!value) return;
        const resolved = path.resolve(value);
        if (process.platform === 'win32' && /[\\/]app\.asar[\\/]/i.test(resolved)) {
            candidates.push(path.resolve(resolved.replace(/[\\/]app\.asar([\\/])/i, `${path.sep}app.asar.unpacked$1`)));
            return;
        }
        candidates.push(resolved);
    };

    const execDir = path.dirname(process.execPath || '');
    const preferUnpacked = app.isPackaged && process.platform === 'win32';

    if (preferUnpacked) {
        if (process.resourcesPath) {
            pushCandidate(path.join(process.resourcesPath, 'app.asar.unpacked', 'npm-dashboard-runner.cmd'));
            pushCandidate(path.join(process.resourcesPath, 'npm-dashboard-runner.cmd'));
        }

        pushCandidate(path.join(execDir, 'app.asar.unpacked', 'npm-dashboard-runner.cmd'));
        pushCandidate(path.join(execDir, 'npm-dashboard-runner.cmd'));
    }

    pushCandidate(path.join(__dirname, 'npm-dashboard-runner.cmd'));

    if (!preferUnpacked && process.resourcesPath) {
        pushCandidate(path.join(process.resourcesPath, 'app.asar.unpacked', 'npm-dashboard-runner.cmd'));
        pushCandidate(path.join(process.resourcesPath, 'npm-dashboard-runner.cmd'));
    }

    if (!preferUnpacked) {
        pushCandidate(path.join(execDir, 'app.asar.unpacked', 'npm-dashboard-runner.cmd'));
        pushCandidate(path.join(execDir, 'npm-dashboard-runner.cmd'));
    }

    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function createCmdRunnerSpawnRequest(scriptPath, scriptArgs = [], extraEnv = {}) {
    const commandLine = [
        'call',
        quoteWindowsCmdArg(scriptPath),
        ...scriptArgs.map(quoteWindowsCmdArg)
    ].join(' ');

    return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', commandLine],
        options: {
            cwd: extraEnv.OPENCLAW_SERVICE_DIR || openClawHomeDir,
            windowsHide: true,
            env: {
                ...getSafeEnv(),
                ...extraEnv
            }
        }
    };
}

function buildNpmDashboardActionRequest(action) {
    const runtime = resolveNpmDashboardRuntime({
        requireConfig: action === 'start' || action === 'restart',
        requirePm2: action !== 'disable-autostart'
    });

    const previewByAction = runtime.ok ? {
        start: `pm2 start ${quoteWindowsCmdArg(runtime.configPath)} --only ${quoteWindowsCmdArg(runtime.appName)}`,
        stop: 'pm2 stop <all OpenClaw apps> && pm2 delete <all OpenClaw apps>',
        restart: `pm2 stop <all OpenClaw apps> && pm2 delete <all OpenClaw apps> && pm2 start ${quoteWindowsCmdArg(runtime.configPath)} --only ${quoteWindowsCmdArg(runtime.appName)} && pm2 save --force`,
        'enable-autostart': `copy /y ${quoteWindowsCmdArg(runtime.serviceStartupVbsPath)} ${quoteWindowsCmdArg(runtime.startupVbsPath)}`,
        'disable-autostart': `del /f /q ${quoteWindowsCmdArg(runtime.startupVbsPath)}`,
        'list-tasks': 'pm2 list'
    } : {};

    const actionConfig = {
        start: {
            previewCommand: previewByAction.start || 'pm2 start <ecosystem.config.js> --only <openclaw-gateway>',
            timeoutMs: 120000,
            cmdRunnerArgs: ['--start-once'],
            nodeRunnerArgs: ['start']
        },
        stop: {
            previewCommand: previewByAction.stop || 'pm2 stop <all OpenClaw apps> && pm2 delete <all OpenClaw apps>',
            timeoutMs: 120000,
            cmdRunnerArgs: ['--stop-once'],
            nodeRunnerArgs: ['stop']
        },
        restart: {
            previewCommand: previewByAction.restart || 'pm2 stop <all OpenClaw apps> && pm2 delete <all OpenClaw apps> && pm2 start <ecosystem.config.js> --only <openclaw-gateway> && pm2 save --force',
            timeoutMs: 180000,
            cmdRunnerArgs: ['--restart-once'],
            nodeRunnerArgs: ['restart']
        },
        'enable-autostart': {
            previewCommand: previewByAction['enable-autostart'] || 'copy /y <OpenClawSilent.vbs> <Startup\\OpenClawSilent.vbs>',
            timeoutMs: 30000,
            cmdRunnerArgs: ['--enable-autostart-once'],
            nodeRunnerArgs: ['enable-autostart']
        },
        'disable-autostart': {
            previewCommand: previewByAction['disable-autostart'] || 'del /f /q <Startup\\OpenClawSilent.vbs>',
            timeoutMs: 30000,
            cmdRunnerArgs: ['--disable-autostart-once'],
            nodeRunnerArgs: ['disable-autostart']
        },
        'list-tasks': {
            previewCommand: previewByAction['list-tasks'] || 'pm2 list',
            timeoutMs: 60000,
            cmdRunnerArgs: ['--list-once'],
            nodeRunnerArgs: ['list-tasks']
        }
    }[action];

    if (!actionConfig) return null;
    if (!runtime.ok) {
        return {
            mode: 'npm',
            action,
            previewCommand: actionConfig.previewCommand,
            error: runtime.error
        };
    }

    const runnerScriptPath = resolveDashboardRunnerScriptPathSync();
    const runnerCmdPath = resolveDashboardRunnerCmdPathSync();
    const useNodeRunner = Boolean(runnerScriptPath && /\.js$/i.test(runnerScriptPath));
    const runnerPath = useNodeRunner ? runnerScriptPath : runnerCmdPath;
    if (!runnerPath) {
        return {
            mode: 'npm',
            action,
            previewCommand: actionConfig.previewCommand,
            error: '未找到 npm dashboard runner.js 或 runner.cmd'
        };
    }
    const spawnRequest = useNodeRunner
        ? createNodeRunnerSpawnRequest(runtime.nodeExe, runnerPath, actionConfig.nodeRunnerArgs, {
            OPENCLAW_NODE_EXE: runtime.nodeExe,
            OPENCLAW_PM2_CLI: runtime.pm2Cli,
            OPENCLAW_PM2_APP_NAME: runtime.appName,
            OPENCLAW_PM2_CONFIG_PATH: runtime.configPath,
            OPENCLAW_PM2_OUT_LOG: runtime.outLogPath,
            OPENCLAW_PM2_ERR_LOG: runtime.errLogPath,
            OPENCLAW_SERVICE_STARTUP_VBS: runtime.serviceStartupVbsPath,
            OPENCLAW_STARTUP_DIR: runtime.startupFolderPath,
            OPENCLAW_STARTUP_VBS: runtime.startupVbsPath,
            OPENCLAW_SERVICE_DIR: runtime.serviceDir,
            OPENCLAW_CLI_BIN: resolveOpenClawCliSync().commandPath || '',
            OPENCLAW_CLI_VARIANT: runtime.cliPackageName || ''
        })
        : createCmdRunnerSpawnRequest(runnerPath, actionConfig.cmdRunnerArgs, {
            OPENCLAW_NODE_EXE: runtime.nodeExe,
            OPENCLAW_PM2_CLI: runtime.pm2Cli,
            OPENCLAW_PM2_APP_NAME: runtime.appName,
            OPENCLAW_PM2_CONFIG_PATH: runtime.configPath,
            OPENCLAW_PM2_OUT_LOG: runtime.outLogPath,
            OPENCLAW_PM2_ERR_LOG: runtime.errLogPath,
            OPENCLAW_SERVICE_STARTUP_VBS: runtime.serviceStartupVbsPath,
            OPENCLAW_STARTUP_DIR: runtime.startupFolderPath,
            OPENCLAW_STARTUP_VBS: runtime.startupVbsPath,
            OPENCLAW_SERVICE_DIR: runtime.serviceDir,
            OPENCLAW_CLI_BIN: resolveOpenClawCliSync().commandPath || '',
            OPENCLAW_CLI_VARIANT: runtime.cliPackageName || ''
        });

    return {
        mode: 'npm',
        action,
        previewCommand: actionConfig.previewCommand,
        spawnRequest,
        timeoutMs: actionConfig.timeoutMs,
        encoding: 'utf8'
    };
}

function stripAnsi(text) {
    const pattern = [
        '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
        '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))'
    ].join('|');
    return String(text || '').replace(new RegExp(pattern, 'g'), '');
}

const COMMON_CHINESE_TEXT_CHARS = new Set(Array.from(
    '的一是在不了有人和这中大为上个国我以要他时来到用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处理世车做给北保造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞。，“”‘’：；！？（）【】《》、·—'
));
const UTF8_MOJIBAKE_LATIN_PATTERN = /[ÃÂâ€]/g;

function scoreChineseReadability(text) {
    const value = String(text || '');
    let score = 0;
    for (const char of value) {
        if (COMMON_CHINESE_TEXT_CHARS.has(char)) {
            score += 2;
        } else if (/[\u4e00-\u9fff]/.test(char)) {
            score += 1;
        }
    }
    const latinArtifacts = value.match(UTF8_MOJIBAKE_LATIN_PATTERN);
    if (latinArtifacts) {
        score -= latinArtifacts.length * 3;
    }
    if (value.includes('�')) {
        score -= 6;
    }
    return score;
}

function repairLikelyUtf8Mojibake(text) {
    const input = String(text || '');
    if (!input) return input;

    try {
        const repaired = iconv.decode(iconv.encode(input, 'gbk'), 'utf8');
        if (!repaired || repaired === input) return input;
        return scoreChineseReadability(repaired) > scoreChineseReadability(input) ? repaired : input;
    } catch (_) {
        return input;
    }
}

function normalizeDecodedOutput(text, encoding = 'utf8') {
    const preferred = String(encoding || 'utf8').trim().toLowerCase();
    const cleaned = stripAnsi(String(text || '')).replace(/\uFEFF/g, '').replace(/\u0000/g, '');
    if (!cleaned) return '';
    if (preferred && !/^utf-?8$/i.test(preferred)) {
        return cleaned;
    }
    return repairLikelyUtf8Mojibake(cleaned);
}

function parseCommand(command) {
    const parts = String(command || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const args = parts.map(item => item.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1'));
    const binary = args.shift();
    return { binary, args };
}

function shouldUseShell(binary) {
    if (process.platform !== 'win32') return false;
    if (/\.(cmd|bat|ps1)$/i.test(binary)) return true;
    if (/\.(exe|com)$/i.test(binary)) return false;
    return true;
}

function quoteWindowsCmdArg(value) {
    const text = String(value ?? '');
    if (!text) return '""';
    if (!/[\s"&()^<>|]/.test(text)) return text;
    return `"${text.replace(/(["^])/g, '^$1')}"`;
}

function buildSpawnRequest(binary, args) {
    const env = getSafeEnv();
    if (process.platform === 'win32' && shouldUseShell(binary)) {
        const commandLine = [binary, ...(args || [])].map(quoteWindowsCmdArg).join(' ');
        return {
            command: process.env.ComSpec || 'cmd.exe',
            args: ['/d', '/s', '/c', commandLine],
            options: {
                windowsHide: true,
                env
            }
        };
    }

    return {
        command: binary,
        args: args || [],
        options: {
            windowsHide: true,
            env
        }
    };
}

function normalizeBinary(binary) {
    if (process.platform !== 'win32') return binary;
    const lower = String(binary || '').toLowerCase();
    if (lower === 'openclaw') return 'openclaw.cmd';
    if (lower === 'npm') return 'npm.cmd';
    if (lower === 'node') return 'node.exe';
    return binary;
}

function normalizeBinary(binary) {
    if (process.platform !== 'win32') return binary;
    const lower = String(binary || '').toLowerCase();
    if (lower === 'openclaw' || lower === 'openclaw-cn') {
        const cli = resolveOpenClawCliSync();
        return cli.commandPath || cli.displayName || (lower === 'openclaw-cn' ? 'openclaw-cn' : 'openclaw');
    }
    if (lower === 'npm') return 'npm.cmd';
    if (lower === 'node') return 'node.exe';
    return binary;
}

function terminateProcessTree(child) {
    if (!child || child.killed) return;

    if (process.platform === 'win32' && child.pid) {
        try {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true
            });
        } catch (error) {
            console.warn('[Process] taskkill failed:', error.message);
        }
    }

    try {
        child.kill('SIGTERM');
    } catch (_) {}
}

function finishActiveProcess(id, sender, code) {
    const meta = activeProcesses.get(id);
    if (!meta) return;

    activeProcesses.delete(id);
    if (meta.logMirrorTimer) {
        clearInterval(meta.logMirrorTimer);
        meta.logMirrorTimer = null;
    }
    if (meta.timeoutHandle) {
        clearTimeout(meta.timeoutHandle);
    }
    if (meta.smokeTimers) {
        meta.smokeTimers.forEach((timer) => clearTimeout(timer));
        meta.smokeTimers.clear();
    }

    sender.send('command-finished', { id, code });
}

function safeSend(sender, channel, payload) {
    try {
        if (sender && !sender.isDestroyed?.()) {
            sender.send(channel, payload);
        }
    } catch (_) {}
}

function buildSmokeManagedCommandScenario(commandText = '') {
    const normalized = String(commandText || '').trim().toLowerCase();
    if (/^openclaw(?:-cn)?\s+channels\s+status\b.*--probe\b/.test(normalized)) {
        return {
            events: [
                { delay: 180, type: 'stdout', text: 'Checking channel status...\n' },
                { delay: 420, type: 'stdout', text: 'Gateway reachable.\n' },
                { delay: 760, type: 'stdout', text: 'openclaw-weixin: configured, waiting for login confirmation.\n' }
            ],
            autoFinish: { delay: 1200, code: 0 }
        };
    }
    if (/^openclaw(?:-cn)?\s+channels\s+login\s+--channel\s+openclaw-weixin\b/.test(normalized)) {
        const link = 'https://liteapp.weixin.qq.com/q/SMOKE-WEIXIN-LINK-20260403';
        return {
            events: [
                { delay: 220, type: 'stdout', text: 'Preparing Weixin login flow...\n' },
                { delay: 520, type: 'stdout', text: '二维码链接: ' + link + '\n' },
                { delay: 920, type: 'stdout', text: '使用微信扫描以下二维码，扫码后请在手机上确认登录。\n' },
                {
                    delay: 1280,
                    type: 'stdout',
                    text: [
                        '████████████████',
                        '██ ▄▄▄▄▄ ██ ▄ ██',
                        '██ █   █ ██▀▀██',
                        '██ █▄▄▄█ ██ ▄██',
                        '██▄▄▄▄▄▄▄██▄███',
                        '████████████████'
                    ].join('\n') + '\n'
                },
                { delay: 1700, type: 'stdout', text: 'waiting for confirmation on phone...\n' }
            ],
            autoFinish: { delay: 20000, code: 0 }
        };
    }
    return null;
}

function startSmokeManagedProcess(sender, id, options = {}) {
    if (!isSmokeTest) return null;
    const scenario = buildSmokeManagedCommandScenario(options.command || options.commandLine || '');
    if (!scenario) return null;

    const fakeChild = {
        pid: 0,
        killed: false,
        stdin: {
            destroyed: true,
            writable: false
        },
        kill() {
            this.killed = true;
        }
    };

    const meta = {
        child: fakeChild,
        sender,
        forcedCode: null,
        timeoutHandle: null,
        encoding: options.encoding || 'utf8',
        startedAt: Date.now(),
        processOutputFingerprints: new Set(),
        logMirrorFingerprints: new Set(),
        smokeTimers: new Set()
    };
    activeProcesses.set(id, meta);

    const scheduleSmokeEvent = (delayMs, callback) => {
        const timer = setTimeout(() => {
            meta.smokeTimers.delete(timer);
            if (!activeProcesses.has(id)) return;
            callback();
        }, Math.max(0, Number(delayMs) || 0));
        meta.smokeTimers.add(timer);
    };

    scenario.events.forEach((event) => {
        scheduleSmokeEvent(event.delay, () => {
            const text = String(event.text || '');
            rememberManagedProcessOutput(meta, text);
            sender.send('command-stream', {
                id,
                type: event.type || 'stdout',
                text
            });
        });
    });

    if (scenario.autoFinish) {
        scheduleSmokeEvent(scenario.autoFinish.delay, () => {
            const currentMeta = activeProcesses.get(id);
            if (!currentMeta || currentMeta !== meta) return;
            finishActiveProcess(id, sender, scenario.autoFinish.code);
        });
    }

    return meta;
}

function decodeOutputChunk(data, encoding = 'utf8') {
    try {
        return normalizeDecodedOutput(iconv.decode(data, encoding || 'utf8'), encoding);
    } catch (_) {
        return normalizeDecodedOutput(iconv.decode(data, 'utf8'), 'utf8');
    }
}

function getOpenClawMainLogPathSync(date = new Date()) {
    const stamp = new Date(date.getTime() - (date.getTimezoneOffset() * 60000))
        .toISOString()
        .slice(0, 10);
    return path.join(resolveWritableTempDir(), `openclaw-${stamp}.log`);
}

function getOpenClawMainLogPathCandidatesSync(date = new Date()) {
    const stamp = new Date(date.getTime() - (date.getTimezoneOffset() * 60000))
        .toISOString()
        .slice(0, 10);
    const userHomeDir = String(process.env.USERPROFILE || os.homedir() || '').trim();
    const localAppDataDir = String(process.env.LOCALAPPDATA || '').trim();
    const dirs = [
        resolveWritableTempDir(),
        path.join(openClawHomeDir, 'tmp'),
        userHomeDir ? path.join(userHomeDir, '.openclaw', 'tmp') : '',
        localAppDataDir ? path.join(localAppDataDir, 'OpenClaw', 'tmp') : '',
        localAppDataDir ? path.join(localAppDataDir, 'Temp', 'OpenClaw') : ''
    ]
        .map((value) => String(value || '').trim())
        .filter(Boolean);

    return Array.from(new Set(dirs)).map((dir) => path.join(dir, `openclaw-${stamp}.log`));
}

function parseOpenClawJsonLogLine(line = '') {
    const raw = String(line || '').trim();
    if (!raw) return null;
    try {
        const payload = JSON.parse(raw);
        return payload && typeof payload === 'object'
            ? payload
            : null;
    } catch (_) {
        return { __raw: raw };
    }
}

function extractOpenClawJsonLogText(entry) {
    if (!entry || typeof entry !== 'object') return '';
    if (typeof entry['1'] === 'string' && entry['1'].trim()) {
        return normalizeDecodedOutput(String(entry['1']), 'utf8');
    }
    if (typeof entry['0'] === 'string' && entry['0'].trim()) {
        return normalizeDecodedOutput(String(entry['0']), 'utf8');
    }
    if (typeof entry.__raw === 'string' && entry.__raw.trim()) {
        return normalizeDecodedOutput(String(entry.__raw), 'utf8');
    }
    return '';
}

function isWeixinQrBlockLine(text = '') {
    return /[\u2580\u2584\u2588]/.test(String(text || ''));
}

function createManagedProcessOutputFingerprint(text = '') {
    return stripAnsi(String(text || '')).replace(/\r/g, '').trim();
}

function rememberManagedProcessOutput(meta, text, bucketName = 'processOutputFingerprints') {
    if (!meta) return;
    const fingerprint = createManagedProcessOutputFingerprint(text);
    if (!fingerprint) return;
    if (!(meta[bucketName] instanceof Set)) {
        meta[bucketName] = new Set();
    }
    meta[bucketName].add(fingerprint);
    if (meta[bucketName].size > 400) {
        const recent = Array.from(meta[bucketName]).slice(-240);
        meta[bucketName] = new Set(recent);
    }
}

function shouldMirrorOpenClawLogCommand(commandText = '') {
    const normalized = String(commandText || '').trim().toLowerCase();
    if (!normalized) return null;
    if (/openclaw(?:\.cmd)?\s+channels\s+login\s+--channel\s+openclaw-weixin\b/.test(normalized)) {
        return 'weixin-login';
    }
    if (/openclaw(?:\.cmd)?\s+channels\s+status\s+--probe\b/.test(normalized)) {
        return 'channels-status-probe';
    }
    return null;
}

function shouldEmitMirroredOpenClawLogEntry(mode, entry) {
    if (!entry || typeof entry !== 'object') return false;
    const loggerName = normalizeDecodedOutput(String(entry?._meta?.name || entry?.['0'] || '').trim(), 'utf8');
    const message = extractOpenClawJsonLogText(entry);
    if (!message.trim()) return false;
    const normalizedMessage = normalizeDecodedOutput(message, 'utf8');
    const loweredMessage = normalizedMessage.toLowerCase();
    const weixinAsciiKeywords = [
        'openclaw-weixin',
        'weixin',
        'wechat',
        'qrcode',
        'qr code',
        'scan',
        'waiting for connection',
        'waiting for login',
        'waiting to poll qr',
        'starting to poll qr',
        'liteapp.weixin.qq.com'
    ];
    const weixinUnicodeKeywords = [
        '\u5fae\u4fe1',
        '\u4e2a\u4eba\u5fae\u4fe1',
        '\u4e8c\u7ef4\u7801',
        '\u626b\u7801',
        '\u767b\u5f55',
        '\u8fde\u63a5',
        '\u7b49\u5f85\u8fde\u63a5\u7ed3\u679c'
    ];
    const statusAsciiKeywords = [
        'checking channel status',
        'gateway reachable',
        'gateway not reachable',
        'gateway connect failed',
        'pairing required',
        'openclaw-weixin',
        'weixin',
        'wechat',
        'scan'
    ];
    const statusUnicodeKeywords = [
        '\u5fae\u4fe1',
        '\u4e2a\u4eba\u5fae\u4fe1',
        '\u4f01\u4e1a\u5fae\u4fe1',
        '\u5df2\u8fde\u63a5',
        '\u672a\u8fde\u63a5',
        '\u5df2\u767b\u5f55',
        '\u672a\u767b\u5f55',
        '\u8fde\u63a5\u6210\u529f',
        '\u8fde\u63a5\u5931\u8d25'
    ];

    if (mode === 'weixin-login') {
        return loggerName === 'openclaw'
            || loggerName.includes('gateway/channels/openclaw-weixin')
            || isWeixinQrBlockLine(normalizedMessage)
            || weixinAsciiKeywords.some((keyword) => loweredMessage.includes(keyword))
            || weixinUnicodeKeywords.some((keyword) => normalizedMessage.includes(keyword));
    }

    if (mode === 'channels-status-probe') {
        return loggerName === 'openclaw'
            || loggerName.includes('gateway/channels/openclaw-weixin')
            || statusAsciiKeywords.some((keyword) => loweredMessage.includes(keyword))
            || statusUnicodeKeywords.some((keyword) => normalizedMessage.includes(keyword));
    }

    return false;
}

function readOpenClawLogSlice(logPath, startOffset = 0) {
    let fd = null;
    try {
        const stats = fs.statSync(logPath);
        const safeOffset = Math.max(0, Number(startOffset) || 0);
        if (stats.size <= safeOffset) {
            return {
                nextOffset: stats.size,
                text: ''
            };
        }
        const length = stats.size - safeOffset;
        const buffer = Buffer.alloc(length);
        fd = fs.openSync(logPath, 'r');
        fs.readSync(fd, buffer, 0, length, safeOffset);
        return {
            nextOffset: stats.size,
            text: buffer.toString('utf8')
        };
    } catch (_) {
        return {
            nextOffset: startOffset,
            text: ''
        };
    } finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch (_) {}
        }
    }
}

function attachOpenClawLogMirror(sender, id, meta, options = {}) {
    const mode = shouldMirrorOpenClawLogCommand(options.command || options.commandLine || '');
    if (!mode || !meta) return;

    meta.processOutputFingerprints = meta.processOutputFingerprints instanceof Set ? meta.processOutputFingerprints : new Set();
    meta.logMirrorFingerprints = meta.logMirrorFingerprints instanceof Set ? meta.logMirrorFingerprints : new Set();
    meta.logMirrorMode = mode;
    const offsetEntries = options.logMirrorOffsets && typeof options.logMirrorOffsets === 'object'
        ? Object.entries(options.logMirrorOffsets)
        : [];
    meta.logMirrorOffsets = new Map(offsetEntries.map(([filePath, offset]) => [
        String(filePath || '').trim(),
        Math.max(0, Number(offset) || 0)
    ]).filter(([filePath]) => filePath));
    meta.logMirrorRemainder = '';
    meta.logMirrorTimer = setInterval(() => {
        const currentMeta = activeProcesses.get(id);
        if (!currentMeta || currentMeta !== meta) return;

        const currentPaths = getOpenClawMainLogPathCandidatesSync();
        for (const filePath of currentPaths) {
            if (!meta.logMirrorOffsets.has(filePath)) {
                meta.logMirrorOffsets.set(filePath, fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
            }
        }

        for (const filePath of currentPaths) {
            if (!fs.existsSync(filePath)) continue;
            const priorOffset = meta.logMirrorOffsets.get(filePath) || 0;
            const slice = readOpenClawLogSlice(filePath, priorOffset);
            meta.logMirrorOffsets.set(filePath, slice.nextOffset);
            if (!slice.text) continue;

            const combined = `${meta.logMirrorRemainder || ''}${slice.text}`;
            const hasTrailingNewline = /\r?\n$/.test(combined);
            const parts = combined.split(/\r?\n/);
            if (!hasTrailingNewline) {
                meta.logMirrorRemainder = parts.pop() || '';
            } else {
                meta.logMirrorRemainder = '';
            }

            for (const part of parts) {
                const entry = parseOpenClawJsonLogLine(part);
                if (!entry || !shouldEmitMirroredOpenClawLogEntry(mode, entry)) continue;
                const text = extractOpenClawJsonLogText(entry);
                const fingerprint = createManagedProcessOutputFingerprint(text);
                if (!fingerprint) continue;
                if (meta.processOutputFingerprints.has(fingerprint) || meta.logMirrorFingerprints.has(fingerprint)) {
                    continue;
                }
                meta.logMirrorFingerprints.add(fingerprint);
                if (meta.logMirrorFingerprints.size > 400) {
                    const recent = Array.from(meta.logMirrorFingerprints).slice(-240);
                    meta.logMirrorFingerprints = new Set(recent);
                }
                safeSend(sender, 'command-stream', {
                    id,
                    type: 'stdout',
                    text: text.endsWith('\n') ? text : `${text}\n`
                });
            }
        }
    }, mode === 'weixin-login' ? 500 : 700);
}

function startManagedProcess(sender, id, spawnRequest, options = {}) {
    const encoding = options.encoding || 'utf8';
    const timeoutMs = options.timeoutMs !== undefined ? Number(options.timeoutMs) : 60000;
    const logMirrorMode = shouldMirrorOpenClawLogCommand(options.command || options.commandLine || '');
    const preSpawnLogMirrorOffsets = logMirrorMode
        ? Object.fromEntries(getOpenClawMainLogPathCandidatesSync().map((filePath) => [
            filePath,
            fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
        ]))
        : {};

    const smokeManagedMeta = startSmokeManagedProcess(sender, id, {
        ...options,
        encoding
    });
    if (smokeManagedMeta) {
        return smokeManagedMeta;
    }

    let child = null;
    try {
        child = spawn(spawnRequest.command, spawnRequest.args, spawnRequest.options);
    } catch (error) {
        console.error('[Command] Spawn failed:', error.message, {
            command: options.command || options.commandLine || '',
            spawnCommand: spawnRequest.command,
            spawnArgs: spawnRequest.args
        });
        sender.send('command-stream', {
            id,
            type: 'error',
            text: `[EXEC ERROR] ${error.message}\n`
        });
        sender.send('command-finished', { id, code: -1 });
        return null;
    }

    const meta = {
        child,
        sender,
        forcedCode: null,
        timeoutHandle: null,
        encoding,
        startedAt: Date.now(),
        processOutputFingerprints: new Set(),
        logMirrorFingerprints: new Set()
    };
    activeProcesses.set(id, meta);
    attachOpenClawLogMirror(sender, id, meta, {
        ...options,
        logMirrorOffsets: preSpawnLogMirrorOffsets
    });

    if (timeoutMs > 0) {
        meta.timeoutHandle = setTimeout(() => {
            if (!activeProcesses.has(id)) return;
            meta.forcedCode = 'TIMEOUT';
            sender.send('command-stream', {
                id,
                type: 'error',
                text: '[TIMEOUT] 命令执行超时，已尝试终止。\n'
            });
            terminateProcessTree(child);

            setTimeout(() => {
                if (activeProcesses.has(id) && meta.forcedCode === 'TIMEOUT') {
                    finishActiveProcess(id, sender, 'TIMEOUT');
                }
            }, 2000);
        }, timeoutMs);
    }

    child.stdout.on('data', data => {
        const text = decodeOutputChunk(data, encoding);
        rememberManagedProcessOutput(meta, text);
        sender.send('command-stream', {
            id,
            type: 'stdout',
            text
        });
    });

    child.stderr.on('data', data => {
        const text = decodeOutputChunk(data, encoding);
        rememberManagedProcessOutput(meta, text);
        sender.send('command-stream', {
            id,
            type: 'stderr',
            text
        });
    });

    child.on('close', code => {
        const currentMeta = activeProcesses.get(id);
        if (!currentMeta || currentMeta.child !== child) return;
        const finalCode = currentMeta.forcedCode || code;
        finishActiveProcess(id, sender, finalCode);
    });

    child.on('error', error => {
        const currentMeta = activeProcesses.get(id);
        if (!currentMeta || currentMeta.child !== child) return;
        if (currentMeta.timeoutHandle) {
            clearTimeout(currentMeta.timeoutHandle);
        }
        activeProcesses.delete(id);
        sender.send('command-stream', { id, type: 'error', text: `[EXEC ERROR] ${error.message}\n` });
        sender.send('command-finished', { id, code: currentMeta.forcedCode || -1 });
    });

    return meta;
}

function runCapturedProcess(spawnRequest, options = {}) {
    const encoding = options.encoding || 'utf8';
    const timeoutMs = options.timeoutMs !== undefined ? Number(options.timeoutMs) : 30000;

    return new Promise((resolve) => {
        let child = null;
        let stdout = '';
        let stderr = '';
        let finished = false;
        let timeoutHandle = null;

        const finish = (result) => {
            if (finished) return;
            finished = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            resolve(result);
        };

        try {
            child = spawn(spawnRequest.command, spawnRequest.args, spawnRequest.options);
        } catch (error) {
            finish({ ok: false, code: -1, stdout, stderr, error });
            return;
        }

        if (timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                terminateProcessTree(child);
                finish({
                    ok: false,
                    code: 'TIMEOUT',
                    stdout,
                    stderr,
                    error: new Error(`Process timed out after ${timeoutMs}ms`)
                });
            }, timeoutMs);
        }

        child.stdout.on('data', (data) => {
            const chunk = decodeOutputChunk(data, encoding);
            stdout += chunk;
            if (typeof options.onStdout === 'function' && chunk) {
                try {
                    options.onStdout(chunk);
                } catch (_) {}
            }
        });

        child.stderr.on('data', (data) => {
            const chunk = decodeOutputChunk(data, encoding);
            stderr += chunk;
            if (typeof options.onStderr === 'function' && chunk) {
                try {
                    options.onStderr(chunk);
                } catch (_) {}
            }
        });

        child.on('error', (error) => {
            finish({ ok: false, code: -1, stdout, stderr, error });
        });

        child.on('close', (code) => {
            finish({ ok: code === 0, code, stdout, stderr });
        });
    });
}

function runManagedCommand(sender, id, command, options = {}) {
    const { binary: rawBinary, args } = parseCommand(command);
    const binary = normalizeBinary(rawBinary);
    const binaryName = String(rawBinary || '').trim().toLowerCase();

    if (!binary) {
        sender.send('command-stream', { id, type: 'error', text: '命令不能为空\n' });
        sender.send('command-finished', { id, code: -1 });
        return null;
    }

    const useOpenClawCliLauncher = ['openclaw', 'openclaw-cn'].includes(binaryName);
    const openClawCommandOptions = {
        cwd: options.cwd || process.cwd(),
        env: options.env || {},
        lightweight: options.lightweight === true
    };
    const spawnRequest = useOpenClawCliLauncher
        ? buildOpenClawCliDirectSpawnRequest(args, openClawCommandOptions)
        : buildSpawnRequest(binary, args);
    if (options.cwd && !useOpenClawCliLauncher) {
        spawnRequest.options = {
            ...(spawnRequest.options || {}),
            cwd: options.cwd
        };
    }
    return startManagedProcess(sender, id, spawnRequest, {
        ...options,
        command
    });
}

function runManagedShellCommand(sender, id, commandLine, options = {}) {
    const spawnRequest = {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', commandLine],
        options: {
            windowsHide: true,
            env: getSafeEnv(),
            cwd: options.cwd || undefined
        }
    };

    return startManagedProcess(sender, id, spawnRequest, {
        ...options,
        commandLine
    });
}

const memoryFileExtensions = new Set(['.md', '.txt', '.json', '.jsonl']);

function toPortableRelativePath(inputPath) {
    return String(inputPath || '').replace(/\\/g, '/');
}

function isUnsafeRelativePath(inputPath) {
    const raw = String(inputPath || '').trim();
    if (!raw) return true;
    if (raw.includes('\0')) return true;
    if (path.isAbsolute(raw)) return true;
    return raw.split(/[\\/]+/).some(segment => segment === '..');
}

function getMemoryCategoryPath(config, agentName, category = 'memory') {
    const workspacePath = getAgentWorkspacePath(config, agentName);
    if (category === 'archive') {
        const parentDir = path.dirname(workspacePath);
        return path.join(parentDir, 'workspace-memory');
    }
    if (category === 'core') {
        return workspacePath;
    }
    return path.join(workspacePath, 'memory');
}

function collectMemoryFilesFromDir(baseDir, currentDir, category, bucket) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            if (category !== 'core') {
                collectMemoryFilesFromDir(baseDir, fullPath, category, bucket);
            }
            continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (!memoryFileExtensions.has(ext)) continue;

        const relativePath = toPortableRelativePath(path.relative(baseDir, fullPath));
        if (!relativePath) continue;
        bucket.push(relativePath);
    }
}

function listMemoryFilesSync(config, agentName, category = 'memory') {
    const baseDir = getMemoryCategoryPath(config, agentName, category);
    if (!fs.existsSync(baseDir)) return [];
    const files = [];
    collectMemoryFilesFromDir(baseDir, baseDir, category, files);
    files.sort((left, right) => left.localeCompare(right, 'zh-CN'));
    return files;
}

function resolveMemoryFileCandidates(config, agentName, relativePath, preferredCategory = '') {
    const normalizedRelative = String(relativePath || '').trim();
    const categories = preferredCategory
        ? [preferredCategory]
        : ['memory', 'archive', 'core'];

    return categories.map((category) => {
        const baseDir = getMemoryCategoryPath(config, agentName, category);
        return {
            category,
            baseDir,
            fullPath: path.join(baseDir, normalizedRelative)
        };
    });
}

function readMemoryFileSync(config, agentName, relativePath) {
    if (isUnsafeRelativePath(relativePath)) {
        throw new Error('非法记忆文件路径');
    }

    for (const candidate of resolveMemoryFileCandidates(config, agentName, relativePath)) {
        if (!isSubPath(candidate.fullPath, candidate.baseDir)) continue;
        if (!fs.existsSync(candidate.fullPath) || !fs.statSync(candidate.fullPath).isFile()) continue;
        return fs.readFileSync(candidate.fullPath, 'utf8');
    }

    throw new Error(`鏂囦欢涓嶅瓨鍦? ${relativePath}`);
}

function writeMemoryFileSync(config, agentName, relativePath, content, category = 'memory') {
    if (isUnsafeRelativePath(relativePath)) {
        throw new Error('非法记忆文件路径');
    }

    const baseDir = getMemoryCategoryPath(config, agentName, category || 'memory');
    const targetPath = path.join(baseDir, String(relativePath || '').trim());
    if (!isSubPath(targetPath, baseDir)) {
        throw new Error('记忆文件路径越界');
    }

    ensureDirectory(path.dirname(targetPath));
    fs.writeFileSync(targetPath, String(content || ''), 'utf8');
    return { ok: true, path: targetPath };
}

function deleteMemoryFileSync(config, agentName, relativePath) {
    if (isUnsafeRelativePath(relativePath)) {
        throw new Error('非法记忆文件路径');
    }

    for (const candidate of resolveMemoryFileCandidates(config, agentName, relativePath)) {
        if (!isSubPath(candidate.fullPath, candidate.baseDir)) continue;
        if (!fs.existsSync(candidate.fullPath) || !fs.statSync(candidate.fullPath).isFile()) continue;
        fs.unlinkSync(candidate.fullPath);
        return { ok: true };
    }

    throw new Error(`鏂囦欢涓嶅瓨鍦? ${relativePath}`);
}

function exportMemoryZipSync(config, agentName, category = 'memory') {
    const normalizedCategory = ['memory', 'archive', 'core'].includes(category) ? category : 'memory';
    const baseDir = getMemoryCategoryPath(config, agentName, normalizedCategory);
    const relativeFiles = listMemoryFilesSync(config, agentName, normalizedCategory);
    if (!relativeFiles.length) {
        throw new Error('The selected category has no memory files to export.');
    }

    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-memory-export-'));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipPath = path.join(os.tmpdir(), `openclaw-${agentName}-${normalizedCategory}-${stamp}.zip`);

    try {
        for (const relativeFile of relativeFiles) {
            const sourcePath = path.join(baseDir, relativeFile);
            const targetPath = path.join(stagingRoot, relativeFile);
            ensureDirectory(path.dirname(targetPath));
            fs.copyFileSync(sourcePath, targetPath);
        }

        const result = runHiddenSync('tar', ['-a', '-cf', zipPath, '-C', stagingRoot, '.'], {
            env: getSafeEnv(),
            cwd: stagingRoot
        });

        if (result.status !== 0 || !fs.existsSync(zipPath)) {
            throw new Error(String(result.stderr || result.stdout || 'ZIP 导出失败').trim() || 'ZIP 导出失败');
        }

        return zipPath;
    } finally {
        try {
            fs.rmSync(stagingRoot, { recursive: true, force: true });
        } catch (_) {}
    }
}

function buildOpenClawCliSpawnRequest(args = [], options = {}) {
    const commandLine = [
        'chcp 65001 >nul',
        '&&',
        [normalizeBinary('openclaw'), ...(args || []).map(item => String(item))].map(quoteWindowsCmdArg).join(' ')
    ].join(' ');

    return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', commandLine],
        options: {
            cwd: options.cwd || openClawHomeDir,
            env: buildOpenClawCliCommandEnv(options),
            windowsHide: true
        }
    };
}

function buildOpenClawCliSpawnRequest(args = [], options = {}) {
    const cli = resolveOpenClawCliSync();
    const binary = cli.commandPath || cli.displayName || 'openclaw';
    const commandLine = [
        'chcp 65001 >nul',
        '&&',
        [binary, ...(args || []).map((item) => String(item))].map(quoteWindowsCmdArg).join(' ')
    ].join(' ');

    return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', commandLine],
        options: {
            cwd: options.cwd || openClawHomeDir,
            env: buildOpenClawCliCommandEnv(options),
            windowsHide: true
        }
    };
}

function buildOpenClawCliCommandEnv(options = {}) {
    const env = {
        ...getSafeEnv(),
        ...(options.env || {})
    };
    return env;
}

function resolveOpenClawCliDirectLaunchTargetSync() {
    const cli = resolveOpenClawCliSync();
    let commandPath = String(cli.commandPath || '').trim();

    if (process.platform !== 'win32') {
        return {
            ok: Boolean(commandPath || cli.displayName),
            command: commandPath || cli.displayName || 'openclaw',
            argsPrefix: []
        };
    }

    if (commandPath && !path.extname(commandPath)) {
        const siblingWrapper = [`.cmd`, `.bat`]
            .map((suffix) => `${commandPath}${suffix}`)
            .find((candidate) => fs.existsSync(candidate));
        if (siblingWrapper) {
            commandPath = siblingWrapper;
        }
    }

    if (commandPath && /\.(exe|com)$/i.test(commandPath)) {
        return {
            ok: true,
            command: commandPath,
            argsPrefix: []
        };
    }

    if (commandPath && /\.(cmd|bat)$/i.test(commandPath)) {
        const wrapperDir = path.dirname(commandPath);
        const baseName = path.basename(commandPath, path.extname(commandPath)).toLowerCase();
        const packageCandidates = [
            cli.packageName,
            cli.displayName,
            baseName,
            'openclaw',
            'openclaw-cn'
        ]
            .map((item) => String(item || '').trim())
            .filter(Boolean);

        const seen = new Set();
        const uniquePackageCandidates = packageCandidates.filter((item) => {
            const key = item.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const scriptPath = uniquePackageCandidates
            .map((pkgName) => path.join(wrapperDir, 'node_modules', pkgName, 'openclaw.mjs'))
            .find((candidate) => fs.existsSync(candidate));
        const nodeExe = resolveNodeExecutableSync();

        if (scriptPath && nodeExe) {
            return {
                ok: true,
                command: nodeExe,
                argsPrefix: [scriptPath]
            };
        }
    }

    return {
        ok: Boolean(commandPath || cli.displayName),
        command: commandPath || cli.displayName || 'openclaw',
        argsPrefix: [],
        fallbackToShell: true
    };
}

function buildOpenClawCliDirectSpawnRequest(args = [], options = {}) {
    const target = resolveOpenClawCliDirectLaunchTargetSync();
    if (!target.ok || target.fallbackToShell) {
        return buildOpenClawCliSpawnRequest(args, options);
    }

    return {
        command: target.command,
        args: [...(target.argsPrefix || []), ...(args || []).map((item) => String(item))],
        options: {
            cwd: options.cwd || openClawHomeDir,
            env: buildOpenClawCliCommandEnv(options),
            windowsHide: true
        }
    };
}

function buildDashboardGatewayDirectEnv(wrapperEnv = {}) {
    const env = { ...process.env };
    const npmGlobalBin = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');

    if (env.PATH && !env.PATH.includes(npmGlobalBin)) {
        env.PATH = `${npmGlobalBin};${env.PATH}`;
    }
    if (env.Path && !env.Path.includes(npmGlobalBin)) {
        env.Path = `${npmGlobalBin};${env.Path}`;
    }

    delete env.OPENCLAW_HOME;

    return {
        ...env,
        ...(wrapperEnv || {})
    };
}

function resolveDashboardGatewayDirectSpawnRequestSync() {
    if (process.platform !== 'win32') return null;

    const gatewayCmdPath = path.join(openClawHomeDir, 'gateway.cmd');
    if (!fs.existsSync(gatewayCmdPath)) return null;

    let content = '';
    try {
        content = fs.readFileSync(gatewayCmdPath, 'utf8');
    } catch (_) {
        return null;
    }

    const wrapperEnv = {};
    let commandLine = '';
    for (const rawLine of String(content || '').split(/\r?\n/)) {
        const line = String(rawLine || '').trim();
        if (!line || /^@echo off$/i.test(line) || /^rem\b/i.test(line)) continue;

        const quotedSetMatch = line.match(/^set\s+"([^=]+)=(.*)"$/i);
        if (quotedSetMatch) {
            wrapperEnv[String(quotedSetMatch[1] || '').trim()] = String(quotedSetMatch[2] || '').trim();
            continue;
        }

        const plainSetMatch = line.match(/^set\s+([^=]+)=(.*)$/i);
        if (plainSetMatch) {
            wrapperEnv[String(plainSetMatch[1] || '').trim()] = String(plainSetMatch[2] || '').trim();
            continue;
        }

        commandLine = line;
        break;
    }

    if (!commandLine) return null;

    const { binary, args } = parseCommand(commandLine);
    if (!binary) return null;

    return {
        command: binary,
        args: args || [],
        options: {
            cwd: openClawHomeDir,
            env: buildDashboardGatewayDirectEnv(wrapperEnv),
            windowsHide: true
        }
    };
}

let cachedHiddenLauncherScriptPath = '';

function ensureHiddenProcessLauncherScriptSync() {
    if (cachedHiddenLauncherScriptPath && fs.existsSync(cachedHiddenLauncherScriptPath)) {
        return cachedHiddenLauncherScriptPath;
    }

    const launcherDir = path.join(resolveWritableTempDir(), 'openclaw-tools');
    ensureDirectory(launcherDir);
    const launcherPath = path.join(launcherDir, 'hidden-launch.vbs');
    const script = [
        'Option Explicit',
        'Dim shell, command, i',
        'Set shell = CreateObject("WScript.Shell")',
        'If WScript.Arguments.Count < 2 Then',
        '  WScript.Quit 1',
        'End If',
        'shell.CurrentDirectory = WScript.Arguments(0)',
        'command = QuoteArg(WScript.Arguments(1))',
        'For i = 2 To WScript.Arguments.Count - 1',
        '  command = command & " " & QuoteArg(WScript.Arguments(i))',
        'Next',
        'shell.Run command, 0, False',
        'WScript.Quit 0',
        '',
        'Function QuoteArg(value)',
        '  If Len(value) = 0 Then',
        '    QuoteArg = Chr(34) & Chr(34)',
        '    Exit Function',
        '  End If',
        '  If InStr(value, " ") = 0 And InStr(value, Chr(34)) = 0 And InStr(value, vbTab) = 0 Then',
        '    QuoteArg = value',
        '    Exit Function',
        '  End If',
        '  QuoteArg = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)',
        'End Function',
        ''
    ].join('\r\n');
    fs.writeFileSync(launcherPath, script, 'utf8');
    cachedHiddenLauncherScriptPath = launcherPath;
    return launcherPath;
}

function buildHiddenWindowsLauncherSpawnRequest(spawnRequest) {
    if (process.platform !== 'win32') return spawnRequest;

    const launcherPath = ensureHiddenProcessLauncherScriptSync();
    const cwd = String(spawnRequest?.options?.cwd || openClawHomeDir || process.cwd()).trim() || process.cwd();
    return {
        command: 'wscript.exe',
        args: [
            '//nologo',
            launcherPath,
            cwd,
            String(spawnRequest.command || ''),
            ...((spawnRequest.args || []).map((item) => String(item)))
        ],
        options: {
            cwd,
            env: {
                ...getSafeEnv(),
                ...(spawnRequest?.options?.env || {})
            },
            windowsHide: true
        }
    };
}

async function runCapturedProcessWithRetries(spawnRequest, options = {}) {
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || 1);
    const retryDelayMs = Math.max(250, Number(options.retryDelayMs) || CHANNEL_INSTALL_RETRY_DELAY_MS);
    let lastResult = null;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
        lastResult = await runCapturedProcess(spawnRequest, options);
        const combinedOutput = `${lastResult?.stdout || ''}\n${lastResult?.stderr || ''}\n${lastResult?.error?.message || ''}`.trim();
        if (attemptIndex >= maxAttempts - 1 || !isRetryableNodeHostWriteFailure(combinedOutput)) {
            return lastResult;
        }

        const retryText = `[WARN] 检测到 OpenClaw 正在写入 node.json，${Math.round(retryDelayMs / 1000)} 秒后自动重试（${attemptIndex + 2}/${maxAttempts}）。\n`;
        if (typeof options.onStderr === 'function') {
            try {
                options.onStderr(retryText);
            } catch (_) {}
        }
        await wait(retryDelayMs);
    }

    return lastResult;
}

async function runOpenClawCliCaptured(args = [], options = {}) {
    const spawnRequest = options.direct === true
        ? buildOpenClawCliDirectSpawnRequest(args, options)
        : buildOpenClawCliSpawnRequest(args, options);
    return runCapturedProcessWithRetries(spawnRequest, {
        encoding: options.encoding || 'utf8',
        timeoutMs: options.timeoutMs,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
        maxAttempts: options.maxAttempts,
        retryDelayMs: options.retryDelayMs
    });
}

function parseCliJsonOutput(rawText) {
    const text = normalizeDecodedOutput(String(rawText || '').trim(), 'utf8');
    if (!text) return null;
    const candidates = [text];
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
        candidates.push(lines.slice(index).join('\n'));
    }

    const seen = new Set();
    for (const candidate of candidates) {
        const normalized = String(candidate || '').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        try {
            return JSON.parse(normalized);
        } catch (_) {}
    }
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

function normalizeCronJobList(payload) {
    const jobs = Array.isArray(payload) ? payload : Array.isArray(payload?.jobs) ? payload.jobs : [];
    return jobs.map((job) => ({
        id: String(job?.id || '').trim(),
        name: String(job?.name || job?.id || '').trim(),
        description: String(job?.description || '').trim(),
        enabled: job?.enabled !== false,
        agentId: String(job?.agentId || '').trim(),
        schedule: cloneJsonValue(job?.schedule || {}),
        payload: cloneJsonValue(job?.payload || {}),
        delivery: cloneJsonValue(job?.delivery || {}),
        sessionTarget: String(job?.sessionTarget || '').trim(),
        state: cloneJsonValue(job?.state || {}),
        raw: cloneJsonValue(job || {})
    }));
}

function getCronJobsStoreCandidatesSync() {
    const cronDir = path.join(openClawHomeDir, 'cron');
    return [
        path.join(cronDir, 'jobs.json'),
        path.join(cronDir, 'jobs.json.bak')
    ];
}

function readCronJobsStoreSync() {
    const candidates = getCronJobsStoreCandidatesSync();
    let lastError = null;
    let foundStoreFile = false;

    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        foundStoreFile = true;
        try {
            const rawText = fs.readFileSync(candidate, 'utf8');
            const parsed = JSON.parse(rawText);
            const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : Array.isArray(parsed) ? parsed : [];
            return {
                ok: true,
                path: candidate,
                jobs,
                raw: parsed,
                missing: false,
                source: 'local-store'
            };
        } catch (error) {
            lastError = error;
        }
    }

    if (!foundStoreFile) {
        return {
            ok: true,
            path: '',
            jobs: [],
            raw: { jobs: [] },
            missing: true,
            source: 'local-store-empty'
        };
    }

    return {
        ok: false,
        path: candidates[0] || '',
        jobs: [],
        raw: null,
        missing: false,
        error: lastError?.message || 'No cron job store file was found.'
    };
}

function buildCronStatusFromStore(store = {}) {
    const normalizedJobs = normalizeCronJobList(store.jobs || []);
    const nextWakeCandidates = normalizedJobs
        .map((job) => Number.parseInt(String(job?.state?.nextRunAtMs ?? job?.state?.nextWakeAtMs ?? ''), 10))
        .filter((value) => Number.isInteger(value) && value > 0);

    return {
        enabled: normalizedJobs.some((job) => job.enabled !== false),
        storePath: store.path || '',
        jobs: normalizedJobs.length,
        enabledJobs: normalizedJobs.filter((job) => job.enabled !== false).length,
        nextWakeAtMs: nextWakeCandidates.length ? Math.min(...nextWakeCandidates) : null,
        source: store?.source === 'local-store-empty' ? 'local-store-empty' : 'local-store'
    };
}

function buildCronJobArgs(payload = {}, mode = 'add') {
    const args = ['cron', mode === 'edit' ? 'edit' : 'add'];
    const jobId = String(payload?.id || '').trim();
    if (mode === 'edit') {
        if (!jobId) throw new Error('缺少定时任务 ID');
        args.push(jobId);
    }

    const pushFlag = (flag, value) => {
        const text = String(value || '').trim();
        if (!text) return;
        args.push(flag, text);
    };

    const scheduleMode = String(payload?.scheduleMode || '').trim().toLowerCase();
    if (scheduleMode === 'cron') {
        pushFlag('--cron', payload?.cron);
    } else if (scheduleMode === 'every') {
        pushFlag('--every', payload?.every);
    } else if (scheduleMode === 'at') {
        pushFlag('--at', payload?.at);
    }

    pushFlag('--name', payload?.name);
    pushFlag('--description', payload?.description);
    pushFlag('--message', payload?.message);
    pushFlag('--system-event', payload?.systemEvent);
    pushFlag('--agent', payload?.agentId);
    pushFlag('--model', payload?.model);
    pushFlag('--thinking', payload?.thinking);
    pushFlag('--channel', payload?.channel);
    pushFlag('--to', payload?.to);
    pushFlag('--account', payload?.accountId);
    pushFlag('--session', payload?.sessionTarget);
    pushFlag('--session-key', payload?.sessionKey);
    pushFlag('--tz', payload?.tz);
    pushFlag('--wake', payload?.wake);

    if (payload?.announce === true) {
        args.push('--announce');
    } else if (payload?.announce === false) {
        args.push('--no-deliver');
    }

    if (payload?.lightContext === true) args.push('--light-context');
    if (payload?.lightContext === false) args.push('--no-light-context');
    if (payload?.deleteAfterRun === true) args.push('--delete-after-run');
    if (payload?.deleteAfterRun === false) args.push('--keep-after-run');
    if (payload?.exact === true) args.push('--exact');
    if (payload?.bestEffortDeliver === true) args.push('--best-effort-deliver');
    if (payload?.bestEffortDeliver === false) args.push('--no-best-effort-deliver');

    if (payload?.enabled === false) {
        args.push(mode === 'edit' ? '--disable' : '--disabled');
    } else if (payload?.enabled === true && mode === 'edit') {
        args.push('--enable');
    }

    return args;
}

function resolveDashboardActionRequest(action, mode) {
    const safeMode = mode === 'npm' ? 'npm' : 'official';
    if (safeMode === 'npm') {
        return buildNpmDashboardActionRequest(action);
    }

    const previewMap = {
        start: ['gateway'],
        stop: ['gateway', 'stop'],
        restart: ['gateway', 'restart'],
        'enable-autostart': ['gateway', 'install'],
        'disable-autostart': ['gateway', 'uninstall'],
        'list-tasks': ['gateway', 'status', '--deep']
    };
    const args = previewMap[action];
    if (!args) return null;

    return {
        mode: safeMode,
        action,
        previewCommand: formatOpenClawCliDisplayCommand(args),
        spawnRequest: buildOpenClawCliSpawnRequest(args),
        timeoutMs: 120000,
        encoding: 'utf8'
    };
}

const DASHBOARD_STATUS_CACHE_TTL_MS = 10000;
const DASHBOARD_ACTION_DEFINITIONS_CACHE_TTL_MS = 3000;
const DASHBOARD_AUTOSTART_CACHE_TTL_MS = 3000;
const dashboardStatusCache = new Map();
const dashboardStatusInflight = new Map();
const dashboardActionDefinitionsCache = new Map();
const dashboardActionDefinitionsInflight = new Map();
const dashboardAutoStartCache = new Map();
const dashboardAutoStartInflight = new Map();
const dashboardAutoStartEpoch = new Map();

function readDashboardCacheEntry(store, key, ttlMs) {
    const cached = store.get(key);
    if (!cached) return null;
    if ((Date.now() - cached.at) > ttlMs) {
        store.delete(key);
        return null;
    }
    return cached.value;
}

function writeDashboardCacheEntry(store, key, value) {
    store.set(key, {
        at: Date.now(),
        value
    });
    return value;
}

function bumpDashboardAutoStartEpoch(mode) {
    const safeMode = mode === 'npm' ? 'npm' : 'official';
    const nextEpoch = Number(dashboardAutoStartEpoch.get(safeMode) || 0) + 1;
    dashboardAutoStartEpoch.set(safeMode, nextEpoch);
    return nextEpoch;
}

function writeDashboardAutoStartCacheEntry(mode, epoch, value) {
    const safeMode = mode === 'npm' ? 'npm' : 'official';
    if (Number(dashboardAutoStartEpoch.get(safeMode) || 0) !== Number(epoch || 0)) {
        return value;
    }
    return writeDashboardCacheEntry(dashboardAutoStartCache, safeMode, value);
}

function invalidateDashboardProbeCaches(mode) {
    if (mode === 'npm' || mode === 'official') {
        dashboardStatusCache.delete(mode);
        dashboardStatusCache.delete(`${mode}:fast`);
        dashboardStatusInflight.delete(mode);
        dashboardStatusInflight.delete(`${mode}:fast`);
        dashboardActionDefinitionsCache.delete(mode);
        dashboardActionDefinitionsInflight.delete(mode);
        dashboardAutoStartCache.delete(mode);
        dashboardAutoStartInflight.delete(mode);
        bumpDashboardAutoStartEpoch(mode);
        return;
    }

    dashboardStatusCache.clear();
    dashboardStatusInflight.clear();
    dashboardActionDefinitionsCache.clear();
    dashboardActionDefinitionsInflight.clear();
    dashboardAutoStartCache.clear();
    dashboardAutoStartInflight.clear();
    dashboardAutoStartEpoch.clear();
}

async function getDashboardActionDefinitions(mode = 'official', options = {}) {
    const safeMode = mode === 'npm' ? 'npm' : 'official';
    const bypassCache = options?.bypassCache === true;
    if (!bypassCache) {
        const cached = readDashboardCacheEntry(
            dashboardActionDefinitionsCache,
            safeMode,
            DASHBOARD_ACTION_DEFINITIONS_CACHE_TTL_MS
        );
        if (cached) {
            return cached;
        }
        const inflight = dashboardActionDefinitionsInflight.get(safeMode);
        if (inflight) {
            return inflight;
        }
    }

    const titleMap = {
        start: '启动 OpenClaw',
        stop: '停止 OpenClaw',
        restart: '重启 OpenClaw',
        'enable-autostart': 'Enable auto start',
        'disable-autostart': 'Disable auto start',
        'list-tasks': '查看运行中的任务'
    };

    const task = (async () => {
        const items = [];
        for (const action of Object.keys(titleMap)) {
            const request = safeMode === 'official' && action === 'start'
                ? await resolveOfficialDashboardStartRequestStable({ fastProbe: true })
                : resolveDashboardActionRequest(action, safeMode);
            items.push({
                id: action,
                title: titleMap[action],
                mode: safeMode,
                previewCommand: String(request?.previewCommand || '').trim(),
                error: String(request?.error || '').trim()
            });
        }
        return writeDashboardCacheEntry(dashboardActionDefinitionsCache, safeMode, items);
    })();

    if (!bypassCache) {
        dashboardActionDefinitionsInflight.set(safeMode, task);
    }

    try {
        return await task;
    } finally {
        if (!bypassCache) {
            dashboardActionDefinitionsInflight.delete(safeMode);
        }
    }
}

async function resolveAutoStartStatus(mode = 'official', options = {}) {
    const safeMode = mode === 'npm' ? 'npm' : 'official';
    const bypassCache = options?.bypassCache === true;
    if (!bypassCache) {
        const cached = readDashboardCacheEntry(dashboardAutoStartCache, safeMode, DASHBOARD_AUTOSTART_CACHE_TTL_MS);
        if (cached) {
            return cached;
        }
        const inflight = dashboardAutoStartInflight.get(safeMode);
        if (inflight) {
            return inflight;
        }
    }

    const epochAtStart = Number(dashboardAutoStartEpoch.get(safeMode) || 0);
    const task = (async () => {
        if (safeMode === 'npm') {
            const startupPath = String(startupVbsPath || '').trim();
            return writeDashboardAutoStartCacheEntry(safeMode, epochAtStart, {
                mode: safeMode,
                enabled: Boolean(startupPath && fs.existsSync(startupPath)),
                detail: startupPath,
                error: ''
            });
        }

        const taskQuery = await runCapturedProcess(
            buildSpawnRequest('schtasks.exe', ['/Query', '/TN', 'OpenClaw Gateway']),
            { timeoutMs: 4000 }
        );
        const text = `${taskQuery.stdout || ''}\n${taskQuery.stderr || ''}`.trim();
        const installed = Boolean(taskQuery?.ok) && /OpenClaw Gateway/i.test(text);
        const missing = /cannot find the file specified|error:\s*the system cannot find|找不到指定的文件|无法找到指定的文件/i.test(text)
            || (!taskQuery?.ok && !text);
        const detail = installed
            ? 'Scheduled Task (registered)'
            : (missing ? 'Scheduled Task (missing)' : text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '');

        return writeDashboardAutoStartCacheEntry(safeMode, epochAtStart, {
            mode: safeMode,
            enabled: installed && !missing,
            detail,
            error: taskQuery.ok || detail ? '' : String(taskQuery.error?.message || '').trim()
        });
    })();

    if (!bypassCache) {
        dashboardAutoStartInflight.set(safeMode, task);
    }

    try {
        return await task;
    } finally {
        if (!bypassCache) {
            dashboardAutoStartInflight.delete(safeMode);
        }
    }
}

function isMissingGatewayServiceOutput(outputText = '') {
    const text = stripAnsi(String(outputText || ''));
    return /gateway service missing|service:\s*scheduled task\s*\(missing\)|service unit not found|service not installed/i.test(text);
}

const WINDOWS_GATEWAY_TASK_NAME = 'OpenClaw Gateway';

function resolveAppLaunchAutoStartEnabledSync() {
    return false;
}

async function runOfficialAutoStartActionWithVerification(sender, id, action, request) {
    const result = await runCapturedProcess(request.spawnRequest, {
        timeoutMs: request.timeoutMs,
        encoding: request.encoding || 'utf8'
    });

    if (result.stdout) {
        sender.send('command-stream', {
            id,
            type: 'stdout',
            text: result.stdout
        });
    }
    if (result.stderr) {
        sender.send('command-stream', {
            id,
            type: 'stderr',
            text: result.stderr
        });
    }

    if (!result.ok) {
        if (result.error?.message) {
            sender.send('command-stream', {
                id,
                type: 'error',
                text: `[EXEC ERROR] ${result.error.message}\n`
            });
        }
        sender.send('command-finished', { id, code: result.code ?? -1 });
        return true;
    }

    let verified = await resolveAutoStartStatus('official', { bypassCache: true });

    if (action === 'disable-autostart' && verified?.enabled) {
        sender.send('command-stream', {
            id,
            type: 'sys',
            text: '[INFO] 官方卸载命令执行后计划任务仍存在，正在补充执行系统级计划任务删除。\n'
        });
        const fallback = await runCapturedProcess(
            buildSpawnRequest('schtasks.exe', ['/Delete', '/TN', 'OpenClaw Gateway', '/F']),
            { timeoutMs: 4000, encoding: request.encoding || 'utf8' }
        );
        if (fallback.stdout) {
            sender.send('command-stream', {
                id,
                type: 'stdout',
                text: fallback.stdout
            });
        }
        if (fallback.stderr) {
            sender.send('command-stream', {
                id,
                type: 'stderr',
                text: fallback.stderr
            });
        }
        if (!fallback.ok && fallback.error?.message) {
            sender.send('command-stream', {
                id,
                type: 'error',
                text: `[EXEC ERROR] ${fallback.error.message}\n`
            });
        }
        verified = await resolveAutoStartStatus('official', { bypassCache: true });
    }

    if (action === 'enable-autostart' && !verified?.enabled) {
        sender.send('command-stream', {
            id,
            type: 'error',
            text: '[首页动作] 启用开机自启命令已执行，但计划任务仍未注册。\n'
        });
        sender.send('command-finished', { id, code: 1 });
        return true;
    }

    if (action === 'disable-autostart' && verified?.enabled) {
        sender.send('command-stream', {
            id,
            type: 'error',
            text: '[首页动作] 禁用开机自启命令已执行，但计划任务仍存在。\n'
        });
        sender.send('command-finished', { id, code: 1 });
        return true;
    }

    sender.send('command-finished', { id, code: 0 });
    return true;
}

async function resolveOfficialDashboardStartRequest() {
    const portStatus = await probeOpenClawGatewayStatus();
    if (portStatus?.online) {
        return {
            mode: 'official',
            action: 'start',
            previewCommand: 'openclaw gateway run (skipped: already running)',
            alreadyRunning: true,
            finishCode: 0,
            infoMessages: [
                `[INFO] Gateway is already running: ${portStatus.detail || 'port is already bound by OpenClaw Gateway.'}\n`,
                '[INFO] 为避免重复启动，本次未再次执行原版启动命令。\n'
            ]
        };
    }

    const statusRequest = buildSpawnRequest(normalizeBinary('openclaw'), ['gateway', 'status', '--deep']);
    const statusResult = await runCapturedProcess(statusRequest, { timeoutMs: 15000 });
    const statusText = `${statusResult.stdout || ''}\n${statusResult.stderr || ''}`.trim();

    if (isMissingGatewayServiceOutput(statusText)) {
        return {
            mode: 'official',
            action: 'start',
            previewCommand: 'openclaw gateway run',
            command: 'openclaw gateway run',
            timeoutMs: 0,
            preamble: '[INFO] 未检测到官方安装的 Gateway 服务，已回退为 openclaw gateway run（前台模式）。\n'
        };
    }

    return {
        mode: 'official',
        action: 'start',
        previewCommand: 'openclaw gateway start',
        command: 'openclaw gateway start',
        timeoutMs: 120000,
        preamble: '[INFO] 检测到官方 Gateway 服务，准备执行 openclaw gateway start。\n'
    };
}

async function resolveOfficialDashboardStartRequest() {
    const portStatus = await probeOpenClawGatewayStatus();
    const gatewayDisplayCommand = formatOpenClawCliDisplayCommand(['gateway']);

    if (portStatus?.online) {
        return {
            mode: 'official',
            action: 'start',
            previewCommand: `${gatewayDisplayCommand} (skipped: already running)`,
            alreadyRunning: true,
            finishCode: 0,
            infoMessages: [
                `[INFO] Gateway is already running: ${portStatus.detail || 'port is already bound by OpenClaw Gateway.'}\n`,
                '[INFO] 为避免重复启动，本次未再次执行原版启动命令。\n'
            ]
        };
    }

    return {
        mode: 'official',
        action: 'start',
        previewCommand: gatewayDisplayCommand,
        spawnRequest: buildOpenClawCliSpawnRequest(['gateway']),
        timeoutMs: 0,
        encoding: 'utf8',
        preamble: `[INFO] 正在执行系统默认启动命令：${gatewayDisplayCommand}\n`
    };

    const statusResult = await runOpenClawCliCaptured(['gateway', 'status', '--deep'], { timeoutMs: 15000 });
    const statusText = `${statusResult.stdout || ''}\n${statusResult.stderr || ''}`.trim();

    if (isMissingGatewayServiceOutput(statusText)) {
        return {
            mode: 'official',
            action: 'start',
            previewCommand: runDisplayCommand,
            command: runDisplayCommand,
            timeoutMs: 0,
            preamble: `[INFO] 未检测到官方 Gateway 服务，已回退为 ${runDisplayCommand}（前台模式）。\n`
        };
    }

    return {
        mode: 'official',
        action: 'start',
        previewCommand: startDisplayCommand,
        command: startDisplayCommand,
        timeoutMs: 120000,
        preamble: `[INFO] 检测到官方 Gateway 服务，准备执行 ${startDisplayCommand}。\n`
    };
}

function stopDashboardLogFollowByKey(senderKey, options = {}) {
    const meta = dashboardFollowProcesses.get(senderKey);
    if (!meta) return;

    dashboardFollowProcesses.delete(senderKey);
    if (meta.cleanupListener && meta.sender?.removeListener) {
        meta.sender.removeListener('destroyed', meta.cleanupListener);
    }
    if (meta.smokeTimer) {
        clearInterval(meta.smokeTimer);
    }
    if (meta.pollTimer) {
        clearInterval(meta.pollTimer);
    }
    if (meta.child) {
        terminateProcessTree(meta.child);
    }

    if (options.notify) {
        safeSend(meta.sender, 'dashboard-log-state', {
            kind: 'info',
            message: 'Realtime log follow stopped.'
        });
    }
}

function startDashboardLogFollow(sender) {
    const senderKey = Number(sender?.id || 0);
    if (!senderKey) return;

    stopDashboardLogFollowByKey(senderKey, { notify: false });
    safeSend(sender, 'dashboard-log-state', {
        kind: 'info',
        resetBuffer: true,
        message: '正在连接 openclaw gateway 的实时日志...'
    });

    const meta = {
        sender,
        child: null,
        smokeTimer: null,
        pollTimer: null,
        reconnectTimer: null,
        cleanupListener: null,
        filePath: getDashboardGatewayLogPath(),
        offset: 0,
        connected: false,
        waitingForFile: false,
        lastReadError: ''
    };
    meta.cleanupListener = () => stopDashboardLogFollowByKey(senderKey, { notify: false });
    sender.once?.('destroyed', meta.cleanupListener);
    dashboardFollowProcesses.set(senderKey, meta);

    pumpDashboardGatewayLog(meta, { initial: true });
    meta.pollTimer = setInterval(() => {
        const currentMeta = dashboardFollowProcesses.get(senderKey);
        if (!currentMeta || currentMeta !== meta) return;
        pumpDashboardGatewayLog(meta);
    }, 1200);
}

function disposeDashboardLogMeta(senderKey, meta, options = {}) {
    if (!meta) return;

    const currentMeta = dashboardFollowProcesses.get(senderKey);
    if (currentMeta === meta) {
        dashboardFollowProcesses.delete(senderKey);
    }

    if (meta.cleanupListener && meta.sender?.removeListener) {
        meta.sender.removeListener('destroyed', meta.cleanupListener);
    }
    if (meta.smokeTimer) {
        clearInterval(meta.smokeTimer);
        meta.smokeTimer = null;
    }
    if (meta.pollTimer) {
        clearInterval(meta.pollTimer);
        meta.pollTimer = null;
    }
    if (meta.reconnectTimer) {
        clearTimeout(meta.reconnectTimer);
        meta.reconnectTimer = null;
    }
    if (options.terminateChild && meta.child) {
        meta.stopping = true;
        terminateProcessTree(meta.child);
    }
    meta.child = null;

    if (options.notify) {
        safeSend(meta.sender, 'dashboard-log-state', {
            kind: 'info',
            message: 'Realtime log follow stopped.'
        });
    }
}

function activateDashboardLogFileFallback(senderKey, meta, reason = '') {
    if (!meta?.sender || meta.fallbackActive) return;

    meta.fallbackActive = true;
    meta.child = null;
    meta.connected = false;
    meta.waitingForFile = false;
    meta.lastReadError = '';
    meta.offset = 0;
    meta.filePath = getDashboardGatewayLogPath();

    const fallbackPath = meta.filePath || '~/.openclaw/logs/gateway.log';
    const detail = reason
        ? `${reason}，已切换为本地日志跟随：${fallbackPath}`
        : `已切换为本地日志跟随：${fallbackPath}`;

    safeSend(meta.sender, 'dashboard-log-state', {
        kind: 'info',
        message: detail
    });

    pumpDashboardGatewayLog(meta, { initial: true });
    meta.pollTimer = setInterval(() => {
        const currentMeta = dashboardFollowProcesses.get(senderKey);
        if (!currentMeta || currentMeta !== meta) return;
        pumpDashboardGatewayLog(meta);
    }, 1200);
}

function scheduleDashboardLogReconnect(senderKey, meta, reason = '') {
    if (!meta?.sender || meta.stopping) return;
    if (meta.reconnectTimer) return;

    meta.child = null;
    meta.connected = false;
    meta.waitingForFile = false;
    meta.lastReadError = '';

    safeSend(meta.sender, 'dashboard-log-state', {
        kind: 'warn',
        message: reason
            ? `${reason}，3 秒后重连 openclaw logs --follow...`
            : '实时日志流已断开，3 秒后重连 openclaw logs --follow...'
    });

    meta.reconnectTimer = setTimeout(() => {
        meta.reconnectTimer = null;
        const currentMeta = dashboardFollowProcesses.get(senderKey);
        if (!currentMeta || currentMeta !== meta || meta.stopping) return;
        startDashboardLogFollow(meta.sender);
    }, 3000);
}

function activateDashboardLogFileFallback(senderKey, meta, reason = '') {
    scheduleDashboardLogReconnect(senderKey, meta, reason);
}

function stopDashboardLogFollowByKey(senderKey, options = {}) {
    const meta = dashboardFollowProcesses.get(senderKey);
    if (!meta) return;
    disposeDashboardLogMeta(senderKey, meta, {
        terminateChild: true,
        notify: options.notify
    });
}

function startDashboardLogFollow(sender) {
    const senderKey = Number(sender?.id || 0);
    if (!senderKey) return;

    stopDashboardLogFollowByKey(senderKey, { notify: false });
    safeSend(sender, 'dashboard-log-state', {
        kind: 'info',
        resetBuffer: true,
        message: '正在连接 openclaw logs --follow...'
    });

    const meta = {
        sender,
        child: null,
        smokeTimer: null,
        pollTimer: null,
        reconnectTimer: null,
        cleanupListener: null,
        filePath: getDashboardGatewayLogPath(),
        offset: 0,
        connected: false,
        waitingForFile: false,
        lastReadError: '',
        stopping: false,
        fallbackActive: false
    };
    meta.cleanupListener = () => stopDashboardLogFollowByKey(senderKey, { notify: false });
    sender.once?.('destroyed', meta.cleanupListener);
    dashboardFollowProcesses.set(senderKey, meta);

    if (isSmokeTest) {
        pumpDashboardGatewayLog(meta, { initial: true });
        meta.pollTimer = setInterval(() => {
            const currentMeta = dashboardFollowProcesses.get(senderKey);
            if (!currentMeta || currentMeta !== meta) return;
            pumpDashboardGatewayLog(meta);
        }, 1200);
        return;
    }

    const spawnRequest = buildOpenClawCliSpawnRequest(buildDashboardLogFollowArgs());
    let child = null;
    try {
        child = spawn(spawnRequest.command, spawnRequest.args, spawnRequest.options);
    } catch (error) {
        activateDashboardLogFileFallback(senderKey, meta, `启动 openclaw logs --follow 失败：${error.message}`);
        return;
    }

    meta.child = child;
    safeSend(sender, 'dashboard-log-state', {
        kind: 'success',
        message: '已连接实时日志：openclaw logs --follow'
    });

    const forwardChunk = (data, kind = 'stdout') => {
        const text = decodeOutputChunk(data, 'utf8');
        if (!text) return;
        safeSend(sender, 'dashboard-log-stream', { text });
        if (kind === 'stderr') {
            safeSend(sender, 'dashboard-log-state', {
                kind: 'info',
                message: 'openclaw logs --follow 正在输出诊断信息...'
            });
        }
    };

    child.stdout?.on('data', (data) => forwardChunk(data, 'stdout'));
    child.stderr?.on('data', (data) => forwardChunk(data, 'stderr'));

    child.on('error', (error) => {
        const currentMeta = dashboardFollowProcesses.get(senderKey);
        if (!currentMeta || currentMeta !== meta) return;
        if (meta.stopping) return;
        activateDashboardLogFileFallback(senderKey, meta, `实时日志流异常退出：${error.message}`);
    });

    child.on('close', (code) => {
        const currentMeta = dashboardFollowProcesses.get(senderKey);
        if (!currentMeta || currentMeta !== meta) return;
        const stoppedManually = Boolean(meta.stopping);
        if (stoppedManually) return;
        meta.child = null;
        activateDashboardLogFileFallback(
            senderKey,
            meta,
            code === 0
                ? 'openclaw logs --follow exited'
                : `openclaw logs --follow exited with code ${code}`
        );
    });
}

function parseGatewayStatusOutput(outputText, fallbackDetail = '') {
    const text = stripAnsi(String(outputText || '')).trim();
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const gatewayLine = lines.find((line) => /gateway/i.test(line));
    const targetLine = gatewayLine || lines.find((line) => /(reachable|unreachable|online|offline|running|stopped|failed)/i.test(line)) || '';
    const lower = targetLine.toLowerCase();
    const positive = /(reachable|online|running|healthy|available|\bok\b)/i.test(lower);
    const negative = /(unreachable|offline|stopped|down|failed|error)/i.test(lower);
    const latencyMatch = targetLine.match(/(\d+(?:\.\d+)?\s*ms)/i);
    const detail = targetLine || fallbackDetail || (lines[0] || 'Gateway status output is unavailable.');

    return {
        online: positive && !negative,
        confident: Boolean(targetLine),
        statusText: positive && !negative ? '在线' : '离线',
        detail,
        latency: latencyMatch ? latencyMatch[1] : ''
    };
}

async function probeOpenClawGatewayStatus(options = {}) {
    const { allowFallbackCli = true, fastPortOnly = false } = options;
    if (isSmokeTest) {
        return createGatewayStatusPayload({
            online: true,
            confident: true,
            detail: 'Smoke 模式：Gateway 端口可达 | 12ms',
            latency: '12ms',
            port: getGatewayPortFromConfig(),
            source: 'smoke'
        });
    }

    if (process.platform === 'win32') {
        const port = getGatewayPortFromConfig();
        if (fastPortOnly) {
            const snapshot = inspectWindowsListeningPortSnapshot(port);
            if (!snapshot.error) {
                return createGatewayStatusPayload({
                    online: snapshot.pids.length > 0,
                    confident: true,
                    detail: snapshot.pids.length > 0
                        ? `端口 ${port} 正在监听 (PID: ${formatPidList(snapshot.pids)})`
                        : `端口 ${port} 当前没有监听`,
                    port,
                    pid: snapshot.pids[0] || null,
                    source: 'port-fast'
                });
            }
        }
        const { gatewayPids, foreignPids, error } = inspectWindowsPortOwners(port);
        if (!error) {
            if (gatewayPids.length) {
                return createGatewayStatusPayload({
                    online: true,
                    confident: true,
                    detail: `端口 ${port} 正由 OpenClaw Gateway 监听 (PID: ${formatPidList(gatewayPids)})`,
                    port,
                    pid: gatewayPids[0] || null,
                    source: 'port'
                });
            }

            if (foreignPids.length) {
                return createGatewayStatusPayload({
                    online: false,
                    confident: true,
                    detail: `端口 ${port} 当前被其他进程占用 (PID: ${formatPidList(foreignPids)})`,
                    port,
                    pid: foreignPids[0] || null,
                    source: 'port-foreign'
                });
            }

            return createGatewayStatusPayload({
                online: false,
                confident: true,
                detail: `端口 ${port} 当前没有 Gateway 监听`,
                port,
                source: 'port'
            });
        }
    }

    if (process.platform === 'linux') {
        const port = getGatewayPortFromConfig();
        const status = inspectLinuxGatewayPort(port);
        if (!status.error) {
            return createGatewayStatusPayload({
                online: status.running,
                confident: true,
                detail: status.running
                    ? `端口 ${port} 正在监听${status.pid ? ` (PID: ${status.pid})` : ''}`
                    : `端口 ${port} 当前没有 Gateway 监听`,
                port,
                pid: status.pid || null,
                source: 'port'
            });
        }
    }

    if (!allowFallbackCli) {
        return null;
    }

    const spawnRequest = buildSpawnRequest(normalizeBinary('openclaw'), ['status', '--deep']);
    const result = await runCapturedProcess(spawnRequest, { timeoutMs: 20000 });
    const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    const parsed = parseGatewayStatusOutput(
        text,
        result.error ? `Status check failed: ${result.error.message}` : 'Unable to parse Gateway status.'
    );

    if (!parsed.confident && result.error) {
        return createGatewayStatusPayload({
            online: false,
            confident: false,
            detail: `状态检测失败：${result.error.message}`,
            source: 'status-cli'
        });
    }

    return {
        ...parsed,
        source: 'status-cli'
    };
}

async function probePm2GatewayStatus() {
    const request = buildNpmDashboardActionRequest('list-tasks');
    const runtime = resolvePm2ServiceRuntimeSync({ requireConfig: false });
    const appName = runtime.appName || 'openclaw-gateway';

    if (!request?.spawnRequest) {
        return request?.error
            ? {
                online: false,
                confident: false,
                statusText: '离线',
                detail: request.error,
                latency: ''
            }
            : null;
    }

    const result = await runCapturedProcess(request.spawnRequest, {
        timeoutMs: 15000,
        encoding: request.encoding || 'utf8'
    });
    const text = stripAnsi(`${result.stdout || ''}\n${result.stderr || ''}`.trim());
    const lower = text.toLowerCase();
    const hasApp = lower.includes(String(appName).toLowerCase());
    const online = hasApp && /\bonline\b/.test(lower);

    if (!hasApp && result.error) {
        return {
            online: false,
            confident: false,
            statusText: '离线',
            detail: `PM2 状态检测失败：${result.error.message}`,
            latency: ''
        };
    }

    return {
        online,
        confident: hasApp,
        statusText: online ? '在线' : '离线',
        detail: hasApp
            ? `PM2 任务 ${appName}: ${online ? 'online' : 'not online'}`
            : `PM2 中未发现 ${appName} 任务`,
        latency: ''
    };
}

async function resolveDashboardGatewayStatus(mode, options = {}) {
    const safeMode = mode === 'npm' ? 'npm' : 'official';
    const bypassCache = options?.bypassCache === true;
    const fast = options?.fast === true;
    const cacheKey = fast ? `${safeMode}:fast` : safeMode;
    if (!bypassCache) {
        const cached = readDashboardCacheEntry(dashboardStatusCache, cacheKey, DASHBOARD_STATUS_CACHE_TTL_MS);
        if (cached) {
            return cached;
        }
        const inflight = dashboardStatusInflight.get(cacheKey);
        if (inflight) {
            return inflight;
        }
    }

    const task = (async () => {
        const primary = await probeOpenClawGatewayStatus({
            allowFallbackCli: fast ? false : true,
            fastPortOnly: fast
        });
        if (safeMode !== 'npm' || primary?.online) {
            return writeDashboardCacheEntry(dashboardStatusCache, cacheKey, primary);
        }

        const pm2Snapshot = getPm2GatewaySnapshotSync();
        if (!pm2Snapshot?.appName) {
            return writeDashboardCacheEntry(dashboardStatusCache, cacheKey, primary);
        }

        const fallback = {
            online: Boolean(pm2Snapshot.online),
            confident: true,
            statusText: pm2Snapshot.online ? '在线' : '离线',
            detail: pm2Snapshot.online
                ? `PM2 任务 ${pm2Snapshot.appName} 在线${pm2Snapshot.pids?.length ? ` (PID: ${formatPidList(pm2Snapshot.pids)})` : ''}`
                : `PM2 中未发现在线的 ${pm2Snapshot.appName} 任务`,
            latency: '',
            pid: pm2Snapshot.pids?.[0] || null,
            source: 'pm2-snapshot'
        };

        if (fallback.online) {
            return writeDashboardCacheEntry(dashboardStatusCache, cacheKey, {
                ...fallback,
                confident: true,
                detail: primary?.detail
                    ? `${fallback.detail}；端口侧检测：${primary.detail}`
                    : fallback.detail
            });
        }

        return writeDashboardCacheEntry(
            dashboardStatusCache,
            cacheKey,
            primary.confident ? primary : fallback
        );
    })();

    if (!bypassCache) {
        dashboardStatusInflight.set(cacheKey, task);
    }

    try {
        return await task;
    } finally {
        if (!bypassCache) {
            dashboardStatusInflight.delete(cacheKey);
        }
    }
}

async function resolveOfficialDashboardStartRequest() {
    const portStatus = await probeOpenClawGatewayStatus();
    const gatewayDisplayCommand = formatOpenClawCliDisplayCommand(['gateway']);
    const runArgs = ['gateway', 'run'];
    const runDisplayCommand = formatOpenClawCliDisplayCommand(runArgs);

    if (portStatus?.online) {
        return {
            mode: 'official',
            action: 'start',
            previewCommand: `${gatewayDisplayCommand} (skipped: already running)`,
            alreadyRunning: true,
            finishCode: 0,
            infoMessages: [
                `[INFO] Gateway is already running: ${portStatus.detail || 'port is already bound by OpenClaw Gateway.'}\n`,
                '[INFO] 为避免重复启动，本次不再重复执行系统默认启动命令。\n'
            ]
        };
    }

    return {
        mode: 'official',
        action: 'start',
        previewCommand: gatewayDisplayCommand,
        command: gatewayDisplayCommand,
        cwd: openClawHomeDir,
        timeoutMs: 0,
        encoding: 'utf8',
        preamble: `[INFO] 正在执行系统默认启动命令：${gatewayDisplayCommand}\n`
    };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveOfficialDashboardStartRequestStable(options = {}) {
    const portStatus = await probeOpenClawGatewayStatus({
        allowFallbackCli: options?.fastProbe !== true,
        fastPortOnly: options?.fastProbe === true
    });
    const gatewayDisplayCommand = formatOpenClawCliDisplayCommand(['gateway']);
    const directSpawnRequest = resolveDashboardGatewayDirectSpawnRequestSync();

    if (portStatus?.online) {
        return {
            mode: 'official',
            action: 'start',
            previewCommand: `${gatewayDisplayCommand} (skipped: already running)`,
            alreadyRunning: true,
            finishCode: 0,
            infoMessages: [
                `[INFO] Gateway is already running: ${portStatus.detail || 'port is already bound by OpenClaw Gateway.'}\n`,
                '[INFO] 为避免重复启动，本次不再重复执行系统默认启动命令。\n'
            ]
        };
    }

    if (directSpawnRequest) {
        return {
            mode: 'official',
            action: 'start',
            previewCommand: gatewayDisplayCommand,
            spawnRequest: directSpawnRequest,
            command: gatewayDisplayCommand,
            cwd: openClawHomeDir,
            timeoutMs: 0,
            encoding: 'utf8',
            preamble: `[INFO] 正在执行系统默认启动命令：${gatewayDisplayCommand}\n[INFO] 已按本机 Gateway 启动脚本直连后台 Node 进程，避免 cmd / openclaw 包装层环境差异。\n`
        };
    }

    return {
        mode: 'official',
        action: 'start',
        previewCommand: gatewayDisplayCommand,
        spawnRequest: buildOpenClawCliSpawnRequest(['gateway'], {
            cwd: openClawHomeDir
        }),
        command: gatewayDisplayCommand,
        cwd: openClawHomeDir,
        timeoutMs: 0,
        encoding: 'utf8',
        preamble: `[INFO] 正在执行系统默认启动命令：${gatewayDisplayCommand}\n`,
        fallbackPreviewCommand: formatOpenClawCliDisplayCommand(['gateway', 'run']),
        fallbackSpawnRequest: buildOpenClawCliSpawnRequest(['gateway', 'run'], {
            cwd: openClawHomeDir
        })
    };
}

function detectGatewayReadyFromOutput(text = '') {
    const normalized = stripAnsi(String(text || ''));
    return /\[gateway\]\s+listening on ws:\/\//i.test(normalized)
        || /\[browser\/server\]\s+browser control listening on http:\/\//i.test(normalized);
}

function detectGatewayAlreadyRunningFromOutput(text = '') {
    return /gateway already running|lock timeout after/i.test(stripAnsi(String(text || '')));
}

async function startDetachedDashboardGatewayLaunch(sender, id, request) {
    const baseSpawnRequest = request?.spawnRequest;
    const spawnRequest = buildHiddenWindowsLauncherSpawnRequest(baseSpawnRequest);
    if (!spawnRequest) {
        safeSend(sender, 'command-stream', {
            id,
            type: 'error',
            text: '[首页动作] 未生成有效的 CLI 启动请求。\n'
        });
        safeSend(sender, 'command-finished', { id, code: -1 });
        return;
    }

    const readyTimeoutMs = Math.max(10000, Number(request?.readyTimeoutMs) || 70000);
    const pollIntervalMs = 500;
    let child = null;
    let finished = false;
    let readyTimer = null;
    let pollTimer = null;

    const cleanup = () => {
        if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
        }
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        if (child) {
            child.removeAllListeners('error');
            child.removeAllListeners('close');
        }
    };

    const finish = (code, extraText = '') => {
        if (finished) return;
        finished = true;
        cleanup();
        if (extraText) {
            safeSend(sender, 'command-stream', {
                id,
                type: code === 0 ? 'sys' : 'error',
                text: extraText
            });
        }
        safeSend(sender, 'command-finished', { id, code });
        if (code === 0 && child?.unref) {
            try {
                child.unref();
            } catch (_) {}
        }
    };

    const probeForReady = async () => {
        try {
            const status = await probeOpenClawGatewayStatus({ allowFallbackCli: false });
            if (status?.online) {
                const detail = String(status.detail || '').trim();
                finish(0, `[INFO] Gateway 已上线${detail ? `：${detail}` : '。'}\n`);
            }
        } catch (_) {}
    };

    try {
        child = spawn(spawnRequest.command, spawnRequest.args, {
            ...(spawnRequest.options || {}),
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
    } catch (error) {
        finish(-1, `[EXEC ERROR] ${error.message}\n`);
        return;
    }

    child.on('error', (error) => {
        finish(-1, `[EXEC ERROR] ${error.message}\n`);
    });

    child.on('close', async (code) => {
        if (finished) return;
        if (Number(code ?? 0) === 0) {
            safeSend(sender, 'command-stream', {
                id,
                type: 'sys',
                text: '[INFO] 后台启动器已退出，正在继续等待 Gateway 上线确认。\n'
            });
            return;
        }
        const status = await probeOpenClawGatewayStatus({ allowFallbackCli: false }).catch(() => null);
        if (status?.online) {
            finish(0, '[INFO] 启动请求已提交，Gateway 已在线。\n');
            return;
        }
        finish(code ?? 1, `[首页动作] ${request.previewCommand || 'CLI 启动命令'} 已退出，但 Gateway 仍未在线。\n`);
    });

    pollTimer = setInterval(() => {
        if (finished) return;
        probeForReady();
    }, pollIntervalMs);

    readyTimer = setTimeout(async () => {
        if (finished) return;
        const status = await probeOpenClawGatewayStatus({ allowFallbackCli: false }).catch(() => null);
        if (status?.online) {
            finish(0, '[INFO] Gateway 已上线，CLI 后台启动完成。\n');
            return;
        }
        finish(1, `[首页动作] ${request.previewCommand || 'CLI 启动命令'} 已发起，但 Gateway 仍未在线。在预期时间内没有等到在线探针确认。\n`);
    }, readyTimeoutMs);
}

async function waitForGatewayOnlineAfterLaunch(options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 20000);
    const intervalMs = Math.max(200, Number(options.intervalMs) || 600);
    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;

    while (Date.now() <= deadline) {
        lastStatus = await probeOpenClawGatewayStatus({ allowFallbackCli: false });
        if (lastStatus?.online) {
            return {
                ok: true,
                status: lastStatus
            };
        }
        await wait(intervalMs);
    }

    return {
        ok: false,
        status: lastStatus
    };
}

async function waitForGatewayOfflineAfterStop(options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 12000);
    const intervalMs = Math.max(200, Number(options.intervalMs) || 600);
    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;

    while (Date.now() <= deadline) {
        lastStatus = await probeOpenClawGatewayStatus({ allowFallbackCli: false });
        if (!lastStatus?.online) {
            return {
                ok: true,
                status: lastStatus
            };
        }
        await wait(intervalMs);
    }

    return {
        ok: false,
        status: lastStatus
    };
}

function spawnDetachedBackgroundProcess(spawnRequest) {
    try {
        const child = spawn(spawnRequest.command, spawnRequest.args, {
            ...(spawnRequest.options || {}),
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        child.unref();
        return {
            ok: true,
            pid: child.pid || null
        };
    } catch (error) {
        return {
            ok: false,
            error
        };
    }
}

async function tryPm2GatewayBootstrapOnLaunch() {
    let request = resolveDashboardActionRequest('start', 'npm');
    let preflightPreamble = '';

    try {
        const preflight = await resolveNpmDashboardPreflight('start');
        preflightPreamble = String(preflight?.preamble || '');
        if (preflight?.requestOverride) {
            request = preflight.requestOverride;
        }
    } catch (error) {
        return {
            ok: false,
            stage: 'pm2-preflight',
            message: error.message || 'PM2 preflight check failed.'
        };
    }

    if (!request) {
        return {
            ok: false,
            stage: 'pm2-request',
            message: '未生成 PM2 启动请求'
        };
    }

    if (request.error) {
        return {
            ok: false,
            stage: 'pm2-request',
            message: request.error
        };
    }

    if (request.alreadyRunning) {
        return {
            ok: true,
            stage: 'pm2-skip',
            detail: `${preflightPreamble}${(request.infoMessages || []).join('')}`.trim()
        };
    }

    const result = await runCapturedProcess(request.spawnRequest, {
        encoding: request.encoding || 'utf8',
        timeoutMs: request.timeoutMs
    });

    if (!result.ok) {
        return {
            ok: false,
            stage: 'pm2-run',
            message: `${result.error?.message || `exit code ${result.code}`}`.trim(),
            stdout: result.stdout || '',
            stderr: result.stderr || ''
        };
    }

    const online = await waitForGatewayOnlineAfterLaunch({ timeoutMs: 15000, intervalMs: 500 });
    if (!online.ok) {
        return {
            ok: false,
            stage: 'pm2-online-check',
            message: 'PM2 start command finished, but OpenClaw Gateway did not come online in time.',
            stdout: result.stdout || '',
            stderr: result.stderr || ''
        };
    }

    return {
        ok: true,
        stage: 'pm2-run',
        status: online.status,
        detail: `${preflightPreamble}${result.stdout || ''}`.trim()
    };
}

async function tryOfficialGatewayBootstrapOnLaunch() {
    const request = await resolveOfficialDashboardStartRequestStable();
    if (!request) {
        return {
            ok: false,
            stage: 'official-request',
            message: '未生成 cmd 启动请求'
        };
    }

    if (request.error) {
        return {
            ok: false,
            stage: 'official-request',
            message: request.error
        };
    }

    if (request.alreadyRunning) {
        return {
            ok: true,
            stage: 'official-skip',
            detail: (request.infoMessages || []).join('').trim()
        };
    }

    let spawnRequest = request.spawnRequest || null;
    if (!spawnRequest && request.command) {
        const { binary: rawBinary, args } = parseCommand(request.command);
        const binary = normalizeBinary(rawBinary);
        if (binary) {
            spawnRequest = buildSpawnRequest(binary, args);
            if (request.cwd) {
                spawnRequest.options = {
                    ...(spawnRequest.options || {}),
                    cwd: request.cwd
                };
            }
        }
    }

    if (!spawnRequest) {
        return {
            ok: false,
            stage: 'official-request',
            message: 'cmd 启动请求缺少可执行的命令'
        };
    }

    const detached = spawnDetachedBackgroundProcess(spawnRequest);
    if (!detached.ok) {
        return {
            ok: false,
            stage: 'official-spawn',
            message: detached.error?.message || 'cmd 启动失败'
        };
    }

    const online = await waitForGatewayOnlineAfterLaunch({ timeoutMs: 20000, intervalMs: 600 });
    if (!online.ok) {
        return {
            ok: false,
            stage: 'official-online-check',
            message: 'cmd fallback launch started, but OpenClaw Gateway did not come online in time.'
        };
    }

    return {
        ok: true,
        stage: 'official-spawn',
        status: online.status,
        detail: request.previewCommand || ''
    };
}

async function ensureOpenClawRunningOnAppLaunch() {
    if (appLaunchBootstrapPromise) {
        return appLaunchBootstrapPromise;
    }

    appLaunchBootstrapPromise = (async () => {
        if (isSmokeTest) {
            return { ok: true, stage: 'smoke-skip' };
        }

        const initialStatus = await probeOpenClawGatewayStatus({ allowFallbackCli: false });
        if (initialStatus?.online) {
            return {
                ok: true,
                stage: 'already-online',
                status: initialStatus
            };
        }

        if (!resolveAppLaunchAutoStartEnabledSync()) {
            return {
                ok: true,
                stage: 'auto-start-disabled',
                status: initialStatus,
                skipped: true
            };
        }

        const pm2Result = await tryPm2GatewayBootstrapOnLaunch();
        if (pm2Result.ok) {
            console.info('[Bootstrap] OpenClaw app launch bootstrap resolved via PM2.');
            return pm2Result;
        }

        console.warn(`[Bootstrap] PM2 bootstrap unavailable or failed at ${pm2Result.stage || 'unknown'}: ${pm2Result.message || 'unknown error'}`);
        const officialResult = await tryOfficialGatewayBootstrapOnLaunch();
        if (officialResult.ok) {
            console.info('[Bootstrap] OpenClaw app launch bootstrap fell back to cmd startup.');
            return officialResult;
        }

        console.error(`[Bootstrap] cmd fallback failed at ${officialResult.stage || 'unknown'}: ${officialResult.message || 'unknown error'}`);
        return officialResult;
    })();

    try {
        return await appLaunchBootstrapPromise;
    } finally {
        appLaunchBootstrapPromise = null;
    }
}

function buildDashboardLogFollowSpawnTarget(mode = 'official') {
    if (mode === 'npm') {
        return buildPm2DashboardLogFollowSpawnRequest();
    }

    return {
        spawnRequest: buildOpenClawCliSpawnRequest(buildDashboardLogFollowArgs()),
        label: 'openclaw logs --follow'
    };
}

function startDashboardLogFollow(sender, payload = {}) {
    const senderKey = Number(sender?.id || 0);
    if (!senderKey) return;

    stopDashboardLogFollowByKey(senderKey, { notify: false });

    const followMode = payload?.mode === 'npm' ? 'npm' : 'official';
    let followTarget;
    try {
        followTarget = buildDashboardLogFollowSpawnTarget(followMode);
    } catch (error) {
        safeSend(sender, 'dashboard-log-state', {
            kind: 'error',
            resetBuffer: true,
            message: `实时日志启动失败：${error.message}`
        });
        return;
    }

    const followLabel = followTarget.label || 'openclaw logs --follow';
    safeSend(sender, 'dashboard-log-state', {
        kind: 'info',
        resetBuffer: true,
        message: `正在连接 ${followLabel}...`
    });

    const meta = {
        sender,
        child: null,
        smokeTimer: null,
        pollTimer: null,
        reconnectTimer: null,
        cleanupListener: null,
        filePath: getDashboardGatewayLogPath(),
        offset: 0,
        connected: false,
        waitingForFile: false,
        lastReadError: '',
        stopping: false,
        fallbackActive: false,
        mode: followMode,
        followLabel
    };
    meta.cleanupListener = () => stopDashboardLogFollowByKey(senderKey, { notify: false });
    sender.once?.('destroyed', meta.cleanupListener);
    dashboardFollowProcesses.set(senderKey, meta);

    if (isSmokeTest) {
        pumpDashboardGatewayLog(meta, { initial: true });
        meta.pollTimer = setInterval(() => {
            const currentMeta = dashboardFollowProcesses.get(senderKey);
            if (!currentMeta || currentMeta !== meta) return;
            pumpDashboardGatewayLog(meta);
        }, 1200);
        return;
    }

    let child = null;
    try {
        child = spawn(followTarget.spawnRequest.command, followTarget.spawnRequest.args, followTarget.spawnRequest.options);
    } catch (error) {
        activateDashboardLogFileFallback(senderKey, meta, `启动 ${followLabel} 失败：${error.message}`);
        return;
    }

    meta.child = child;
    safeSend(sender, 'dashboard-log-state', {
        kind: 'success',
        message: `已连接实时日志：${followLabel}`
    });

    const forwardChunk = (data, kind = 'stdout') => {
        const text = decodeOutputChunk(data, 'utf8');
        if (!text) return;
        safeSend(sender, 'dashboard-log-stream', { text });
        if (kind === 'stderr') {
            safeSend(sender, 'dashboard-log-state', {
                kind: 'info',
                message: `${followLabel} 正在输出诊断信息...`
            });
        }
    };

    child.stdout?.on('data', (data) => forwardChunk(data, 'stdout'));
    child.stderr?.on('data', (data) => forwardChunk(data, 'stderr'));

    child.on('error', (error) => {
        const currentMeta = dashboardFollowProcesses.get(senderKey);
        if (!currentMeta || currentMeta !== meta) return;
        if (meta.stopping) return;
        activateDashboardLogFileFallback(senderKey, meta, `实时日志流异常退出：${error.message}`);
    });

    child.on('close', (code) => {
        const currentMeta = dashboardFollowProcesses.get(senderKey);
        if (!currentMeta || currentMeta !== meta) return;
        if (meta.stopping) return;
        meta.child = null;
        activateDashboardLogFileFallback(
            senderKey,
            meta,
            code === 0
                ? `${followLabel} exited`
                : `${followLabel} exited with code ${code}`
        );
    });
}

function scheduleDashboardLogReconnect(senderKey, meta, reason = '') {
    if (!meta?.sender || meta.stopping) return;
    if (meta.reconnectTimer) return;

    meta.child = null;
    meta.connected = false;
    meta.waitingForFile = false;
    meta.lastReadError = '';
    const followLabel = meta.followLabel || 'openclaw logs --follow';

    safeSend(meta.sender, 'dashboard-log-state', {
        kind: 'warn',
        message: reason
            ? `${reason}，3 秒后重连 ${followLabel}...`
            : `实时日志流已断开，3 秒后重连 ${followLabel}...`
    });

    meta.reconnectTimer = setTimeout(() => {
        meta.reconnectTimer = null;
        const currentMeta = dashboardFollowProcesses.get(senderKey);
        if (!currentMeta || currentMeta !== meta || meta.stopping) return;
        startDashboardLogFollow(meta.sender, { mode: meta.mode });
    }, 3000);
}

function activateDashboardLogFileFallback(senderKey, meta, reason = '') {
    scheduleDashboardLogReconnect(senderKey, meta, reason);
}

function notifyConfigRecovery(message, type = 'error') {
    BrowserWindow.getAllWindows().forEach((windowInstance) => {
        windowInstance.webContents.send('command-stream', {
            id: 'sentinel',
            type,
            text: `${message.endsWith('\n') ? message : `${message}\n`}`
        });
    });
}

async function runConfigHealthCheck(trigger = 'background') {
    if (configHealthCheckPromise) {
        return configHealthCheckPromise;
    }

    configHealthCheckPromise = (async () => {
        if (!fs.existsSync(configPath)) {
            return { ok: true, skipped: 'missing-config' };
        }

        const rawText = fs.readFileSync(configPath, 'utf8');
        const currentHash = createStableHash(rawText);
        const state = readConfigHealthStateSync();
        const shouldCheck = state.pendingHash === currentHash
            || !state.lastKnownGoodHash
            || state.lastKnownGoodHash !== currentHash
            || state.lastBootStatus === 'failed';

        if (!shouldCheck) {
            lastObservedConfigHash = currentHash;
            return { ok: true, skipped: 'already-known-good' };
        }

        let parsed;
        try {
            parsed = parseConfigText(rawText);
        } catch (error) {
            return {
                ok: false,
                stage: 'parse',
                error: error.message,
            };
        }

        const { config } = sanitizeOpenClawConfig(parsed);
        const validation = validateOpenClawConfig(config);
        if (!validation.ok) {
            return {
                ok: false,
                stage: 'validate',
                error: validation.errors[0] || '配置校验失败',
                validation,
            };
        }

        let status = await probeOpenClawGatewayStatus({ allowFallbackCli: false });
        const wasOnlineBeforeBootstrap = Boolean(status?.online);
        if (!status?.online) {
            if (trigger === 'app-start') {
                appendConfigAuditLog({
                    action: 'config-health-deferred',
                    trigger,
                    reason: 'gateway-offline-skip-bootstrap',
                    hash: currentHash
                });
                return {
                    ok: true,
                    deferred: true,
                    skipped: 'gateway-offline-skip-bootstrap'
                };
            }
            const bootstrap = await ensureOpenClawRunningOnAppLaunch();
            status = await probeOpenClawGatewayStatus({ allowFallbackCli: false });
            if (!status?.online || bootstrap?.ok === false) {
                return {
                    ok: false,
                    stage: 'boot',
                    error: bootstrap?.message || 'Gateway health check failed.',
                    validation,
                };
            }
        }

        if (state.pendingHash === currentHash && wasOnlineBeforeBootstrap) {
            appendConfigAuditLog({
                action: 'config-health-deferred',
                trigger,
                reason: 'gateway-already-online',
                hash: currentHash
            });
            return {
                ok: true,
                deferred: true,
                status
            };
        }

        markConfigKnownGoodSync(config, {
            source: trigger,
            reason: 'health-check-passed'
        });

        return {
            ok: true,
            status,
            validation
        };
    })().finally(() => {
        configHealthCheckPromise = null;
    });

    const result = await configHealthCheckPromise;
    if (!result.ok) {
        const state = readConfigHealthStateSync();
        const restoreHint = buildManualConfigRestoreHint();
        writeConfigHealthStateSync({
            ...state,
            lastBootStatus: 'failed',
            lastBootReason: result.error || result.stage || 'health-check-failed',
            lastValidatedAt: new Date().toISOString()
        });
        notifyConfigRecovery(`[ConfigGuard] 配置体检失败 (${result.stage || 'unknown'}): ${result.error || 'unknown error'}\n${restoreHint}`);
        appendConfigAuditLog({
            action: 'config-health-failed',
            trigger,
            stage: result.stage || 'unknown',
            error: result.error || 'unknown error',
            rollback: false,
            manualRestoreRequired: true
        });
    }
    return result;
}

function scheduleConfigHealthCheck(trigger = 'background', delayMs = 1500) {
    if (isSmokeTest) return;
    clearTimeout(configHealthCheckTimer);
    configHealthCheckTimer = setTimeout(() => {
        runConfigHealthCheck(trigger).catch((error) => {
            console.error('[ConfigGuard] Health check failed:', error.message);
        });
    }, Math.max(200, Number(delayMs) || 1500));
}

function initSentinel() {
    setTimeout(() => {
        if (!fs.existsSync(configPath)) return;
        try {
            const data = fs.readFileSync(configPath, 'utf8');
            parseConfigText(data);
            const { config } = sanitizeOpenClawConfig(parseConfigText(data));
            lastGoodConfig = data;
            lastObservedConfigHash = createStableHash(data);
            updateOpenClawConfigCache(config, buildFileStatCacheEntry(configPath).stat);
            captureKnownGoodBaselineIfNeeded();
        } catch (_) {}
    }, 5000);

    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) return;

    try {
        let watchTimeout = null;
        fs.watch(configDir, (_eventType, filename) => {
            if (filename !== 'openclaw.json') return;
            clearTimeout(watchTimeout);

            watchTimeout = setTimeout(() => {
                if (!fs.existsSync(configPath)) return;

                try {
                    const stat = fs.statSync(configPath);
                    if (stat.size === 0) return;
                } catch (_) {
                    return;
                }

                try {
                    const data = fs.readFileSync(configPath, 'utf8');
                    const parsed = parseConfigText(data);
                    const { config } = sanitizeOpenClawConfig(parsed);
                    const validation = validateOpenClawConfig(config);
                    if (!validation.ok) {
                        throw new Error(validation.errors[0] || '配置校验失败');
                    }
                    lastGoodConfig = data;
                    updateOpenClawConfigCache(config, buildFileStatCacheEntry(configPath).stat);
                    const nextHash = createStableHash(data);
                    const state = readConfigHealthStateSync();
                    if (nextHash !== lastObservedConfigHash) {
                        if (state.lastKnownGoodHash !== nextHash) {
                            markConfigPendingSync(data, {
                                source: 'external-watch',
                                reason: 'external-change'
                            });
                            scheduleConfigHealthCheck('external-watch', 2200);
                        } else {
                            lastObservedConfigHash = nextHash;
                        }
                    }
                } catch (_) {
                    setTimeout(() => {
                        if (!fs.existsSync(configPath)) return;
                        try {
                            const retryData = fs.readFileSync(configPath, 'utf8');
                            const retryParsed = parseConfigText(retryData);
                            const { config } = sanitizeOpenClawConfig(retryParsed);
                            const validation = validateOpenClawConfig(config);
                            if (!validation.ok) {
                                throw new Error(validation.errors[0] || 'Config validation failed');
                            }
                            lastGoodConfig = retryData;
                            updateOpenClawConfigCache(config, buildFileStatCacheEntry(configPath).stat);
                            const retryHash = createStableHash(retryData);
                            const state = readConfigHealthStateSync();
                            if (retryHash !== lastObservedConfigHash) {
                                if (state.lastKnownGoodHash !== retryHash) {
                                    markConfigPendingSync(retryData, {
                                        source: 'external-watch',
                                        reason: 'external-change'
                                    });
                                    scheduleConfigHealthCheck('external-watch', 2200);
                                } else {
                                    lastObservedConfigHash = retryHash;
                                }
                            }
                        } catch (retryError) {
                            const restoreHint = buildManualConfigRestoreHint();
                            const state = readConfigHealthStateSync();
                            writeConfigHealthStateSync({
                                ...state,
                                lastBootStatus: 'failed',
                                lastBootReason: retryError.message || 'sentinel-invalid-config',
                                lastValidatedAt: new Date().toISOString()
                            });
                            appendConfigAuditLog({
                                action: 'config-sentinel-invalid',
                                error: retryError.message || 'unknown error',
                                rollback: false,
                                manualRestoreRequired: true
                            });
                            notifyConfigRecovery(`\n[Sentinel] 检测到 openclaw.json 内容异常，请检查配置或手动恢复最近可用快照。\n${restoreHint}\n`);
                        }
                    }, 1500);
                }
            }, 300);
        });
    } catch (error) {
        console.warn('[Sentinel] Watch disabled:', error.message);
    }
}

function setMainWindow(windowInstance) {
    mainWindow = windowInstance || null;
    return mainWindow;
}

function getMainWindow() {
    return mainWindow;
}

function createWindow() {
    return createMainWindow({
        BrowserWindow,
        appDir: __dirname,
        setMainWindow
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function emitSmokeResult(payload) {
    try {
        fs.writeFileSync(smokeResultPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
        console.error('[Smoke] Failed to write result:', error.message);
    }

    setTimeout(() => {
        app.exit(payload.ok ? 0 : 1);
    }, 150);
}

function installSmokeFixtures() {
    if (!isSmokeTest) return;
    if (process.env.OPENCLAW_SMOKE_ALLOW_REAL_HOME === '1') return;

    const smokeHomeBaseName = path.basename(openClawHomeDir).toLowerCase();
    const smokeHomeParentName = path.basename(path.dirname(openClawHomeDir)).toLowerCase();
    const canResetSmokeHome =
        smokeHomeBaseName === 'openclaw-home'
        && smokeHomeParentName.startsWith('openclaw-tools-smoke-');

    if (!canResetSmokeHome) {
        throw new Error(`Refusing to run smoke fixtures outside isolated temp home: ${openClawHomeDir}`);
    }

    if (fs.existsSync(openClawHomeDir)) {
        fs.rmSync(openClawHomeDir, { recursive: true, force: true });
    }

    ensureDirectory(openClawHomeDir);
    ensureDirectory(path.join(openClawHomeDir, 'logs'));

    const smokeConfig = {
        meta: {},
        wizard: {},
        auth: {
            profiles: {
                'google:default': {
                    provider: 'google',
                    mode: 'api_key'
                },
                'openai-codex:default': {
                    provider: 'openai-codex',
                    mode: 'oauth'
                }
            }
        },
        models: {
            providers: {
                openai: {
                    baseUrl: 'https://api.openai.com/v1',
                    apiKey: 'smoke-key',
                    api: 'openai-completions',
                    models: [
                        { id: 'gpt-4o-mini', name: 'GPT-4o mini', api: 'openai-completions' }
                    ]
                },
                'custom-codex-provider': {
                    baseUrl: 'https://chatgpt.com/backend-api',
                    api: 'openai-codex-responses',
                    models: []
                }
            }
        },
        agents: {
            defaults: {
                model: {
                    primary: 'openai/gpt-4o-mini',
                    fallbacks: ['openai-codex/gpt-5.2-codex']
                },
                models: {
                    'openai/gpt-4o-mini': {},
                    'openai-codex/gpt-5.2-codex': {},
                    'google/gemini-2.0-flash': {}
                },
                workspace: path.join(openClawHomeDir, 'workspace')
            },
            list: []
        },
        tools: { profile: 'minimal' },
        bindings: [],
        messages: {},
        commands: {},
        session: {},
        hooks: {},
        channels: {},
        gateway: {
            port: 18789,
            bind: 'loopback',
            mode: 'local',
            auth: { mode: 'token', token: 'smoke-token' }
        },
        skills: {},
        plugins: {}
    };

    writeOpenClawConfigSync(smokeConfig);
    ensureMainOpenClawLayout(smokeConfig);
    ensureAgentWorkspaceFiles('main', getDefaultWorkspacePath(smokeConfig), 'main');

    const mainMetadataDir = getAgentMetadataDir(smokeConfig, 'main');
    fs.writeFileSync(
        path.join(mainMetadataDir, 'auth-profiles.json'),
        JSON.stringify({
            version: 1,
            profiles: {
                'google:default': {
                    type: 'api_key',
                    provider: 'google',
                    key: 'smoke-google-key'
                },
                'openai-codex:default': {
                    type: 'oauth',
                    provider: 'openai-codex',
                    access: 'smoke-openai-access'
                }
            },
            lastGood: {
                google: 'google:default',
                'openai-codex': 'openai-codex:default'
            },
            usageStats: {}
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(mainMetadataDir, 'models.json'),
        JSON.stringify({
            providers: {
                openai: {
                    baseUrl: 'https://api.openai.com/v1',
                    api: 'openai-completions',
                    models: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini' }]
                },
                'openai-codex': {
                    baseUrl: 'https://chatgpt.com/backend-api',
                    api: 'openai-codex-responses',
                    models: [
                        { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
                        { id: 'smoke-invalid-model', name: 'Smoke Invalid Model' }
                    ]
                },
                google: {
                    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                    api: 'google-generative-ai',
                    models: [{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }]
                },
                'custom-codex-provider': {
                    baseUrl: 'https://chatgpt.com/backend-api',
                    api: 'openai-codex-responses',
                    models: []
                }
            }
        }, null, 2),
        'utf8'
    );

    const mainSessionsDir = getAgentSessionsPath('main');
    ensureDirectory(mainSessionsDir);
    fs.writeFileSync(
        path.join(mainSessionsDir, 'smoke-session.jsonl'),
        [
            JSON.stringify({ role: 'user', content: 'hello smoke test' }),
            JSON.stringify({ role: 'assistant', content: 'smoke reply' })
        ].join('\n'),
        'utf8'
    );

    fs.writeFileSync(
        path.join(openClawHomeDir, 'logs', 'gateway.log'),
        ['[INFO] smoke gateway log', '[WARN] smoke gateway warn'].join('\n'),
        'utf8'
    );

    fs.writeFileSync(
        path.join(openClawHomeDir, 'logs', 'gateway.err.log'),
        ['[ERROR] smoke gateway error'].join('\n'),
        'utf8'
    );

    fs.writeFileSync(
        path.join(openClawHomeDir, 'logs', 'guardian.log'),
        ['[INFO] smoke guardian heartbeat'].join('\n'),
        'utf8'
    );

    fs.writeFileSync(
        path.join(openClawHomeDir, 'logs', 'commands.log'),
        ['[INFO] smoke backup command log'].join('\n'),
        'utf8'
    );

    fs.writeFileSync(
        path.join(openClawHomeDir, 'logs', 'config-audit.jsonl'),
        [JSON.stringify({ time: new Date().toISOString(), action: 'smoke-save', ok: true })].join('\n'),
        'utf8'
    );
}

function resolveGatewayAuthToken(config = {}) {
    const gateway = config?.gateway || {};
    const candidates = [
        gateway?.auth?.token,
        gateway?.token,
        gateway?.controlUi?.token,
        gateway?.controlUi?.auth?.token,
        gateway?.control_ui?.token,
        gateway?.control_ui?.auth?.token,
        gateway?.accessToken,
        gateway?.access_token
    ];
    return candidates
        .map((value) => String(value || '').trim())
        .find(Boolean) || '';
}

function resolveChatWebviewBootstrap() {
    let config = {};
    try {
        config = readOpenClawConfigSync();
    } catch (_) {}

    const gatewayMode = String(config?.gateway?.mode || '').trim().toLowerCase();
    const remoteUrl = trimTrailingSlash(String(config?.gateway?.remote?.url || ''));
    const port = getGatewayPortFromConfig(config);
    const baseUrl = gatewayMode === 'remote' && remoteUrl
        ? (/^wss?:\/\//i.test(remoteUrl) ? remoteUrl.replace(/^ws/i, 'http') : remoteUrl)
        : `http://127.0.0.1:${port}`;
    const token = resolveGatewayAuthToken(config);
    let chatUrl = baseUrl;

    if (token) {
        try {
            const parsed = new URL(baseUrl);
            parsed.searchParams.set('token', token);
            chatUrl = parsed.toString();
        } catch (_) {}
    }

    return {
        url: chatUrl,
        token,
        preloadUrl: `file:///${path.join(__dirname, 'webview-preload.js').replace(/\\/g, '/')}`
    };
}

registerPlatformIpcHandlers({
    ipcMain,
    appDir: __dirname,
    openClawHomeDir,
    fs,
    QRCode,
    DESKTOP_PLUGIN_PARAMETER_FILE,
    parsePluginParameterText,
    resolveChatWebviewBootstrap,
    readOpenClawConfigSync,
    resolveGatewayAuthToken,
    startDashboardLogFollow,
    stopDashboardLogFollowByKey,
    getActiveChannelInstallOperation,
    readDashboardCacheEntry,
    dashboardStatusCache,
    DASHBOARD_STATUS_CACHE_TTL_MS,
    getChannelEnvironmentProfile,
    resolveDashboardGatewayStatus,
    getDashboardActionDefinitions,
    bumpDashboardAutoStartEpoch,
    dashboardAutoStartCache,
    dashboardAutoStartInflight,
    resolveAutoStartStatus,
    checkPm2RuntimeInstalled,
    ensurePm2RuntimeInstalled,
    checkPm2ServiceInstalled,
    ensurePm2ServiceInstalled,
    resetCachedPm2ServiceRuntime,
    verifyMessagingPlatformCredentials,
    buildCredentialCheckResult,
    getWeixinPluginStatus,
    normalizeChannelEnvironmentKey,
    buildChannelEnvironmentStatus,
    buildAllChannelEnvironmentStatuses,
    resolveChannelInstallSource,
    listChannelInstallSources,
    installChannelEnvironment
});

registerCommandIpcHandlers({
    ipcMain,
    activeProcesses,
    terminateProcessTree,
    finishActiveProcess,
    runManagedCommand
});

registerConfigIpcHandlers({
    ipcMain,
    readOpenClawConfigSync,
    sanitizeOpenClawConfig,
    validateOpenClawConfig,
    readConfigHealthStateSync,
    rollbackConfigToLastKnownGoodSync,
    writeOpenClawConfigSync
});

registerModelIpcHandlers({
    ipcMain,
    readOpenClawConfigSync,
    writeOpenClawConfigSync,
    buildRuntimeModelCatalog,
    resolveProviderContext,
    listRemoteModelsForContext,
    testProviderModelWithContext,
    pruneInvalidModelsFromConfig,
    pruneInvalidModelsFromAllAgents
});

registerMemoryIpcHandlers({
    ipcMain,
    readOpenClawConfigSync,
    listMemoryFilesSync,
    readMemoryFileSync,
    writeMemoryFileSync,
    deleteMemoryFileSync,
    exportMemoryZipSync
});

registerUsageIpcHandlers({
    ipcMain,
    openClawHomeDir,
    buildUsageReport,
    readUsageReportCache,
    writeUsageReportCache
});

registerAgentIpcHandlers({
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
});

registerMultiAgentIpcHandlers({
    ipcMain,
    BrowserWindow,
    fs,
    path,
    readOpenClawConfigSync,
    writeOpenClawConfigSync,
    buildRuntimeModelCatalog,
    mergeAgentIds,
    resolveAgentFilePath,
    getAgentWorkspacePath,
    ensureAgentWorkspaceFiles,
    normalizeAgentName,
    getAgentRootPath,
    ensureDirectory,
    runManagedCommand
});

registerCronIpcHandlers({
    ipcMain,
    fs,
    openClawHomeDir,
    ensureDirectory,
    readCronJobsStoreSync,
    normalizeCronJobList,
    buildCronStatusFromStore,
    runOpenClawCliCaptured,
    parseCliJsonOutput,
    buildCronJobArgs
});

registerPairingIpcHandlers({
    ipcMain,
    runOpenClawCliCaptured,
    parseCliJsonOutput,
    cloneJsonValue
});

registerDashboardIpcHandlers({
    ipcMain,
    resolveDashboardActionRequest,
    invalidateDashboardProbeCaches,
    stopDashboardLogFollowByKey,
    resolveOfficialDashboardStartRequestStable,
    resolveNpmDashboardPreflight,
    runOfficialAutoStartActionWithVerification,
    startDetachedDashboardGatewayLaunch,
    runCapturedProcess,
    waitForGatewayOfflineAfterStop,
    killWindowsProcessIdsSync,
    formatPidList,
    waitForGatewayOnlineAfterLaunch,
    buildHiddenWindowsLauncherSpawnRequest,
    spawnDetachedBackgroundProcess,
    startManagedProcess,
    runManagedShellCommand,
    runManagedCommand
});

registerLogIpcHandlers({
    ipcMain,
    fs,
    path,
    openClawHomeDir,
    getAgentSessionsPath,
    normalizeAgentName,
    isSubPath,
    readTail,
    resolveServiceLogPath,
    getAgentRootPath,
    getOpenClawMainLogPathCandidatesSync,
    runOpenClawCliCaptured
});

bootstrapAppLifecycle({
    app,
    session,
    BrowserWindow,
    installSmokeFixtures,
    readOpenClawConfigSync,
    ensureMainOpenClawLayout,
    initSentinel,
    createWindow,
    scheduleConfigHealthCheck,
    isSmokeTest,
    getMainWindow,
    runSmokeTests: async () => {
        throw new Error('Smoke runner is unavailable in the minimal package.');
    },
    emitSmokeResult,
    dashboardFollowProcesses,
    stopDashboardLogFollowByKey
});

