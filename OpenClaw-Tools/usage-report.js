const fs = require('fs');
const path = require('path');

function createUsageTotals() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0
    };
}

function addUsageTotals(target, usage) {
    if (!target || !usage) return target;
    target.input += Number(usage.input || 0);
    target.output += Number(usage.output || 0);
    target.cacheRead += Number(usage.cacheRead || 0);
    target.cacheWrite += Number(usage.cacheWrite || 0);
    target.totalTokens += Number(usage.totalTokens || 0);
    target.totalCost += Number(usage.totalCost || 0);
    return target;
}

function buildEmptyMessageCounts() {
    return {
        total: 0,
        user: 0,
        assistant: 0,
        toolResults: 0,
        errors: 0
    };
}

function extractSessionIdFromTranscriptFileName(fileName) {
    if (!fileName.endsWith('.jsonl') && !fileName.includes('.jsonl.reset.')) return undefined;
    return fileName
        .replace(/\.reset\..+$/, '')
        .replace(/\.deleted\.jsonl$/, '')
        .replace(/\.jsonl$/, '');
}

function normalizeUsageContent(value) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || undefined;
    }

    if (Array.isArray(value)) {
        const chunks = value
            .map((item) => normalizeUsageContent(item))
            .filter(Boolean);
        return chunks.length ? chunks.join('\n\n') : undefined;
    }

    if (value && typeof value === 'object') {
        const record = value;
        if (typeof record.text === 'string') {
            const trimmed = record.text.trim();
            if (trimmed) return trimmed;
        }
        if (typeof record.content === 'string') {
            const trimmed = record.content.trim();
            if (trimmed) return trimmed;
        }
        if (Array.isArray(record.content)) {
            return normalizeUsageContent(record.content);
        }
        if (typeof record.thinking === 'string') {
            const trimmed = record.thinking.trim();
            if (trimmed) return trimmed;
        }
        try {
            return JSON.stringify(record, null, 2);
        } catch (_) {
            return undefined;
        }
    }

    return undefined;
}

function normalizeTimestampMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function normalizeUsageShape(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const input = Number(usage.input ?? usage.promptTokens ?? 0) || 0;
    const output = Number(usage.output ?? usage.completionTokens ?? 0) || 0;
    const cacheRead = Number(usage.cacheRead ?? 0) || 0;
    const cacheWrite = Number(usage.cacheWrite ?? 0) || 0;
    const totalTokens = Number(usage.total ?? usage.totalTokens ?? (input + output + cacheRead + cacheWrite)) || 0;
    const totalCost = Number(usage?.cost?.total ?? 0) || 0;

    if (totalTokens <= 0) return null;

    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        totalCost
    };
}

function parseUsageEntriesFromJsonl(content, context, limit) {
    const entries = [];
    const lines = String(content || '').split(/\r?\n/).filter(Boolean);
    const maxEntries = typeof limit === 'number' && Number.isFinite(limit)
        ? Math.max(Math.floor(limit), 0)
        : Number.POSITIVE_INFINITY;

    for (let index = lines.length - 1; index >= 0 && entries.length < maxEntries; index -= 1) {
        let parsed;
        try {
            parsed = JSON.parse(lines[index]);
        } catch (_) {
            continue;
        }

        const message = parsed?.message;
        if (!message || !parsed?.timestamp) continue;

        if (message.role === 'assistant' && message.usage) {
            const usage = normalizeUsageShape(message.usage);
            if (!usage) continue;
            const contentText = normalizeUsageContent(message.content);
            entries.push({
                timestamp: parsed.timestamp,
                sessionId: context.sessionId,
                agentId: context.agentId,
                model: message.model ?? message.modelRef,
                provider: message.provider,
                ...(contentText ? { content: contentText } : {}),
                inputTokens: usage.input,
                outputTokens: usage.output,
                cacheReadTokens: usage.cacheRead,
                cacheWriteTokens: usage.cacheWrite,
                totalTokens: usage.totalTokens,
                costUsd: usage.totalCost
            });
            continue;
        }

        if (message.role !== 'toolResult' || !message.details) continue;

        const usage = normalizeUsageShape(message.details.usage);
        if (!usage) continue;

        const provider = message.details.provider ?? message.details?.externalContent?.provider ?? message.provider;
        const model = message.details.model ?? message.model ?? message.modelRef;
        const contentText = normalizeUsageContent(message.details.content) ?? normalizeUsageContent(message.content);
        entries.push({
            timestamp: parsed.timestamp,
            sessionId: context.sessionId,
            agentId: context.agentId,
            model,
            provider,
            ...(contentText ? { content: contentText } : {}),
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            totalTokens: usage.totalTokens,
            costUsd: usage.totalCost
        });
    }

    return entries;
}

