function createMultiAgentStore(deps = {}) {
    const {
        fs,
        path,
        readOpenClawConfigSync,
        normalizeAgentName,
        getAgentRootPath,
        ensureDirectory
    } = deps;

    const MAIN_AGENT_ID = "main";
    const ITEM_PHASES = new Set(["planning", "execution", "collecting"]);
    const STATUS_ORDER = new Set([
        "idle",
        "pending",
        "running",
        "waiting_collect",
        "completed",
        "failed",
        "paused"
    ]);
    const THEMES = ["teal", "amber", "rose", "blue", "mint", "violet"];
    const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

    function nowIso() {
        return new Date().toISOString();
    }

    function createId(prefix = "id") {
        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function readConfigSafe() {
        try {
            return readOpenClawConfigSync() || {};
        } catch (_) {
            return {};
        }
    }

    function listConfiguredAgentIds(config = {}) {
        const ids = new Set([MAIN_AGENT_ID]);
        const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
        list.forEach((entry) => {
            try {
                ids.add(normalizeAgentName(entry?.id || ""));
            } catch (_) {}
        });
        return Array.from(ids).filter(Boolean);
    }

    function getConfiguredAgentEntry(config = {}, agentName = MAIN_AGENT_ID) {
        const normalized = normalizeAgentName(agentName);
        const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
        return list.find((item) => {
            try {
                return normalizeAgentName(item?.id || "") === normalized;
            } catch (_) {
                return false;
            }
        }) || null;
    }

    function getAgentMetadataDir(config = {}, agentName = MAIN_AGENT_ID) {
        const entry = getConfiguredAgentEntry(config, agentName);
        if (entry?.agentDir) return String(entry.agentDir).trim();
        return path.join(getAgentRootPath(agentName), "agent");
    }

    function getCollaborationFilePath(config = {}, agentName = MAIN_AGENT_ID) {
        return path.join(getAgentMetadataDir(config, agentName), "collaboration.json");
    }

    function themeFor(agentId = MAIN_AGENT_ID) {
        const normalizedId = normalizeAgentName(agentId);
        const seed = normalizedId.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
        return THEMES[Math.abs(seed) % THEMES.length];
    }

    function buildGeneratedAvatar(agentId, label = "") {
        const normalizedId = normalizeAgentName(agentId);
        const safeLabel = String(label || normalizedId).trim() || normalizedId;
        return {
            mode: "generated",
            path: "",
            seed: normalizedId,
            theme: themeFor(normalizedId),
            fallbackInitial: safeLabel.slice(0, 1).toUpperCase() || "A"
        };
    }

    function normalizeTagList(input = []) {
        const raw = Array.isArray(input)
            ? input
            : String(input || "").split(",").map((entry) => entry.trim());
        return Array.from(new Set(raw.map((entry) => String(entry || "").trim()).filter(Boolean)));
    }

    function isCorruptedQuestionMarkText(value = "") {
        const trimmed = String(value || "").trim();
        if (!trimmed) return false;
        if (!/[?？�]/.test(trimmed)) return false;
        const normalized = trimmed.replace(/[?？�\s\.,;:!！、，。；：“”"'‘’()（）\[\]【】\-_/]+/g, "");
        return normalized.length === 0;
    }

    function getDefaultAgentTitle(normalizedId = MAIN_AGENT_ID) {
        return normalizedId === MAIN_AGENT_ID ? "主编排 Agent" : "执行专家";
    }

    function getDefaultAgentResponsibilities(normalizedId = MAIN_AGENT_ID, label = "") {
        const normalizedLabel = String(label || "").trim();
        if (normalizedId === MAIN_AGENT_ID) {
            return "负责接收任务、拆解任务、分发子 Agent，并在最后统一汇总结果。";
        }
        if (normalizedId === "writer" || normalizedLabel.includes("写手") || normalizedLabel.includes("文案")) {
            return "负责文案撰写、文章输出、改写润色和内容交付。";
        }
        if (normalizedId === "coder" || normalizedLabel.includes("代码") || normalizedLabel.includes("程序")) {
            return "负责代码开发、脚本实现、技术排查和修复。";
        }
        if (normalizedId === "brainstorm" || normalizedLabel.includes("创意") || normalizedLabel.includes("策划")) {
            return "负责创意策划、头脑风暴、方案构思和选题方向。";
        }
        if (normalizedId === "backstop" || normalizedLabel.includes("兜底")) {
            return "负责兜底执行没有匹配专职角色的任务，并处理模糊任务、查询资料和通用杂活。";
        }
        return "负责执行主 Agent 派发的具体任务，并输出可汇总结果。";
    }

    function normalizeAgentProfile(agentId, input = {}, fallbackLabel = "") {
        const normalizedId = normalizeAgentName(input.agentId || agentId || MAIN_AGENT_ID);
        const label = String(input.label || fallbackLabel || normalizedId).trim() || normalizedId;
        const avatarInput = input.avatar && typeof input.avatar === "object" ? clone(input.avatar) : null;
        const capabilityTags = normalizeTagList(input.capabilityTags || input.capabilities || []);
        const rawTitle = String(input.title || input.roleTitle || "").trim();
        const rawResponsibilities = String(input.responsibilities || "").trim();
        return {
            agentId: normalizedId,
            label,
            title: isCorruptedQuestionMarkText(rawTitle)
                ? getDefaultAgentTitle(normalizedId)
                : (rawTitle || getDefaultAgentTitle(normalizedId)),
            responsibilities: isCorruptedQuestionMarkText(rawResponsibilities)
                ? getDefaultAgentResponsibilities(normalizedId, label)
                : (rawResponsibilities || getDefaultAgentResponsibilities(normalizedId, label)),
            capabilityTags,
            fallbackExecution: input.fallbackExecution === true || capabilityTags.includes("generalist"),
            modelOverride: String(input.modelOverride || input.model || "").trim(),
            workspaceOverride: String(input.workspaceOverride || input.workspace || "").trim(),
            avatar: avatarInput
                ? { ...buildGeneratedAvatar(normalizedId, label), ...avatarInput }
                : buildGeneratedAvatar(normalizedId, label)
        };
    }

    function normalizeTopology(input = {}, fallbackMainAgentId = MAIN_AGENT_ID, legacyRoleIds = [], configuredIds = []) {
        const mainAgentId = normalizeAgentName(input.mainAgentId || fallbackMainAgentId || MAIN_AGENT_ID);
        const sourceItems = Array.isArray(input.childAgentIds)
            ? input.childAgentIds
            : []
                .concat(input.workerAgentIds || [])
                .concat(input.reviewerAgentIds || [])
                .concat(input.testerAgentIds || [])
                .concat(legacyRoleIds || [])
                .concat(configuredIds || []);
        const childAgentIds = Array.from(new Set(sourceItems.map((item) => {
            try {
                return normalizeAgentName(item || "");
            } catch (_) {
                return "";
            }
        }).filter(Boolean).filter((item) => item !== mainAgentId)));
        return { mainAgentId, childAgentIds };
    }

    function normalizeDispatchPolicy(input = {}) {
        const defaultPrompt = [
            "\u4f60\u662f\u4e3b\u7f16\u6392 Agent\u3002",
            "\u4e0d\u8981\u4eb2\u81ea\u6267\u884c\u4efb\u52a1\u3002",
            "\u8bf7\u628a\u6536\u5230\u7684\u4efb\u52a1\u62c6\u6210\u591a\u4e2a\u5b50 Agent \u6267\u884c\u5355\u3002",
            "\u53ea\u8fd4\u56de JSON\uff0c\u7ed3\u6784\u4e3a {\"assignments\":[{\"agentId\":\"...\",\"objective\":\"...\",\"deliverable\":\"...\",\"reason\":\"...\"}],\"collectionBrief\":\"...\"}\u3002"
        ].join(" ");
        return {
            planningPromptTemplate: String(input.planningPromptTemplate || defaultPrompt).trim() || defaultPrompt,
            planFormatVersion: String(input.planFormatVersion || "openclaw-dispatch-v1").trim() || "openclaw-dispatch-v1",
            autoLaunchChildren: input.autoLaunchChildren !== false,
            autoStartCollection: input.autoStartCollection === true
        };
    }

    function normalizeTeamMeta(input = {}, topology = {}, agents = {}) {
        const fallbackName = topology?.mainAgentId === MAIN_AGENT_ID
            ? "\u9ed8\u8ba4\u56e2\u961f"
            : `${topology?.mainAgentId || MAIN_AGENT_ID} \u56e2\u961f`;
        const childIds = Array.isArray(topology?.childAgentIds) ? topology.childAgentIds : [];
        const explicitFallbackId = childIds.includes(String(input.fallbackAgentId || "").trim())
            ? String(input.fallbackAgentId || "").trim()
            : "";
        const flaggedFallbackId = childIds.find((agentId) => agents?.[agentId]?.fallbackExecution === true) || "";
        const generalistFallbackId = childIds.find((agentId) => Array.isArray(agents?.[agentId]?.capabilityTags) && agents[agentId].capabilityTags.includes("generalist")) || "";
        return {
            name: String(input.name || input.teamName || fallbackName).trim() || fallbackName,
            templateId: String(input.templateId || "custom").trim() || "custom",
            fallbackAgentId: explicitFallbackId || flaggedFallbackId || generalistFallbackId || "",
            strictDispatchOnly: input.strictDispatchOnly !== false
        };
    }

    function normalizeRunItem(item = {}, collaboration = null) {
        const phase = ITEM_PHASES.has(String(item.phase || "").trim()) ? String(item.phase).trim() : "execution";
        const agentId = normalizeAgentName(item.agentId || MAIN_AGENT_ID);
        const status = STATUS_ORDER.has(String(item.status || "").trim()) ? String(item.status).trim() : "pending";
        const agentProfile = collaboration?.agents?.[agentId] || null;
        return {
            itemId: String(item.itemId || createId("item")).trim(),
            phase,
            agentId,
            label: String(item.label || agentProfile?.label || agentId).trim() || agentId,
            status,
            taskSummary: String(item.taskSummary || "").trim(),
            workflowId: String(item.workflowId || item.runId || "").trim(),
            updatedAt: String(item.updatedAt || nowIso()),
            startedAt: item.startedAt ? String(item.startedAt) : "",
            completedAt: item.completedAt ? String(item.completedAt) : "",
            commandSessionId: String(item.commandSessionId || "").trim(),
            commandCode: String(item.commandCode || "").trim(),
            message: String(item.message || "").trim(),
            note: String(item.note || "").trim(),
            error: String(item.error || "").trim(),
            structuredPayload: item.structuredPayload && typeof item.structuredPayload === "object" ? clone(item.structuredPayload) : null,
            resultSummary: String(item.resultSummary || "").trim()
        };
    }

    function deriveRunStatus(run = {}) {
        const items = Array.isArray(run.items) ? run.items : [];
        if (!items.length) return "idle";
        if (items.some((item) => item.status === "failed")) return "failed";
        if (items.some((item) => item.status === "running")) return "running";
        const collectingItem = items.find((item) => item.phase === "collecting");
        if (collectingItem) return collectingItem.status === "completed" ? "completed" : "running";
        const executionItems = items.filter((item) => item.phase === "execution");
        const planningItems = items.filter((item) => item.phase === "planning");
        if (executionItems.length && executionItems.every((item) => item.status === "completed") && planningItems.every((item) => item.status === "completed")) return "waiting_collect";
        if (items.some((item) => item.status === "paused") && !items.some((item) => item.status === "pending")) return "paused";
        return "pending";
    }

    function normalizeWorkflowRun(run = {}, collaboration = null) {
        const normalized = {
            runId: String(run.runId || createId("run")).trim(),
            templateId: String(run.templateId || "ad-hoc").trim() || "ad-hoc",
            name: String(run.name || "\u672a\u547d\u540d\u7f16\u6392\u4efb\u52a1").trim() || "\u672a\u547d\u540d\u7f16\u6392\u4efb\u52a1",
            summary: String(run.summary || "").trim(),
            taskType: String(run.taskType || "general").trim() || "general",
            message: String(run.message || "").trim(),
            thinking: String(run.thinking || "medium").trim() || "medium",
            plan: run.plan && typeof run.plan === "object" ? clone(run.plan) : { status: "idle", assignments: [], collectionBrief: "", rawPlan: null, error: "", appliedAt: "" },
            items: [],
            startedAt: String(run.startedAt || nowIso()),
            updatedAt: String(run.updatedAt || nowIso())
        };
        normalized.items = (Array.isArray(run.items) ? run.items : []).map((item) => normalizeRunItem(item, collaboration));
        normalized.status = STATUS_ORDER.has(String(run.status || "").trim()) ? String(run.status).trim() : deriveRunStatus(normalized);
        return normalized;
    }

    function normalizeCollaboration(input = {}, fallbackMainAgentId = MAIN_AGENT_ID) {
        const config = readConfigSafe();
        const configuredIds = listConfiguredAgentIds(config).filter((item) => item !== fallbackMainAgentId);
        const legacyRoles = input.roles && typeof input.roles === "object" ? input.roles : {};
        const currentAgents = input.agents && typeof input.agents === "object" ? input.agents : {};
        const topology = normalizeTopology(input.topology || {}, fallbackMainAgentId, Object.keys(legacyRoles), configuredIds);
        const agents = {};
        const registerAgent = (agentId, profile, fallbackLabel = "") => {
            if (!agentId) return;
            try {
                const normalizedId = normalizeAgentName(agentId);
                agents[normalizedId] = normalizeAgentProfile(normalizedId, { ...(agents[normalizedId] || {}), ...(profile || {}) }, fallbackLabel || normalizedId);
            } catch (_) {}
        };
        Object.entries(currentAgents).forEach(([agentId, profile]) => registerAgent(agentId, profile));
        Object.entries(legacyRoles).forEach(([agentId, profile]) => registerAgent(agentId, profile));
        registerAgent(topology.mainAgentId, currentAgents[topology.mainAgentId] || legacyRoles[topology.mainAgentId] || {}, "\u4e3b Agent");
        topology.childAgentIds.forEach((agentId) => registerAgent(agentId, currentAgents[agentId] || legacyRoles[agentId] || {}, agentId));
        const collaboration = {
            version: 2,
            team: normalizeTeamMeta(input.team || {}, topology, agents),
            topology,
            agents,
            dispatchPolicy: normalizeDispatchPolicy(input.dispatchPolicy || {}),
            workflowRuns: [],
            updatedAt: String(input.updatedAt || nowIso())
        };
        collaboration.workflowRuns = (Array.isArray(input.workflowRuns) ? input.workflowRuns : []).map((run) => normalizeWorkflowRun(run, collaboration));
        return collaboration;
    }

    function readCollaborationSync(agentName = MAIN_AGENT_ID) {
        const config = readConfigSafe();
        const normalizedAgent = normalizeAgentName(agentName || MAIN_AGENT_ID);
        const metadataDir = getAgentMetadataDir(config, normalizedAgent);
        const targetPath = getCollaborationFilePath(config, normalizedAgent);
        ensureDirectory(metadataDir);
        if (!fs.existsSync(targetPath)) return { mainAgentId: normalizedAgent, targetPath, data: normalizeCollaboration({}, normalizedAgent) };
        try {
            return {
                mainAgentId: normalizedAgent,
                targetPath,
                data: normalizeCollaboration(JSON.parse(fs.readFileSync(targetPath, "utf8")), normalizedAgent)
            };
        } catch (_) {
            return { mainAgentId: normalizedAgent, targetPath, data: normalizeCollaboration({}, normalizedAgent) };
        }
    }

    function writeCollaborationSync(agentName = MAIN_AGENT_ID, nextValue = {}) {
        const config = readConfigSafe();
        const normalizedAgent = normalizeAgentName(agentName || MAIN_AGENT_ID);
        const metadataDir = getAgentMetadataDir(config, normalizedAgent);
        const targetPath = getCollaborationFilePath(config, normalizedAgent);
        ensureDirectory(metadataDir);
        const normalized = normalizeCollaboration(nextValue, normalizedAgent);
        fs.writeFileSync(targetPath, JSON.stringify(normalized, null, 2), "utf8");
        return { mainAgentId: normalizedAgent, targetPath, data: normalized };
    }

    function getRunById(collaboration, runId = "") {
        return (collaboration.workflowRuns || []).find((entry) => entry.runId === String(runId || "").trim()) || null;
    }

    function getRunItem(run, itemId = "") {
        return (run?.items || []).find((entry) => entry.itemId === String(itemId || "").trim()) || null;
    }

    function readAvatarAsDataUrl(avatarPath = "") {
        const resolved = String(avatarPath || "").trim();
        if (!resolved || !fs.existsSync(resolved)) return null;
        const ext = path.extname(resolved).toLowerCase();
        const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" }[ext]) || "application/octet-stream";
        return `data:${mime};base64,${fs.readFileSync(resolved).toString("base64")}`;
    }

    function validateAssignments(assignments = [], collaboration = {}) {
        if (!Array.isArray(assignments) || !assignments.length) throw new Error("派单计划里至少要包含一个 assignment。");
        const childIds = new Set(collaboration.topology?.childAgentIds || []);
        const seen = new Set();
        return assignments.map((assignment, index) => {
            const agentId = normalizeAgentName(assignment?.agentId || "");
            if (!agentId) throw new Error(`\u7b2c ${index + 1} \u4e2a assignment \u7f3a\u5c11 agentId\u3002`);
            if (agentId === collaboration.topology?.mainAgentId) throw new Error("\u4e3b Agent \u4e0d\u80fd\u88ab\u5206\u914d\u6267\u884c\u4efb\u52a1\u3002");
            if (!childIds.has(agentId)) throw new Error(`\u7b2c ${index + 1} \u4e2a assignment \u6307\u5411\u4e86\u672a\u77e5\u5b50 Agent\uff1a${agentId}`);
            if (seen.has(agentId)) throw new Error(`\u6d3e\u5355\u8ba1\u5212\u91cc\u91cd\u590d\u4f7f\u7528\u4e86\u5b50 Agent\uff1a${agentId}`);
            seen.add(agentId);
            return {
                agentId,
                objective: String(assignment?.objective || "").trim(),
                deliverable: String(assignment?.deliverable || "").trim(),
                reason: String(assignment?.reason || "").trim(),
                context: String(assignment?.context || "").trim()
            };
        });
    }

    return {
        MAIN_AGENT_ID,
        clone,
        nowIso,
        createId,
        readConfigSafe,
        getAgentMetadataDir,
        normalizeAgentProfile,
        normalizeRunItem,
        normalizeWorkflowRun,
        normalizeCollaboration,
        writeCollaborationSync,
        readCollaborationSync,
        deriveRunStatus,
        getRunById,
        getRunItem,
        readAvatarAsDataUrl,
        validateAssignments,
        buildGeneratedAvatar
    };
}

module.exports = {
    createMultiAgentStore
};
