'use strict';

const os = require('os');
const path = require('path');

const DESKTOP_PLUGIN_PARAMETER_FILE = path.join(os.homedir(), 'Desktop', '插件参数.txt');

const CHANNEL_SETUP_DEFS = {
    telegram: {
        key: 'telegram',
        label: 'Telegram',
        storageKey: 'telegram',
        builtIn: true,
        installCommand: '内置渠道，无需额外安装',
        parameterFields: ['Bot Token'],
        createConfigFromParams(record = {}) {
            const token = String(record.clientId || '').trim();
            if (!token) return null;
            return {
                enabled: true,
                botToken: token,
                allowFrom: [],
                groupAllowFrom: [],
                groupPolicy: 'open',
                dmPolicy: 'pairing'
            };
        }
    },
    qqbot: {
        key: 'qqbot',
        label: 'QQ 机器人',
        storageKey: 'qqbot',
        builtIn: false,
        installCommand: 'openclaw plugins install @tencent-connect/openclaw-qqbot@latest',
        installSpec: '@tencent-connect/openclaw-qqbot@latest',
        pluginAllowId: 'openclaw-qqbot',
        extensionDirName: 'openclaw-qqbot',
        parameterFields: ['AppID', 'AppSecret'],
        createConfigFromParams(record = {}) {
            const appId = String(record.clientId || '').trim();
            const appSecret = String(record.secret || '').trim();
            if (!appId || !appSecret) return null;
            return {
                enabled: true,
                appId,
                appSecret,
                clientSecret: appSecret,
                token: `${appId}:${appSecret}`,
                allowFrom: ['*']
            };
        }
    },
    feishu: {
        key: 'feishu',
        label: '飞书',
        storageKey: 'feishu',
        builtIn: true,
        installCommand: '内置渠道，无需额外安装',
        parameterFields: ['App ID', 'App Secret'],
        createConfigFromParams(record = {}) {
            const appId = String(record.clientId || '').trim();
            const appSecret = String(record.secret || '').trim();
            if (!appId || !appSecret) return null;
            return {
                enabled: true,
                domain: 'feishu',
                connectionMode: 'websocket',
                dmPolicy: 'pairing',
                groupPolicy: 'open',
                streaming: true,
                typingIndicator: true,
                resolveSenderNames: true,
                defaultAccount: 'default',
                accounts: {
                    default: {
                        enabled: true,
                        appId,
                        appSecret,
                        domain: 'feishu',
                        typingIndicator: true,
                        resolveSenderNames: true
                    }
                }
            };
        }
    },
    wecom: {
        key: 'wecom',
        label: '企业微信',
        storageKey: 'wecom',
        builtIn: false,
        installCommand: 'openclaw plugins install @wecom/wecom-openclaw-plugin',
        installSpec: '@wecom/wecom-openclaw-plugin',
        pluginAllowId: 'wecom-openclaw-plugin',
        extensionDirName: 'wecom-openclaw-plugin',
        parameterFields: ['Bot ID', 'Secret'],
        createConfigFromParams(record = {}) {
            const botId = String(record.clientId || '').trim();
            const secret = String(record.secret || '').trim();
            if (!botId || !secret) return null;
            return {
                enabled: true,
                botId,
                secret,
                allowFrom: [],
                groupAllowFrom: [],
                dmPolicy: 'open',
                groupPolicy: 'open',
                websocketUrl: '',
                sendThinkingMessage: true
            };
        }
    },
    'openclaw-weixin': {
        key: 'openclaw-weixin',
        label: '个人微信',
        storageKey: 'openclaw-weixin',
        builtIn: false,
        installCommand: 'openclaw plugins install @tencent-weixin/openclaw-weixin',
        installSpec: '@tencent-weixin/openclaw-weixin',
        pluginAllowId: 'openclaw-weixin',
        extensionDirName: 'openclaw-weixin',
        parameterFields: [],
        createConfigFromParams() {
            return null;
        }
    },
    dingtalk: {
        key: 'dingtalk',
        label: '钉钉',
        storageKey: 'dingtalk-connector',
        builtIn: false,
        installCommand: 'openclaw plugins install @dingtalk-real-ai/dingtalk-connector',
        installSpec: '@dingtalk-real-ai/dingtalk-connector',
        pluginAllowId: 'dingtalk-connector',
        extensionDirName: 'dingtalk-connector',
        parameterFields: ['Client ID', 'Client Secret'],
        createConfigFromParams(record = {}, context = {}) {
            const clientId = String(record.clientId || '').trim();
            const clientSecret = String(record.secret || '').trim();
            if (!clientId || !clientSecret) return null;
            const gatewayAuth = context.gatewayAuth && typeof context.gatewayAuth === 'object'
                ? context.gatewayAuth
                : {};
            const config = {
                enabled: true,
                clientId,
                clientSecret
            };
            if (String(gatewayAuth.mode || '').trim() === 'token' && String(gatewayAuth.token || '').trim()) {
                config.gatewayToken = String(gatewayAuth.token).trim();
            }
            if (String(gatewayAuth.mode || '').trim() === 'password' && String(gatewayAuth.password || '').trim()) {
                config.gatewayPassword = String(gatewayAuth.password).trim();
            }
            return config;
        }
    }
};

