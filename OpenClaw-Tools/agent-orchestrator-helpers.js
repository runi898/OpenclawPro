(function () {
    const esc = (value) => typeof window.escapeHtml === "function"
        ? window.escapeHtml(value)
        : String(value ?? "").replace(/[&<>"]/g, (matched) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[matched]));
    const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
    const ensureArray = (value) => Array.isArray(value) ? value : [];
    const ensureString = (value) => String(value ?? "").trim();
    const normalizeTagList = (value) => {
        const raw = Array.isArray(value)
            ? value
            : String(value ?? "").split(/[,\uFF0C]/g);
        return Array.from(new Set(raw.map((entry) => ensureString(entry)).filter(Boolean)));
    };

    const STATUS_META = {
        idle: { label: "空闲", tone: "muted" },
        pending: { label: "待执行", tone: "pending" },
        running: { label: "执行中", tone: "running" },
    waiting_collect: { label: "待回收", tone: "pending" },
        completed: { label: "已完成", tone: "success" },
        failed: { label: "失败", tone: "danger" },
        paused: { label: "已暂停", tone: "muted" }
    };

    function getStatusMeta(status) {
        return STATUS_META[ensureString(status)] || STATUS_META.idle;
    }

    function inferTargetKind(targetId = "") {
        const safeId = ensureString(targetId);
        if (!safeId) return "group";
        if (/^oc_/i.test(safeId)) return "group";
        if (/^ou_/i.test(safeId)) return "user";
        if (/^dm_/i.test(safeId)) return "dm";
        return "group";
    }

    function createBindingRow(partial = {}) {
        return {
            rowId: partial.rowId || `binding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            channel: ensureString(partial.channel),
            targetId: ensureString(partial.targetId),
            targetKind: ensureString(partial.targetKind || inferTargetKind(partial.targetId)),
            match: partial.match && typeof partial.match === "object" ? clone(partial.match) : null,
            manual: partial.manual === true || !partial.match,
            summary: ensureString(partial.summary)
        };
    }

    function buildDraft(data = {}) {
        const team = data?.team || {};
        const agents = ensureArray(data?.agents).map((agent) => ({
            id: ensureString(agent.id),
            name: ensureString(agent.name || agent.id),
            model: ensureString(agent.model),
            workspace: ensureString(agent.workspace),
            agentDir: ensureString(agent.agentDir),
            roleTitle: ensureString(agent.roleTitle || (agent.isMain ? "主 Agent" : "子 Agent")),
            responsibilities: ensureString(agent.responsibilities),
            capabilityTags: normalizeTagList(agent.capabilityTags || agent.capabilities || []),
            fallbackExecution: agent.fallbackExecution === true,
            identityContent: String(agent.identityContent || ""),
            soulContent: String(agent.soulContent || ""),
            userContent: String(agent.userContent || ""),
            agentsContent: String(agent.agentsContent || ""),
            toolsContent: String(agent.toolsContent || ""),
            isMain: agent.isMain === true,
            isChild: agent.isChild === true,
            avatar: agent.avatar && typeof agent.avatar === "object" ? clone(agent.avatar) : null,
            bindings: ensureArray(agent.bindings).map((binding) => createBindingRow(binding))
        }));
        return {
            mainAgentId: ensureString(team.mainAgentId || data?.mainAgentId || "main") || "main",
            team: {
                name: ensureString(team.name || "默认团队") || "默认团队",
                dispatchMode: ensureString(team.dispatchMode || "auto") === "manual" ? "manual" : "auto",
                childAgentIds: ensureArray(team.childAgentIds).map((entry) => ensureString(entry)).filter(Boolean),
                templateId: ensureString(team.templateId || "custom") || "custom",
                fallbackAgentId: ensureString(team.fallbackAgentId || ""),
                strictDispatchOnly: team.strictDispatchOnly !== false,
                entryStatus: team?.entryStatus && typeof team.entryStatus === "object" ? clone(team.entryStatus) : null
            },
            agents,
            dirty: false
        };
    }

    function getTeamAgentIds(draft = {}) {
        const childAgentIds = ensureArray(draft?.team?.childAgentIds).map((entry) => ensureString(entry)).filter(Boolean);
        return Array.from(new Set([ensureString(draft?.mainAgentId || "main") || "main"].concat(childAgentIds)));
    }

    function getAgentDraft(draft = {}, agentId = "") {
        const safeId = ensureString(agentId);
        return ensureArray(draft?.agents).find((agent) => agent.id === safeId) || null;
    }

    function getModelOptions(modelCatalog = {}) {
        return ensureArray(modelCatalog?.options)
            .map((option) => ({
                value: ensureString(option.value),
                label: ensureString(option.label || option.value)
            }))
            .filter((option) => option.value);
    }

    function getChannelMap(channels = []) {
        return new Map(ensureArray(channels).map((channel) => [ensureString(channel.key), clone(channel)]));
    }

    function getBindingStatusText(agent = {}) {
        const count = ensureArray(agent?.bindings).filter((binding) => ensureString(binding.channel) && ensureString(binding.targetId)).length;
        if (!count) return "未绑定";
        if (count === 1) return "已绑定 1 项";
        return `已绑定 ${count} 项`;
    }

    function getEntryStatusText(team = {}) {
        return ensureString(team?.entryStatus?.label || "未绑定外部聊天入口") || "未绑定外部聊天入口";
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

    function buildPlanningCommand(mainAgentId, run, draft) {
        const childAgents = ensureArray(draft?.agents).filter((agent) => ensureArray(draft?.team?.childAgentIds).includes(agent.id));
        const fallbackAgent = childAgents.find((agent) => agent.fallbackExecution) || childAgents.find((agent) => ensureArray(agent.capabilityTags).includes("generalist"));
        const roster = childAgents.map((agent) => {
            const desc = ensureString(agent.responsibilities || agent.roleTitle || "执行任务");
            const capabilities = ensureArray(agent.capabilityTags).join(", ") || "general";
            const fallbackLabel = agent.fallbackExecution ? " [fallback]" : "";
            return `${agent.id}: ${agent.name}${fallbackLabel} - ${desc}; capabilities=${capabilities}`;
        }).join(" | ");
        const prompt = [
            "你是主 Agent。",
            "你不能亲自执行任务。",
            "你只能从现有子 Agent 名单里分配任务。",
            "先判断任务需要的能力标签，再把任务派给最匹配的子 Agent。",
            fallbackAgent
                ? `如果没有明显匹配的子 Agent，优先把任务交给兜底执行 Agent：${fallbackAgent.id}。`
                : "如果没有合适的子 Agent，请在 JSON 的 reason 字段说明缺少执行角色或需要补充信息，但不要自己执行。",
            "请只返回 JSON，不要附加解释。",
            "JSON 结构固定为：{\"assignments\":[{\"agentId\":\"child-id\",\"objective\":\"...\",\"deliverable\":\"...\",\"reason\":\"...\",\"context\":\"...\"}],\"collectionBrief\":\"...\"}",
            `团队成员：${roster || "当前没有可用的子 Agent。"}`,
            `用户任务：${ensureString(run?.message || run?.summary || run?.name)}`
        ].join(" ");
        return `openclaw agent --agent ${JSON.stringify(ensureString(mainAgentId || "main"))} --thinking ${JSON.stringify(ensureString(run?.thinking || "medium") || "medium")} --message ${JSON.stringify(prompt)}`;
    }

    function buildExecutionCommand(run, item) {
        const payload = item?.structuredPayload || {};
        const prompt = [
            `你现在角色扮演${ensureString(item?.label || item?.agentId)}。`,
            `本次目标：${ensureString(payload.objective || item?.taskSummary || run?.summary || run?.name)}`,
            payload.deliverable ? `预期交付：${ensureString(payload.deliverable)}` : "",
            payload.reason ? `分配原因：${ensureString(payload.reason)}` : "",
            payload.context ? `补充上下文：${ensureString(payload.context)}` : "",
            `原始任务：${ensureString(run?.message || run?.summary || run?.name)}`,
            "请直接完成执行工作，并输出可供主 Agent 汇总的结果。"
        ].filter(Boolean).join(" ");
        return `openclaw agent --agent ${JSON.stringify(ensureString(item?.agentId))} --thinking ${JSON.stringify(ensureString(run?.thinking || "medium") || "medium")} --message ${JSON.stringify(prompt)}`;
    }

    function buildCollectionCommand(mainAgentId, run) {
        const results = ensureArray(run?.items)
            .filter((item) => ensureString(item?.phase) === "execution")
            .map((item) => `${ensureString(item?.label || item?.agentId)}: ${ensureString(item?.resultSummary || item?.note || "暂无结果")}`)
            .join(" | ");
        const prompt = [
            "你是主 Agent。",
            "不要重新执行子任务。",
            "请只汇总各个子 Agent 的执行结果并输出最终答复。",
            run?.plan?.collectionBrief ? `汇总要求：${ensureString(run.plan.collectionBrief)}` : "",
            `子任务结果：${results || "还没有采集到结果。"}`,
            `原始任务：${ensureString(run?.message || run?.summary || run?.name)}`
        ].filter(Boolean).join(" ");
        return `openclaw agent --agent ${JSON.stringify(ensureString(mainAgentId || "main"))} --thinking ${JSON.stringify(ensureString(run?.thinking || "medium") || "medium")} --message ${JSON.stringify(prompt)}`;
    }

    function summarizeLogText(text = "", limit = 420) {
        const lines = String(text || "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !/^\[命令结束]/.test(line));
        const summary = lines.slice(-8).join("\n");
        return summary.length > limit ? `${summary.slice(0, limit)}...` : summary;
    }

    window.OpenClawAgentHubHelpers = {
        esc,
        clone,
        ensureArray,
        ensureString,
        normalizeTagList,
        getStatusMeta,
        inferTargetKind,
        createBindingRow,
        buildDraft,
        getTeamAgentIds,
        getAgentDraft,
        getModelOptions,
        getChannelMap,
        getBindingStatusText,
        getEntryStatusText,
        parsePlanText,
        buildPlanningCommand,
        buildExecutionCommand,
        buildCollectionCommand,
        summarizeLogText
    };
})();