function getLocalDateKey(timestampMs) {
    const date = new Date(timestampMs);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function detectChannelFromText(text) {
    const source = String(text || '');
    if (!source) return '';

    const patterns = [
        /"message_id"\s*:\s*"openclaw-([a-z0-9_-]+):/i,
        /channel\s*=\s*([a-z0-9_-]+)/i,
        /"channel"\s*:\s*"([a-z0-9_-]+)"/i,
        /投递目标[:：]\s*([a-z0-9_-]+)/i,
        /投递目标\s+([a-z0-9_-]+)\s*:/i,
        /渠道[:：]\s*([a-z0-9_-]+)/i,
        /你正在通过\s*QQ\s*与用户对话/i,
        /你正在通过\s*Telegram\s*与用户对话/i,
        /你正在通过\s*企业微信\s*与用户对话/i,
        /你正在通过\s*微信\s*与用户对话/i,
        /你正在通过\s*飞书\s*与用户对话/i,
        /你正在通过\s*钉钉\s*与用户对话/i
    ];

    for (const pattern of patterns) {
        const match = source.match(pattern);
        if (match?.[1]) return String(match[1]).trim().toLowerCase();
        if (/QQ/i.test(pattern.source) && pattern.test(source)) return 'qqbot';
        if (/Telegram/i.test(pattern.source) && pattern.test(source)) return 'telegram';
        if (/企业微信/i.test(pattern.source) && pattern.test(source)) return 'wecom';
        if (/微信/i.test(pattern.source) && !/企业微信/i.test(pattern.source) && pattern.test(source)) return 'weixin';
        if (/飞书/i.test(pattern.source) && pattern.test(source)) return 'feishu';
        if (/钉钉/i.test(pattern.source) && pattern.test(source)) return 'dingtalk';
    }

    return '';
}

function extractSessionDisplayNameFromKey(sessionKey) {
    const raw = String(sessionKey || '').trim();
    if (!raw) return '';
    const parts = raw.split(':').filter(Boolean);
    if (parts[0] === 'agent' && parts.length >= 3) {
        return parts[2];
    }
    return raw;
}

function listAgentIds(openClawHomeDir) {
    const agentIds = new Set(['main']);
    const configPath = path.join(openClawHomeDir, 'openclaw.json');

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const configuredAgents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
        for (const entry of configuredAgents) {
            const agentId = String(entry?.id || '').trim();
            if (agentId) agentIds.add(agentId);
        }
        const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
        for (const binding of bindings) {
            const agentId = String(binding?.agentId || '').trim();
            if (agentId) agentIds.add(agentId);
        }
    } catch (_) {}

    const agentsDir = path.join(openClawHomeDir, 'agents');
    try {
        for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const agentId = String(entry.name || '').trim();
            if (agentId) agentIds.add(agentId);
        }
    } catch (_) {}

    return Array.from(agentIds);
}

function listSessionFiles(openClawHomeDir) {
    const files = [];
    const agentsDir = path.join(openClawHomeDir, 'agents');

    for (const agentId of listAgentIds(openClawHomeDir)) {
        const sessionDir = path.join(agentsDir, agentId, 'sessions');
        let entries = [];
        try {
            entries = fs.readdirSync(sessionDir, { withFileTypes: true });
        } catch (_) {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const sessionId = extractSessionIdFromTranscriptFileName(entry.name);
            if (!sessionId) continue;
            const filePath = path.join(sessionDir, entry.name);
            let stat = null;
            try {
                stat = fs.statSync(filePath);
            } catch (_) {
                stat = null;
            }
            files.push({
                filePath,
                sessionId,
                agentId,
                mtimeMs: stat?.mtimeMs || 0
            });
        }
    }

    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return files;
}