const CHANNEL_NAME_ALIASES = {
    '钉钉': 'dingtalk',
    '飞书': 'feishu',
    '企业微信': 'wecom',
    'qq机器人': 'qqbot',
    'qq 机器人': 'qqbot',
    'qq bot': 'qqbot',
    'telegram': 'telegram',
    'tg': 'telegram',
    '个人微信': 'openclaw-weixin',
    '微信': 'openclaw-weixin',
    'openclaw-weixin': 'openclaw-weixin'
};

function normalizePluginAliasName(name) {
    return String(name || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function resolvePluginAlias(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    return CHANNEL_NAME_ALIASES[normalizePluginAliasName(raw)] || '';
}

function parsePluginParameterText(text) {
    const lines = String(text || '')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/);

    const audit = {
        filePath: DESKTOP_PLUGIN_PARAMETER_FILE,
        totalLines: lines.length,
        emptyLines: [],
        invalidLines: [],
        unknownPluginNames: [],
        unsupportedPlugins: [],
        conflicts: [],
        mappedEntries: [],
        validEntries: [],
        pluginsWithCompleteParams: [],
        pluginsWithoutParams: []
    };

    const seen = new Map();
    const blockedKeys = new Set();

    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const raw = String(line || '');
        const trimmed = raw.trim();
        if (!trimmed) {
            audit.emptyLines.push({ lineNumber, raw });
            return;
        }

        const parts = raw.split('--').map((item) => String(item || '').trim());
        if (parts.length !== 3 || parts.some((item) => !item)) {
            audit.invalidLines.push({
                lineNumber,
                raw,
                reason: '参数行不是完整的三段格式：插件名称--Client ID--Secret'
            });
            return;
        }

        const [pluginName, clientId, secret] = parts;
        const mappedKey = resolvePluginAlias(pluginName);
        if (!mappedKey) {
            audit.unknownPluginNames.push({
                lineNumber,
                raw,
                pluginName
            });
            return;
        }

        const definition = CHANNEL_SETUP_DEFS[mappedKey];
        if (!definition) {
            audit.unsupportedPlugins.push({
                lineNumber,
                raw,
                pluginName,
                mappedKey
            });
            return;
        }

        const entry = {
            lineNumber,
            raw,
            pluginName,
            clientId,
            secret,
            mappedKey
        };

        if (blockedKeys.has(mappedKey)) {
            const existingConflict = audit.conflicts.find((item) => item.mappedKey === mappedKey);
            if (existingConflict) {
                existingConflict.entries.push(entry);
            } else {
                audit.conflicts.push({
                    mappedKey,
                    entries: [entry]
                });
            }
            return;
        }

        if (seen.has(mappedKey)) {
            const firstEntry = seen.get(mappedKey);
            blockedKeys.add(mappedKey);
            seen.delete(mappedKey);
            audit.validEntries = audit.validEntries.filter((item) => item.mappedKey !== mappedKey);
            audit.pluginsWithCompleteParams = audit.pluginsWithCompleteParams.filter((item) => item !== mappedKey);
            audit.conflicts.push({
                mappedKey,
                entries: [firstEntry, entry]
            });
            return;
        }

        seen.set(mappedKey, entry);
        audit.mappedEntries.push({
            lineNumber,
            pluginName,
            mappedKey,
            hasCompleteParams: true
        });
        audit.validEntries.push(entry);
        audit.pluginsWithCompleteParams.push(mappedKey);
    });

    audit.pluginsWithoutParams = Object.keys(CHANNEL_SETUP_DEFS)
        .filter((key) => !audit.pluginsWithCompleteParams.includes(key));

    return audit;
}

module.exports = {
    CHANNEL_SETUP_DEFS,
    CHANNEL_NAME_ALIASES,
    DESKTOP_PLUGIN_PARAMETER_FILE,
    normalizePluginAliasName,
    resolvePluginAlias,
    parsePluginParameterText
};
