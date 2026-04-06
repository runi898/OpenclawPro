const { createMultiAgentStore } = require("./multi-agent-store");

const { dialog } = require("electron");

const CHANNEL_LABELS = {
    telegram: "Telegram",
    qqbot: "QQ 机器人",
    feishu: "飞书",
    lark: "飞书",
    wecom: "企业微信",
    "openclaw-weixin": "个人微信",
    dingtalk: "钉钉",
    "dingtalk-connector": "钉钉",
    discord: "Discord",
    slack: "Slack",
    signal: "Signal",
    matrix: "Matrix",
    msteams: "Teams"
};

function registerMultiAgentIpcHandlers(deps = {}) {
    const {
        ipcMain,
        BrowserWindow,
        fs,
        path,
        ensureDirectory,
        readOpenClawConfigSync,
        writeOpenClawConfigSync,
        buildRuntimeModelCatalog,
        mergeAgentIds,
        resolveAgentFilePath,
        getAgentWorkspacePath,
        ensureAgentWorkspaceFiles,
        runManagedCommand,
        runOpenClawCliCaptured,
        parseCliJsonOutput
    } = deps;
    const store = createMultiAgentStore(deps);

    const {
        MAIN_AGENT_ID,
        clone,
        nowIso,
        createId,
        normalizeAgentProfile,
        normalizeRunItem,
        normalizeWorkflowRun,
        readCollaborationSync,
        writeCollaborationSync,
        deriveRunStatus,
        getRunById,
        getRunItem,
        readConfigSafe,
        getAgentMetadataDir,
        readAvatarAsDataUrl,
        validateAssignments,
        buildGeneratedAvatar
    } = store;

    const cloneJson = (value) => JSON.parse(JSON.stringify(value ?? null));
    const workflowRuntimeSessions = new Map();

    const ensureString = (value) => String(value ?? "").trim();
    const ensureArray = (value) => Array.isArray(value) ? value : [];

    function broadcast(type, payload = {}) {
        BrowserWindow.getAllWindows().forEach((windowInstance) => {
            try {
                windowInstance.webContents.send("agent-workflow-event", { type, ...clone(payload) });
            } catch (_) {}
        });
    }

    function safeNormalizeAgentId(value = "") {
        try {
            return deps.normalizeAgentName(value || "");
        } catch (_) {
            return "";
        }
    }

    function normalizeCapabilityTags(value = []) {
        const raw = Array.isArray(value)
            ? value
            : String(value || "").split(/[,\uFF0C]/g);
        return Array.from(new Set(raw.map((entry) => String(entry || "").trim()).filter(Boolean)));
    }

    function sanitizePortableAvatar(avatar = null) {
        if (!avatar || typeof avatar !== "object") return null;
        if (ensureString(avatar.mode) !== "generated") return null;
        return {
            mode: "generated",
            seed: ensureString(avatar.seed),
            theme: ensureString(avatar.theme),
            fallbackInitial: ensureString(avatar.fallbackInitial).slice(0, 2)
        };
    }

    function sanitizePortableBindings(bindings = []) {
        return ensureArray(bindings).map((binding) => {
            const channel = ensureString(binding?.channel || "");
            const targetId = ensureString(binding?.targetId || "");
            if (!channel || !targetId) return null;
            return {
                channel,
                targetId,
                targetKind: ensureString(binding?.targetKind || ""),
                match: binding?.manual === true ? null : (binding?.match && typeof binding.match === "object" ? cloneJson(binding.match) : null),
                manual: binding?.manual === true
            };
        }).filter(Boolean);
    }

    function buildPortableTeamDraft(input = {}) {
        const root = input?.draft && typeof input.draft === "object" ? input.draft : input;
        const teamInput = root?.team && typeof root.team === "object" ? root.team : {};
        const mainAgentId = safeNormalizeAgentId(root?.mainAgentId || teamInput?.mainAgentId || MAIN_AGENT_ID) || MAIN_AGENT_ID;
        const childAgentIds = Array.from(new Set(
            ensureArray(teamInput?.childAgentIds)
                .map((entry) => safeNormalizeAgentId(entry))
                .filter(Boolean)
                .filter((entry) => entry !== mainAgentId)
        ));
        if (!childAgentIds.length) {
            throw new Error("导入或导出的团队配置至少需要 1 个子 Agent。");
        }

        const requestedFallbackAgentId = safeNormalizeAgentId(teamInput?.fallbackAgentId || "") || "";
        const allowedAgentIds = new Set([mainAgentId].concat(childAgentIds));
        const normalizedAgents = ensureArray(root?.agents).map((agent) => {
            const id = safeNormalizeAgentId(agent?.id || "");
            if (!id || !allowedAgentIds.has(id)) return null;
            return {
                id,
                name: ensureString(agent?.name || id) || id,
                model: ensureString(agent?.model || ""),
                workspace: ensureString(agent?.workspace || ""),
                agentDir: ensureString(agent?.agentDir || ""),
                roleTitle: ensureString(agent?.roleTitle || (id === mainAgentId ? "主 Agent" : "子 Agent")) || (id === mainAgentId ? "主 Agent" : "子 Agent"),
                responsibilities: ensureString(agent?.responsibilities || ""),
                capabilityTags: normalizeCapabilityTags(agent?.capabilityTags || agent?.capabilities || []),
                fallbackExecution: false,
                identityContent: String(agent?.identityContent || ""),
                soulContent: String(agent?.soulContent || ""),
                userContent: String(agent?.userContent || ""),
                agentsContent: String(agent?.agentsContent || ""),
                toolsContent: String(agent?.toolsContent || ""),
                avatar: sanitizePortableAvatar(agent?.avatar),
                bindings: sanitizePortableBindings(agent?.bindings || [])
            };
        }).filter(Boolean);

        const mainAgent = normalizedAgents.find((agent) => agent.id === mainAgentId);
        if (!mainAgent) {
            throw new Error("团队配置缺少主 Agent。");
        }
        const missingChildId = childAgentIds.find((agentId) => !normalizedAgents.some((agent) => agent.id === agentId));
        if (missingChildId) {
            throw new Error(`团队配置缺少子 Agent「${missingChildId}」的资料。`);
        }
        const fallbackAgentId = childAgentIds.includes(requestedFallbackAgentId)
            ? requestedFallbackAgentId
            : "";
        normalizedAgents.forEach((agent) => {
            agent.fallbackExecution = agent.id === fallbackAgentId;
        });

        return {
            mainAgentId,
            team: {
                name: ensureString(teamInput?.name || "默认团队") || "默认团队",
                mainAgentId,
                childAgentIds,
                dispatchMode: ensureString(teamInput?.dispatchMode || "auto") === "manual" ? "manual" : "auto",
                templateId: ensureString(teamInput?.templateId || "custom") || "custom",
                fallbackAgentId,
                strictDispatchOnly: teamInput?.strictDispatchOnly !== false
            },
            agents: [mainAgent].concat(childAgentIds.map((agentId) => normalizedAgents.find((agent) => agent.id === agentId)).filter(Boolean))
        };
    }

    function buildPortableTeamExportDocument(input = {}) {
        const draft = buildPortableTeamDraft(input);
        return {
            format: "openclaw-agent-team-config",
            version: 1,
            exportedAt: nowIso(),
            source: {
                app: "OpenClaw Tools",
                teamName: draft.team.name,
                mainAgentId: draft.mainAgentId
            },
            draft
        };
    }

    function parsePortableTeamImportDocument(fileContent = "") {
        let parsed;
        try {
            parsed = JSON.parse(String(fileContent || ""));
        } catch (error) {
            throw new Error(`导入文件不是合法的 JSON：${error.message}`);
        }
        const draft = buildPortableTeamDraft(parsed?.draft && typeof parsed.draft === "object" ? parsed.draft : parsed);
        return {
            draft,
            meta: {
                format: ensureString(parsed?.format || ""),
                version: Number(parsed?.version || 0) || 0,
                exportedAt: ensureString(parsed?.exportedAt || ""),
                teamName: draft.team.name,
                mainAgentId: draft.mainAgentId
            }
        };
    }

    function buildPortableTeamFileName(teamName = "", mainAgentId = "") {
        const base = ensureString(teamName || mainAgentId || "team-config")
            .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 80);
        return `${base || "team-config"}.json`;
    }

    function parsePlanText(text = "") {
        const trimmed = String(text || "").trim();
        const fenceMatches = Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) => match[1].trim());
        const candidates = fenceMatches.slice();
        const firstBrace = trimmed.indexOf("{");
        const lastBrace = trimmed.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
        }
        for (const candidate of candidates) {
            try {
                return { jsonText: candidate, plan: JSON.parse(candidate) };
            } catch (_) {}
        }
        return { jsonText: "", plan: null };
    }

    function resolveFallbackChildAgent(collaboration = {}) {
        const childAgents = getChildAgentProfiles(collaboration);
        return childAgents.find((agent) => agent.fallbackExecution)
            || null;
    }

    function normalizeGreetingProbeText(value = "") {
        return ensureString(value)
            .toLowerCase()
            .replace(/[\s\p{P}\p{S}]+/gu, "");
    }

    function isFallbackGreetingLikeMessage(message = "") {
        const normalized = normalizeGreetingProbeText(message);
        if (!normalized) return false;
        const greetingSamples = new Set([
            "你好",
            "您好",
            "你好呀",
            "你好啊",
            "嗨",
            "嗨呀",
            "哈喽",
            "哈啰",
            "嘿",
            "在吗",
            "在嘛",
            "在不在",
            "有人吗",
            "忙吗",
            "hi",
            "hello",
            "hey"
        ]);
        return greetingSamples.has(normalized);
    }

    function normalizeRoutingRuleText(value = "") {
        return ensureString(value)
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
    }

    function isCorruptedQuestionMarkText(value = "") {
        const trimmed = ensureString(value).trim();
        if (!trimmed) return false;
        if (!/[?？�]/.test(trimmed)) return false;
        const normalized = trimmed.replace(/[?？�\s\.,;:!！、，。；：“”"'‘’()（）\[\]【】\-_/]+/g, "");
        return normalized.length === 0;
    }

    const GENERIC_CHILD_RESPONSIBILITIES = new Set([
        "负责执行主 Agent 派发的具体任务，并输出可汇总结果。",
        "负责执行主agent派发的具体任务，并输出可汇总结果。",
        "负责执行主 agent 派发的具体任务，并输出可汇总结果。"
    ]);

    function inferAgentSpecializationDefaults(agentId = "", label = "", roleTitle = "") {
        const normalizedId = safeNormalizeAgentId(agentId || "");
        const normalizedLabel = normalizeRoutingRuleText(label);
        const normalizedRole = normalizeRoutingRuleText(roleTitle);
        if (normalizedRole.includes("主 agent") || normalizedRole.includes("主agent")) {
            return {
                responsibilities: "负责接单、拆解、派单、监控、回收和最终汇总，不直接执行用户主任务。",
                capabilityTags: ["dispatch", "coordination"]
            };
        }
        if (normalizedId === "writer" || normalizedLabel.includes("写手") || normalizedLabel.includes("文案")) {
            return {
                responsibilities: "负责文案撰写、文章输出、改写润色和内容交付。",
                capabilityTags: ["writing", "copywriting", "editing"]
            };
        }
        if (normalizedId === "coder" || normalizedLabel.includes("代码") || normalizedLabel.includes("程序")) {
            return {
                responsibilities: "负责代码开发、脚本实现、技术排查和修复。",
                capabilityTags: ["coding", "development", "debug"]
            };
        }
        if (normalizedId === "brainstorm" || normalizedLabel.includes("创意") || normalizedLabel.includes("策划")) {
            return {
                responsibilities: "负责创意策划、头脑风暴、方案构思和选题方向。",
                capabilityTags: ["ideation", "planning", "strategy"]
            };
        }
        if (normalizedId === "backstop" || normalizedLabel.includes("兜底")) {
            return {
                responsibilities: "负责兜底执行没有匹配专职角色的任务，并处理模糊任务、查询资料和通用杂活。",
                capabilityTags: ["generalist", "research", "execution"]
            };
        }
        return {
            responsibilities: "",
            capabilityTags: []
        };
    }

    function resolveAgentResponsibilities(rawResponsibilities = "", agentId = "", label = "", roleTitle = "") {
        const trimmed = ensureString(rawResponsibilities).trim();
        if (
            trimmed
            && !isCorruptedQuestionMarkText(trimmed)
            && !GENERIC_CHILD_RESPONSIBILITIES.has(trimmed.toLowerCase())
            && !GENERIC_CHILD_RESPONSIBILITIES.has(trimmed)
        ) {
            return trimmed;
        }
        return inferAgentSpecializationDefaults(agentId, label, roleTitle).responsibilities || trimmed;
    }

    function resolveAgentCapabilityTags(rawTags = [], agentId = "", label = "", roleTitle = "") {
        const normalized = normalizeCapabilityTags(rawTags || []);
        if (normalized.length) return normalized;
        return normalizeCapabilityTags(inferAgentSpecializationDefaults(agentId, label, roleTitle).capabilityTags || []);
    }

    function resolveAgentRoleTitle(rawTitle = "", isMain = false) {
        const trimmed = ensureString(rawTitle).trim();
        if (trimmed && !isCorruptedQuestionMarkText(trimmed)) return trimmed;
        return isMain ? "主 Agent" : "子 Agent";
    }

    function matchesAnyRoutingKeyword(message = "", patterns = []) {
        const normalized = normalizeRoutingRuleText(message);
        if (!normalized) return false;
        return patterns.some((pattern) => {
            if (!pattern) return false;
            if (pattern instanceof RegExp) return pattern.test(normalized);
            return normalized.includes(String(pattern).toLowerCase());
        });
    }

    function isExplicitCodingTaskMessage(message = "") {
        return matchesAnyRoutingKeyword(message, [
            "python",
            "javascript",
            "typescript",
            "java",
            "c++",
            "golang",
            "node.js",
            "nodejs",
            "sql",
            "html",
            "css",
            "shell",
            "powershell",
            "bash",
            "脚本",
            "代码",
            "编程",
            "开发",
            "修复bug",
            "修 bug",
            "报错",
            "接口",
            "函数",
            "算法",
            "程序员",
            "git",
            "debug"
        ]);
    }

    function isExplicitWritingTaskMessage(message = "") {
        return matchesAnyRoutingKeyword(message, [
            "文案",
            "公众号",
            "推文",
            "文章",
            "稿子",
            "润色",
            "改写",
            "写一篇",
            "写个",
            "写一段",
            "标题",
            "摘要",
            "宣传语",
            "小红书",
            "朋友圈文案",
            "邮件正文",
            "新闻稿"
        ]);
    }

    function isExplicitIdeationTaskMessage(message = "") {
        return matchesAnyRoutingKeyword(message, [
            "头脑风暴",
            "brainstorm",
            "创意",
            "策划",
            "方案",
            "点子",
            "选题",
            "构思",
            "思路"
        ]);
    }

    function isExplicitAnalysisTaskMessage(message = "") {
        return matchesAnyRoutingKeyword(message, [
            "分析",
            "报表",
            "数据",
            "统计",
            "趋势",
            "汇总",
            "复盘",
            "监控",
            "report",
            "analysis",
            "metrics",
            "dashboard"
        ]);
    }

    function isFallbackLookupLikeMessage(message = "") {
        if (!message) return false;
        if (isExplicitCodingTaskMessage(message)) return false;
        if (isExplicitWritingTaskMessage(message)) return false;
        if (isExplicitIdeationTaskMessage(message)) return false;
        if (isExplicitAnalysisTaskMessage(message)) return false;
        return matchesAnyRoutingKeyword(message, [
            "帮我看看",
            "帮我查",
            "查一下",
            "查一查",
            "查查",
            "查询",
            "搜一下",
            "搜一搜",
            "搜索",
            "帮我找",
            "找一下",
            "找找",
            "有没有",
            "票",
            "余票",
            "动车",
            "高铁",
            "火车",
            "机票",
            "航班",
            "酒店",
            "餐厅",
            "天气",
            "路线",
            "路程",
            "时刻表",
            "资料",
            "信息",
            "攻略",
            "价格",
            "费用",
            "地址",
            "电话",
            "位置",
            "怎么去",
            "怎么走",
            "要多久"
        ]);
    }

    function getHeuristicIntent(message = "") {
        if (isExplicitCodingTaskMessage(message)) return "coding";
        if (isExplicitWritingTaskMessage(message)) return "writing";
        if (isExplicitIdeationTaskMessage(message)) return "ideation";
        if (isExplicitAnalysisTaskMessage(message)) return "analysis";
        if (isFallbackLookupLikeMessage(message)) return "lookup";
        if (isFallbackGreetingLikeMessage(message)) return "chat";
        return "";
    }

    function getAgentRoutingCorpus(agent = {}) {
        return normalizeRoutingRuleText([
            ensureString(agent.agentId),
            ensureString(agent.label),
            ensureString(agent.title),
            ensureString(agent.responsibilities),
            ensureArray(agent.capabilityTags).join(" ")
        ].filter(Boolean).join(" "));
    }

    function getIntentRoutingPatterns(intent = "") {
        switch (intent) {
            case "coding":
                return ["code", "coding", "coder", "developer", "development", "program", "script", "debug", "bug", "工程", "开发", "代码", "脚本", "程序"];
            case "writing":
                return ["write", "writer", "writing", "copy", "copywriting", "content", "editor", "editing", "article", "文案", "写作", "润色", "改写", "内容", "稿"];
            case "ideation":
                return ["brainstorm", "ideation", "creative", "strategy", "planning", "plan", "策划", "创意", "方案", "构思", "选题", "头脑风暴"];
            case "analysis":
                return ["analysis", "report", "metrics", "dashboard", "monitor", "统计", "分析", "报表", "数据", "趋势", "复盘", "监控"];
            case "lookup":
                return ["research", "search", "lookup", "retrieval", "compare", "comparison", "investigation", "data-collection", "researcher", "查询", "搜索", "检索", "资料", "研究", "比价", "票务", "路线", "天气", "travel"];
            default:
                return [];
        }
    }

    function scoreAgentForIntent(agent = {}, intent = "") {
        if (!agent || agent.fallbackExecution === true) return 0;
        const corpus = getAgentRoutingCorpus(agent);
        if (!corpus) return 0;
        return getIntentRoutingPatterns(intent).reduce((score, pattern) => (
            corpus.includes(pattern) ? score + 1 : score
        ), 0);
    }

    function pickSpecialistChildAgent(intent = "", collaboration = {}) {
        if (!intent || intent === "chat") return null;
        const candidates = getChildAgentProfiles(collaboration)
            .map((agent) => ({ agent, score: scoreAgentForIntent(agent, intent) }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => {
                if (right.score !== left.score) return right.score - left.score;
                return String(left.agent.agentId || "").localeCompare(String(right.agent.agentId || ""));
            });
        return candidates[0]?.agent || null;
    }

    function buildHeuristicDispatchPlan(run = {}, collaboration = {}) {
        const fallbackAgent = resolveFallbackChildAgent(collaboration);
        const originalMessage = ensureString(run.message || run.summary || run.name) || "请完成当前用户任务";
        const intent = getHeuristicIntent(originalMessage);
        if (!intent || intent === "chat") return null;
        const specialistAgent = pickSpecialistChildAgent(intent, collaboration);
        const targetAgent = specialistAgent || fallbackAgent;
        if (!targetAgent?.agentId) return null;
        const isFallbackRoute = !specialistAgent;
        const deliverableByIntent = {
            coding: "完成这条明确的代码/脚本/开发任务，并返回可供主 Agent 汇总的结果。",
            writing: "完成这条明确的写作/文案任务，并返回可供主 Agent 汇总的结果。",
            ideation: "完成这条明确的创意/策划/方案构思任务，并返回可供主 Agent 汇总的结果。",
            analysis: "完成这条明确的分析/报表/数据整理任务，并返回可供主 Agent 汇总的结果。",
            lookup: "完成这条查询/检索/资料/票务路线类任务，并返回可供主 Agent 汇总的结果。"
        };
        const reasonByIntent = {
            coding: isFallbackRoute
                ? "用户提出了明确执行任务，但团队里没有匹配的代码执行 Agent，按规则转交兜底 Agent。"
                : `用户提出了明确代码执行任务，优先交给更匹配的子 Agent：${targetAgent.agentId}。`,
            writing: isFallbackRoute
                ? "用户提出了明确执行任务，但团队里没有匹配的写作 Agent，按规则转交兜底 Agent。"
                : `用户提出了明确写作任务，优先交给更匹配的子 Agent：${targetAgent.agentId}。`,
            ideation: isFallbackRoute
                ? "用户提出了明确执行任务，但团队里没有匹配的策划/创意 Agent，按规则转交兜底 Agent。"
                : `用户提出了明确策划/创意任务，优先交给更匹配的子 Agent：${targetAgent.agentId}。`,
            analysis: isFallbackRoute
                ? "用户提出了明确执行任务，但团队里没有匹配的分析 Agent，按规则转交兜底 Agent。"
                : `用户提出了明确分析任务，优先交给更匹配的子 Agent：${targetAgent.agentId}。`,
            lookup: isFallbackRoute
                ? "这是一条具体执行查询任务，但团队里没有更匹配的查询/研究型 Agent，按规则转交兜底 Agent。"
                : `这是一条具体执行查询任务，优先交给更匹配的子 Agent：${targetAgent.agentId}。`
        };
        const contextByIntent = {
            coding: "如果用户后续补充技术细节或报错信息，继续按代码任务承接。",
            writing: "如果用户后续补充风格、字数、受众要求，继续按写作任务承接。",
            ideation: "如果用户后续补充方向、限制和目标，继续按策划任务承接。",
            analysis: "如果用户后续补充数据源、指标或格式要求，继续按分析任务承接。",
            lookup: "如果用户后续把问题收敛为明确写作、策划、分析或代码需求，再回传主 Agent 做二次专业派单。"
        };
        return {
            assignments: [
                {
                    agentId: targetAgent.agentId,
                    objective: originalMessage,
                    deliverable: deliverableByIntent[intent] || "直接完成用户请求，并返回可供主 Agent 汇总的结果。",
                    reason: reasonByIntent[intent] || "系统已根据任务类型自动匹配执行 Agent。",
                    context: contextByIntent[intent] || ""
                }
            ],
            collectionBrief: "请基于子 Agent 的执行结果整理最终答复，直接返回给用户。",
            heuristicNote: isFallbackRoute
                ? `系统已检测到这是 ${intent} 类型执行任务，但没有匹配专职 Agent，已按规则转交兜底 Agent。`
                : `系统已检测到这是 ${intent} 类型执行任务，已优先派给匹配的专职 Agent。`,
            heuristicResultSummary: isFallbackRoute
                ? "系统已按兜底规则自动派单。"
                : "系统已按专职匹配规则自动派单。"
        };
    }

    function buildFallbackDispatchPlan(run = {}, collaboration = {}, failureReason = "") {
        const fallbackAgent = resolveFallbackChildAgent(collaboration);
        if (!fallbackAgent?.agentId) return null;
        const originalMessage = ensureString(run.message || run.summary || run.name) || "请完成当前用户任务";
        const summary = ensureString(run.summary || run.name) || originalMessage;
        const reason = ensureString(failureReason)
            || "主 Agent 没有返回结构化派单计划，系统按兜底规则自动改派。";
        return {
            assignments: [
                {
                    agentId: fallbackAgent.agentId,
                    objective: originalMessage,
                    deliverable: "直接完成用户请求，并返回可供主 Agent 汇总的结果。",
                    reason,
                    context: `原始任务：${summary}`
                }
            ],
            collectionBrief: "请基于子 Agent 的执行结果整理最终答复，直接返回给用户。"
        };
    }

    function summarizeLogText(text = "", limit = 520) {
        const lines = String(text || "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !/^\[command finished]/i.test(line))
            .filter((line) => !/^\[exec error]/i.test(line));
        const summary = lines.slice(-10).join("\n");
        if (!summary) return "";
        return summary.length > limit ? `${summary.slice(0, limit)}...` : summary;
    }

    function getWorkflowRun(mainAgentId = MAIN_AGENT_ID, runId = "") {
        const result = readCollaborationSync(mainAgentId);
        const collaboration = clone(result.data);
        const run = getRunById(collaboration, runId);
        if (!run) throw new Error(`Workflow not found: ${runId}`);
        return {
            mainAgentId: result.mainAgentId,
            collaboration,
            run
        };
    }

    function writeWorkflowRun(mainAgentId = MAIN_AGENT_ID, run = {}, collaboration = {}, broadcastType = "item-updated", extraPayload = {}) {
        run.updatedAt = nowIso();
        run.status = deriveRunStatus(run);
        collaboration.updatedAt = nowIso();
        const saved = writeCollaborationSync(mainAgentId, collaboration);
        const savedRun = getRunById(saved.data, run.runId);
        broadcast(broadcastType, {
            agentId: saved.mainAgentId,
            runId: run.runId,
            run: savedRun,
            ...clone(extraPayload)
        });
        return {
            mainAgentId: saved.mainAgentId,
            collaboration: saved.data,
            run: savedRun
        };
    }

    function updateWorkflowItemState(mainAgentId = MAIN_AGENT_ID, runId = "", itemId = "", patch = {}, broadcastType = "item-updated") {
        const { mainAgentId: normalizedMainId, collaboration, run } = getWorkflowRun(mainAgentId, runId);
        const item = getRunItem(run, itemId);
        if (!item) throw new Error(`Workflow item not found: ${itemId}`);
        Object.keys(patch || {}).forEach((key) => {
            const value = patch[key];
            item[key] = value && typeof value === "object" ? clone(value) : value;
        });
        if (item.status === "running" && !item.startedAt) item.startedAt = nowIso();
        if (item.status === "completed" && !item.completedAt) item.completedAt = nowIso();
        item.updatedAt = nowIso();
        return writeWorkflowRun(normalizedMainId, run, collaboration, broadcastType, { itemId: item.itemId });
    }

    function getChildAgentProfiles(collaboration = {}) {
        return ensureArray(collaboration?.topology?.childAgentIds)
            .map((agentId) => {
                const normalizedId = safeNormalizeAgentId(agentId);
                const profile = collaboration?.agents?.[normalizedId] || normalizeAgentProfile(normalizedId, {}, normalizedId);
                const label = ensureString(profile.label || normalizedId) || normalizedId;
                const title = ensureString(profile.title || profile.roleTitle || "执行专家") || "执行专家";
                return {
                    agentId: normalizedId,
                    label,
                    title,
                    responsibilities: resolveAgentResponsibilities(profile.responsibilities, normalizedId, label, title),
                    capabilityTags: resolveAgentCapabilityTags(profile.capabilityTags || [], normalizedId, label, title),
                    fallbackExecution: profile.fallbackExecution === true
                };
            })
            .filter((item) => item.agentId);
    }

    function buildPlanningCommandText(mainAgentId = MAIN_AGENT_ID, run = {}, collaboration = {}) {
        const childAgents = getChildAgentProfiles(collaboration);
        const fallbackAgent = childAgents.find((agent) => agent.fallbackExecution) || null;
        const roster = childAgents.length
            ? childAgents.map((agent) => {
                const capabilityText = agent.capabilityTags.join(", ") || "general";
                const dutyText = agent.responsibilities || agent.title || "执行具体任务";
                const fallbackText = agent.fallbackExecution ? "；兜底执行" : "";
                return `${agent.agentId}: ${agent.label} - ${dutyText}；capabilities=${capabilityText}${fallbackText}`;
            }).join(" | ")
            : "当前没有可用的子 Agent。";
        const planningTemplate = ensureString(collaboration?.dispatchPolicy?.planningPromptTemplate)
            || "你是主编排 Agent。不要亲自执行任务，只负责规划、派单、监控和汇总。";
        const prompt = [
            planningTemplate,
            "你现在正在处理一个团队工作流。",
            "主 Agent 永远不能把执行任务分配给自己。",
            "如果只是普通聊天、寒暄、问候、简单闲聊，没有明确执行目标，主 Agent 可以自己直接回复，不必派给子 Agent。",
            "如果是明确执行任务，应优先分配给最匹配的专职子 Agent。",
            collaboration?.team?.strictDispatchOnly !== false
                ? "如果没有可执行的匹配角色，也不能自己执行，只能把任务交给兜底 Agent 或在 reason 中说明团队缺少能力。"
                : "如果没有完全匹配的角色，优先交给最接近的子 Agent 或兜底 Agent。",
            fallbackAgent
                ? `没有明确匹配时，优先交给兜底执行 Agent：${fallbackAgent.agentId}。`
                : "如果没有兜底执行 Agent，请在 reason 中明确写出缺少的执行角色。",
            "写代码/脚本/开发/修 bug 优先派给代码类 Agent；写文案/文章/润色优先派给写作类 Agent；创意/策划/方案优先派给策划类 Agent；分析/报表/统计优先派给分析类 Agent；查票/路线/天气/资料/时刻表/一般信息检索优先派给查询研究类 Agent。",
            "如果没有匹配的专职 Agent，再转给兜底 Agent；不要把普通查询误派给 coder、writer、brainstorm。",
            "请只返回 JSON，不要输出解释文字。",
            "当前工作流只处理需要执行的任务；纯聊天消息不应被当成执行派单。",
            "JSON 固定结构为：{\"assignments\":[{\"agentId\":\"child-id\",\"objective\":\"...\",\"deliverable\":\"...\",\"reason\":\"...\",\"context\":\"...\"}],\"collectionBrief\":\"...\"}",
            `团队成员：${roster}`,
            `工作流标题：${ensureString(run.summary || run.name) || "未命名任务"}`,
            `用户原始消息：${ensureString(run.message || run.summary || run.name) || "未提供"}`
        ].filter(Boolean).join(" ");
        return `openclaw agent --agent ${JSON.stringify(ensureString(mainAgentId || MAIN_AGENT_ID))} --thinking ${JSON.stringify(ensureString(run?.thinking || "medium") || "medium")} --message ${JSON.stringify(prompt)}`;
    }

    function buildExecutionCommandText(run = {}, item = {}, collaboration = {}) {
        const payload = item?.structuredPayload || {};
        const agentProfile = collaboration?.agents?.[item.agentId] || normalizeAgentProfile(item.agentId, {}, item.agentId);
        const capabilityText = normalizeCapabilityTags(agentProfile.capabilityTags || []).join("、") || "未设置";
        const prompt = [
            `你是子 Agent ${ensureString(agentProfile.label || item.agentId) || item.agentId}。`,
            "你只负责执行，不负责调度团队。",
            `本次执行目标：${ensureString(payload.objective || item.taskSummary || run.summary || run.name) || "未提供"}`,
            payload.deliverable ? `预期交付：${ensureString(payload.deliverable)}` : "",
            payload.reason ? `派单原因：${ensureString(payload.reason)}` : "",
            payload.context ? `补充上下文：${ensureString(payload.context)}` : "",
            `你的能力标签：${capabilityText}`,
            `原始用户消息：${ensureString(run.message || run.summary || run.name) || "未提供"}`,
            "请直接完成执行，并输出一份适合主 Agent 汇总的结果。"
        ].filter(Boolean).join(" ");
        return `openclaw agent --agent ${JSON.stringify(ensureString(item?.agentId))} --thinking ${JSON.stringify(ensureString(run?.thinking || "medium") || "medium")} --message ${JSON.stringify(prompt)}`;
    }

    function buildCollectionCommandText(mainAgentId = MAIN_AGENT_ID, run = {}) {
        const results = ensureArray(run?.items)
            .filter((item) => ensureString(item.phase) === "execution")
            .map((item) => {
                const label = ensureString(item.label || item.agentId) || item.agentId;
                const summary = ensureString(item.resultSummary || item.note || item.error || "暂无结果") || "暂无结果";
                return `${label}: ${summary}`;
            })
            .join(" | ");
        const prompt = [
            "你是主 Agent，只负责汇总，不要重新执行任何子任务。",
            run?.plan?.collectionBrief ? `汇总要求：${ensureString(run.plan.collectionBrief)}` : "",
            `原始用户消息：${ensureString(run.message || run.summary || run.name) || "未提供"}`,
            `子 Agent 执行结果：${results || "暂无执行结果"}`,
            "请整理成最终可以直接返回给用户的完整答复。"
        ].filter(Boolean).join(" ");
        return `openclaw agent --agent ${JSON.stringify(ensureString(mainAgentId || MAIN_AGENT_ID))} --thinking ${JSON.stringify(ensureString(run?.thinking || "medium") || "medium")} --message ${JSON.stringify(prompt)}`;
    }

    function buildRuntimeKey(mainAgentId = MAIN_AGENT_ID, runId = "", itemId = "", phase = "") {
        return [ensureString(mainAgentId || MAIN_AGENT_ID), ensureString(runId), ensureString(itemId), ensureString(phase)].join(":");
    }

    function createWorkflowRuntimeSender(runtime) {
        return {
            send(channel, payload = {}) {
                handleWorkflowRuntimeEvent(runtime, channel, payload);
            },
            isDestroyed() {
                return false;
            }
        };
    }

    function flushWorkflowRuntimeProgress(runtime, force = false) {
        if (!runtime || !workflowRuntimeSessions.has(runtime.key)) return;
        if (runtime.flushTimer) {
            clearTimeout(runtime.flushTimer);
            runtime.flushTimer = null;
        }
        const combined = [runtime.stdout, runtime.stderr].filter(Boolean).join("\n");
        const summary = summarizeLogText(combined, 420);
        if (!force && summary === runtime.lastProgressSummary) return;
        runtime.lastProgressSummary = summary;
        try {
            updateWorkflowItemState(runtime.mainAgentId, runtime.runId, runtime.itemId, {
                status: "running",
                note: summary || runtime.pendingNote,
                commandSessionId: runtime.commandSessionId
            });
        } catch (_) {}
    }

    function scheduleWorkflowRuntimeProgress(runtime) {
        if (!runtime || runtime.flushTimer) return;
        runtime.flushTimer = setTimeout(() => {
            flushWorkflowRuntimeProgress(runtime, false);
        }, 320);
    }

    function handleWorkflowRuntimeEvent(runtime, channel, payload = {}) {
        if (!runtime) return;
        if (channel === "command-stream") {
            const type = ensureString(payload.type || "stdout").toLowerCase();
            const text = String(payload.text || "");
            if (type === "stderr" || type === "error") {
                runtime.stderr += text;
            } else {
                runtime.stdout += text;
            }
            scheduleWorkflowRuntimeProgress(runtime);
            return;
        }
        if (channel === "command-finished") {
            workflowRuntimeSessions.delete(runtime.key);
            finalizeWorkflowRuntime(runtime, payload).catch((error) => {
                try {
                    updateWorkflowItemState(runtime.mainAgentId, runtime.runId, runtime.itemId, {
                        status: "failed",
                        error: error.message || String(error),
                        note: error.message || String(error),
                        commandCode: String(payload?.code ?? -1)
                    });
                } catch (_) {}
            });
        }
    }

    async function finalizeWorkflowRuntime(runtime, payload = {}) {
        flushWorkflowRuntimeProgress(runtime, true);
        const exitCode = payload?.code;
        const finishedSummary = summarizeLogText([runtime.stdout, runtime.stderr].filter(Boolean).join("\n"), 720);
        const normalizedCode = String(exitCode ?? "");
        if (normalizedCode !== "0") {
            updateWorkflowItemState(runtime.mainAgentId, runtime.runId, runtime.itemId, {
                status: "failed",
                error: finishedSummary || `命令退出码：${normalizedCode || "-1"}`,
                note: finishedSummary || runtime.pendingNote,
                commandCode: normalizedCode
            });
            return;
        }

        if (runtime.phase === "planning") {
            const parsed = parsePlanText([runtime.stdout, runtime.stderr].filter(Boolean).join("\n"));
            if (!parsed.plan) {
                const current = getWorkflowRun(runtime.mainAgentId, runtime.runId);
                const sessionActivity = readRecentAgentSessionActivity(readConfigSafe(), runtime.mainAgentId);
                const hydrated = hydrateWorkflowFromSpawnedSessions(
                    runtime.mainAgentId,
                    runtime.runId,
                    sessionActivity,
                    finishedSummary || "主 Agent 没有返回可解析的 JSON 派单计划。"
                );
                if (hydrated) {
                    return;
                }
                const fallbackPlan = buildFallbackDispatchPlan(
                    current.run,
                    current.collaboration,
                    finishedSummary || "主 Agent 没有返回可解析的 JSON 派单计划。"
                );
                if (fallbackPlan) {
                    const applied = applyDispatchPlanInternal(runtime.mainAgentId, runtime.runId, fallbackPlan, { force: true });
                    updateWorkflowItemState(runtime.mainAgentId, runtime.runId, runtime.itemId, {
                        note: `${finishedSummary || "主 Agent 未返回结构化派单计划。"}\n系统已按兜底规则自动生成派单计划。`,
                        resultSummary: "主 Agent 未返回 JSON，系统已自动按兜底规则完成派单。",
                        error: ""
                    });
                    const autoLaunchChildren = applied.collaboration?.dispatchPolicy?.autoLaunchChildren !== false;
                    if (autoLaunchChildren) {
                        ensureArray(applied.run?.items)
                            .filter((item) => item.phase === "execution")
                            .forEach((item) => {
                                startWorkflowExecutionRun(runtime.mainAgentId, runtime.runId, item.itemId).catch(() => {});
                            });
                    }
                    return;
                }
                updateWorkflowItemState(runtime.mainAgentId, runtime.runId, runtime.itemId, {
                    status: "failed",
                    error: "主 Agent 没有返回可解析的 JSON 派单计划。",
                    note: finishedSummary || "没有解析到派单 JSON。",
                    commandCode: normalizedCode
                });
                return;
            }
            const applied = applyDispatchPlanInternal(runtime.mainAgentId, runtime.runId, parsed.plan, { force: true });
            const autoLaunchChildren = applied.collaboration?.dispatchPolicy?.autoLaunchChildren !== false;
            if (autoLaunchChildren) {
                ensureArray(applied.run?.items)
                    .filter((item) => item.phase === "execution")
                    .forEach((item) => {
                        startWorkflowExecutionRun(runtime.mainAgentId, runtime.runId, item.itemId).catch(() => {});
                    });
            }
            return;
        }

        if (runtime.phase === "execution") {
            const updated = updateWorkflowItemState(runtime.mainAgentId, runtime.runId, runtime.itemId, {
                status: "completed",
                completedAt: nowIso(),
                resultSummary: finishedSummary || "执行完成。",
                note: finishedSummary || "执行完成。",
                error: "",
                commandCode: normalizedCode
            });
            const executionItems = ensureArray(updated.run?.items).filter((item) => item.phase === "execution");
            const allCompleted = executionItems.length > 0 && executionItems.every((item) => item.status === "completed");
            const autoStartCollection = updated.collaboration?.dispatchPolicy?.autoStartCollection === true;
            if (allCompleted && autoStartCollection) {
                startWorkflowCollectionRun(runtime.mainAgentId, runtime.runId).catch(() => {});
            }
            return;
        }

        if (runtime.phase === "collecting") {
            updateWorkflowItemState(runtime.mainAgentId, runtime.runId, runtime.itemId, {
                status: "completed",
                completedAt: nowIso(),
                resultSummary: finishedSummary || "汇总完成。",
                note: finishedSummary || "汇总完成。",
                error: "",
                commandCode: normalizedCode
            });
        }
    }

    function runWorkflowManagedCommand({
        mainAgentId = MAIN_AGENT_ID,
        runId = "",
        itemId = "",
        phase = "",
        command = "",
        timeoutMs = 0,
        pendingNote = ""
    } = {}) {
        if (typeof runManagedCommand !== "function") {
            throw new Error("runManagedCommand is unavailable for multi-agent orchestration.");
        }
        const runtimeKey = buildRuntimeKey(mainAgentId, runId, itemId, phase);
        if (workflowRuntimeSessions.has(runtimeKey)) {
            return workflowRuntimeSessions.get(runtimeKey);
        }
        const commandSessionId = createId(`workflow-${phase || "task"}`);
        const runtime = {
            key: runtimeKey,
            mainAgentId,
            runId,
            itemId,
            phase,
            command,
            commandSessionId,
            stdout: "",
            stderr: "",
            flushTimer: null,
            lastProgressSummary: "",
            pendingNote: ensureString(pendingNote)
        };
        workflowRuntimeSessions.set(runtimeKey, runtime);
        updateWorkflowItemState(mainAgentId, runId, itemId, {
            status: "running",
            startedAt: nowIso(),
            commandSessionId,
            commandCode: "",
            note: runtime.pendingNote
        });
        const sender = createWorkflowRuntimeSender(runtime);
        runManagedCommand(sender, commandSessionId, command, {
            timeoutMs,
            lightweight: true
        });
        return runtime;
    }

    function startWorkflowPlanningRun(mainAgentId = MAIN_AGENT_ID, runId = "") {
        const { collaboration, run } = getWorkflowRun(mainAgentId, runId);
        const planningItem = ensureArray(run.items).find((item) => item.phase === "planning");
        if (!planningItem) throw new Error("当前工作流缺少规划项。");
        if (planningItem.status === "running") return;
        const heuristicPlan = buildHeuristicDispatchPlan(run, collaboration);
        if (heuristicPlan) {
            const applied = applyDispatchPlanInternal(mainAgentId, runId, heuristicPlan, { force: true });
            updateWorkflowItemState(mainAgentId, runId, planningItem.itemId, {
                note: ensureString(heuristicPlan.heuristicNote || "系统已根据任务类型自动派发。"),
                resultSummary: ensureString(heuristicPlan.heuristicResultSummary || "系统已自动生成派单结果。"),
                error: ""
            });
            const autoLaunchChildren = applied.collaboration?.dispatchPolicy?.autoLaunchChildren !== false;
            if (autoLaunchChildren) {
                ensureArray(applied.run?.items)
                    .filter((item) => item.phase === "execution")
                    .forEach((item) => {
                        startWorkflowExecutionRun(mainAgentId, runId, item.itemId).catch(() => {});
                    });
            }
            return;
        }
        const command = buildPlanningCommandText(mainAgentId, run, collaboration);
        runWorkflowManagedCommand({
            mainAgentId,
            runId,
            itemId: planningItem.itemId,
            phase: "planning",
            command,
            timeoutMs: 10 * 60 * 1000,
            pendingNote: "主 Agent 正在分析消息并生成派单计划。"
        });
    }

    function startWorkflowExecutionRun(mainAgentId = MAIN_AGENT_ID, runId = "", itemId = "") {
        const { collaboration, run } = getWorkflowRun(mainAgentId, runId);
        const item = getRunItem(run, itemId);
        if (!item) throw new Error(`Workflow item not found: ${itemId}`);
        if (item.phase !== "execution") throw new Error("只能启动执行阶段的工作项。");
        if (item.status === "running") return;
        const command = buildExecutionCommandText(run, item, collaboration);
        runWorkflowManagedCommand({
            mainAgentId,
            runId,
            itemId,
            phase: "execution",
            command,
            timeoutMs: 30 * 60 * 1000,
            pendingNote: "子 Agent 正在执行主 Agent 派发的任务。"
        });
    }

    function startWorkflowCollectionRun(mainAgentId = MAIN_AGENT_ID, runId = "") {
        const { collaboration, run } = getWorkflowRun(mainAgentId, runId);
        let collectingItem = ensureArray(run.items).find((item) => item.phase === "collecting");
        if (!collectingItem || collectingItem.status === "failed") {
            const started = startCollectionInternal(mainAgentId, runId, { force: true });
            collectingItem = ensureArray(started.run?.items).find((item) => item.phase === "collecting");
        }
        if (!collectingItem) throw new Error("无法创建汇总项。");
        if (collectingItem.status === "running") return;
        const latest = getWorkflowRun(mainAgentId, runId);
        const command = buildCollectionCommandText(mainAgentId, latest.run);
        runWorkflowManagedCommand({
            mainAgentId,
            runId,
            itemId: collectingItem.itemId,
            phase: "collecting",
            command,
            timeoutMs: 15 * 60 * 1000,
            pendingNote: "主 Agent 正在回收子任务结果并汇总最终答复。"
        });
    }

    function getAgentIds(config = {}) {
        if (typeof mergeAgentIds === "function") {
            try {
                return mergeAgentIds(config);
            } catch (_) {}
        }
        const ids = new Set([MAIN_AGENT_ID]);
        const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
        list.forEach((entry) => {
            const id = safeNormalizeAgentId(entry?.id || "");
            if (id) ids.add(id);
        });
        const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
        bindings.forEach((binding) => {
            const id = safeNormalizeAgentId(binding?.agentId || "");
            if (id) ids.add(id);
        });
        return Array.from(ids);
    }

    function getAgentConfigEntry(config = {}, agentId = MAIN_AGENT_ID) {
        const normalizedId = safeNormalizeAgentId(agentId || MAIN_AGENT_ID);
        const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
        return list.find((entry) => safeNormalizeAgentId(entry?.id || "") === normalizedId) || null;
    }

    function getAgentDisplayName(config = {}, collaboration = {}, agentId = MAIN_AGENT_ID) {
        const normalizedId = safeNormalizeAgentId(agentId || MAIN_AGENT_ID) || MAIN_AGENT_ID;
        const profile = collaboration?.agents?.[normalizedId] || null;
        const entry = getAgentConfigEntry(config, normalizedId);
        if (profile?.label) return String(profile.label).trim();
        if (entry?.name) return String(entry.name).trim();
        if (normalizedId === MAIN_AGENT_ID) return "主 Agent";
        return normalizedId;
    }

    function readAgentSoul(config = {}, agentId = MAIN_AGENT_ID) {
        if (typeof resolveAgentFilePath !== "function") return "";
        try {
            const targetPath = resolveAgentFilePath(config, agentId, "SOUL.md");
            if (!targetPath || !fs.existsSync(targetPath)) return "";
            return fs.readFileSync(targetPath, "utf8");
        } catch (_) {
            return "";
        }
    }

    function writeAgentSoul(config = {}, agentId = MAIN_AGENT_ID, displayName = "", content = "") {
        if (typeof resolveAgentFilePath !== "function" || typeof getAgentWorkspacePath !== "function") return;
        const normalizedId = safeNormalizeAgentId(agentId || MAIN_AGENT_ID) || MAIN_AGENT_ID;
        const workspacePath = getAgentWorkspacePath(config, normalizedId);
        if (typeof ensureAgentWorkspaceFiles === "function") {
            ensureAgentWorkspaceFiles(normalizedId, workspacePath, displayName || normalizedId);
        }
        const targetPath = resolveAgentFilePath(config, normalizedId, "SOUL.md");
        ensureDirectory(path.dirname(targetPath));
        fs.writeFileSync(targetPath, String(content ?? ""), "utf8");
    }

    function ensureAgentWorkspaceShell(config = {}, agentId = MAIN_AGENT_ID, displayName = "") {
        if (typeof getAgentWorkspacePath !== "function") return;
        const normalizedId = safeNormalizeAgentId(agentId || MAIN_AGENT_ID) || MAIN_AGENT_ID;
        const workspacePath = getAgentWorkspacePath(config, normalizedId);
        if (typeof ensureAgentWorkspaceFiles === "function") {
            ensureAgentWorkspaceFiles(normalizedId, workspacePath, displayName || normalizedId);
        }
    }

    function writeAgentWorkspaceFile(config = {}, agentId = MAIN_AGENT_ID, fileName = "", content = "", displayName = "") {
        if (typeof resolveAgentFilePath !== "function") return;
        const normalizedId = safeNormalizeAgentId(agentId || MAIN_AGENT_ID) || MAIN_AGENT_ID;
        ensureAgentWorkspaceShell(config, normalizedId, displayName || normalizedId);
        const targetPath = resolveAgentFilePath(config, normalizedId, fileName);
        ensureDirectory(path.dirname(targetPath));
        fs.writeFileSync(targetPath, String(content ?? ""), "utf8");
    }

    function readAgentWorkspaceFile(config = {}, agentId = MAIN_AGENT_ID, fileName = "") {
        if (typeof resolveAgentFilePath !== "function") return "";
        try {
            const targetPath = resolveAgentFilePath(config, agentId, fileName);
            if (!targetPath || !fs.existsSync(targetPath)) return "";
            return fs.readFileSync(targetPath, "utf8");
        } catch (_) {
            return "";
        }
    }

    function readAvatarPresetManifest() {
        const presetDir = path.join(__dirname, "..", "..", "assets", "agent-avatar-presets");
        const manifestPath = path.join(presetDir, "manifest.json");
        if (!fs.existsSync(manifestPath)) return [];
        let manifest = [];
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        } catch (error) {
            throw new Error(`Failed to parse avatar preset manifest: ${error.message}`);
        }
        if (!Array.isArray(manifest)) return [];
        return manifest
            .map((entry) => {
                const id = String(entry?.id || "").trim();
                const label = String(entry?.label || id).trim();
                const relativeSrc = String(entry?.src || "").trim();
                const sourceUrl = String(entry?.sourceUrl || "").trim();
                const license = String(entry?.license || "CC0").trim() || "CC0";
                if (!id || !relativeSrc) return null;
                const absoluteSrc = path.join(presetDir, relativeSrc);
                if (!fs.existsSync(absoluteSrc)) return null;
                return {
                    id,
                    label,
                    src: absoluteSrc,
                    license,
                    sourceUrl,
                    dataUrl: readAvatarAsDataUrl(absoluteSrc)
                };
            })
            .filter(Boolean);
    }

    function formatBindingsSummary(bindings = []) {
        const validBindings = Array.isArray(bindings)
            ? bindings.filter((binding) => String(binding?.channel || "").trim() && String(binding?.targetId || "").trim())
            : [];
        if (!validBindings.length) return "未绑定聊天入口";
        return validBindings
            .map((binding) => {
                const channel = getChannelLabel(binding.channel);
                const targetKind = String(binding?.targetKind || inferTargetKind(binding?.targetId || "")).trim() || "group";
                const targetId = String(binding?.targetId || "").trim();
                return `${channel} / ${targetKind} / ${targetId}`;
            })
            .join("\n");
    }

    function normalizeManagedFileContent(content = "") {
        return String(content ?? "").replace(/\r\n/g, "\n").trim();
    }

    function isTeamManagedWorkspaceFile(content = "") {
        return normalizeManagedFileContent(content).includes("此文件由 Agent 团队管理自动同步。");
    }

    function buildWorkspacePlaceholderTemplates(displayName = "", agentId = "") {
        return {
            "IDENTITY.md": `# ${displayName}\n\n你是 Agent「${agentId}」。\n`,
            "SOUL.md": `# ${displayName} Soul\n\n在这里记录这个 Agent 的风格、偏好和长期约束。\n`,
            "USER.md": "# User Context\n\n在这里记录这个 Agent 面向的用户背景和协作约定。\n",
            "AGENTS.md": `# ${displayName} Workspace Notes\n\n在这里补充 Agent 运行所需的额外说明。\n`,
            "TOOLS.json": "{}\n",
            "BOOTSTRAP.md": "# Session Bootstrap\n\n在这里记录这个 Agent 每次开工前都应遵守的默认流程。\n",
            "HEARTBEAT.md": "# HEARTBEAT.md Template\n\n# Keep this file empty (or with only comments) to skip heartbeat API calls.\n",
            "MEMORY.md": "# MEMORY\n\n在这里记录这个 Agent 的长期偏好、决策和持续事项。\n",
            "TOOLS.md": "# TOOLS.md - Local Notes\n\n在这里记录这个 Agent 的本地工具、环境和协作备忘。\n"
        };
    }

    function shouldKeepManagedFileContent(fileName = "", content = "", placeholders = {}) {
        const normalized = normalizeManagedFileContent(content);
        if (!normalized) return false;
        const placeholder = normalizeManagedFileContent(placeholders[fileName] || "");
        return !placeholder || normalized !== placeholder;
    }

    function resolveManagedTextFileContent({
        fileName = "",
        suppliedContent = "",
        generatedContent = "",
        placeholders = {}
    } = {}) {
        const raw = String(suppliedContent ?? "");
        if (isTeamManagedWorkspaceFile(raw)) return generatedContent;
        return shouldKeepManagedFileContent(fileName, raw, placeholders)
            ? raw
            : generatedContent;
    }

    function buildManagedAgentFiles({
        config = {},
        agentId = MAIN_AGENT_ID,
        entry = {},
        teamName = "默认团队",
        mainAgentId = MAIN_AGENT_ID,
        childAgentIds = [],
        dispatchMode = "auto",
        teamAgents = []
    } = {}) {
        const normalizedId = safeNormalizeAgentId(agentId || MAIN_AGENT_ID) || MAIN_AGENT_ID;
        const displayName = String(entry?.name || normalizedId).trim() || normalizedId;
        const roleTitle = String(entry?.roleTitle || (normalizedId === mainAgentId ? "主 Agent" : "子 Agent")).trim()
            || (normalizedId === mainAgentId ? "主 Agent" : "子 Agent");
        const responsibilities = String(entry?.responsibilities || "").trim();
        const soulContent = String(entry?.soulContent || "").trim();
        const model = String(entry?.model || "").trim() || "未配置";
        const workspace = String(entry?.workspace || "").trim() || "留空时自动创建";
        const bindingSummary = formatBindingsSummary(entry?.bindings);
        const mainAgentName = String(
            (teamAgents.find((item) => safeNormalizeAgentId(item?.id || "") === mainAgentId) || {}).name
            || mainAgentId
        ).trim() || mainAgentId;
        const childAgentSummary = childAgentIds.length
            ? childAgentIds
                .map((childId) => {
                    const child = teamAgents.find((item) => safeNormalizeAgentId(item?.id || "") === safeNormalizeAgentId(childId));
                    return `- ${String(child?.name || childId).trim() || childId}（${safeNormalizeAgentId(childId)}）`;
                })
                .join("\n")
            : "- 当前没有子 Agent";
        const dispatchLabel = dispatchMode === "manual" ? "人工确认后分配" : "自动分配";
        const fallbackChildId = childAgentIds.find((childId) => {
            const child = teamAgents.find((item) => safeNormalizeAgentId(item?.id || "") === safeNormalizeAgentId(childId));
            return child?.fallbackExecution === true;
        }) || "";
        const hasIdentityContent = Object.prototype.hasOwnProperty.call(entry, "identityContent");
        const hasSoulContent = Object.prototype.hasOwnProperty.call(entry, "soulContent");
        const hasUserContent = Object.prototype.hasOwnProperty.call(entry, "userContent");
        const hasAgentsContent = Object.prototype.hasOwnProperty.call(entry, "agentsContent");
        const hasToolsContent = Object.prototype.hasOwnProperty.call(entry, "toolsContent");

        const generatedIdentityContent = [
            `# ${displayName}`,
            "",
            "> 此文件由 Agent 团队管理自动同步。",
            "",
            `- Agent ID：\`${normalizedId}\``,
            `- 角色：${roleTitle}`,
            `- 所属团队：${teamName}`,
            `- 直属主 Agent：${mainAgentName}（${mainAgentId}）`,
            `- 当前模型：${model}`,
            `- Workspace：${workspace}`,
            `- 聊天绑定：${bindingSummary.replace(/\n/g, "；")}`,
            responsibilities ? `- 职责说明：${responsibilities}` : "- 职责说明：暂未填写"
        ].join("\n");

        const soulBody = soulContent
            || (responsibilities ? `围绕以下职责执行：${responsibilities}` : "在这里补充这个 Agent 的风格、长期约束和输出偏好。");
        const generatedSoulFile = [
            `# ${displayName} Soul`,
            "",
            "> 此文件由 Agent 团队管理自动同步。",
            "",
            "## 身份定位",
            `${displayName} 是团队中的${roleTitle}。${responsibilities || "负责完成当前团队分配的职责。"}`,
            "",
            "## 默认流程",
            normalizedId === mainAgentId
                ? "收到消息后先判断这是不是纯聊天。如果只是问候、寒暄、简单闲聊、澄清、团队状态、配置说明、进度播报，主 Agent 可以自己直接回复；如果是明确执行任务，就先匹配最合适的子 Agent 派单，随后持续监控子 Agent 进度，最后回收并汇总结果。派单后必须立刻向用户说明任务已交给哪个子 Agent 执行。主 Agent 只能从团队子 Agent 列表中选择执行者，禁止使用 `runtime=acp`，禁止派给 `codex`、`claude`、`pi` 等团队外运行时；如果派单失败，也不能自己接手执行业务任务。"
                : `收到主 Agent「${mainAgentName}」派发的任务后直接执行，并返回可供汇总的结果。`,
            "",
            "## 风格与约束",
            soulBody,
            normalizedId === mainAgentId
                ? "- 允许你直接回复的包括：问候、寒暄、简单闲聊、澄清问题、团队状态、配置说明、任务进度播报。"
                : "",
            normalizedId === mainAgentId
                ? "- 任何需要搜索、查资料、查票务、查时刻表、查天气、查路线、写文案、写代码、做分析、做整理、做翻译的请求，都属于执行任务，不属于简单聊天。"
                : "",
            normalizedId === mainAgentId
                ? "- 明确代码任务优先派给代码类 Agent；明确写作任务优先派给写作类 Agent；明确策划/创意任务优先派给策划类 Agent；明确分析任务优先派给分析类 Agent；明确查询/资料/票务/路线任务优先派给查询研究类 Agent。"
                : "",
            normalizedId === mainAgentId && fallbackChildId
                ? `- 只有在找不到合适专职 Agent 时，才把具体执行任务交给兜底 Agent：${fallbackChildId}。`
                : ""
        ].join("\n");

        const generatedUserFile = [
            "# User Context",
            "",
            "> 此文件由 Agent 团队管理自动同步。",
            "",
            `- 当前团队：${teamName}`,
            `- 当前角色：${roleTitle}`,
            `- 团队协作方式：${normalizedId === mainAgentId ? "负责分配、监控、回收" : `接受主 Agent「${mainAgentName}」派发的任务并执行`}`,
            `- 任务分配模式：${dispatchLabel}`,
            responsibilities ? `- 默认职责：${responsibilities}` : "- 默认职责：暂未填写"
        ].join("\n");

        const generatedAgentsFile = [
            `# ${teamName} Team Notes`,
            "",
            "> 此文件由 Agent 团队管理自动同步。",
            "",
            "## 团队结构",
            `- 主 Agent：${mainAgentName}（${mainAgentId}）`,
            `- 子 Agent 数量：${childAgentIds.length}`,
            `- 分配模式：${dispatchLabel}`,
            "",
            "## 子 Agent 列表",
            childAgentSummary,
            "",
            "## 当前 Agent",
            `- 名称：${displayName}`,
            `- ID：${normalizedId}`,
            `- 角色：${roleTitle}`,
            responsibilities ? `- 职责：${responsibilities}` : "- 职责：暂未填写",
            normalizedId === mainAgentId
                ? "- 调度约束：只能把任务派给上面的子 Agent，禁止改派到外部 ACP/Codex/Claude/Pi 运行时。"
                : "- 执行约束：只接受主 Agent 派单，不承担团队总调度。",
            normalizedId === mainAgentId
                ? "- 主 Agent 可以直接回复问候、寒暄、简单闲聊、澄清、团队状态、配置说明、进度播报。"
                : "",
            normalizedId === mainAgentId && fallbackChildId
                ? `- 具体执行任务应优先派给匹配专职 Agent；只有没有匹配角色时，才派给兜底 Agent：${fallbackChildId}。`
                : ""
        ].join("\n");

        const childAgentRoster = childAgentIds.length
            ? childAgentIds
                .map((childId) => {
                    const child = teamAgents.find((item) => safeNormalizeAgentId(item?.id || "") === safeNormalizeAgentId(childId)) || {};
                    const childResponsibilities = String(child.responsibilities || "").trim() || "职责未填写";
                    const childTags = Array.isArray(child.capabilityTags) ? child.capabilityTags.filter(Boolean) : [];
                    const childWorkspace = String(
                        (config && typeof config === "object" && getAgentWorkspacePath(config, childId))
                        || child.workspace
                        || ""
                    ).trim();
                    const fallbackNote = child.fallbackExecution === true ? "；兜底执行 Agent" : "";
                    const tagNote = childTags.length ? `；capabilities=${childTags.join(", ")}` : "";
                    return `- ${String(child.name || childId).trim() || childId}（agentId=${safeNormalizeAgentId(childId)}，cwd=${childWorkspace || "自动解析"}；职责=${childResponsibilities}${tagNote}${fallbackNote}）`;
                })
                .join("\n")
            : "- 当前没有可用的子 Agent";
        const generatedBootstrapFile = normalizedId === mainAgentId
            ? [
                "# Session Bootstrap",
                "",
                "> 此文件由 Agent 团队管理自动同步。",
                "",
                "## 默认协作模式",
                `你是团队「${teamName}」的主 Agent。默认采用自动工作流：接单 -> 拆解 -> 派单 -> 监督 -> 回收 -> 汇总。`,
                "如果用户只是问候、寒暄、简单闲聊、澄清、团队状态、配置说明、任务进度，这类消息可以由主 Agent 自己直接回复。",
                "如果用户给的是明确执行任务，就先判断最匹配的专职子 Agent；只有找不到匹配角色时，才交给兜底 Agent。",
                "凡是用户让你去查、找、看、搜、写、做、分析、整理、翻译、检索、编写、查询票务/时刻表/天气/路线/资料，这些都算执行任务。",
                "如果用户追问的是“完成了吗 / 进度如何 / 谁在执行 / 当前什么状态 / 还要多久”这类进度查询，先把当前已知进展立即回复给用户，再继续监控；不要为了等最终结果而长时间卡住当前回复。",
                "",
                "## 必须遵守的动作",
                "1. 收到新任务后，先调用 `agents_list` 确认可用子 Agent，再判断需要哪些子 Agent 能力，并拆成一个或多个可执行子任务。",
                "2. 为每个子任务优先使用 `sessions_spawn` 创建子会话，并显式带上：`agentId=<子 Agent ID>`、`cwd=<子 Agent workspace>`、`label=<任务短名>`、`task=<目标+交付物+约束+原始需求>`。`agentId` 只能取自下面的子 Agent 清单。",
                "3. 禁止使用 `runtime=acp`，禁止把任务派给 `codex`、`claude`、`pi` 或任何团队外运行时。`sessions_list` 只用于监控已有子会话，不能用于选择执行者。",
                "4. 如果某个子 Agent 已经有正在运行的会话，并且你已经掌握该子会话的 `sessionKey` 或既有标签时，才可以使用 `sessions_send` 发给已有会话；禁止在没有现成子会话时先用 `sessions_send` 试探。",
                "5. 一旦成功派单或追单，在同一轮回复用户时必须原句回执：`我已经把任务交给xxx执行，我会持续监控任务完成进度`。如果派给多个子 Agent，就把 xxx 换成完整名单，不要改写这句话。",
                "6. 成功 `sessions_spawn` 后，必须在回执之后立刻继续调用 `sessions_yield` 等待结果回流，不能只回复一句回执就 `stop` 结束当前轮。",
                "7. 派单失败时要继续改派、补派或向用户说明阻塞点，不能因为失败就自己直接完成用户主任务，更不能自己调用 `web_search`、`web_fetch`、`read`、`write`、`exec` 等工具去替代子 Agent 执行。",
                "8. 对于进度类追问，优先用 `sessions_list` 查看已有子会话的最新状态；如果已经知道哪几个子会话在执行，就先直接告诉用户“谁在执行、做到哪一步、是否还在等待回收”，除非用户明确要求你继续等待最终结果，否则不要先调用 `sessions_yield` 把本轮回复卡住。",
                fallbackChildId
                    ? `9. 具体执行任务要先找匹配专职 Agent；例如代码任务优先给 coder，写作任务优先给 writer，策划任务优先给 brainstorm，查询研究任务优先给对应查询研究 Agent。只有没有匹配角色时，才交给兜底执行 Agent：${fallbackChildId}。`
                    : "9. 若团队里没有合适执行者，只能向用户说明能力缺口或先补充澄清，不能自己直接接手执行。",
                "10. 纯聊天消息可以主 Agent 直接回复；执行任务才需要先派单，再回执。",
                "",
                "## 子 Agent 派发清单",
                childAgentRoster
            ].join("\n")
            : [
                "# Session Bootstrap",
                "",
                "> 此文件由 Agent 团队管理自动同步。",
                "",
                "## 默认协作模式",
                `你是团队「${teamName}」中的执行型子 Agent，直属主 Agent 是「${mainAgentName}」。`,
                "",
                "## 必须遵守的动作",
                "1. 收到主 Agent 派发的任务后直接执行，先产出结果，再补充说明。",
                "2. 你的职责是执行，不负责整个团队的调度、拆单和总汇总。",
                "3. 如果上下文不足、任务超出能力范围或需要更多材料，直接告诉主 Agent 缺什么，不要空转。",
                "4. 返回时优先给主 Agent 可继续汇总的结论、材料、结构化结果或下一步建议。"
            ].join("\n");
        const generatedMemoryFile = [
            "# MEMORY",
            "",
            "## Team Identity",
            `- 当前团队：${teamName}`,
            `- 当前 Agent：${displayName}（${normalizedId}）`,
            `- 当前角色：${roleTitle}`,
            `- 主 Agent：${mainAgentName}（${mainAgentId}）`,
            `- 协作方式：${dispatchLabel}`,
            responsibilities ? `- 默认职责：${responsibilities}` : "- 默认职责：暂未填写",
            "",
            "## Long-term Rules",
            normalizedId === mainAgentId
                ? "- 主 Agent 只负责任务分发、监督、催办、回收和最终汇总，不直接执行用户主任务。"
                : "- 子 Agent 默认只执行主 Agent 派发的任务，不承担整个团队的总调度。",
            normalizedId === mainAgentId
                ? "- 纯聊天可由主 Agent 直接回复；复杂或明确执行任务默认走多 Agent 自动工作流。"
                : "- 结果必须尽量可被主 Agent 直接汇总。"
            ,
            normalizedId === mainAgentId
                ? "- 查资料、票务查询、搜索、路线、天气、文案、代码、分析这类需求都视为执行任务，应优先分配给匹配的专职子 Agent。"
                : "",
            normalizedId === mainAgentId && fallbackChildId
                ? `- 只有当团队里没有匹配的专职 Agent 时，具体执行任务才交给兜底 Agent：${fallbackChildId}。`
                : ""
        ].join("\n");
        const generatedHeartbeatFile = [
            "# HEARTBEAT.md Template",
            "",
            "# Keep this file empty (or with only comments) to skip heartbeat API calls.",
            "# Team-managed agents do not require default heartbeat jobs."
        ].join("\n");
        const generatedToolsMdFile = normalizedId === mainAgentId
            ? [
                "# TOOLS.md - Team Routing Notes",
                "",
                "## Default Tool Protocol",
                "- 派单前先调用 `agents_list`，确认这轮可用的子 Agent 列表；不要用 `sessions_list` 选执行者。",
                "- 新任务派单：优先使用 `sessions_spawn` 创建子 Agent 会话，`agentId` 只能取自团队子 Agent 清单。",
                "- 禁止使用 `runtime=acp`，禁止派给 `codex`、`claude`、`pi` 或任何团队外运行时。",
                "- 主 Agent 不得用 `web_search`、`web_fetch`、`read`、`write`、`exec` 等工具直接替用户完成业务任务；这些工具只可用于协调、核对派单上下文或汇总阶段。",
                "- 继续跟进已有子会话：只有拿到现成 `sessionKey` 或既有标签时才使用 `sessions_send`，不要在没有子会话时先用它试探。",
                "- 派单后必须立刻按原句回复用户：`我已经把任务交给xxx执行，我会持续监控任务完成进度`。",
                "- 成功 `sessions_spawn` 后必须紧接着调用 `sessions_yield`，不能停在回执文本直接结束当前轮。",
                "- 派单失败时继续改派、补派或说明阻塞点，不能自己兜底执行用户主任务。",
                "- 用户追问“完成了吗 / 进度如何 / 谁在执行 / 当前状态”时，先用 `sessions_list` 或现有会话状态给出即时进度答复；这类协调回复优先快，不要为了等最终结果而先阻塞在 `sessions_yield`。",
                "- 问候、寒暄、简单闲聊可以由主 Agent 直接回复，不需要派单。",
                fallbackChildId
                    ? `- 具体执行任务先匹配专职 Agent；只有没有匹配角色时，才派给 ${fallbackChildId}。`
                    : "",
                "",
                "## Child Agent Targets",
                childAgentRoster
            ].join("\n")
            : [
                "# TOOLS.md - Execution Notes",
                "",
                `- 直属主 Agent：${mainAgentName}（${mainAgentId}）`,
                "- 默认先执行，再回报结果。",
                "- 如果缺信息或超出能力边界，明确告诉主 Agent 不足点。"
            ].join("\n");

        const placeholders = buildWorkspacePlaceholderTemplates(displayName, normalizedId);
        const currentTools = String(readAgentWorkspaceFile(config, normalizedId, "TOOLS.json") || "").trim();
        const currentBootstrap = String(readAgentWorkspaceFile(config, normalizedId, "BOOTSTRAP.md") || "");
        const currentHeartbeat = String(readAgentWorkspaceFile(config, normalizedId, "HEARTBEAT.md") || "");
        const currentMemory = String(readAgentWorkspaceFile(config, normalizedId, "MEMORY.md") || "");
        const currentToolsMd = String(readAgentWorkspaceFile(config, normalizedId, "TOOLS.md") || "");
        const identityContent = resolveManagedTextFileContent({
            fileName: "IDENTITY.md",
            suppliedContent: hasIdentityContent ? String(entry.identityContent ?? "") : "",
            generatedContent: generatedIdentityContent,
            placeholders
        });
        const soulFile = resolveManagedTextFileContent({
            fileName: "SOUL.md",
            suppliedContent: hasSoulContent ? String(entry.soulContent ?? "") : "",
            generatedContent: generatedSoulFile,
            placeholders
        });
        const userFile = resolveManagedTextFileContent({
            fileName: "USER.md",
            suppliedContent: hasUserContent ? String(entry.userContent ?? "") : "",
            generatedContent: generatedUserFile,
            placeholders
        });
        const agentsFile = resolveManagedTextFileContent({
            fileName: "AGENTS.md",
            suppliedContent: hasAgentsContent ? String(entry.agentsContent ?? "") : "",
            generatedContent: generatedAgentsFile,
            placeholders
        });
        const toolsFile = shouldKeepManagedFileContent("TOOLS.json", hasToolsContent ? String(entry.toolsContent ?? "") : "", placeholders)
            ? String(entry.toolsContent ?? "")
            : (currentTools || "{}\n");
        const bootstrapFile = isTeamManagedWorkspaceFile(currentBootstrap)
            ? generatedBootstrapFile
            : shouldKeepManagedFileContent("BOOTSTRAP.md", currentBootstrap, placeholders)
            ? currentBootstrap
            : generatedBootstrapFile;
        const heartbeatFile = shouldKeepManagedFileContent("HEARTBEAT.md", currentHeartbeat, placeholders)
            ? currentHeartbeat
            : generatedHeartbeatFile;
        const memoryFile = shouldKeepManagedFileContent("MEMORY.md", currentMemory, placeholders)
            ? currentMemory
            : generatedMemoryFile;
        const toolsMdFile = isTeamManagedWorkspaceFile(currentToolsMd)
            ? generatedToolsMdFile
            : shouldKeepManagedFileContent("TOOLS.md", currentToolsMd, placeholders)
            ? currentToolsMd
            : generatedToolsMdFile;

        return {
            "IDENTITY.md": `${identityContent}\n`,
            "SOUL.md": `${soulFile}\n`,
            "USER.md": `${userFile}\n`,
            "AGENTS.md": `${agentsFile}\n`,
            "TOOLS.json": toolsFile.endsWith("\n") ? toolsFile : `${toolsFile}\n`,
            "BOOTSTRAP.md": bootstrapFile.endsWith("\n") ? bootstrapFile : `${bootstrapFile}\n`,
            "HEARTBEAT.md": heartbeatFile.endsWith("\n") ? heartbeatFile : `${heartbeatFile}\n`,
            "MEMORY.md": memoryFile.endsWith("\n") ? memoryFile : `${memoryFile}\n`,
            "TOOLS.md": toolsMdFile.endsWith("\n") ? toolsMdFile : `${toolsMdFile}\n`
        };
    }

    function getChannelLabel(channelKey = "") {
        return CHANNEL_LABELS[String(channelKey || "").trim().toLowerCase()] || String(channelKey || "").trim() || "未命名渠道";
    }

    function inferTargetKind(targetId = "") {
        const safeId = String(targetId || "").trim();
        if (!safeId) return "group";
        if (/^oc_/i.test(safeId)) return "group";
        if (/^ou_/i.test(safeId)) return "user";
        if (/^dm_/i.test(safeId)) return "dm";
        return "group";
    }

    function extractMatchTarget(match = {}) {
        const channel = String(match?.channel || "").trim();
        const peer = match?.peer && typeof match.peer === "object" ? match.peer : null;
        const targetId = String(
            peer?.id
            || match?.id
            || match?.groupId
            || match?.roomId
            || match?.chatId
            || match?.threadId
            || match?.peerId
            || match?.accountId
            || ""
        ).trim();
        const targetKind = String(
            peer?.kind
            || (match?.accountId ? "account" : "")
            || (match?.threadId ? "thread" : "")
            || (match?.groupId ? "group" : "")
            || inferTargetKind(targetId)
        ).trim() || "group";
        return {
            channel,
            targetId,
            targetKind
        };
    }

    function makeMatchKey(match = {}) {
        const target = extractMatchTarget(match);
        return JSON.stringify({
            channel: target.channel,
            targetId: target.targetId,
            targetKind: target.targetKind
        });
    }

    function makeBindingRow(binding = {}, index = 0) {
        const match = binding?.match && typeof binding.match === "object" ? cloneJson(binding.match) : {};
        const target = extractMatchTarget(match);
        return {
            rowId: String(binding?.rowId || binding?.id || `binding-${index}-${Date.now()}`),
            channel: target.channel,
            targetId: target.targetId,
            targetKind: target.targetKind,
            match,
            sourceLabel: getChannelLabel(target.channel),
            summary: target.targetId
                ? `${getChannelLabel(target.channel)} / ${target.targetKind} / ${target.targetId}`
                : "未绑定"
        };
    }

    function buildBindingMatch(binding = {}) {
        const channel = String(binding?.channel || binding?.match?.channel || "").trim();
        const targetId = String(binding?.targetId || "").trim();
        if (!channel) return null;
        if (binding?.match && typeof binding.match === "object" && !binding?.manual) {
            const normalized = cloneJson(binding.match);
            if (!normalized.channel) normalized.channel = channel;
            return normalized;
        }
        if (!targetId) return null;
        return {
            channel,
            peer: {
                kind: String(binding?.targetKind || inferTargetKind(targetId)).trim() || "group",
                id: targetId
            }
        };
    }

    function buildChannelCatalog(config = {}) {
        const bucket = new Map();
        const ensureChannel = (channelKey) => {
            const safeKey = String(channelKey || "").trim();
            if (!safeKey) return null;
            if (!bucket.has(safeKey)) {
                bucket.set(safeKey, {
                    key: safeKey,
                    label: getChannelLabel(safeKey),
                    sessions: []
                });
            }
            return bucket.get(safeKey);
        };
        const normalizeIdList = (value) => {
            if (Array.isArray(value)) {
                return value.map((entry) => String(entry || "").trim()).filter(Boolean);
            }
            if (typeof value === "string") {
                return value.split(/[,\n\uFF0C]/g).map((entry) => String(entry || "").trim()).filter(Boolean);
            }
            return [];
        };

        const seen = new Set();
        const pushSession = (channelKey, targetId, targetKind = "group", source = "config", match = null) => {
            const safeChannel = String(channelKey || "").trim();
            const safeTargetId = String(targetId || "").trim();
            if (!safeChannel || !safeTargetId || safeTargetId === "*") return;
            const safeKind = String(targetKind || inferTargetKind(safeTargetId)).trim() || "group";
            const key = JSON.stringify({ channel: safeChannel, targetId: safeTargetId, targetKind: safeKind });
            if (seen.has(key)) return;
            seen.add(key);
            const channel = ensureChannel(safeChannel);
            channel.sessions.push({
                key,
                channel: safeChannel,
                targetId: safeTargetId,
                targetKind: safeKind,
                source,
                label: `${getChannelLabel(safeChannel)} / ${safeKind} / ${safeTargetId}`,
                match: match && typeof match === "object"
                    ? cloneJson(match)
                    : {
                        channel: safeChannel,
                        peer: {
                            kind: safeKind,
                            id: safeTargetId
                        }
                    }
            });
        };

        const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
        bindings.forEach((binding) => {
            const match = binding?.match && typeof binding.match === "object" ? binding.match : {};
            const target = extractMatchTarget(match);
            pushSession(target.channel, target.targetId, target.targetKind, "bindings", match);
        });

        const channels = config?.channels && typeof config.channels === "object" ? config.channels : {};
        Object.entries(channels).forEach(([channelKey, channelConfig]) => {
            if (channelConfig?.groups && typeof channelConfig.groups === "object") {
                Object.keys(channelConfig.groups).forEach((groupId) => {
                    pushSession(channelKey, groupId, "group", "groups");
                });
            }
            normalizeIdList(channelConfig?.allowFrom).forEach((userId) => {
                pushSession(channelKey, userId, "user", "allowFrom");
            });
            normalizeIdList(channelConfig?.groupAllowFrom).forEach((groupId) => {
                pushSession(channelKey, groupId, "group", "groupAllowFrom");
            });
        });

        return Array.from(bucket.values())
            .map((channel) => ({
                ...channel,
                sessions: channel.sessions.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"))
            }))
            .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    }

    function buildModelCatalog(config = {}, mainAgentId = MAIN_AGENT_ID) {
        if (typeof buildRuntimeModelCatalog !== "function") {
            return { providers: [], options: [] };
        }
        const runtimeCatalog = buildRuntimeModelCatalog(config, mainAgentId) || { providers: [] };
        const options = [];
        const seen = new Set();
        (runtimeCatalog.providers || []).forEach((provider) => {
            const providerKey = String(provider?.key || "").trim();
            (provider?.models || []).forEach((model) => {
                const rawId = typeof model === "string" ? model : model?.id;
                const modelId = String(rawId || "").trim();
                if (!providerKey || !modelId) return;
                const value = modelId.startsWith(`${providerKey}/`)
                    ? modelId
                    : `${providerKey}/${modelId}`;
                if (seen.has(value)) return;
                seen.add(value);
                options.push({
                    value,
                    label: value,
                    providerKey,
                    modelId
                });
            });
        });
        return {
            providers: runtimeCatalog.providers || [],
            options: options.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"))
        };
    }

    function normalizeConfiguredModelValue(rawValue = "", modelCatalog = {}, fallbackValue = "") {
        const requested = String(rawValue || "").trim();
        const fallback = String(fallbackValue || "").trim();
        const options = Array.isArray(modelCatalog?.options) ? modelCatalog.options : [];
        if (!options.length) return requested || fallback;

        const byValue = new Map();
        const byModelId = new Map();
        const byShortModelId = new Map();
        options.forEach((option) => {
            const value = String(option?.value || "").trim();
            const modelId = String(option?.modelId || "").trim();
            if (!value) return;
            byValue.set(value.toLowerCase(), value);
            if (!modelId) return;
            const modelKey = modelId.toLowerCase();
            const modelMatches = byModelId.get(modelKey) || [];
            modelMatches.push(value);
            byModelId.set(modelKey, modelMatches);
            const shortKey = modelId.includes("/") ? modelId.split("/").pop() : modelId;
            const shortMatches = byShortModelId.get(String(shortKey || "").trim().toLowerCase()) || [];
            shortMatches.push(value);
            byShortModelId.set(String(shortKey || "").trim().toLowerCase(), shortMatches);
        });

        const resolveCandidate = (candidate = "") => {
            const normalized = String(candidate || "").trim();
            if (!normalized) return "";
            const exact = byValue.get(normalized.toLowerCase());
            if (exact) return exact;
            const exactModelMatches = byModelId.get(normalized.toLowerCase()) || [];
            if (exactModelMatches.length === 1) return exactModelMatches[0];
            const suffix = normalized.includes("/") ? normalized.split("/").pop() : normalized;
            const suffixMatches = byShortModelId.get(String(suffix || "").trim().toLowerCase()) || [];
            return suffixMatches.length === 1 ? suffixMatches[0] : "";
        };

        return resolveCandidate(requested) || resolveCandidate(fallback) || "";
    }

    function getCollaborationFileForAgent(config = {}, agentId = MAIN_AGENT_ID) {
        return path.join(getAgentMetadataDir(config, agentId), "collaboration.json");
    }

    function getAgentSessionsIndexPath(config = {}, agentId = MAIN_AGENT_ID) {
        const metadataDir = getAgentMetadataDir(config, agentId);
        return path.join(path.dirname(metadataDir), "sessions", "sessions.json");
    }

    function normalizeAgentSessionStatus(status = "") {
        const normalized = ensureString(status).toLowerCase();
        if (!normalized) return "idle";
        if (["done", "completed", "success"].includes(normalized)) return "completed";
        if (["running", "in_progress", "processing"].includes(normalized)) return "running";
        if (["pending", "queued", "waiting"].includes(normalized)) return "pending";
        if (["failed", "error", "cancelled", "canceled", "aborted"].includes(normalized)) return "failed";
        return normalized;
    }

    function toIsoTimestamp(value) {
        if (typeof value === "number" && Number.isFinite(value)) {
            const timestamp = value < 1e12 ? value * 1000 : value;
            return new Date(timestamp).toISOString();
        }
        const parsed = Date.parse(String(value || "").trim());
        return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
    }

    function extractAgentIdFromSessionKey(sessionKey = "") {
        const match = ensureString(sessionKey).match(/^agent:([^:]+):/i);
        if (!match?.[1]) return "";
        return safeNormalizeAgentId(match[1]) || ensureString(match[1]);
    }

    function readSessionsIndexSafe(targetPath = "") {
        const resolved = ensureString(targetPath);
        if (!resolved || !fs.existsSync(resolved)) return {};
        try {
            const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    function writeSessionsIndexSafe(targetPath = "", data = {}) {
        const resolved = ensureString(targetPath);
        if (!resolved) return false;
        try {
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, JSON.stringify(data && typeof data === "object" ? data : {}, null, 2), "utf8");
            return true;
        } catch (_) {
            return false;
        }
    }

    function shouldResetReusableAgentSessionKey(sessionKey = "", agentId = MAIN_AGENT_ID) {
        const normalizedAgentId = safeNormalizeAgentId(agentId || "") || MAIN_AGENT_ID;
        const normalizedKey = ensureString(sessionKey).trim().toLowerCase();
        if (!normalizedKey) return false;
        const prefix = `agent:${normalizedAgentId}:`;
        if (!normalizedKey.startsWith(prefix)) return false;
        return normalizedKey === `${prefix}main` || normalizedKey.includes(":direct:");
    }

    function buildSessionResetBackupPath(sessionFile = "") {
        const resolved = ensureString(sessionFile).trim();
        if (!resolved) return "";
        const stamp = new Date().toISOString().replace(/[:]/g, "-");
        let candidate = `${resolved}.reset.${stamp}`;
        let index = 1;
        while (fs.existsSync(candidate)) {
            candidate = `${resolved}.reset.${stamp}.${index}`;
            index += 1;
        }
        return candidate;
    }

    function buildReusableSessionResetPlaceholder(sessionKey = "", session = {}) {
        const previousSessionId = ensureString(session?.sessionId || "").trim();
        if (!previousSessionId) return null;
        return {
            sessionId: previousSessionId,
            updatedAt: 0,
            startedAt: 0,
            endedAt: 0,
            status: "reset_pending",
            sessionFile: "",
            systemSent: false,
            label: ensureString(session?.label || "").trim(),
            lastChannel: ensureString(session?.lastChannel || session?.channel || "").trim(),
            displayName: ensureString(session?.displayName || "").trim(),
            bootstrapResetPending: true,
            bootstrapResetRequestedAt: new Date().toISOString(),
            sessionKey: ensureString(sessionKey).trim()
        };
    }

    function isBootstrapResetPlaceholder(session = {}) {
        return session && typeof session === "object" && session.bootstrapResetPending === true;
    }

    function resetReusableAgentSessions(config = {}, agentId = MAIN_AGENT_ID) {
        const normalizedAgentId = safeNormalizeAgentId(agentId || "") || MAIN_AGENT_ID;
        const sessionsIndexPath = getAgentSessionsIndexPath(config, normalizedAgentId);
        const sessionsIndex = readSessionsIndexSafe(sessionsIndexPath);
        if (!sessionsIndex || typeof sessionsIndex !== "object") {
            return { agentId: normalizedAgentId, resetCount: 0, resetKeys: [] };
        }
        let changed = false;
        const resetKeys = [];
        Object.entries(sessionsIndex).forEach(([sessionKey, session]) => {
            if (!shouldResetReusableAgentSessionKey(sessionKey, normalizedAgentId)) return;
            const sessionFile = ensureString(session?.sessionFile || "").trim();
            if (sessionFile && fs.existsSync(sessionFile)) {
                try {
                    const backupPath = buildSessionResetBackupPath(sessionFile);
                    if (backupPath) fs.renameSync(sessionFile, backupPath);
                } catch (_) {}
            }
            const placeholder = buildReusableSessionResetPlaceholder(sessionKey, session);
            if (placeholder) {
                sessionsIndex[sessionKey] = placeholder;
            } else {
                delete sessionsIndex[sessionKey];
            }
            resetKeys.push(sessionKey);
            changed = true;
        });
        if (changed) writeSessionsIndexSafe(sessionsIndexPath, sessionsIndex);
        return {
            agentId: normalizedAgentId,
            resetCount: resetKeys.length,
            resetKeys
        };
    }

    async function resetGatewaySessionCache(sessionKey = "", options = {}) {
        const normalizedKey = ensureString(sessionKey).trim();
        if (!normalizedKey) {
            return {
                ok: false,
                skipped: true,
                sessionKey: normalizedKey,
                error: "missing_session_key"
            };
        }
        if (typeof runOpenClawCliCaptured !== "function") {
            return {
                ok: false,
                skipped: true,
                sessionKey: normalizedKey,
                error: "gateway_cli_unavailable"
            };
        }
        const params = {
            key: normalizedKey,
            reason: options.reason === "new" ? "new" : "reset"
        };
        const gatewayTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000;
        const cliResult = await runOpenClawCliCaptured([
            "gateway",
            "call",
            "sessions.reset",
            "--timeout",
            String(gatewayTimeoutMs),
            "--json",
            "--params",
            JSON.stringify(params)
        ], {
            timeoutMs: gatewayTimeoutMs + 5000,
            maxAttempts: 2,
            retryDelayMs: 500
        });
        const rawOutput = `${ensureString(cliResult?.stdout || "")}\n${ensureString(cliResult?.stderr || "")}`.trim();
        const parsed = typeof parseCliJsonOutput === "function"
            ? parseCliJsonOutput(rawOutput)
            : null;
        const payload = parsed && typeof parsed === "object"
            ? (parsed.result && typeof parsed.result === "object" ? parsed.result : parsed)
            : null;
        if (cliResult?.ok === true && payload?.ok === true) {
            return {
                ok: true,
                sessionKey: normalizedKey,
                response: payload
            };
        }
        return {
            ok: false,
            sessionKey: normalizedKey,
            response: payload,
            error: ensureString(payload?.error || parsed?.error || cliResult?.error || rawOutput || "gateway_session_reset_failed")
        };
    }

    async function syncGatewayReusableSessionResets(sessionReset = {}, options = {}) {
        const resetKeys = Array.isArray(sessionReset?.resetKeys)
            ? sessionReset.resetKeys.map((entry) => ensureString(entry).trim()).filter(Boolean)
            : [];
        if (!resetKeys.length) {
            return {
                attempted: false,
                resetCount: 0,
                successCount: 0,
                failureCount: 0,
                results: []
            };
        }
        const results = [];
        for (const sessionKey of resetKeys) {
            try {
                results.push(await resetGatewaySessionCache(sessionKey, options));
            } catch (error) {
                results.push({
                    ok: false,
                    sessionKey,
                    error: error?.message || String(error)
                });
            }
        }
        return {
            attempted: true,
            resetCount: resetKeys.length,
            successCount: results.filter((entry) => entry?.ok === true).length,
            failureCount: results.filter((entry) => entry?.ok !== true).length,
            results
        };
    }

    function isPassiveBackgroundSession(sessionKey = "", sessionFile = "") {
        const normalizedKey = ensureString(sessionKey).toLowerCase();
        if (ensureString(sessionFile)) return false;
        return normalizedKey.includes(":cron:") || normalizedKey.includes(":run:");
    }

    function inferSessionStatusFromTranscript(sessionFile = "") {
        const resolved = ensureString(sessionFile);
        if (!resolved || !fs.existsSync(resolved)) return "";
        if (transcriptEndsInYieldWaiting(resolved)) return "waiting_collect";
        try {
            const lines = fs.readFileSync(resolved, "utf8")
                .split(/\r?\n/)
                .filter(Boolean)
                .slice(-120);
            for (let index = lines.length - 1; index >= 0; index -= 1) {
                let parsed = null;
                try {
                    parsed = JSON.parse(lines[index]);
                } catch (_) {
                    continue;
                }
                if (!parsed) continue;
                const role = ensureString(parsed?.message?.role || "");
                if (role === "assistant") {
                    const stopReason = ensureString(parsed?.stopReason || parsed?.message?.stopReason || "");
                    const content = ensureArray(parsed?.message?.content);
                    const hasText = content.some((entry) => entry?.type === "text" && ensureString(entry?.text || ""));
                    const hasToolCall = content.some((entry) => entry?.type === "toolCall");
                    if (hasText && (!hasToolCall || !stopReason || stopReason === "stop")) {
                        return "completed";
                    }
                    if (hasToolCall || stopReason === "toolUse") {
                        return "running";
                    }
                    if (hasText) {
                        return "completed";
                    }
                    continue;
                }
                if (role === "user" || role === "toolResult") {
                    return "running";
                }
            }
        } catch (_) {}
        return "";
    }

    function resolveAgentSessionDisplayStatus(rawStatus = "", sessionFile = "") {
        const normalizedStatus = normalizeAgentSessionStatus(rawStatus);
        const transcriptStatus = inferSessionStatusFromTranscript(sessionFile);
        if (!transcriptStatus) return normalizedStatus;
        if (transcriptStatus === "waiting_collect") return "waiting_collect";
        if (transcriptStatus === "completed" && ["running", "pending", "idle"].includes(normalizedStatus)) {
            return "completed";
        }
        return normalizedStatus;
    }

    function findSpawnedChildSessionActivity(config = {}, parentSessionKey = "") {
        const normalizedParentKey = ensureString(parentSessionKey);
        if (!normalizedParentKey) return { totalCount: 0, activeCount: 0, latestUpdatedAt: "" };

        const childSessions = [];
        getAgentIds(config).forEach((candidateAgentId) => {
            const parsed = readSessionsIndexSafe(getAgentSessionsIndexPath(config, candidateAgentId));
            Object.entries(parsed || {}).forEach(([key, session]) => {
                if (ensureString(session?.spawnedBy || "") !== normalizedParentKey) return;
                const rawStatus = ensureString(session?.status || "");
                const sessionFile = ensureString(session?.sessionFile || "");
                if (isPassiveBackgroundSession(key, sessionFile)) return;
                const status = resolveAgentSessionDisplayStatus(rawStatus, sessionFile);
                const transcriptPreview = readSessionTranscriptPreview(sessionFile);
                childSessions.push({
                    key,
                    rawStatus,
                    status,
                    sessionFile,
                    taskPreview: transcriptPreview.taskPreview,
                    resultPreview: transcriptPreview.resultPreview,
                    agentId: safeNormalizeAgentId(candidateAgentId || extractAgentIdFromSessionKey(key)) || ensureString(candidateAgentId),
                    agentName: getAgentDisplayName(config, {}, candidateAgentId),
                    updatedAt: toIsoTimestamp(session?.updatedAt || session?.endedAt || session?.startedAt || "")
                });
            });
        });

        childSessions.sort((left, right) => {
            const leftTime = Date.parse(left.updatedAt || 0) || 0;
            const rightTime = Date.parse(right.updatedAt || 0) || 0;
            return rightTime - leftTime;
        });

        return {
            totalCount: childSessions.length,
            activeCount: childSessions.filter((session) => ["running", "pending", "waiting_collect"].includes(session.status)).length,
            latestUpdatedAt: childSessions[0]?.updatedAt || "",
            latestTaskPreview: childSessions[0]?.taskPreview || "",
            latestResultPreview: childSessions[0]?.resultPreview || "",
            latestAgentId: childSessions[0]?.agentId || "",
            latestAgentName: childSessions[0]?.agentName || ""
        };
    }

    function listSpawnedChildSessions(config = {}, parentSessionKey = "") {
        const normalizedParentKey = ensureString(parentSessionKey);
        if (!normalizedParentKey) return [];
        const childSessions = [];
        getAgentIds(config).forEach((candidateAgentId) => {
            const parsed = readSessionsIndexSafe(getAgentSessionsIndexPath(config, candidateAgentId));
            Object.entries(parsed || {}).forEach(([key, session]) => {
                if (ensureString(session?.spawnedBy || "") !== normalizedParentKey) return;
                const rawStatus = ensureString(session?.status || "");
                const sessionFile = ensureString(session?.sessionFile || "");
                if (isPassiveBackgroundSession(key, sessionFile)) return;
                childSessions.push({
                    agentId: safeNormalizeAgentId(candidateAgentId || extractAgentIdFromSessionKey(ensureString(session?.systemPromptReport?.sessionKey || key)))
                        || ensureString(candidateAgentId),
                    sessionId: ensureString(session?.sessionId || ""),
                    sessionKey: ensureString(session?.systemPromptReport?.sessionKey || key),
                    rawStatus,
                    status: resolveAgentSessionDisplayStatus(rawStatus, sessionFile),
                    startedAt: toIsoTimestamp(session?.startedAt || ""),
                    endedAt: toIsoTimestamp(session?.endedAt || ""),
                    updatedAt: toIsoTimestamp(session?.updatedAt || session?.endedAt || session?.startedAt || ""),
                    sessionFile,
                    label: ensureString(session?.origin?.label || session?.displayName || ""),
                    task: ensureString(session?.task || session?.origin?.task || "")
                });
            });
        });
        return childSessions.sort((left, right) => {
            const leftTime = Date.parse(left.updatedAt || left.startedAt || 0) || 0;
            const rightTime = Date.parse(right.updatedAt || right.startedAt || 0) || 0;
            return rightTime - leftTime;
        });
    }

    function extractSessionTaskPreview(text = "") {
        const raw = String(text || "");
        if (!raw) return "";
        const subagentMatch = raw.match(/\[Subagent Task\]:\s*([\s\S]*)/i);
        if (subagentMatch?.[1]) return ensureString(subagentMatch[1]);
        const lines = raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => line !== "```");
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const line = lines[index];
            if (!line) continue;
            if (/^Conversation info/i.test(line) || /^Sender/i.test(line) || /^Current time:/i.test(line)) continue;
            if (/^\[Subagent Context]/i.test(line)) continue;
            const directMessageMatch = line.match(/^\[message_id:[^\]]+\]\s*.+?:\s*([\s\S]+)$/i);
            if (directMessageMatch?.[1]) return ensureString(directMessageMatch[1]);
            if (/^[{\[`]/.test(line)) continue;
            return ensureString(line);
        }
        return ensureString(raw);
    }

    function readSessionTranscriptPreview(sessionFile = "") {
        const resolved = ensureString(sessionFile);
        if (!resolved || !fs.existsSync(resolved)) {
            return { taskPreview: "", resultPreview: "" };
        }
        try {
            const lines = fs.readFileSync(resolved, "utf8")
                .split(/\r?\n/)
                .filter(Boolean);
            let firstUserText = "";
            let latestAssistantText = "";
            lines.forEach((line) => {
                let parsed = null;
                try {
                    parsed = JSON.parse(line);
                } catch (_) {
                    return;
                }
                const role = ensureString(parsed?.message?.role || "");
                if (!role) return;
                const texts = ensureArray(parsed?.message?.content)
                    .filter((entry) => entry?.type === "text")
                    .map((entry) => ensureString(entry?.text || ""))
                    .filter(Boolean);
                if (!texts.length) return;
                if (role === "user" && !firstUserText) {
                    firstUserText = texts.join("\n");
                }
                if (role === "assistant") {
                    latestAssistantText = texts.join("\n");
                }
            });
            return {
                taskPreview: extractSessionTaskPreview(firstUserText),
                resultPreview: ensureString(latestAssistantText)
            };
        } catch (_) {
            return { taskPreview: "", resultPreview: "" };
        }
    }

    function readLatestAssistantTextFromSessionFile(sessionFile = "") {
        const resolved = ensureString(sessionFile);
        if (!resolved || !fs.existsSync(resolved)) return "";
        try {
            const lines = fs.readFileSync(resolved, "utf8")
                .split(/\r?\n/)
                .filter(Boolean);
            for (let index = lines.length - 1; index >= 0; index -= 1) {
                let parsed = null;
                try {
                    parsed = JSON.parse(lines[index]);
                } catch (_) {
                    continue;
                }
                if (ensureString(parsed?.message?.role || "") !== "assistant") continue;
                const texts = ensureArray(parsed?.message?.content)
                    .filter((entry) => entry?.type === "text")
                    .map((entry) => ensureString(entry?.text || ""))
                    .filter(Boolean);
                if (texts.length) return texts.join("\n");
            }
        } catch (_) {}
        return "";
    }

    function hydrateWorkflowFromSpawnedSessions(mainAgentId = MAIN_AGENT_ID, runId = "", sessionActivity = null, failureReason = "") {
        const current = getWorkflowRun(mainAgentId, runId);
        const config = readConfigSafe();
        const mainSessionActivity = sessionActivity || readRecentAgentSessionActivity(config, mainAgentId);
        const parentSessionKey = ensureString(mainSessionActivity?.latest?.sessionKey || "");
        if (!parentSessionKey) return null;
        const childSessions = listSpawnedChildSessions(config, parentSessionKey);
        if (!childSessions.length) return null;

        const originalMessage = ensureString(current.run.message || current.run.summary || current.run.name) || "请完成当前用户任务";
        const plan = {
            assignments: childSessions.map((session) => ({
                agentId: session.agentId,
                objective: originalMessage,
                deliverable: "直接完成用户请求，并返回可供主 Agent 汇总的结果。",
                reason: "主 Agent 已通过会话式自动派单创建了子任务。",
                context: session.task || `childSessionKey=${session.sessionKey}`
            })),
            collectionBrief: "请基于全部子 Agent 的执行结果整理最终答复，直接返回给用户。"
        };

        const existingExecutionItems = ensureArray(current.run?.items).filter((item) => item.phase === "execution");
        const working = existingExecutionItems.length
            ? current
            : applyDispatchPlanInternal(mainAgentId, runId, plan, { force: true });
        const executionItems = ensureArray(working.run?.items).filter((item) => item.phase === "execution");
        const childBuckets = new Map();
        childSessions.forEach((session) => {
            const key = ensureString(session.agentId);
            const bucket = childBuckets.get(key) || [];
            bucket.push(session);
            childBuckets.set(key, bucket);
        });

        executionItems.forEach((item) => {
            const agentKey = ensureString(item.agentId);
            const bucket = childBuckets.get(agentKey) || [];
            const childSession = bucket.shift() || null;
            childBuckets.set(agentKey, bucket);
            if (!childSession) return;
            const summary = readLatestAssistantTextFromSessionFile(childSession.sessionFile)
                || childSession.task
                || childSession.label
                || ensureString(failureReason)
                || "子 Agent 已完成会话式执行。";
            const nextStatus = childSession.status === "waiting_collect"
                ? "running"
                : childSession.status;
            updateWorkflowItemState(mainAgentId, runId, item.itemId, {
                status: nextStatus || "running",
                startedAt: childSession.startedAt || item.startedAt || "",
                completedAt: ["completed", "failed"].includes(nextStatus)
                    ? (childSession.endedAt || childSession.updatedAt || nowIso())
                    : "",
                note: summary,
                resultSummary: nextStatus === "completed" ? summary : "",
                error: nextStatus === "failed" ? (summary || "子 Agent 执行失败。") : "",
                commandSessionId: childSession.sessionId || ""
            });
        });

        const refreshed = getWorkflowRun(mainAgentId, runId);
        const refreshedExecutionItems = ensureArray(refreshed.run?.items).filter((item) => item.phase === "execution");
        const allCompleted = refreshedExecutionItems.length > 0 && refreshedExecutionItems.every((item) => item.status === "completed");
        if (!allCompleted) {
            return refreshed;
        }

        const collectionStarted = startCollectionInternal(mainAgentId, runId, { force: true });
        const collectionItem = ensureArray(collectionStarted.run?.items).find((item) => item.phase === "collecting");
        if (!collectionItem) return getWorkflowRun(mainAgentId, runId);
        const mainSummary = readLatestAssistantTextFromSessionFile(ensureString(mainSessionActivity?.latest?.sessionFile || ""))
            || ensureString(failureReason)
            || "主 Agent 已完成最终汇总。";
        updateWorkflowItemState(mainAgentId, runId, collectionItem.itemId, {
            status: "completed",
            startedAt: ensureString(mainSessionActivity?.latest?.startedAt || collectionItem.startedAt || nowIso()),
            completedAt: ensureString(mainSessionActivity?.latest?.endedAt || mainSessionActivity?.latest?.updatedAt || nowIso()),
            note: mainSummary,
            resultSummary: mainSummary,
            error: "",
            commandCode: "0",
            commandSessionId: ensureString(mainSessionActivity?.latest?.sessionId || "")
        });
        return getWorkflowRun(mainAgentId, runId);
    }

    function transcriptEndsInYieldWaiting(sessionFile = "") {
        const resolved = ensureString(sessionFile);
        if (!resolved || !fs.existsSync(resolved)) return false;
        try {
            const lines = fs.readFileSync(resolved, "utf8")
                .split(/\r?\n/)
                .filter(Boolean)
                .slice(-120);
            let sawYield = false;
            for (let index = 0; index < lines.length; index += 1) {
                let parsed = null;
                try {
                    parsed = JSON.parse(lines[index]);
                } catch (_) {
                    continue;
                }
                if (!parsed) continue;
                if (parsed.type === "custom_message" && ensureString(parsed.customType) === "openclaw.sessions_yield") {
                    sawYield = true;
                    continue;
                }
                if (!sawYield) continue;
                const role = ensureString(parsed?.message?.role || "");
                if (role === "assistant") {
                    const content = Array.isArray(parsed?.message?.content) ? parsed.message.content : [];
                    const hasVisibleText = content.some((entry) => entry?.type === "text" && ensureString(entry?.text));
                    if (hasVisibleText) return false;
                    continue;
                }
            }
            return sawYield;
        } catch (_) {
            return false;
        }
    }

    function readRecentAgentSessionActivity(config = {}, agentId = MAIN_AGENT_ID) {
        const targetPath = getAgentSessionsIndexPath(config, agentId);
        if (!fs.existsSync(targetPath)) return null;
        const parsed = readSessionsIndexSafe(targetPath);
        if (!Object.keys(parsed).length) return null;

        const sessions = Object.entries(parsed || {})
            .map(([key, session]) => {
                if (isBootstrapResetPlaceholder(session)) return null;
                const rawStatus = ensureString(session?.status || "");
                const sessionFile = ensureString(session?.sessionFile || "");
                if (isPassiveBackgroundSession(key, sessionFile)) return null;
                const normalizedStatus = resolveAgentSessionDisplayStatus(rawStatus, sessionFile);
                const transcriptPreview = readSessionTranscriptPreview(sessionFile);
                const spawnedByKey = ensureString(session?.spawnedBy || "");
                const spawnedByAgentId = extractAgentIdFromSessionKey(spawnedByKey);
                return {
                    key,
                    sessionId: ensureString(session?.sessionId || ""),
                    rawStatus,
                    status: normalizedStatus,
                    sessionFile,
                    updatedAt: toIsoTimestamp(session?.updatedAt || session?.endedAt || session?.startedAt || ""),
                    startedAt: toIsoTimestamp(session?.startedAt || ""),
                    endedAt: toIsoTimestamp(session?.endedAt || ""),
                    channel: ensureString(
                        session?.lastChannel
                        || session?.deliveryContext?.channel
                        || session?.origin?.surface
                        || session?.origin?.provider
                    ),
                    displayName: ensureString(session?.origin?.label || session?.displayName || ""),
                    workspaceDir: ensureString(session?.systemPromptReport?.workspaceDir || ""),
                    sessionKey: ensureString(session?.systemPromptReport?.sessionKey || key),
                    taskPreview: transcriptPreview.taskPreview,
                    resultPreview: transcriptPreview.resultPreview,
                    spawnedByKey,
                    spawnedByAgentId,
                    spawnedByAgentName: spawnedByAgentId ? getAgentDisplayName(config, {}, spawnedByAgentId) : "",
                    spawnedWorkspaceDir: ensureString(session?.spawnedWorkspaceDir || ""),
                    isSpawnedTask: Boolean(spawnedByKey)
                };
            })
            .filter(Boolean)
            .filter((session) => session.sessionId || session.updatedAt)
            .sort((left, right) => {
                const leftTime = Date.parse(left.updatedAt || left.startedAt || 0) || 0;
                const rightTime = Date.parse(right.updatedAt || right.startedAt || 0) || 0;
                return rightTime - leftTime;
            });

        if (!sessions.length) return null;
        const latest = { ...sessions[0] };
        const childActivity = findSpawnedChildSessionActivity(config, latest.sessionKey);
        if (["completed", "failed"].includes(latest.status)) {
            if (childActivity.activeCount > 0 || transcriptEndsInYieldWaiting(ensureString(latest.sessionFile || ""))) {
                latest.status = "waiting_collect";
            }
        }
        const activeCount = sessions.filter((session) => ["running", "pending", "waiting_collect"].includes(session.status)).length
            + (latest.status === "waiting_collect" && !["running", "pending", "waiting_collect"].includes(sessions[0]?.status) ? 1 : 0);
        return {
            activeCount,
            sessionCount: sessions.length,
            childSessionCount: childActivity.totalCount,
            childSessionActiveCount: childActivity.activeCount,
            latestChildUpdatedAt: childActivity.latestUpdatedAt,
            latestChildTaskPreview: childActivity.latestTaskPreview,
            latestChildResultPreview: childActivity.latestResultPreview,
            latestChildAgentId: childActivity.latestAgentId,
            latestChildAgentName: childActivity.latestAgentName,
            latest
        };
    }

    function listTeams(config = readConfigSafe()) {
        const seen = new Set();
        const teams = [];
        const candidateIds = Array.from(new Set([MAIN_AGENT_ID].concat(getAgentIds(config))));

        candidateIds.forEach((agentId) => {
            const normalizedId = safeNormalizeAgentId(agentId || "") || MAIN_AGENT_ID;
            const targetPath = getCollaborationFileForAgent(config, normalizedId);
            const hasFile = fs.existsSync(targetPath);
            if (!hasFile && normalizedId !== MAIN_AGENT_ID) return;
            const result = readCollaborationSync(normalizedId);
            const collaboration = cloneJson(result.data);
            const teamMainId = safeNormalizeAgentId(collaboration?.topology?.mainAgentId || normalizedId) || normalizedId;
            if (teamMainId !== normalizedId) return;
            if (seen.has(teamMainId)) return;
            seen.add(teamMainId);
            teams.push({
                id: teamMainId,
                mainAgentId: teamMainId,
                name: String(collaboration?.team?.name || (teamMainId === MAIN_AGENT_ID ? "榛樿鍥㈤槦" : `${teamMainId} 鍥㈤槦`)).trim() || (teamMainId === MAIN_AGENT_ID ? "榛樿鍥㈤槦" : `${teamMainId} 鍥㈤槦`),
                childAgentIds: cloneJson(collaboration?.topology?.childAgentIds || []),
                childCount: Array.isArray(collaboration?.topology?.childAgentIds) ? collaboration.topology.childAgentIds.length : 0,
                hasFile
            });
        });

        return teams.sort((a, b) => {
            if (a.id === MAIN_AGENT_ID) return -1;
            if (b.id === MAIN_AGENT_ID) return 1;
            return a.name.localeCompare(b.name, "zh-CN");
        });
    }

    function buildAgentBuilderRecord(config = {}, collaboration = {}, agentId = MAIN_AGENT_ID) {
        const normalizedId = safeNormalizeAgentId(agentId || MAIN_AGENT_ID) || MAIN_AGENT_ID;
        const entry = getAgentConfigEntry(config, normalizedId);
        const profile = collaboration?.agents?.[normalizedId] || {};
        const isMain = normalizedId === collaboration?.topology?.mainAgentId;
        const isChild = Array.isArray(collaboration?.topology?.childAgentIds)
            ? collaboration.topology.childAgentIds.includes(normalizedId)
            : false;
        const usesGlobalMainDefaults = isMain && normalizedId === MAIN_AGENT_ID;
        const rawModel = usesGlobalMainDefaults
            ? (config?.agents?.defaults?.model?.primary || profile?.modelOverride || "")
            : (entry?.model || profile?.modelOverride || "");
        const rawWorkspace = usesGlobalMainDefaults
            ? (config?.agents?.defaults?.workspace || profile?.workspaceOverride || "")
            : (entry?.workspace || profile?.workspaceOverride || "");
        const bindings = (Array.isArray(config?.bindings) ? config.bindings : [])
            .filter((binding) => safeNormalizeAgentId(binding?.agentId || "") === normalizedId)
            .map((binding, index) => makeBindingRow(binding, index));

        return {
            id: normalizedId,
            name: getAgentDisplayName(config, collaboration, normalizedId),
            model: String(rawModel || "").trim(),
            workspace: String(rawWorkspace || "").trim(),
            agentDir: String(entry?.agentDir || "").trim(),
            roleTitle: resolveAgentRoleTitle(profile?.title || "", isMain),
            responsibilities: resolveAgentResponsibilities(
                profile?.responsibilities || "",
                normalizedId,
                getAgentDisplayName(config, collaboration, normalizedId),
                resolveAgentRoleTitle(profile?.title || "", isMain)
            ),
            capabilityTags: resolveAgentCapabilityTags(
                Array.isArray(profile?.capabilityTags) ? cloneJson(profile.capabilityTags) : [],
                normalizedId,
                getAgentDisplayName(config, collaboration, normalizedId),
                resolveAgentRoleTitle(profile?.title || "", isMain)
            ),
            fallbackExecution: profile?.fallbackExecution === true,
            identityContent: readAgentWorkspaceFile(config, normalizedId, "IDENTITY.md"),
            soulContent: readAgentWorkspaceFile(config, normalizedId, "SOUL.md"),
            userContent: readAgentWorkspaceFile(config, normalizedId, "USER.md"),
            agentsContent: readAgentWorkspaceFile(config, normalizedId, "AGENTS.md"),
            toolsContent: readAgentWorkspaceFile(config, normalizedId, "TOOLS.json"),
            avatar: cloneJson(profile?.avatar || buildGeneratedAvatar(normalizedId, getAgentDisplayName(config, collaboration, normalizedId))),
            isMain,
            isChild,
            isDefault: normalizedId === MAIN_AGENT_ID,
            bindings,
            bindingStatus: bindings.length ? "bound" : "unbound"
        };
    }

    function buildEntryStatus(teamAgentIds = [], agents = []) {
        const scopedAgents = agents.filter((agent) => teamAgentIds.includes(agent.id));
        const totalBindings = scopedAgents.reduce((sum, agent) => sum + (Array.isArray(agent.bindings) ? agent.bindings.length : 0), 0);
        const mainAgent = scopedAgents.find((agent) => agent.isMain);
        if (totalBindings === 0) {
            return {
                mode: "none",
                label: "未绑定外部聊天入口"
            };
        }
        if (mainAgent && (mainAgent.bindings || []).length > 0) {
            return {
                mode: "main-bound",
                label: `主 Agent 已绑定 ${mainAgent.bindings.length} 个入口`
            };
        }
        return {
            mode: "team-bound",
            label: `团队已绑定 ${totalBindings} 个入口`
        };
    }

    function buildTeamBuilderData(mainAgentId = MAIN_AGENT_ID) {
        const config = readConfigSafe();
        const teams = listTeams(config);
        const selectedTeamId = safeNormalizeAgentId(mainAgentId || "") || teams[0]?.mainAgentId || MAIN_AGENT_ID;
        const initialResult = readCollaborationSync(selectedTeamId);
        ensureArray(initialResult.data.workflowRuns || [])
            .filter((run) => {
                const status = ensureString(run?.status || "");
                return status && !["completed", "failed"].includes(status);
            })
            .forEach((run) => {
                try {
                    hydrateWorkflowFromSpawnedSessions(selectedTeamId, ensureString(run?.runId || ""));
                } catch (_) {}
            });
        const collaborationResult = readCollaborationSync(selectedTeamId);
        const collaboration = cloneJson(collaborationResult.data);
        const allAgentIds = Array.from(new Set(
            getAgentIds(config)
                .concat(collaboration?.topology?.mainAgentId || [])
                .concat(collaboration?.topology?.childAgentIds || [])
        )).filter(Boolean);
        const agents = allAgentIds
            .map((agentId) => buildAgentBuilderRecord(config, collaboration, agentId))
            .sort((a, b) => {
                if (a.id === collaboration.topology.mainAgentId) return -1;
                if (b.id === collaboration.topology.mainAgentId) return 1;
                if (a.isChild && !b.isChild) return -1;
                if (!a.isChild && b.isChild) return 1;
                return a.id.localeCompare(b.id, "zh-CN");
            });
        const teamAgentIds = [collaboration.topology.mainAgentId].concat(collaboration.topology.childAgentIds || []);
        const entryStatus = buildEntryStatus(teamAgentIds, agents);
        const dispatchMode = collaboration?.dispatchPolicy?.autoLaunchChildren !== false ? "auto" : "manual";
        const sessionActivity = {};
        teamAgentIds.forEach((agentId) => {
            const activity = readRecentAgentSessionActivity(config, agentId);
            if (activity) sessionActivity[agentId] = activity;
        });
        return {
            ok: true,
            mainAgentId: collaboration.topology.mainAgentId,
            teams,
            team: {
                name: String(collaboration?.team?.name || "榛樿鍥㈤槦").trim() || "榛樿鍥㈤槦",
                mainAgentId: collaboration.topology.mainAgentId,
                childAgentIds: cloneJson(collaboration.topology.childAgentIds || []),
                dispatchMode,
                templateId: String(collaboration?.team?.templateId || "custom").trim() || "custom",
                fallbackAgentId: String(collaboration?.team?.fallbackAgentId || "").trim(),
                strictDispatchOnly: collaboration?.team?.strictDispatchOnly !== false,
                entryStatus
            },
            agents,
            channels: buildChannelCatalog(config),
            modelCatalog: buildModelCatalog(config, collaboration.topology.mainAgentId),
            workflows: cloneJson(collaboration.workflowRuns || []),
            sessionActivity
        };
    }

    function scrubDeletedAgentsFromRemainingCollaborations(config = {}, deletedAgentIds = []) {
        const deletedSet = new Set(
            (Array.isArray(deletedAgentIds) ? deletedAgentIds : [])
                .map((agentId) => safeNormalizeAgentId(agentId))
                .filter(Boolean)
        );
        if (!deletedSet.size) return;

        getAgentIds(config)
            .map((agentId) => safeNormalizeAgentId(agentId))
            .filter(Boolean)
            .filter((agentId) => !deletedSet.has(agentId))
            .forEach((agentId) => {
                try {
                    const metadataDir = getAgentMetadataDir(config, agentId);
                    const targetPath = path.join(metadataDir, "collaboration.json");
                    if (!fs.existsSync(targetPath)) return;
                    const collaboration = cloneJson(readCollaborationSync(agentId).data);
                    let changed = false;

                    const currentChildren = Array.isArray(collaboration?.topology?.childAgentIds)
                        ? collaboration.topology.childAgentIds
                        : [];
                    const nextChildren = currentChildren.filter((childId) => !deletedSet.has(safeNormalizeAgentId(childId)));
                    if (nextChildren.length !== currentChildren.length) {
                        collaboration.topology = {
                            ...(collaboration.topology || {}),
                            childAgentIds: nextChildren
                        };
                        changed = true;
                    }

                    if (collaboration?.agents && typeof collaboration.agents === "object") {
                        const nextAgents = { ...collaboration.agents };
                        let removedAgentMeta = false;
                        deletedSet.forEach((agentIdToDelete) => {
                            if (nextAgents[agentIdToDelete]) {
                                delete nextAgents[agentIdToDelete];
                                removedAgentMeta = true;
                            }
                        });
                        if (removedAgentMeta) {
                            collaboration.agents = nextAgents;
                            changed = true;
                        }
                    }

                    if (!changed) return;
                    collaboration.updatedAt = nowIso();
                    writeCollaborationSync(agentId, collaboration);
                } catch (_) {}
            });
    }

    ipcMain.handle("get-agent-team-builder-data", (_, payload = {}) => {
        try {
            const mainAgentId = safeNormalizeAgentId(payload?.mainAgentId || payload?.agentId || MAIN_AGENT_ID) || MAIN_AGENT_ID;
            return buildTeamBuilderData(mainAgentId);
        } catch (error) {
            return {
                ok: false,
                error: error.message
            };
        }
    });

    ipcMain.handle("save-agent-team-builder-data", async (_, payload = {}) => {
        try {
            const currentConfig = readConfigSafe();
            const nextConfig = cloneJson(currentConfig || {});
            const mainAgentId = safeNormalizeAgentId(payload?.mainAgentId || payload?.team?.mainAgentId || MAIN_AGENT_ID) || MAIN_AGENT_ID;
            const childAgentIds = Array.from(new Set(
                (Array.isArray(payload?.team?.childAgentIds) ? payload.team.childAgentIds : [])
                    .map((entry) => safeNormalizeAgentId(entry))
                    .filter(Boolean)
                    .filter((entry) => entry !== mainAgentId)
            ));
            if (!childAgentIds.length) {
                throw new Error("创建团队至少需要 1 个子 Agent。");
            }
            const teamAgentIds = [mainAgentId].concat(childAgentIds);
            const requestedFallbackAgentId = safeNormalizeAgentId(payload?.team?.fallbackAgentId || "");
            const agentPayloadMap = new Map(
                (Array.isArray(payload?.agents) ? payload.agents : [])
                    .map((entry) => {
                        const id = safeNormalizeAgentId(entry?.id || "");
                        const nextEntry = { ...cloneJson(entry), id };
                        nextEntry.capabilityTags = normalizeCapabilityTags(nextEntry?.capabilityTags || nextEntry?.capabilities || []);
                        nextEntry.fallbackExecution = nextEntry?.fallbackExecution === true;
                        return [id, nextEntry];
                    })
                    .filter(([id]) => Boolean(id) && teamAgentIds.includes(id))
            );
            const fallbackByFlag = childAgentIds.find((agentId) => (agentPayloadMap.get(agentId) || {}).fallbackExecution === true) || "";
            const fallbackAgentId = childAgentIds.includes(requestedFallbackAgentId)
                ? requestedFallbackAgentId
                : fallbackByFlag;
            const templateId = String(payload?.team?.templateId || "custom").trim() || "custom";
            const strictDispatchOnly = payload?.team?.strictDispatchOnly !== false;

            if (!nextConfig.agents || typeof nextConfig.agents !== "object") nextConfig.agents = {};
            if (!nextConfig.agents.defaults || typeof nextConfig.agents.defaults !== "object") nextConfig.agents.defaults = {};
            if (!nextConfig.agents.defaults.model || typeof nextConfig.agents.defaults.model !== "object") nextConfig.agents.defaults.model = {};
            if (!Array.isArray(nextConfig.agents.list)) nextConfig.agents.list = [];
            if (!Array.isArray(nextConfig.bindings)) nextConfig.bindings = [];
            if (!nextConfig.tools || typeof nextConfig.tools !== "object") nextConfig.tools = {};
            const teamChildAllowAgents = childAgentIds
                .map((agentId) => safeNormalizeAgentId(agentId))
                .filter(Boolean);
            const currentAgentToAgent = nextConfig.tools.agentToAgent && typeof nextConfig.tools.agentToAgent === "object"
                ? nextConfig.tools.agentToAgent
                : {};
            const allowSet = new Set(
                (Array.isArray(currentAgentToAgent.allow) ? currentAgentToAgent.allow : [])
                    .map((agentId) => safeNormalizeAgentId(agentId))
                    .filter(Boolean)
            );
            teamAgentIds.forEach((agentId) => allowSet.add(agentId));
            nextConfig.tools.agentToAgent = {
                ...currentAgentToAgent,
                enabled: true,
                allow: Array.from(allowSet)
            };

            const modelCatalog = buildModelCatalog(nextConfig, mainAgentId);
            const defaultModelValue = normalizeConfiguredModelValue(
                nextConfig?.agents?.defaults?.model?.primary || "",
                modelCatalog,
                modelCatalog?.options?.[0]?.value || ""
            );
            const mainPayload = agentPayloadMap.get(mainAgentId) || {};
            const mainModelRaw = String(mainPayload?.model || "").trim();
            const mainModel = mainModelRaw
                ? normalizeConfiguredModelValue(mainModelRaw, modelCatalog, defaultModelValue)
                : "";
            const mainWorkspace = String(mainPayload?.workspace || "").trim();
            if (mainAgentId === MAIN_AGENT_ID) {
                if (mainModel) nextConfig.agents.defaults.model.primary = mainModel;
                else delete nextConfig.agents.defaults.model.primary;
                if (mainWorkspace) nextConfig.agents.defaults.workspace = mainWorkspace;
                else delete nextConfig.agents.defaults.workspace;
                const currentDefaultsSubagents = nextConfig.agents.defaults.subagents && typeof nextConfig.agents.defaults.subagents === "object"
                    ? nextConfig.agents.defaults.subagents
                    : {};
                nextConfig.agents.defaults.subagents = {
                    ...currentDefaultsSubagents,
                    allowAgents: cloneJson(teamChildAllowAgents)
                };
            } else {
                let mainEntry = nextConfig.agents.list.find((item) => safeNormalizeAgentId(item?.id || "") === mainAgentId);
                if (!mainEntry) {
                    mainEntry = { id: mainAgentId };
                    nextConfig.agents.list.push(mainEntry);
                }
                mainEntry.id = mainAgentId;
                mainEntry.name = String(mainPayload?.name || mainEntry.name || mainAgentId).trim() || mainAgentId;
                if (mainModel) mainEntry.model = mainModel;
                else delete mainEntry.model;
                const resolvedMainWorkspace = mainWorkspace || getAgentWorkspacePath(nextConfig, mainAgentId);
                if (resolvedMainWorkspace) mainEntry.workspace = resolvedMainWorkspace;
                else delete mainEntry.workspace;
                const mainAgentDir = String(mainPayload?.agentDir || mainEntry.agentDir || "").trim();
                if (mainAgentDir) mainEntry.agentDir = mainAgentDir;
                const currentEntrySubagents = mainEntry.subagents && typeof mainEntry.subagents === "object"
                    ? mainEntry.subagents
                    : {};
                mainEntry.subagents = {
                    ...currentEntrySubagents,
                    allowAgents: cloneJson(teamChildAllowAgents)
                };
            }

            const managedEntryIds = teamAgentIds.filter((agentId) => agentId !== MAIN_AGENT_ID);
            managedEntryIds.forEach((agentId) => {
                const payloadEntry = agentPayloadMap.get(agentId) || {};
                let entry = nextConfig.agents.list.find((item) => safeNormalizeAgentId(item?.id || "") === agentId);
                if (!entry) {
                    entry = { id: agentId };
                    nextConfig.agents.list.push(entry);
                }
                entry.id = agentId;
                entry.name = String(payloadEntry?.name || agentId).trim() || agentId;
                const modelRaw = String(payloadEntry?.model || "").trim();
                const model = modelRaw
                    ? normalizeConfiguredModelValue(modelRaw, modelCatalog, defaultModelValue)
                    : "";
                const workspace = String(payloadEntry?.workspace || "").trim();
                const agentDir = String(payloadEntry?.agentDir || entry.agentDir || "").trim();
                if (model) entry.model = model;
                else delete entry.model;
                const resolvedWorkspace = workspace || getAgentWorkspacePath(nextConfig, agentId);
                if (resolvedWorkspace) entry.workspace = resolvedWorkspace;
                else delete entry.workspace;
                if (agentDir) entry.agentDir = agentDir;
                if (agentId !== mainAgentId) {
                    const currentEntrySubagents = entry.subagents && typeof entry.subagents === "object"
                        ? entry.subagents
                        : {};
                    entry.subagents = {
                        ...currentEntrySubagents,
                        allowAgents: []
                    };
                }
            });

            const claimedMatchKeys = new Set();
            const nextBindings = [];
            teamAgentIds.forEach((agentId) => {
                const payloadEntry = agentPayloadMap.get(agentId) || {};
                const bindings = Array.isArray(payloadEntry?.bindings) ? payloadEntry.bindings : [];
                bindings.forEach((binding) => {
                    const match = buildBindingMatch(binding);
                    if (!match) return;
                    const matchKey = makeMatchKey(match);
                    if (claimedMatchKeys.has(matchKey)) return;
                    claimedMatchKeys.add(matchKey);
                    nextBindings.push({
                        agentId,
                        match
                    });
                });
            });

            nextConfig.bindings = nextConfig.bindings
                .filter((binding) => !teamAgentIds.includes(safeNormalizeAgentId(binding?.agentId || "")))
                .filter((binding) => !claimedMatchKeys.has(makeMatchKey(binding?.match || {})))
                .concat(nextBindings);

            const writeConfigResult = writeOpenClawConfigSync(nextConfig);
            if (writeConfigResult?.ok === false) {
                throw new Error(writeConfigResult.error || "淇濆瓨閰嶇疆澶辫触");
            }

            teamAgentIds.forEach((agentId) => {
                const payloadEntry = agentPayloadMap.get(agentId) || {};
                const displayName = String(payloadEntry?.name || getAgentDisplayName(nextConfig, {}, agentId) || agentId).trim();
                const managedFiles = buildManagedAgentFiles({
                    config: nextConfig,
                    agentId,
                    entry: {
                        ...payloadEntry,
                        name: displayName,
                        fallbackExecution: agentId === fallbackAgentId,
                        roleTitle: resolveAgentRoleTitle(payloadEntry?.roleTitle || "", agentId === mainAgentId)
                    },
                    teamName: String(payload?.team?.name || "默认团队").trim() || "默认团队",
                    mainAgentId,
                    childAgentIds,
                    dispatchMode: String(payload?.team?.dispatchMode || "auto").trim() === "manual" ? "manual" : "auto",
                    teamAgents: teamAgentIds.map((memberId) => {
                        const memberPayload = agentPayloadMap.get(memberId) || {};
                        const memberLabel = String(memberPayload?.name || getAgentDisplayName(nextConfig, {}, memberId) || memberId).trim() || memberId;
                        const memberRoleTitle = String(memberPayload?.roleTitle || (memberId === mainAgentId ? "主 Agent" : "子 Agent")).trim() || (memberId === mainAgentId ? "主 Agent" : "子 Agent");
                        return {
                            id: memberId,
                            name: memberLabel,
                            roleTitle: memberRoleTitle,
                            responsibilities: resolveAgentResponsibilities(memberPayload?.responsibilities || "", memberId, memberLabel, memberRoleTitle),
                            capabilityTags: resolveAgentCapabilityTags(memberPayload?.capabilityTags || [], memberId, memberLabel, memberRoleTitle),
                            fallbackExecution: memberId === fallbackAgentId,
                            workspace: String(memberPayload?.workspace || getAgentWorkspacePath(nextConfig, memberId) || "").trim()
                        };
                    })
                });
                Object.entries(managedFiles).forEach(([fileName, content]) => {
                    writeAgentWorkspaceFile(nextConfig, agentId, fileName, content, displayName);
                });
            });

            const currentCollaboration = cloneJson(readCollaborationSync(mainAgentId).data);
            const previousAgents = cloneJson(currentCollaboration?.agents || {});
            currentCollaboration.team = {
                ...(currentCollaboration.team || {}),
                name: String(payload?.team?.name || currentCollaboration?.team?.name || "默认团队").trim() || "默认团队",
                templateId,
                fallbackAgentId,
                strictDispatchOnly
            };
            currentCollaboration.topology = {
                mainAgentId,
                childAgentIds
            };
            const dispatchMode = String(payload?.team?.dispatchMode || "auto").trim() === "manual" ? "manual" : "auto";
            currentCollaboration.dispatchPolicy = {
                ...(currentCollaboration.dispatchPolicy || {}),
                autoLaunchChildren: dispatchMode === "auto",
                autoStartCollection: dispatchMode === "auto"
            };
            currentCollaboration.agents = {};
            teamAgentIds.forEach((agentId) => {
                const payloadEntry = agentPayloadMap.get(agentId) || {};
                const previousAgent = previousAgents?.[agentId] || {};
                const avatarFromPayload = payloadEntry?.avatar && typeof payloadEntry.avatar === "object"
                    ? cloneJson(payloadEntry.avatar)
                    : null;
                const avatarFromPrevious = previousAgent?.avatar && typeof previousAgent.avatar === "object"
                    ? cloneJson(previousAgent.avatar)
                    : null;
                currentCollaboration.agents[agentId] = normalizeAgentProfile(
                    agentId,
                    {
                        label: (() => String(payloadEntry?.name || getAgentDisplayName(nextConfig, currentCollaboration, agentId) || agentId).trim())(),
                        title: resolveAgentRoleTitle(payloadEntry?.roleTitle || "", agentId === mainAgentId),
                        responsibilities: resolveAgentResponsibilities(
                            payloadEntry?.responsibilities || previousAgent?.responsibilities || "",
                            agentId,
                            String(payloadEntry?.name || getAgentDisplayName(nextConfig, currentCollaboration, agentId) || agentId).trim(),
                            String(payloadEntry?.roleTitle || (agentId === mainAgentId ? "主 Agent" : "子 Agent")).trim()
                        ),
                        capabilityTags: resolveAgentCapabilityTags(
                            payloadEntry?.capabilityTags || previousAgent?.capabilityTags || [],
                            agentId,
                            String(payloadEntry?.name || getAgentDisplayName(nextConfig, currentCollaboration, agentId) || agentId).trim(),
                            String(payloadEntry?.roleTitle || (agentId === mainAgentId ? "主 Agent" : "子 Agent")).trim()
                        ),
                        fallbackExecution: agentId === fallbackAgentId,
                        modelOverride: (() => {
                            const rawModel = String(payloadEntry?.model || "").trim();
                            return rawModel
                                ? normalizeConfiguredModelValue(rawModel, modelCatalog, defaultModelValue)
                                : "";
                        })(),
                        workspaceOverride: String(payloadEntry?.workspace || "").trim(),
                        avatar: avatarFromPayload || avatarFromPrevious || buildGeneratedAvatar(agentId, payloadEntry?.name || agentId)
                    },
                    agentId === mainAgentId ? "主 Agent" : agentId
                );
            });
            currentCollaboration.updatedAt = nowIso();
            writeCollaborationSync(mainAgentId, currentCollaboration);
            const sessionReset = resetReusableAgentSessions(nextConfig, mainAgentId);
            sessionReset.gateway = await syncGatewayReusableSessionResets(sessionReset);

            const childSet = new Set(childAgentIds);
            getAgentIds(nextConfig)
                .filter((agentId) => agentId && agentId !== mainAgentId)
                .forEach((agentId) => {
                    try {
                        const targetPath = path.join(getAgentMetadataDir(nextConfig, agentId), "collaboration.json");
                        if (!fs.existsSync(targetPath)) return;
                        const otherCollaboration = cloneJson(readCollaborationSync(agentId).data);
                        const currentChildren = Array.isArray(otherCollaboration?.topology?.childAgentIds)
                            ? otherCollaboration.topology.childAgentIds
                            : [];
                        const nextChildren = currentChildren.filter((childId) => !childSet.has(childId));
                        if (nextChildren.length === currentChildren.length) return;
                        otherCollaboration.topology = {
                            ...(otherCollaboration.topology || {}),
                            mainAgentId: safeNormalizeAgentId(otherCollaboration?.topology?.mainAgentId || agentId) || agentId,
                            childAgentIds: nextChildren
                        };
                        otherCollaboration.updatedAt = nowIso();
                        writeCollaborationSync(agentId, otherCollaboration);
                    } catch (_) {}
                });

            broadcast("team-builder-saved", {
                agentId: mainAgentId,
                sessionReset
            });
            return {
                ...buildTeamBuilderData(mainAgentId),
                sessionReset
            };
        } catch (error) {
            return {
                ok: false,
                error: error.message
            };
        }
    });

    ipcMain.handle("export-agent-team-config", async (_, payload = {}) => {
        try {
            const exportDoc = buildPortableTeamExportDocument(payload?.draft || payload);
            const targetWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
            const saveResult = await dialog.showSaveDialog(targetWindow, {
                title: "导出团队配置",
                defaultPath: buildPortableTeamFileName(exportDoc?.source?.teamName, exportDoc?.source?.mainAgentId),
                filters: [
                    { name: "JSON 配置", extensions: ["json"] }
                ],
                properties: ["createDirectory", "showOverwriteConfirmation"]
            });
            if (saveResult.canceled || !saveResult.filePath) {
                return { ok: true, canceled: true };
            }
            fs.writeFileSync(saveResult.filePath, `${JSON.stringify(exportDoc, null, 2)}\n`, "utf8");
            return {
                ok: true,
                canceled: false,
                path: saveResult.filePath
            };
        } catch (error) {
            return {
                ok: false,
                error: error.message
            };
        }
    });

    ipcMain.handle("import-agent-team-config", async () => {
        try {
            const targetWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
            const openResult = await dialog.showOpenDialog(targetWindow, {
                title: "导入团队配置",
                filters: [
                    { name: "JSON 配置", extensions: ["json"] }
                ],
                properties: ["openFile"]
            });
            if (openResult.canceled || !Array.isArray(openResult.filePaths) || !openResult.filePaths[0]) {
                return { ok: true, canceled: true };
            }
            const filePath = openResult.filePaths[0];
            const fileContent = fs.readFileSync(filePath, "utf8");
            const imported = parsePortableTeamImportDocument(fileContent);
            return {
                ok: true,
                canceled: false,
                path: filePath,
                draft: imported.draft,
                meta: imported.meta
            };
        } catch (error) {
            return {
                ok: false,
                error: error.message
            };
        }
    });

    ipcMain.handle("delete-agent-team", (_, payload = {}) => {
        try {
            const currentConfig = readConfigSafe();
            const nextConfig = cloneJson(currentConfig || {});
            const mainAgentId = safeNormalizeAgentId(payload?.mainAgentId || payload?.team?.mainAgentId || "") || "";
            if (!mainAgentId) throw new Error("缺少团队主 Agent。");
            if (mainAgentId === MAIN_AGENT_ID) throw new Error("默认团队不支持解散删除。");

            const collaboration = cloneJson(readCollaborationSync(mainAgentId).data);
            const childAgentIds = Array.isArray(collaboration?.topology?.childAgentIds)
                ? collaboration.topology.childAgentIds.map((entry) => safeNormalizeAgentId(entry)).filter(Boolean)
                : [];
            const deletedAgentIds = Array.from(new Set([mainAgentId].concat(childAgentIds)));

            if (Array.isArray(nextConfig?.agents?.list)) {
                nextConfig.agents.list = nextConfig.agents.list.filter((item) => !deletedAgentIds.includes(safeNormalizeAgentId(item?.id || "")));
            }

            if (nextConfig?.agents?.profiles && typeof nextConfig.agents.profiles === "object") {
                deletedAgentIds.forEach((agentId) => {
                    delete nextConfig.agents.profiles[agentId];
                });
            }

            if (Array.isArray(nextConfig?.bindings)) {
                nextConfig.bindings = nextConfig.bindings.filter((binding) => !deletedAgentIds.includes(safeNormalizeAgentId(binding?.agentId || "")));
            }

            if (nextConfig?.tools?.agentToAgent && Array.isArray(nextConfig.tools.agentToAgent.allow)) {
                nextConfig.tools.agentToAgent.allow = nextConfig.tools.agentToAgent.allow
                    .map((agentId) => safeNormalizeAgentId(agentId))
                    .filter((agentId) => agentId && !deletedAgentIds.includes(agentId));
            }

            if (nextConfig?.agents?.defaults?.subagents && Array.isArray(nextConfig.agents.defaults.subagents.allowAgents)) {
                nextConfig.agents.defaults.subagents.allowAgents = nextConfig.agents.defaults.subagents.allowAgents
                    .map((agentId) => safeNormalizeAgentId(agentId))
                    .filter((agentId) => agentId && !deletedAgentIds.includes(agentId));
            }

            if (Array.isArray(nextConfig?.agents?.list)) {
                nextConfig.agents.list.forEach((entry) => {
                    if (!entry?.subagents || !Array.isArray(entry.subagents.allowAgents)) return;
                    entry.subagents.allowAgents = entry.subagents.allowAgents
                        .map((agentId) => safeNormalizeAgentId(agentId))
                        .filter((agentId) => agentId && !deletedAgentIds.includes(agentId));
                });
            }

            scrubDeletedAgentsFromRemainingCollaborations(nextConfig, deletedAgentIds);

            const writeConfigResult = writeOpenClawConfigSync(nextConfig);
            if (writeConfigResult?.ok === false) {
                throw new Error(writeConfigResult.error || "鍒犻櫎鍥㈤槦澶辫触");
            }

            deletedAgentIds.forEach((agentId) => {
                try {
                    const metadataDir = getAgentMetadataDir(nextConfig, agentId);
                    const agentRoot = path.dirname(metadataDir);
                    if (fs.existsSync(agentRoot)) {
                        fs.rmSync(agentRoot, {
                            recursive: true,
                            force: true,
                            maxRetries: 4,
                            retryDelay: 150
                        });
                    }
                } catch (_) {}
            });

            const fallbackTeams = listTeams(nextConfig);
            const fallbackMainAgentId = fallbackTeams[0]?.mainAgentId || MAIN_AGENT_ID;
            broadcast("team-builder-saved", {
                agentId: fallbackMainAgentId
            });
            return {
                ok: true,
                removedAgentIds: deletedAgentIds,
                removedTeamMainAgentId: mainAgentId,
                next: buildTeamBuilderData(fallbackMainAgentId)
            };
        } catch (error) {
            return {
                ok: false,
                error: error.message
            };
        }
    });

    ipcMain.handle("get-agent-collaboration", (_, payload = {}) => {
        const result = readCollaborationSync(payload.agentId || payload.mainAgentId || MAIN_AGENT_ID);
        return { ok: true, agentId: result.mainAgentId, path: result.targetPath, collaboration: result.data };
    });

    ipcMain.handle("save-agent-collaboration", async (_, payload = {}) => {
        try {
            const result = writeCollaborationSync(payload.agentId || payload.mainAgentId || MAIN_AGENT_ID, payload.collaboration || {});
            const sessionReset = resetReusableAgentSessions(readConfigSafe(), result.mainAgentId);
            sessionReset.gateway = await syncGatewayReusableSessionResets(sessionReset);
            broadcast("saved", { agentId: result.mainAgentId, collaboration: result.data, sessionReset });
            return { ok: true, agentId: result.mainAgentId, collaboration: result.data, sessionReset };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    function startAgentWorkflowInternal(payload = {}) {
        const result = readCollaborationSync(payload.agentId || payload.mainAgentId || MAIN_AGENT_ID);
        const collaboration = clone(result.data);
        const mainAgentId = collaboration.topology?.mainAgentId || result.mainAgentId;
        const childAgentIds = ensureArray(collaboration?.topology?.childAgentIds).filter(Boolean);
        if (!childAgentIds.length) {
            throw new Error("当前团队至少需要 1 个子 Agent，主 Agent 才能自动派发任务。");
        }
        const mainAgent = collaboration.agents?.[mainAgentId] || normalizeAgentProfile(mainAgentId, {}, "主 Agent");
        const createdAt = nowIso();
        const runId = createId("run");
        const summary = ensureString(payload.summary || payload.name || "新建编排任务") || "新建编排任务";
        const message = ensureString(payload.message || summary) || summary;
        const planningItem = normalizeRunItem({
            itemId: createId("item"),
            phase: "planning",
            agentId: mainAgentId,
            label: mainAgent.label,
            status: "pending",
            taskSummary: `规划并派单：${summary}`,
            workflowId: runId,
            updatedAt: createdAt,
            message,
            note: "等待主 Agent 生成派单计划。"
        }, collaboration);
        const run = normalizeWorkflowRun({
            runId,
            templateId: ensureString(payload.templateId || collaboration?.team?.templateId || "ad-hoc") || "ad-hoc",
            name: ensureString(payload.name || summary) || summary,
            summary,
            taskType: ensureString(payload.taskType || "general") || "general",
            message,
            thinking: ensureString(payload.thinking || "medium") || "medium",
            source: payload.source && typeof payload.source === "object" ? clone(payload.source) : null,
            items: [planningItem],
            startedAt: createdAt,
            updatedAt: createdAt
        }, collaboration);
        collaboration.workflowRuns = [run].concat(Array.isArray(collaboration.workflowRuns) ? collaboration.workflowRuns : []).slice(0, 30);
        collaboration.updatedAt = createdAt;
        const saved = writeCollaborationSync(result.mainAgentId, collaboration);
        const savedRun = getRunById(saved.data, runId);
        broadcast("run-started", { agentId: result.mainAgentId, run: savedRun });
        if (payload.autoRun !== false) {
            setTimeout(() => {
                try {
                    startWorkflowPlanningRun(result.mainAgentId, runId);
                } catch (error) {
                    try {
                        updateWorkflowItemState(result.mainAgentId, runId, planningItem.itemId, {
                            status: "failed",
                            error: error.message || String(error),
                            note: error.message || String(error)
                        });
                    } catch (_) {}
                }
            }, 0);
        }
        return { ok: true, run: savedRun, collaboration: saved.data };
    }

    function applyDispatchPlanInternal(mainAgentId = MAIN_AGENT_ID, runId = "", planInput = {}, options = {}) {
        const result = readCollaborationSync(mainAgentId);
        const collaboration = clone(result.data);
        const run = getRunById(collaboration, runId);
        if (!run) throw new Error(`Workflow not found: ${runId}`);
        const parsedPlan = typeof planInput === "string" ? JSON.parse(planInput) : planInput;
        if (!parsedPlan || typeof parsedPlan !== "object") throw new Error("派单计划必须是 JSON 对象。");
        const planningItem = ensureArray(run.items).find((item) => item.phase === "planning");
        if (!planningItem) throw new Error("当前工作流缺少规划项。");
        if (ensureArray(run.items).some((item) => item.phase === "execution") && options.force !== true) {
            throw new Error("这个工作流已经应用过派单计划。");
        }
        const assignments = validateAssignments(parsedPlan.assignments, collaboration);
        const appliedAt = nowIso();
        const executionItems = assignments.map((assignment) => {
            const childAgent = collaboration.agents?.[assignment.agentId] || normalizeAgentProfile(assignment.agentId, {}, assignment.agentId);
            return normalizeRunItem({
                itemId: createId("item"),
                phase: "execution",
                agentId: assignment.agentId,
                label: childAgent.label,
                status: "pending",
                taskSummary: assignment.objective || `${run.summary || run.name} - execution`,
                workflowId: run.runId,
                updatedAt: appliedAt,
                message: assignment.objective || run.message || run.summary || run.name,
                note: "等待子 Agent 执行。",
                structuredPayload: assignment
            }, collaboration);
        });
        planningItem.status = "completed";
        planningItem.completedAt = appliedAt;
        planningItem.updatedAt = appliedAt;
        planningItem.note = `派单计划已生成，共 ${executionItems.length} 个子任务。`;
        planningItem.structuredPayload = clone(parsedPlan);
        planningItem.resultSummary = `已创建 ${executionItems.length} 个子任务。`;
        planningItem.error = "";
        run.plan = {
            status: "applied",
            assignments: clone(assignments),
            collectionBrief: ensureString(parsedPlan.collectionBrief),
            rawPlan: clone(parsedPlan),
            error: "",
            appliedAt
        };
        run.items = [planningItem].concat(executionItems);
        return writeWorkflowRun(result.mainAgentId, run, collaboration, "dispatch-applied");
    }

    function startCollectionInternal(mainAgentId = MAIN_AGENT_ID, runId = "", options = {}) {
        const result = readCollaborationSync(mainAgentId);
        const collaboration = clone(result.data);
        const run = getRunById(collaboration, runId);
        if (!run) throw new Error(`Workflow not found: ${runId}`);
        const executionItems = ensureArray(run.items).filter((item) => item.phase === "execution");
        if (!executionItems.length) throw new Error("当前工作流还没有子 Agent 执行项。");
        if (!executionItems.every((item) => item.status === "completed")) {
            throw new Error("必须等全部子 Agent 执行完成后，才能启动汇总。");
        }
        const existingCollection = ensureArray(run.items).find((item) => item.phase === "collecting");
        if (existingCollection && existingCollection.status !== "failed" && options.force !== true) {
            throw new Error("这个工作流已经启动过汇总。");
        }
        const finalMainAgentId = collaboration.topology?.mainAgentId || result.mainAgentId;
        const mainAgent = collaboration.agents?.[finalMainAgentId] || normalizeAgentProfile(finalMainAgentId, {}, "主 Agent");
        const createdAt = nowIso();
        const collectionItem = normalizeRunItem({
            itemId: createId("item"),
            phase: "collecting",
            agentId: finalMainAgentId,
            label: mainAgent.label,
            status: "pending",
            taskSummary: options.summary || `汇总最终结果：${run.summary || run.name}`,
            workflowId: run.runId,
            updatedAt: createdAt,
            message: run.message || run.summary || run.name,
            note: "等待主 Agent 汇总子任务结果。",
            structuredPayload: { collectionBrief: run.plan?.collectionBrief || "", executionItems: clone(executionItems) }
        }, collaboration);
        run.items = ensureArray(run.items).filter((item) => item.phase !== "collecting").concat(collectionItem);
        return writeWorkflowRun(result.mainAgentId, run, collaboration, "collection-started");
    }

    ipcMain.handle("list-agent-work-runs", (_, payload = {}) => {
        const mainAgentId = payload.agentId || payload.mainAgentId || MAIN_AGENT_ID;
        const initial = readCollaborationSync(mainAgentId);
        ensureArray(initial.data.workflowRuns || [])
            .filter((run) => {
                const status = ensureString(run?.status || "");
                return status && !["completed", "failed"].includes(status);
            })
            .forEach((run) => {
                try {
                    hydrateWorkflowFromSpawnedSessions(mainAgentId, ensureString(run?.runId || ""));
                } catch (_) {}
            });
        const result = readCollaborationSync(mainAgentId);
        return { ok: true, runs: result.data.workflowRuns || [] };
    });

    ipcMain.handle("start-agent-workflow", (_, payload = {}) => {
        try {
            return startAgentWorkflowInternal(payload);
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle("submit-agent-team-message", (_, payload = {}) => {
        try {
            return startAgentWorkflowInternal({
                ...payload,
                summary: payload.summary || payload.name || payload.message || "主 Agent 消息",
                autoRun: payload.autoRun !== false
            });
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle("apply-agent-dispatch-plan", (_, payload = {}) => {
        try {
            const saved = applyDispatchPlanInternal(payload.agentId || payload.mainAgentId || MAIN_AGENT_ID, payload.runId, payload.plan, {
                force: payload.force === true
            });
            if (payload.autoRunChildren === true) {
                ensureArray(saved.run?.items)
                    .filter((item) => item.phase === "execution")
                    .forEach((item) => {
                        startWorkflowExecutionRun(saved.mainAgentId, saved.run.runId, item.itemId).catch(() => {});
                    });
            }
            return { ok: true, collaboration: saved.collaboration, run: saved.run };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle("start-agent-collection", (_, payload = {}) => {
        try {
            const saved = startCollectionInternal(payload.agentId || payload.mainAgentId || MAIN_AGENT_ID, payload.runId, {
                force: payload.force === true,
                summary: payload.summary
            });
            return { ok: true, collaboration: saved.collaboration, run: saved.run };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle("update-agent-work-item", (_, payload = {}) => {
        try {
            const result = readCollaborationSync(payload.agentId || payload.mainAgentId || MAIN_AGENT_ID);
            const collaboration = clone(result.data);
            const run = getRunById(collaboration, payload.runId);
            if (!run) throw new Error(`Workflow not found: ${payload.runId}`);
            const item = getRunItem(run, payload.itemId);
            if (!item) throw new Error(`Workflow item not found: ${payload.itemId}`);
            const patch = payload.patch && typeof payload.patch === "object" ? payload.patch : {};
            Object.keys(patch).forEach((key) => {
                item[key] = patch[key] && typeof patch[key] === "object" ? clone(patch[key]) : patch[key];
            });
            if (payload.action === "retry") {
                item.status = "pending";
                item.startedAt = "";
                item.completedAt = "";
                item.error = "";
                item.resultSummary = "";
                item.note = "";
            }
            if (payload.action === "pause") item.status = "paused";
            if (payload.action === "collect") {
                item.status = "completed";
                item.completedAt = nowIso();
            }
            if (payload.action === "reassign" && payload.nextAgentId) {
                const nextAgentId = payload.nextAgentId;
                const nextAgent = collaboration.agents?.[nextAgentId] || normalizeAgentProfile(nextAgentId, {}, nextAgentId);
                item.agentId = nextAgentId;
                item.label = nextAgent.label;
            }
            if (item.status === "running" && !item.startedAt) item.startedAt = nowIso();
            if (item.status === "completed" && !item.completedAt) item.completedAt = nowIso();
            item.updatedAt = nowIso();
            run.updatedAt = nowIso();
            run.status = deriveRunStatus(run);
            collaboration.updatedAt = nowIso();
            const saved = writeCollaborationSync(result.mainAgentId, collaboration);
            const savedRun = getRunById(saved.data, run.runId);
            broadcast("item-updated", { agentId: result.mainAgentId, runId: run.runId, itemId: item.itemId, run: savedRun });
            return { ok: true, collaboration: saved.data, run: savedRun };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle("set-agent-avatar", (_, payload = {}) => {
        try {
            const mainAgentId = payload.mainAgentId || payload.agentId || MAIN_AGENT_ID;
            const targetAgentId = payload.targetAgentId || payload.agentId || MAIN_AGENT_ID;
            const dataUrl = String(payload.dataUrl || "").trim();
            const presetId = String(payload.presetId || "").trim();
            const presetLabel = String(payload.label || "").trim();
            const sourceUrl = String(payload.sourceUrl || "").trim();
            const license = String(payload.license || "").trim();
            if (!dataUrl) throw new Error("Missing avatar data.");
            const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (!match) throw new Error("Invalid avatar data URL.");
            const mimeType = String(match[1] || "").trim().toLowerCase();
            const ext = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg" }[mimeType]) || ".png";
            const result = readCollaborationSync(mainAgentId);
            const avatarDir = path.join(getAgentMetadataDir(readConfigSafe(), result.mainAgentId), "avatars");
            ensureDirectory(avatarDir);
            const targetPath = path.join(avatarDir, `${targetAgentId}-${Date.now()}${ext}`);
            fs.writeFileSync(targetPath, Buffer.from(String(match[2] || "").trim(), "base64"));
            const collaboration = clone(result.data);
            const agent = collaboration.agents?.[targetAgentId] || normalizeAgentProfile(targetAgentId, {}, targetAgentId);
            collaboration.agents[targetAgentId] = {
                ...agent,
                avatar: {
                    ...buildGeneratedAvatar(targetAgentId, agent.label || targetAgentId),
                    mode: "custom",
                    path: targetPath,
                    presetId,
                    presetLabel,
                    sourceUrl,
                    license,
                    updatedAt: nowIso()
                }
            };
            collaboration.updatedAt = nowIso();
            const saved = writeCollaborationSync(result.mainAgentId, collaboration);
            broadcast("avatar-updated", { agentId: result.mainAgentId, targetAgentId });
            return { ok: true, avatar: saved.data.agents?.[targetAgentId]?.avatar || null };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle("read-agent-avatar", (_, payload = {}) => {
        try {
            const result = readCollaborationSync(payload.mainAgentId || payload.agentId || MAIN_AGENT_ID);
            const targetAgentId = payload.targetAgentId || payload.agentId || MAIN_AGENT_ID;
            const avatar = result.data.agents?.[targetAgentId]?.avatar;
            if (!avatar || avatar.mode !== "custom" || !avatar.path) return { ok: true, dataUrl: null };
            return { ok: true, dataUrl: readAvatarAsDataUrl(avatar.path) };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });

    ipcMain.handle("list-agent-avatar-presets", () => {
        try {
            return {
                ok: true,
                presets: readAvatarPresetManifest()
            };
        } catch (error) {
            return { ok: false, error: error.message, presets: [] };
        }
    });
}

module.exports = {
    registerMultiAgentIpcHandlers
};