function updateDailyMap(dailyMap, dateKey, patch) {
    if (!dailyMap[dateKey]) {
        dailyMap[dateKey] = {
            date: dateKey,
            tokens: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            messages: 0
        };
    }

    const day = dailyMap[dateKey];
    day.tokens += Number(patch.tokens || 0);
    day.input += Number(patch.input || 0);
    day.output += Number(patch.output || 0);
    day.cacheRead += Number(patch.cacheRead || 0);
    day.cacheWrite += Number(patch.cacheWrite || 0);
    day.cost += Number(patch.cost || 0);
    day.messages += Number(patch.messages || 0);
}

function createAggregateBucket(seed = {}) {
    return {
        count: 0,
        totals: createUsageTotals(),
        ...seed
    };
}

function addAggregateUsage(bucket, usage, countDelta = 0) {
    bucket.count += countDelta;
    addUsageTotals(bucket.totals, usage);
    return bucket;
}

function parseSessionTranscript(file, rangeStartMs, rangeEndMs) {
    const raw = fs.readFileSync(file.filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const session = {
        key: `agent:${file.agentId}:${file.sessionId}`,
        sessionId: file.sessionId,
        agentId: file.agentId,
        displayName: '',
        sessionKey: '',
        provider: '',
        model: '',
        channel: '',
        startedAt: '',
        updatedAt: '',
        usage: createUsageTotals(),
        messageCounts: buildEmptyMessageCounts(),
        hasActivity: false
    };
    const usageEntries = [];
    const toolCounts = {};
    const dailyMessages = {};

    for (const line of lines) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch (_) {
            continue;
        }

        const timestampMs = normalizeTimestampMs(parsed?.timestamp ?? parsed?.message?.timestamp);
        if (timestampMs) {
            if (!session.startedAt) session.startedAt = new Date(timestampMs).toISOString();
            session.updatedAt = new Date(timestampMs).toISOString();
        }

        if (parsed?.type === 'model_change') {
            session.provider = String(parsed.provider || session.provider || '').trim();
            session.model = String(parsed.modelId || session.model || '').trim();
        }

        const message = parsed?.message;
        if (!message || !timestampMs) continue;

        if (message.role === 'toolResult') {
            const sessionKey = String(message?.details?.sessionKey || '').trim();
            if (sessionKey) {
                session.sessionKey = sessionKey;
                if (!session.displayName) {
                    session.displayName = extractSessionDisplayNameFromKey(sessionKey);
                }
                if (!session.channel) {
                    const keyChannel = detectChannelFromText(sessionKey);
                    if (keyChannel) session.channel = keyChannel;
                }
            }
        }

        const inRange = timestampMs >= rangeStartMs && timestampMs <= rangeEndMs;
        if (!session.channel && message.role === 'user') {
            const contentText = normalizeUsageContent(message.content) || '';
            const detectedChannel = detectChannelFromText(contentText);
            if (detectedChannel) session.channel = detectedChannel;
            if (!session.displayName) {
                const metadataSessionKeyMatch = contentText.match(/"message_id"\s*:\s*"openclaw-([a-z0-9_-]+):/i);
                if (metadataSessionKeyMatch?.[1]) {
                    session.displayName = `openclaw-${String(metadataSessionKeyMatch[1]).trim().toLowerCase()}`;
                }
            }
        }

        if (!inRange) {
            if (message.role === 'assistant') {
                session.provider = String(message.provider || session.provider || '').trim();
                session.model = String(message.model || message.modelRef || session.model || '').trim();
            }
            continue;
        }

        session.hasActivity = true;
        session.messageCounts.total += 1;
        if (message.role === 'user') session.messageCounts.user += 1;
        if (message.role === 'assistant') session.messageCounts.assistant += 1;
        if (message.role === 'toolResult') session.messageCounts.toolResults += 1;

        const dateKey = getLocalDateKey(timestampMs);
        updateDailyMap(dailyMessages, dateKey, { messages: 1 });

        if (message.role === 'assistant') {
            session.provider = String(message.provider || session.provider || '').trim();
            session.model = String(message.model || message.modelRef || session.model || '').trim();
            if (message.stopReason === 'error' || message.errorMessage) {
                session.messageCounts.errors += 1;
            }

            const usage = normalizeUsageShape(message.usage);
            if (usage) {
                addUsageTotals(session.usage, usage);
                usageEntries.push({
                    timestamp: new Date(timestampMs).toISOString(),
                    sessionId: file.sessionId,
                    agentId: file.agentId,
                    model: session.model || undefined,
                    provider: session.provider || undefined,
                    inputTokens: usage.input,
                    outputTokens: usage.output,
                    cacheReadTokens: usage.cacheRead,
                    cacheWriteTokens: usage.cacheWrite,
                    totalTokens: usage.totalTokens,
                    costUsd: usage.totalCost
                });
                updateDailyMap(dailyMessages, dateKey, {
                    tokens: usage.totalTokens,
                    input: usage.input,
                    output: usage.output,
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                    cost: usage.totalCost
                });
            }
            continue;
        }

        if (message.role !== 'toolResult') continue;

        const toolName = String(message.toolName || '').trim();
        if (toolName) {
            toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
        }
        if (message.isError || message?.details?.status === 'error') {
            session.messageCounts.errors += 1;
        }

        const usage = normalizeUsageShape(message?.details?.usage);
        if (!usage) continue;

        const provider = String(
            message?.details?.provider
            || message?.details?.externalContent?.provider
            || message.provider
            || session.provider
            || ''
        ).trim();
        const model = String(message?.details?.model || message.model || message.modelRef || session.model || '').trim();
        if (provider) session.provider = provider;
        if (model) session.model = model;

        addUsageTotals(session.usage, usage);
        usageEntries.push({
            timestamp: new Date(timestampMs).toISOString(),
            sessionId: file.sessionId,
            agentId: file.agentId,
            model: model || undefined,
            provider: provider || undefined,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            totalTokens: usage.totalTokens,
            costUsd: usage.totalCost
        });
        updateDailyMap(dailyMessages, dateKey, {
            tokens: usage.totalTokens,
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            cost: usage.totalCost
        });
    }

    if (!session.channel) session.channel = 'unknown';
    if (!session.displayName) {
        session.displayName = extractSessionDisplayNameFromKey(session.sessionKey) || '';
    }
    return { session, usageEntries, toolCounts, dailyMessages };
}

function finalizeAggregateArray(items, projector) {
    return Array.from(items.values())
        .map(projector)
        .sort((left, right) => {
            const costDiff = Number(right?.totals?.totalCost || 0) - Number(left?.totals?.totalCost || 0);
            if (costDiff !== 0) return costDiff;
            const tokenDiff = Number(right?.totals?.totalTokens || 0) - Number(left?.totals?.totalTokens || 0);
            if (tokenDiff !== 0) return tokenDiff;
            return Number(right?.count || 0) - Number(left?.count || 0);
        });
}

function buildUsageReport(openClawHomeDir, days = 7) {
    const safeDays = Number.isFinite(Number(days)) ? Math.max(1, Math.floor(Number(days))) : 7;
    const now = new Date();
    const rangeEndMs = now.getTime();
    const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    rangeStart.setDate(rangeStart.getDate() - (safeDays - 1));
    const rangeStartMs = rangeStart.getTime();

    const totals = createUsageTotals();
    const messageTotals = buildEmptyMessageCounts();
    const toolCounts = {};
    const byModel = new Map();
    const byProvider = new Map();
    const byAgent = new Map();
    const byChannel = new Map();
    const dailyMap = {};
    const sessions = [];

    for (let cursor = new Date(rangeStartMs); cursor.getTime() <= rangeEndMs; cursor.setDate(cursor.getDate() + 1)) {
        const key = getLocalDateKey(cursor.getTime());
        dailyMap[key] = {
            date: key,
            tokens: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            messages: 0
        };
    }

    for (const file of listSessionFiles(openClawHomeDir)) {
        let parsed = null;
        try {
            parsed = parseSessionTranscript(file, rangeStartMs, rangeEndMs);
        } catch (_) {
            parsed = null;
        }
        if (!parsed || !parsed.session.hasActivity) continue;

        const { session, usageEntries, toolCounts: sessionTools, dailyMessages } = parsed;
        addUsageTotals(totals, session.usage);
        messageTotals.total += session.messageCounts.total;
        messageTotals.user += session.messageCounts.user;
        messageTotals.assistant += session.messageCounts.assistant;
        messageTotals.toolResults += session.messageCounts.toolResults;
        messageTotals.errors += session.messageCounts.errors;

        for (const [dateKey, patch] of Object.entries(dailyMessages)) {
            updateDailyMap(dailyMap, dateKey, patch);
        }

        for (const entry of usageEntries) {
            const providerKey = String(entry.provider || 'unknown').trim() || 'unknown';
            const modelKey = String(entry.model || 'unknown').trim() || 'unknown';
            const usage = {
                input: entry.inputTokens,
                output: entry.outputTokens,
                cacheRead: entry.cacheReadTokens,
                cacheWrite: entry.cacheWriteTokens,
                totalTokens: entry.totalTokens,
                totalCost: entry.costUsd || 0
            };

            if (!byProvider.has(providerKey)) {
                byProvider.set(providerKey, createAggregateBucket({ provider: providerKey }));
            }
            addAggregateUsage(byProvider.get(providerKey), usage, 1);

            const modelMapKey = `${providerKey}::${modelKey}`;
            if (!byModel.has(modelMapKey)) {
                byModel.set(modelMapKey, createAggregateBucket({ provider: providerKey, model: modelKey }));
            }
            addAggregateUsage(byModel.get(modelMapKey), usage, 1);

            const entryDateKey = getLocalDateKey(Date.parse(entry.timestamp));
            updateDailyMap(dailyMap, entryDateKey, {
                tokens: usage.totalTokens,
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                cacheWrite: usage.cacheWrite,
                cost: usage.totalCost
            });
        }

        const agentKey = String(session.agentId || 'main').trim() || 'main';
        if (!byAgent.has(agentKey)) {
            byAgent.set(agentKey, createAggregateBucket({ agentId: agentKey }));
        }
        addAggregateUsage(byAgent.get(agentKey), session.usage, 1);

        const channelKey = String(session.channel || 'unknown').trim() || 'unknown';
        if (!byChannel.has(channelKey)) {
            byChannel.set(channelKey, createAggregateBucket({ channel: channelKey }));
        }
        addAggregateUsage(byChannel.get(channelKey), session.usage, 1);

        for (const [toolName, count] of Object.entries(sessionTools)) {
            toolCounts[toolName] = (toolCounts[toolName] || 0) + Number(count || 0);
        }

        sessions.push({
            key: session.key,
            sessionId: session.sessionId,
            agentId: session.agentId,
            displayName: session.displayName || '',
            sessionKey: session.sessionKey || '',
            provider: session.provider || 'unknown',
            model: session.model || 'unknown',
            channel: session.channel || 'unknown',
            startedAt: session.startedAt,
            updatedAt: session.updatedAt,
            usage: {
                ...session.usage
            },
            messageCounts: {
                ...session.messageCounts
            }
        });
    }

    sessions.sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));

    return {
        days: safeDays,
        generatedAt: now.toISOString(),
        startDate: getLocalDateKey(rangeStartMs),
        endDate: getLocalDateKey(rangeEndMs),
        totals,
        aggregates: {
            messages: messageTotals,
            tools: {
                totalCalls: Object.values(toolCounts).reduce((sum, count) => sum + Number(count || 0), 0),
                uniqueTools: Object.keys(toolCounts).length,
                tools: Object.entries(toolCounts)
                    .map(([name, count]) => ({ name, count }))
                    .sort((left, right) => Number(right.count || 0) - Number(left.count || 0))
            },
            byModel: finalizeAggregateArray(byModel, (item) => ({
                model: item.model,
                provider: item.provider,
                count: item.count,
                totals: item.totals
            })),
            byProvider: finalizeAggregateArray(byProvider, (item) => ({
                provider: item.provider,
                count: item.count,
                totals: item.totals
            })),
            byAgent: finalizeAggregateArray(byAgent, (item) => ({
                agentId: item.agentId,
                count: item.count,
                totals: item.totals
            })),
            byChannel: finalizeAggregateArray(byChannel, (item) => ({
                channel: item.channel,
                count: item.count,
                totals: item.totals
            })),
            daily: Object.values(dailyMap).sort((left, right) => left.date.localeCompare(right.date))
        },
        sessions: sessions.slice(0, 30)
    };
}

module.exports = {
    buildUsageReport,
    extractSessionIdFromTranscriptFileName,
    parseUsageEntriesFromJsonl
};
