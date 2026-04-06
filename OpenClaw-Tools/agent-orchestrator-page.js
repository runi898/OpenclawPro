(function () {
    const H = window.OpenClawAgentHubHelpers;
    const TEAM_LIVE_SYNC_INTERVAL_MS = 2500;

    function renderAgentHubPage(container, options = {}) {
        if (!container) return Promise.resolve();

        if (typeof container.__openclawCleanupAgentHub === "function") {
            try { container.__openclawCleanupAgentHub(); } catch (_) {}
        }

        const state = {
            mode: "single",
            host: null,
            switchButtons: [],
            team: {
                mainAgentId: "main",
                data: null,
                draft: null,
                selectedAgentId: "main",
                statusScreenClose: null,
                avatarPresets: null,
                teams: [],
                notice: { text: "", tone: "" },
                disposeFns: [],
                liveDisposeFns: [],
                liveSyncInFlight: null,
                liveSyncQueued: false,
                needsReload: true
            }
        };

        const currentAgent = () => H.getAgentDraft(state.team.draft, state.team.selectedAgentId);
        const teamAgentIds = () => H.getTeamAgentIds(state.team.draft);
        const teamAgents = () => H.ensureArray(state.team.draft?.agents).filter((agent) => teamAgentIds().includes(agent.id));
        const childAgents = () => teamAgents().filter((agent) => agent.id !== state.team.draft?.mainAgentId);
        const modelOptions = () => H.getModelOptions(state.team.data?.modelCatalog || {});
        const teamOptions = () => H.ensureArray(state.team.teams);
        const channelMap = () => H.getChannelMap(state.team.data?.channels || []);
        const getChannelSessions = (channelKey) => channelMap().get(channelKey)?.sessions || [];
        const fallbackAgentId = () => childAgents().find((agent) => agent.fallbackExecution)?.id || "";

        function scoreChannelSession(session = {}) {
            const targetId = H.ensureString(session?.targetId).toLowerCase();
            const targetKind = H.ensureString(session?.targetKind).toLowerCase();
            let score = 0;
            if (targetKind && targetKind !== "account") score += 200;
            if (["user", "group", "dm", "thread"].includes(targetKind)) score += 60;
            if (/^\d+$/.test(targetId)) score += 90;
            if (targetId && targetId !== "default") score += 24;
            if (/^(ou_|oc_|dm_|chat_|room_|group_|thread_)/i.test(targetId)) score += 30;
            if (targetKind === "account" && targetId === "default") score -= 120;
            return score;
        }

        function pickPreferredChannelSession(channelKey = "", currentTargetId = "", currentTargetKind = "") {
            const sessions = H.ensureArray(getChannelSessions(channelKey));
            if (!sessions.length) return null;
            const safeCurrentId = H.ensureString(currentTargetId);
            const safeCurrentKind = H.ensureString(currentTargetKind);
            const current = sessions.find((session) => {
                if (H.ensureString(session?.targetId) !== safeCurrentId) return false;
                if (!safeCurrentKind) return true;
                return H.ensureString(session?.targetKind) === safeCurrentKind;
            });
            if (current) return current;
            return sessions
                .slice()
                .sort((left, right) => {
                    const scoreGap = scoreChannelSession(right) - scoreChannelSession(left);
                    if (scoreGap !== 0) return scoreGap;
                    return H.ensureString(left?.label).localeCompare(H.ensureString(right?.label), "zh-CN");
                })[0] || null;
        }

        function syncBindingAutoSelection(binding = {}) {
            if (!binding || !H.ensureString(binding.channel)) return;
            if (binding.manual === true && H.ensureString(binding.targetId)) return;
            const nextSession = pickPreferredChannelSession(binding.channel, binding.targetId, binding.targetKind);
            if (!nextSession) {
                if (!H.ensureString(binding.targetId)) binding.manual = true;
                return;
            }
            binding.targetId = H.ensureString(nextSession.targetId);
            binding.targetKind = H.ensureString(nextSession.targetKind) || H.inferTargetKind(nextSession.targetId);
            binding.match = nextSession.match ? H.clone(nextSession.match) : null;
            binding.manual = false;
        }

        function syncAllBindingAutoSelections() {
            H.ensureArray(state.team.draft?.agents).forEach((agent) => {
                H.ensureArray(agent?.bindings).forEach((binding) => {
                    syncBindingAutoSelection(binding);
                });
            });
        }

        function buildMainAgentSoul(teamName, mainAgent, childAgentList) {
            const routingRules = childAgentList.length
                ? childAgentList
                    .map((agent) => {
                        const tags = H.ensureArray(agent.capabilityTags).join("、") || "未设置";
                        const workspaceText = H.ensureString(agent.workspace) ? `；workspace=${H.ensureString(agent.workspace)}` : "";
                        const fallbackText = agent.fallbackExecution ? "；无明确匹配时由你兜底" : "";
                        return `- ${agent.name}（${agent.id}）：${tags}${fallbackText}${workspaceText}`;
                    })
                    .join("\n")
                : "- 当前没有可分配的子 Agent";
            const fallbackId = childAgentList.find((agent) => agent.fallbackExecution)?.id || "";
            return [
                `# ${mainAgent.name || mainAgent.id} SOUL`,
                "",
                "## 身份定位",
                `你是团队「${teamName || "默认团队"}」的主 Agent。你只负责接单、拆解、派单、监控、催办、回收结果，绝不亲自执行任务。`,
                "",
                "## 工作流程",
                "1. 收到用户消息后，先判断目标、产出物和所需能力标签。",
                "2. 立刻把任务拆成一个或多个子任务，优先通过 `sessions_spawn` 派给最匹配的子 Agent。",
                "3. 使用 `sessions_spawn` 时，要显式带上子 Agent 的 `agentId` 和对应 `workspace`，避免子会话跑错工作区。",
                "4. 如果某个子 Agent 已经有现成会话，需要补充上下文、催办或追问时，再使用 `sessions_send` 继续对话。",
                "5. 派单后优先使用 `sessions_yield` 等待子 Agent 结果回流，不要靠循环轮询代替协作。",
                "6. 所有子任务完成后，再统一汇总成最终答复返回给用户。",
                "",
                "## 路由规则",
                "1. 先判断任务需要的能力标签，再选择最匹配的子 Agent。",
                "2. 可以把一个复杂任务拆成多个子任务，分配给不同子 Agent。",
                fallbackId
                    ? `3. 如果没有明确匹配的执行者，优先把任务交给兜底执行 Agent：${fallbackId}。`
                    : "3. 如果没有合适的子 Agent，只能向用户补充提问或提示团队缺少能力，不能自己执行。",
                "4. 只有问候、澄清、团队状态、配置说明这类协调型问题，才允许你自己直接回复用户。",
                "5. 子 Agent 卡住时，你负责补充上下文、唤醒继续、改派或回收中间结果。",
                "6. 最终只负责汇总子 Agent 结果并返回给用户。",
                "",
                "## 子 Agent 能力表",
                routingRules
            ].join("\n");
        }

        function buildChildAgentSoul(teamName, mainAgent, agent) {
            const capabilityText = H.ensureArray(agent.capabilityTags).join("、") || "未设置";
            return [
                `# ${agent.name || agent.id} SOUL`,
                "",
                "## 身份定位",
                `你是团队「${teamName || "默认团队"}」中的子 Agent，直属主 Agent 是「${mainAgent.name || mainAgent.id}」。你负责执行具体任务，不负责整个团队的调度。`,
                "",
                "## 当前能力",
                `- 能力标签：${capabilityText}`,
                agent.fallbackExecution
                    ? "- 兜底执行：是。没有明确匹配者时，由你优先承接任务。"
                    : "- 兜底执行：否。只处理与自己能力标签匹配的任务。",
                agent.responsibilities ? `- 默认职责：${agent.responsibilities}` : "- 默认职责：暂未填写",
                H.ensureString(agent.workspace) ? `- 默认 workspace：${H.ensureString(agent.workspace)}` : "- 默认 workspace：未设置",
                "",
                "## 行为规则",
                "1. 收到任务后直接执行，并返回可汇总的结构化结果。",
                agent.fallbackExecution
                    ? "2. 对于模糊任务或无明确归属任务，先做通用执行、初步整理或兜底处理。"
                    : "2. 如果任务明显超出能力范围，明确告诉主 Agent 需要改派，不要硬做。",
                "3. 回复时优先给出结果、结论、材料或可继续执行的下一步，而不是空泛描述。",
                "4. 不主动承担主 Agent 的调度职责，也不要自己再拆分成新的团队工作流。",
                "5. 如果缺少上下文或素材，直接向主 Agent 说明缺口。"
            ].join("\n");
        }

        const TEAM_TEMPLATE_PRESETS = [
            {
                id: "custom",
                label: "自定义团队",
                description: "从一个主 Agent 和一个兜底子 Agent 开始，自行修改每个角色。",
                build(defaultModel = "") {
                    const main = {
                        id: "",
                        name: "任务总管",
                        model: defaultModel,
                        workspace: "",
                        responsibilities: "只负责分配、监控、回收，不直接执行任务。",
                        capabilityTags: ["dispatch", "monitoring"],
                        fallbackExecution: false
                    };
                    const children = [
                        {
                            id: "",
                            name: "通用执行 Agent",
                            model: defaultModel,
                            workspace: "",
                            responsibilities: "负责兜底执行未明确归属的任务，并把结果回传给主 Agent。",
                            capabilityTags: ["generalist", "research"],
                            fallbackExecution: true
                        }
                    ];
                    return {
                        templateId: "custom",
                        teamName: "",
                        dispatchMode: "auto",
                        main,
                        children
                    };
                }
            },
            {
                id: "content",
                label: "内容团队",
                description: "适合文章策划、写作、润色、校对等内容生产协作。",
                build(defaultModel = "") {
                    const main = {
                        id: "content_lead",
                        name: "内容总控",
                        model: defaultModel,
                        workspace: "",
                        responsibilities: "只负责拆解内容需求、分配给对应子 Agent、监控进度并回收结果。",
                        capabilityTags: ["dispatch", "content-orchestration"],
                        fallbackExecution: false
                    };
                    const children = [
                        {
                            id: "topic_planner",
                            name: "选题策划",
                            model: defaultModel,
                            workspace: "",
                            responsibilities: "负责选题、结构提纲、资料方向和创意切入点。",
                            capabilityTags: ["research", "ideation", "planning"],
                            fallbackExecution: false
                        },
                        {
                            id: "content_writer",
                            name: "内容写手",
                            model: defaultModel,
                            workspace: "",
                            responsibilities: "负责根据选题和提纲完成正文写作。",
                            capabilityTags: ["writing", "copywriting", "longform"],
                            fallbackExecution: false
                        },
                        {
                            id: "content_editor",
                            name: "润色校对",
                            model: defaultModel,
                            workspace: "",
                            responsibilities: "负责改写、润色、纠错、统一风格和交付格式。",
                            capabilityTags: ["editing", "review", "formatting"],
                            fallbackExecution: false
                        },
                        {
                            id: "content_generalist",
                            name: "通用兜底",
                            model: defaultModel,
                            workspace: "",
                            responsibilities: "负责兜底处理模糊任务、补资料、做通用整理。",
                            capabilityTags: ["generalist", "research", "writing"],
                            fallbackExecution: true
                        }
                    ];
                    return {
                        templateId: "content",
                        teamName: "内容协作团队",
                        dispatchMode: "auto",
                        main,
                        children
                    };
                }
            },
            {
                id: "ecommerce",
                label: "电商团队",
                description: "适合同款检索、数据分析、图片视频处理、上下架和运营优化。",
                build(defaultModel = "") {
                    const main = {
                        id: "commerce_lead",
                        name: "电商调度官",
                        model: defaultModel,
                        workspace: "",
                        responsibilities: "只负责拆解电商任务、派给不同角色执行、监控进度并汇总结果。",
                        capabilityTags: ["dispatch", "commerce-orchestration"],
                        fallbackExecution: false
                    };
                    const children = [
                        {
                            id: "same_style_search",
                            name: "同款检索",
                            model: defaultModel,
                            workspace: "",
                            responsibilities: "负责查找同款、对比链接、整理价格和卖点。",
                            capabilityTags: ["search", "comparison", "data-collection"],
                            fallbackExecution: false
                        },
                        {
                            id: "commerce_analyst",
                            name: "数据分析",
                            model: defaultModel,
                            workspace: "",
                            responsibilities: "负责整理表格、分析转化、异常波动和趋势数据。",
                            capabilityTags: ["analysis", "report", "monitoring"],
                            fallbackExecution: false
                        },
                        {
                            id: "image_operator",
                            name: "图片处理",
                            model: defaultModel,
                            workspace: "",
                            responsibilities: "负责商品主图、详情图、裁切、压缩和简单修图。",
                            capabilityTags: ["image", "retouch", "resize"],
                            fallbackExecution: false
                        },
                        {
                            id: "video_operator",
                            name: "视频处理",
                            model: defaultModel,
                            workspace: "",
                            responsibilities: "负责商品短视频、字幕、封面和基础剪辑。",
                            capabilityTags: ["video", "subtitle", "editing"],
                            fallbackExecution: false
                        },
                        {
                            id: "listing_operator",
                            name: "商品上下架",
                            model: defaultModel,
                            workspace: "",
                            responsibilities: "负责商品信息整理、上下架、库存和基础运营动作。",
                            capabilityTags: ["listing", "inventory", "ops"],
                            fallbackExecution: false
                        },
                        {
                            id: "commerce_generalist",
                            name: "运营兜底",
                            model: defaultModel,
                            workspace: "",
                            responsibilities: "负责接住没有明确归属的电商任务，并给主 Agent 返回可继续分配的结果。",
                            capabilityTags: ["generalist", "operations", "research"],
                            fallbackExecution: true
                        }
                    ];
                    return {
                        templateId: "ecommerce",
                        teamName: "电商协作团队",
                        dispatchMode: "auto",
                        main,
                        children
                    };
                }
            }
        ];
        function setNotice(text = "", tone = "") {
            state.team.notice = {
                text: H.ensureString(text),
                tone: H.ensureString(tone)
            };
            renderTeamView();
        }

        function clearNotice() {
            state.team.notice = { text: "", tone: "" };
        }

        function markDirty() {
            if (state.team.draft) state.team.draft.dirty = true;
        }

        function getTeamSelectorOptions() {
            const options = teamOptions().slice();
            const draftMainAgentId = H.ensureString(state.team.draft?.mainAgentId || state.team.mainAgentId || "");
            if (!draftMainAgentId) return options;
            const exists = options.some((team) => H.ensureString(team.mainAgentId || team.id) === draftMainAgentId);
            if (exists) return options;
            return options.concat([{
                id: draftMainAgentId,
                mainAgentId: draftMainAgentId,
                name: `${H.ensureString(state.team.draft?.team?.name || draftMainAgentId) || draftMainAgentId}（未保存）`
            }]);
        }

        function syncSelection() {
            const ids = teamAgents().map((agent) => agent.id);
            if (ids.includes(state.team.selectedAgentId)) return;
            state.team.selectedAgentId = childAgents()[0]?.id || state.team.draft?.mainAgentId || "main";
        }

        function clearLiveSyncDisposers() {
            state.team.liveDisposeFns.forEach((dispose) => {
                try { dispose(); } catch (_) {}
            });
            state.team.liveDisposeFns = [];
            state.team.liveSyncInFlight = null;
            state.team.liveSyncQueued = false;
        }

        function isSameJson(left, right) {
            return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
        }

        function shouldSoftRefreshTeamView() {
            if (state.mode !== "team" || !state.host || !state.team.draft) return false;
            if (typeof state.team.statusScreenClose === "function") return true;
            const activeElement = document.activeElement;
            return Boolean(
                activeElement
                && state.host.contains(activeElement)
                && ["INPUT", "TEXTAREA", "SELECT"].includes(activeElement.tagName)
            );
        }

        function refreshCurrentTeamView(options = {}) {
            if (state.mode !== "team" || !state.host || !state.team.draft) return;
            if (options.soft === true || shouldSoftRefreshTeamView()) {
                refreshTeamLiveStatusViews();
                return;
            }
            const shouldRestoreStatusScreen = typeof state.team.statusScreenClose === "function";
            renderTeamView();
            if (shouldRestoreStatusScreen) {
                openAgentStatusScreen();
            }
        }

        function mergeTeamLiveSnapshot(snapshot = {}) {
            if (!snapshot?.ok) return false;
            if (!state.team.data) state.team.data = {};

            let changed = false;
            const nextWorkflows = H.ensureArray(snapshot.workflows);
            if (!isSameJson(state.team.data.workflows, nextWorkflows)) {
                state.team.data.workflows = H.clone(nextWorkflows);
                changed = true;
            }

            const nextSessionActivity = snapshot.sessionActivity && typeof snapshot.sessionActivity === "object"
                ? snapshot.sessionActivity
                : {};
            if (!isSameJson(state.team.data.sessionActivity, nextSessionActivity)) {
                state.team.data.sessionActivity = H.clone(nextSessionActivity);
                changed = true;
            }

            const nextEntryStatus = snapshot.team?.entryStatus && typeof snapshot.team.entryStatus === "object"
                ? snapshot.team.entryStatus
                : null;
            const currentEntryStatus = state.team.data.team?.entryStatus ?? null;
            if (!isSameJson(currentEntryStatus, nextEntryStatus)) {
                if (!state.team.data.team || typeof state.team.data.team !== "object") {
                    state.team.data.team = {};
                }
                state.team.data.team.entryStatus = nextEntryStatus ? H.clone(nextEntryStatus) : null;
                if (state.team.draft?.team && typeof state.team.draft.team === "object") {
                    state.team.draft.team.entryStatus = nextEntryStatus ? H.clone(nextEntryStatus) : null;
                }
                changed = true;
            }

            const nextTeams = H.ensureArray(snapshot.teams);
            if (!isSameJson(state.team.teams, nextTeams)) {
                state.team.teams = H.clone(nextTeams);
                changed = true;
            }

            return changed;
        }

        async function syncTeamLiveSnapshot(options = {}) {
            if (state.mode !== "team" || !state.team.draft) return false;
            if (state.team.liveSyncInFlight) {
                state.team.liveSyncQueued = true;
                return false;
            }

            const mainAgentId = H.ensureString(state.team.mainAgentId || state.team.draft?.mainAgentId || "main") || "main";
            const request = window.api.getAgentTeamBuilderData({ mainAgentId });
            state.team.liveSyncInFlight = request;

            try {
                const result = await request;
                if (!result?.ok) return false;
                if (H.ensureString(result.mainAgentId || "") !== mainAgentId) return false;
                const changed = mergeTeamLiveSnapshot(result);
                if (changed && options.refresh !== false) {
                    refreshCurrentTeamView({ soft: options.soft === true });
                }
                return changed;
            } catch (_) {
                return false;
            } finally {
                state.team.liveSyncInFlight = null;
                if (state.team.liveSyncQueued) {
                    state.team.liveSyncQueued = false;
                    setTimeout(() => {
                        syncTeamLiveSnapshot(options).catch(() => {});
                    }, 0);
                }
            }
        }

        function startTeamLiveSync() {
            clearLiveSyncDisposers();
            if (state.mode !== "team" || !state.team.draft) return;

            const intervalId = window.setInterval(() => {
                syncTeamLiveSnapshot({ refresh: true, soft: true }).catch(() => {});
            }, TEAM_LIVE_SYNC_INTERVAL_MS);
            state.team.liveDisposeFns.push(() => window.clearInterval(intervalId));

            const handleWindowFocus = () => {
                syncTeamLiveSnapshot({ refresh: true, soft: true }).catch(() => {});
            };
            const handleVisibilityChange = () => {
                if (document.visibilityState !== "visible") return;
                syncTeamLiveSnapshot({ refresh: true, soft: true }).catch(() => {});
            };

            window.addEventListener("focus", handleWindowFocus);
            document.addEventListener("visibilitychange", handleVisibilityChange);
            state.team.liveDisposeFns.push(() => window.removeEventListener("focus", handleWindowFocus));
            state.team.liveDisposeFns.push(() => document.removeEventListener("visibilitychange", handleVisibilityChange));

            syncTeamLiveSnapshot({ refresh: true, soft: true }).catch(() => {});
        }

        async function loadTeamData(options = {}) {
            const result = await window.api.getAgentTeamBuilderData({ mainAgentId: state.team.mainAgentId });
            if (!result?.ok) {
                throw new Error(result?.error || "加载团队配置失败");
            }
            state.team.data = result;
            state.team.mainAgentId = result.mainAgentId || "main";
            state.team.teams = H.ensureArray(result.teams);
            state.team.draft = H.buildDraft(result);
            state.team.needsReload = false;
            syncAllBindingAutoSelections();
            syncSelection();
            if (options.noticeText) {
                setNotice(options.noticeText, options.noticeTone || "success");
                return;
            }
            renderTeamView();
        }

        function upsertWorkflowRun(nextRun) {
            if (!nextRun || typeof nextRun !== "object") return;
            if (!state.team.data) state.team.data = {};
            const workflows = H.ensureArray(state.team.data.workflows).slice();
            const nextRunId = H.ensureString(nextRun.runId);
            const existingIndex = workflows.findIndex((entry) => H.ensureString(entry?.runId) === nextRunId);
            if (existingIndex >= 0) {
                workflows.splice(existingIndex, 1, H.clone(nextRun));
            } else {
                workflows.unshift(H.clone(nextRun));
            }
            workflows.sort((left, right) => {
                const leftTime = new Date(H.ensureString(left?.updatedAt || left?.startedAt || 0)).getTime() || 0;
                const rightTime = new Date(H.ensureString(right?.updatedAt || right?.startedAt || 0)).getTime() || 0;
                return rightTime - leftTime;
            });
            state.team.data.workflows = workflows;
        }

        function handleWorkflowEvent(event = {}) {
            const eventAgentId = H.ensureString(event?.agentId || "");
            const currentMainAgentId = H.ensureString(state.team.mainAgentId || state.team.draft?.mainAgentId || "");
            if (!eventAgentId || !currentMainAgentId || eventAgentId !== currentMainAgentId) return;
            if (event.run) {
                upsertWorkflowRun(event.run);
            }
            if (state.mode !== "team" || !state.host || !state.team.draft) return;
            refreshCurrentTeamView({ soft: shouldSoftRefreshTeamView() });
            syncTeamLiveSnapshot({ refresh: true, soft: true }).catch(() => {});
        }

        function renderNotice() {
            if (!state.team.notice?.text) return "";
            return `<div class="mab-notice is-${H.esc(state.team.notice.tone || "info")}">${H.esc(state.team.notice.text)}</div>`;
        }

        function renderSummaryCard(title, value, tone = "") {
            return `
                <div class="mab-summary-card ${tone ? `is-${H.esc(tone)}` : ""}">
                    <span>${H.esc(title)}</span>
                    <strong>${H.esc(value || "-")}</strong>
                </div>
            `;
        }

        function toFileUrl(filePath = "") {
            const raw = H.ensureString(filePath);
            if (!raw) return "";
            if (/^(data:|file:|https?:)/i.test(raw)) return raw;
            if (/^[a-zA-Z]:[\\/]/.test(raw)) return encodeURI(`file:///${raw.replace(/\\/g, "/")}`);
            if (raw.startsWith("/")) return encodeURI(`file://${raw}`);
            return encodeURI(raw);
        }

        function getAgentAvatarInfo(agent = {}) {
            const avatar = agent?.avatar || {};
            return {
                avatar,
                avatarSrc: avatar.mode === "custom" ? toFileUrl(avatar.path || avatar.dataUrl || "") : "",
                fallbackTheme: H.ensureString(avatar.theme || "blue") || "blue",
                fallbackInitial: H.esc((H.ensureString(avatar.fallbackInitial || agent.name || agent.id).slice(0, 1) || "A").toUpperCase())
            };
        }

        function renderAgentAvatarMarkup(agent = {}, options = {}) {
            const { avatarSrc, fallbackTheme, fallbackInitial } = getAgentAvatarInfo(agent);
            const shellClass = H.ensureString(options.shellClass || "mab-agent-avatar-shell");
            const imageClass = H.ensureString(options.imageClass || "mab-agent-avatar-img");
            const fallbackClass = H.ensureString(options.fallbackClass || "mab-agent-avatar-fallback");
            const alt = H.esc(agent?.name || agent?.id || "Agent Avatar");
            return `
                <span class="${H.esc(shellClass)}">
                    ${avatarSrc
                        ? `<img class="${H.esc(imageClass)}" src="${H.esc(avatarSrc)}" alt="${alt}">`
                        : `<span class="${H.esc(fallbackClass)} is-${H.esc(fallbackTheme)}">${fallbackInitial}</span>`}
                </span>
            `;
        }

        function applyAvatarToState(agentId, avatar) {
            const safeId = H.ensureString(agentId);
            if (!safeId || !avatar || typeof avatar !== "object") return;
            const nextAvatar = H.clone(avatar);
            H.ensureArray(state.team.draft?.agents).forEach((entry) => {
                if (entry.id === safeId) entry.avatar = H.clone(nextAvatar);
            });
            H.ensureArray(state.team.data?.agents).forEach((entry) => {
                if (entry.id === safeId) entry.avatar = H.clone(nextAvatar);
            });
        }

        async function ensureAvatarPresets() {
            if (Array.isArray(state.team.avatarPresets)) return state.team.avatarPresets;
            const result = await window.api.listAgentAvatarPresets();
            if (!result?.ok) {
                throw new Error(result?.error || "加载头像库失败");
            }
            state.team.avatarPresets = H.ensureArray(result.presets);
            return state.team.avatarPresets;
        }

        function formatStatusDateTime(value) {
            const safeValue = H.ensureString(value);
            if (!safeValue) return "暂无记录";
            const date = new Date(safeValue);
            if (Number.isNaN(date.getTime())) return "暂无记录";
            return new Intl.DateTimeFormat("zh-CN", {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false
            }).format(date).replace(/\//g, "-");
        }

        function getEntityTimestamp(entity = {}) {
            return H.ensureString(
                entity.completedAt
                || entity.updatedAt
                || entity.startedAt
                || ""
            );
        }

        function pickStatusTimestamp(...values) {
            for (const value of values) {
                const safeValue = H.ensureString(value);
                if (!safeValue) continue;
                const date = new Date(safeValue);
                if (!Number.isNaN(date.getTime())) return safeValue;
            }
            return "";
        }

        function formatStatusBlockTime(...values) {
            const picked = pickStatusTimestamp(...values);
            return picked ? formatStatusDateTime(picked) : "暂无记录";
        }

        function toCardPreviewText(value = "", fallback = "") {
            const normalized = H.ensureString(String(value || "")
                .replace(/```(?:[\w-]+)?/g, " ")
                .replace(/\r?\n+/g, " ")
                .replace(/\s+/g, " "));
            return normalized || fallback;
        }

        function extractCommandMessageText(commandText = "") {
            const safeCommand = H.ensureString(commandText);
            const marker = " --message ";
            const markerIndex = safeCommand.indexOf(marker);
            if (markerIndex < 0) return "";
            const encodedMessage = safeCommand.slice(markerIndex + marker.length).trim();
            if (!encodedMessage) return "";
            try {
                return JSON.parse(encodedMessage);
            } catch (_) {
                return encodedMessage.replace(/^"(.*)"$/, "$1");
            }
        }

        function getLatestExecutionItem(run = {}) {
            return H.ensureArray(run?.items)
                .filter((item) => H.ensureString(item?.phase) === "execution")
                .slice()
                .sort((a, b) => new Date(getEntityTimestamp(b)).getTime() - new Date(getEntityTimestamp(a)).getTime())[0] || null;
        }

        function getDispatchPromptPreview(item = {}, run = {}) {
            const payload = item?.structuredPayload || {};
            return toCardPreviewText(
                extractCommandMessageText(H.buildExecutionCommand(run, item))
                || H.ensureString(
                    payload.objective
                    || item.taskSummary
                    || run.summary
                    || run.name
                    || run.message
                ),
                "暂无派单记录"
            );
        }

        function getItemPrimaryText(item = {}, run = {}) {
            return H.ensureString(
                item.structuredPayload?.objective
                || item.taskSummary
                || item.resultSummary
                || item.note
                || run.summary
                || run.name
                || run.message
            ) || "暂无任务";
        }

        function getItemWorkResultText(item = {}, run = {}) {
            return toCardPreviewText(
                H.ensureString(
                    item.resultSummary
                    || item.note
                    || item.error
                    || item.structuredPayload?.deliverable
                    || item.structuredPayload?.objective
                    || item.taskSummary
                    || run.summary
                    || run.name
                    || run.message
                ),
                "暂无工作记录"
            );
        }

        function getItemCompletionText(item = {}) {
            if (!item) return "暂无完成记录";
            const statusMeta = H.getStatusMeta(item.status);
            const detail = H.ensureString(item.resultSummary || item.error || item.note || item.structuredPayload?.deliverable || "");
            return detail ? `${statusMeta.label} · ${detail}` : statusMeta.label;
        }

        function getRunDispatchSummary(run = {}) {
            const latestExecutionItem = getLatestExecutionItem(run);
            if (latestExecutionItem) {
                return getDispatchPromptPreview(latestExecutionItem, run);
            }
            const assignments = H.ensureArray(run?.plan?.assignments);
            if (assignments.length) {
                return toCardPreviewText(
                    H.ensureString(assignments[0]?.objective || assignments[0]?.deliverable || assignments[0]?.reason || ""),
                    "暂无派单记录"
                );
            }
            return toCardPreviewText(H.ensureString(run.summary || run.name || run.message), "暂无派单记录");
        }

        function getRunWorkResultText(run = {}) {
            if (!run || !run.runId) return "暂无工作记录";
            const collectingItem = H.ensureArray(run.items).find((item) => item.phase === "collecting");
            if (collectingItem) {
                return getItemWorkResultText(collectingItem, run);
            }
            const finishedExecution = H.ensureArray(run.items).find((item) => item.phase === "execution" && ["completed", "failed"].includes(H.ensureString(item.status)));
            if (finishedExecution) {
                return getItemWorkResultText(finishedExecution, run);
            }
            return toCardPreviewText(H.ensureString(run.summary || run.name || run.message), "暂无工作记录");
        }

        function getRunPendingTaskText(run = {}) {
            if (!run || !run.runId) return "当前没有待完成任务";
            const pendingExecution = H.ensureArray(run.items).find((item) => item.phase === "execution" && ["pending", "running", "paused"].includes(H.ensureString(item.status)));
            if (pendingExecution) {
                return getItemPrimaryText(pendingExecution, run);
            }
            const collectingItem = H.ensureArray(run.items).find((item) => item.phase === "collecting" && ["pending", "running", "paused"].includes(H.ensureString(item.status)));
            if (collectingItem) {
                return getItemPrimaryText(collectingItem, run);
            }
            return "当前没有待完成任务";
        }

        function getRunCompletionText(run = {}) {
            if (!run || !run.runId) return "暂无完成记录";
            const collectingItem = H.ensureArray(run.items).find((item) => item.phase === "collecting");
            const source = collectingItem || run;
            const statusMeta = H.getStatusMeta(source.status || run.status);
            const detail = H.ensureString(
                collectingItem?.resultSummary
                || collectingItem?.note
                || run.summary
                || run.name
            );
            return detail ? `${statusMeta.label} · ${detail}` : statusMeta.label;
        }

        function normalizeSessionStatus(status = "") {
            const normalized = H.ensureString(status).toLowerCase();
            if (!normalized) return "idle";
            if (["done", "completed", "success"].includes(normalized)) return "completed";
            if (["running", "in_progress", "processing"].includes(normalized)) return "running";
            if (["pending", "queued", "waiting"].includes(normalized)) return "pending";
            if (["failed", "error", "cancelled", "canceled", "aborted"].includes(normalized)) return "failed";
            return normalized;
        }

        function getSessionActivityDetails(agent) {
            const activity = state.team.data?.sessionActivity?.[agent?.id];
            const latest = activity?.latest;
            if (!latest) return null;
            const normalizedStatus = normalizeSessionStatus(latest.status || latest.rawStatus);
            const statusMeta = H.getStatusMeta(normalizedStatus);
            const channel = H.ensureString(latest.channel || "");
            const displayName = H.ensureString(latest.displayName || latest.sessionId || "");
            const scopeLabel = [channel, displayName].filter(Boolean).join(" / ") || "普通会话";
            const activeCount = Number(activity.activeCount || 0);
            const childSessionCount = Number(activity.childSessionCount || 0);
            const childSessionActiveCount = Number(activity.childSessionActiveCount || 0);
            const spawnedByAgentId = H.ensureString(latest.spawnedByAgentId || "");
            const spawnedByAgentName = H.ensureString(latest.spawnedByAgentName || spawnedByAgentId || "");
            const isMainAgent = H.ensureString(agent?.id) === H.ensureString(state.team.draft?.mainAgentId);
            const isSpawnedTask = latest.isSpawnedTask === true || Boolean(spawnedByAgentId);
            const latestTaskPreview = toCardPreviewText(H.ensureString(latest.taskPreview || ""), "");
            const latestResultPreview = toCardPreviewText(H.ensureString(latest.resultPreview || ""), "");
            const latestChildTaskPreview = toCardPreviewText(H.ensureString(activity.latestChildTaskPreview || ""), "");
            const latestChildResultPreview = toCardPreviewText(H.ensureString(activity.latestChildResultPreview || ""), "");
            const latestActivityAt = H.ensureString(latest.updatedAt || latest.startedAt || latest.endedAt || "");
            const latestChildActivityAt = H.ensureString(activity.latestChildUpdatedAt || "");

            if (isMainAgent && childSessionCount > 0) {
                return {
                    status: normalizedStatus,
                    statusLabel: statusMeta.label,
                    statusTone: statusMeta.tone,
                    task: `主 Agent 会话 · 已派发 ${childSessionCount} 个子会话`,
                    currentStatusAt: formatStatusBlockTime(latestActivityAt),
                    workLogAt: formatStatusBlockTime(latestChildActivityAt, latestActivityAt),
                    workLog: childSessionActiveCount > 0
                        ? (latestChildResultPreview || latestChildTaskPreview || `当前正在等待 ${childSessionActiveCount} 个子会话回收`)
                        : (latestResultPreview || latestTaskPreview || "当前没有新的实时工作日志"),
                    lastWorkAt: formatStatusBlockTime(latestChildActivityAt, latestActivityAt),
                    lastWorkContent: latestChildResultPreview
                        || latestResultPreview
                        || (H.ensureString(latest.workspaceDir)
                            ? `最近一次主 Agent 会话工作区：${latest.workspaceDir}`
                            : `最近一次主 Agent 会话来自 ${scopeLabel}`),
                    pendingCount: Math.max(activeCount, childSessionActiveCount),
                    pendingAt: formatStatusBlockTime(latestChildActivityAt, latestActivityAt),
                    pendingTask: childSessionActiveCount > 0
                        ? `已派发 ${childSessionCount} 个子会话，当前 ${childSessionActiveCount} 个等待回收`
                        : `最近一次已派发 ${childSessionCount} 个子会话`,
                    lastDispatchAt: formatStatusBlockTime(latestChildActivityAt, latestActivityAt),
                    lastDispatchTask: latestChildTaskPreview || latestTaskPreview || `最近一次已向 ${childSessionCount} 个子 Agent 派发子会话`,
                    lastCompletionAt: formatStatusBlockTime(latest.endedAt, latestChildActivityAt, latestActivityAt),
                    lastCompletion: `${statusMeta.label} · ${scopeLabel}`
                };
            }

            if (isSpawnedTask) {
                const dispatcherLabel = spawnedByAgentName || spawnedByAgentId || "主 Agent";
                return {
                    status: normalizedStatus,
                    statusLabel: statusMeta.label,
                    statusTone: statusMeta.tone,
                    task: `主 Agent 派发子会话 · ${scopeLabel}`,
                    currentStatusAt: formatStatusBlockTime(latestActivityAt),
                    workLogAt: formatStatusBlockTime(latestActivityAt),
                    workLog: latestResultPreview || latestTaskPreview || "当前没有新的实时工作日志",
                    lastWorkAt: formatStatusBlockTime(latestActivityAt),
                    lastWorkContent: latestResultPreview
                        || (H.ensureString(latest.workspaceDir)
                            ? `最近一次派发会话工作区：${latest.workspaceDir}`
                            : `最近一次主 Agent 派发来自 ${dispatcherLabel}`),
                    pendingCount: activeCount,
                    pendingAt: formatStatusBlockTime(latestActivityAt),
                    pendingTask: activeCount > 0
                        ? `当前有 ${activeCount} 个主 Agent 派发会话在运行`
                        : "当前没有运行中的主 Agent 派发会话",
                    lastDispatchAt: formatStatusBlockTime(latest.startedAt, latestActivityAt),
                    lastDispatchTask: latestTaskPreview || `来自主 Agent ${dispatcherLabel} 的子会话派发`,
                    lastCompletionAt: formatStatusBlockTime(latest.endedAt, latestActivityAt),
                    lastCompletion: `${statusMeta.label} · ${scopeLabel}`
                };
            }

            return {
                status: normalizedStatus,
                statusLabel: statusMeta.label,
                statusTone: statusMeta.tone,
                task: `渠道直连会话 · ${scopeLabel}`,
                currentStatusAt: formatStatusBlockTime(latestActivityAt),
                workLogAt: formatStatusBlockTime(latestActivityAt),
                workLog: latestResultPreview || latestTaskPreview || "当前没有新的实时工作日志",
                lastWorkAt: formatStatusBlockTime(latestActivityAt),
                lastWorkContent: H.ensureString(latest.workspaceDir)
                    ? `最近一次会话工作区：${latest.workspaceDir}`
                    : `最近一次活动来自 ${scopeLabel}`,
                pendingCount: activeCount,
                pendingAt: formatStatusBlockTime(latestActivityAt),
                pendingTask: activeCount > 0
                    ? `当前有 ${activeCount} 个渠道直连会话在运行`
                    : "当前没有运行中的渠道直连会话",
                lastDispatchAt: formatStatusBlockTime(latest.startedAt, latestActivityAt),
                lastDispatchTask: "这次活动来自渠道直连，不是主 Agent 派发",
                lastCompletionAt: formatStatusBlockTime(latest.endedAt, latestActivityAt),
                lastCompletion: `${statusMeta.label} · ${scopeLabel}`
            };
        }

        function getAgentStatusDetails(agent) {
            const workflows = H.ensureArray(state.team.data?.workflows)
                .slice()
                .sort((a, b) => new Date(b?.updatedAt || b?.startedAt || 0).getTime() - new Date(a?.updatedAt || a?.startedAt || 0).getTime());

            if (!agent) {
                return {
                    status: "idle",
                    statusLabel: "未添加",
                    statusTone: "muted",
                    task: "等待添加 Agent",
                    currentStatusAt: "暂无记录",
                    workLogAt: "暂无记录",
                    workLog: "当前没有实时工作日志。",
                    lastWorkAt: "暂无记录",
                    lastWorkContent: "当前空位，还没有 Agent 信息。",
                    pendingCount: 0,
                    pendingAt: "暂无记录",
                    pendingTask: "当前没有待完成任务",
                    lastDispatchAt: "暂无记录",
                    lastDispatchTask: "暂无派单记录",
                    lastCompletionAt: "暂无记录",
                    lastCompletion: "暂无完成记录"
                };
            }

            const sessionFallback = getSessionActivityDetails(agent);

            if (agent.id === state.team.draft?.mainAgentId) {
                const latestRun = workflows[0] || null;
                if (!latestRun && sessionFallback) {
                    return sessionFallback;
                }
                const activeRuns = workflows.filter((run) => !["completed", "failed"].includes(H.ensureString(run.status)));
                const latestFinishedRun = workflows.find((run) => ["completed", "failed"].includes(H.ensureString(run.status))) || null;
                const latestCollecting = latestRun ? H.ensureArray(latestRun.items).find((item) => item.phase === "collecting") : null;
                const latestPlanning = latestRun ? H.ensureArray(latestRun.items).find((item) => item.phase === "planning") : null;
                const latestExecutionItem = latestRun ? getLatestExecutionItem(latestRun) : null;
                const activeRun = activeRuns[0] || null;
                const task = H.ensureString(latestRun?.summary || latestRun?.name || latestRun?.message) || "等待新任务";
                const statusMeta = H.getStatusMeta(latestRun?.status || "idle");
                return {
                    status: H.ensureString(latestRun?.status || "idle") || "idle",
                    statusLabel: statusMeta.label,
                    statusTone: statusMeta.tone,
                    task,
                    currentStatusAt: formatStatusBlockTime(getEntityTimestamp(latestRun || {}), sessionFallback?.currentStatusAt),
                    workLogAt: H.ensureString(sessionFallback?.workLogAt || "")
                        || formatStatusBlockTime(getEntityTimestamp(activeRun || latestCollecting || latestPlanning || latestExecutionItem || latestRun || {})),
                    workLog: H.ensureString(sessionFallback?.workLog || "")
                        || (activeRun ? getRunPendingTaskText(activeRun) : getRunWorkResultText(latestRun || {})),
                    lastWorkAt: formatStatusBlockTime(getEntityTimestamp(latestFinishedRun || latestCollecting || latestPlanning || latestRun || {})),
                    lastWorkContent: latestFinishedRun
                        ? getRunWorkResultText(latestFinishedRun)
                        : getRunWorkResultText(latestRun || {}),
                    pendingCount: activeRuns.length,
                    pendingAt: formatStatusBlockTime(getEntityTimestamp(activeRun || latestRun || {})),
                    pendingTask: activeRuns[0]
                        ? getRunPendingTaskText(activeRuns[0])
                        : "当前没有待完成任务",
                    lastDispatchAt: formatStatusBlockTime(getEntityTimestamp(latestExecutionItem || latestRun || {})),
                    lastDispatchTask: latestRun ? getRunDispatchSummary(latestRun) : "暂无派单记录",
                    lastCompletionAt: formatStatusBlockTime(getEntityTimestamp(latestFinishedRun || latestRun || {})),
                    lastCompletion: latestRun ? getRunCompletionText(latestRun) : "暂无完成记录"
                };
            }

            const matchedItems = [];
            workflows.forEach((run) => {
                H.ensureArray(run?.items)
                    .filter((item) => H.ensureString(item?.agentId) === agent.id)
                    .forEach((item) => matchedItems.push({ item, run }));
            });
            matchedItems.sort((a, b) => {
                const aTime = new Date(getEntityTimestamp(a?.item || a?.run || {})).getTime();
                const bTime = new Date(getEntityTimestamp(b?.item || b?.run || {})).getTime();
                return bTime - aTime;
            });

            const current = matchedItems[0] || null;
            if (!current && sessionFallback) {
                return sessionFallback;
            }
            const latestAssigned = matchedItems.find((entry) => H.ensureString(entry.item?.phase) === "execution") || current;
            const latestFinished = matchedItems.find((entry) => ["completed", "failed"].includes(H.ensureString(entry.item?.status))) || current;
            const pendingItems = matchedItems.filter((entry) => ["pending", "running", "paused"].includes(H.ensureString(entry.item?.status)));
            const statusMeta = H.getStatusMeta(current?.item?.status || current?.run?.status || "idle");

            return {
                status: H.ensureString(current?.item?.status || current?.run?.status || "idle") || "idle",
                statusLabel: statusMeta.label,
                statusTone: statusMeta.tone,
                task: current ? getItemPrimaryText(current.item, current.run) : "等待主 Agent 分配",
                currentStatusAt: formatStatusBlockTime(getEntityTimestamp(current?.item || current?.run || {}), sessionFallback?.currentStatusAt),
                workLogAt: H.ensureString(sessionFallback?.workLogAt || "")
                    || formatStatusBlockTime(getEntityTimestamp(current?.item || current?.run || {})),
                workLog: H.ensureString(sessionFallback?.workLog || "")
                    || (current ? getItemWorkResultText(current.item, current.run) : "当前没有新的实时工作日志"),
                lastWorkAt: formatStatusBlockTime(getEntityTimestamp(latestFinished?.item || latestFinished?.run || current?.item || current?.run || {})),
                lastWorkContent: latestFinished
                    ? getItemWorkResultText(latestFinished.item, latestFinished.run)
                    : "暂无工作记录",
                pendingCount: pendingItems.length,
                pendingAt: formatStatusBlockTime(getEntityTimestamp(pendingItems[0]?.item || pendingItems[0]?.run || {})),
                pendingTask: pendingItems[0]
                    ? getItemPrimaryText(pendingItems[0].item, pendingItems[0].run)
                    : "当前没有待完成任务",
                lastDispatchAt: formatStatusBlockTime(getEntityTimestamp(latestAssigned?.item || latestAssigned?.run || {})),
                lastDispatchTask: latestAssigned
                    ? getDispatchPromptPreview(latestAssigned.item, latestAssigned.run)
                    : "暂无派单记录",
                lastCompletionAt: formatStatusBlockTime(getEntityTimestamp(latestFinished?.item || latestFinished?.run || {})),
                lastCompletion: latestFinished ? getItemCompletionText(latestFinished.item) : "暂无完成记录"
            };
        }

        function renderStatusScreenBlock(title, value, time, options = {}) {
            const valueClass = ["mab-status-screen-value"];
            if (options.strong) valueClass.push("is-strong");
            if (options.muted) valueClass.push("is-muted");
            if (options.ellipsis) valueClass.push("is-ellipsis");
            const safeValue = H.esc(value);
            const safeTime = H.esc(time || "暂无记录");
            const safeTitle = H.esc(value || "");
            return `
                <section class="mab-status-screen-block">
                    <div class="mab-status-screen-label-row">
                        <div class="mab-status-screen-label">${H.esc(title)}</div>
                        <div class="mab-status-screen-label-time">${safeTime}</div>
                    </div>
                    <div class="${valueClass.join(" ")}" title="${safeTitle}">${safeValue}</div>
                </section>
            `;
        }

        function getAgentRosterActivity(agent) {
            const details = getAgentStatusDetails(agent);
            return {
                status: details.status,
                task: details.task
            };
        }

        function bindStatusScreenTriggers(scope = state.host) {
            if (!scope || typeof scope.querySelectorAll !== "function") return;
            scope.querySelectorAll("[data-open-status-screen]").forEach((slot) => {
                slot.addEventListener("click", () => {
                    openAgentStatusScreen();
                });
                slot.addEventListener("keydown", (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    openAgentStatusScreen();
                });
            });
        }

        function renderTopbarRosterSlot(agent, index) {
            if (!agent) {
                return `
                    <div class="mab-roster-slot is-empty" data-open-status-screen="${String(index)}" role="button" tabindex="0" aria-label="打开 Agent 状态全屏总览">
                        <div class="mab-roster-status is-muted">未添加</div>
                        <div class="mab-roster-center">
                            <span class="mab-roster-avatar">
                                <span class="mab-roster-avatar-fallback is-empty">+</span>
                            </span>
                            <span class="mab-roster-name">空位</span>
                        </div>
                        <div class="mab-roster-task">等待添加 Agent</div>
                    </div>
                `;
            }

            const activity = getAgentRosterActivity(agent);
            const statusMeta = H.getStatusMeta(activity.status);

            return `
                <div class="mab-roster-slot" data-open-status-screen="${H.esc(agent.id)}" role="button" tabindex="0" title="${H.esc(agent.name || agent.id)}" aria-label="查看 ${H.esc(agent.name || agent.id)} 的完整状态">
                    <div class="mab-roster-status is-${H.esc(statusMeta.tone || "muted")}">${H.esc(statusMeta.label || "空闲")}</div>
                    <div class="mab-roster-center">
                        ${renderAgentAvatarMarkup(agent, {
                            shellClass: "mab-roster-avatar",
                            imageClass: "mab-roster-avatar-img",
                            fallbackClass: "mab-roster-avatar-fallback"
                        })}
                        <span class="mab-roster-name">${H.esc(agent.name || agent.id)}</span>
                    </div>
                    <div class="mab-roster-task">${H.esc(activity.task || "暂无任务")}</div>
                </div>
            `;
        }

        function renderTopbarRoster() {
            const roster = teamAgents().slice(0, 6);
            while (roster.length < 6) roster.push(null);
            return `
                <div class="mab-topbar-roster">
                    ${roster.map((agent, index) => renderTopbarRosterSlot(agent, index)).join("")}
                </div>
            `;
        }

        function renderStatusScreenGrid() {
            const roster = teamAgents().slice(0, 6);
            while (roster.length < 6) roster.push(null);
            return roster.map((agent, index) => renderStatusScreenCard(agent, index)).join("");
        }

        function refreshTeamLiveStatusViews() {
            if (state.mode !== "team" || !state.host || !state.team.draft) return;
            const roster = state.host.querySelector(".mab-topbar-roster");
            if (roster) {
                roster.outerHTML = renderTopbarRoster();
                bindStatusScreenTriggers(state.host);
                requestAnimationFrame(syncTopbarRosterOffset);
            }
            const statusGrid = document.querySelector(".mab-status-screen-grid");
            if (statusGrid) {
                statusGrid.innerHTML = renderStatusScreenGrid();
            }
        }

        function renderStatusScreenCard(agent, index) {
            const details = getAgentStatusDetails(agent);
            if (!agent) {
                return `
                    <article class="mab-status-screen-card is-empty">
                        <div class="mab-status-screen-head">
                            <span class="mab-status-screen-badge is-muted">未添加</span>
                            <span class="mab-status-screen-id">槽位 ${index + 1}</span>
                        </div>
                        <div class="mab-status-screen-avatar-wrap">
                            <span class="mab-status-screen-avatar">
                                <span class="mab-status-screen-avatar-fallback is-empty">+</span>
                            </span>
                            <div class="mab-status-screen-name">空位</div>
                        </div>
                        <div class="mab-status-screen-body">
                            <section class="mab-status-screen-block">
                                <div class="mab-status-screen-label-row">
                                    <div class="mab-status-screen-label">当前状态</div>
                                    <div class="mab-status-screen-label-time">暂无记录</div>
                                </div>
                                <div class="mab-status-screen-value">等待添加 Agent</div>
                            </section>
                            ${renderStatusScreenBlock("实时工作日志", "当前没有实时工作日志。", "暂无记录", { muted: true })}
                            ${renderStatusScreenBlock("上次工作内容", "当前没有 Agent 信息。", "暂无记录", { muted: true, ellipsis: true })}
                            ${renderStatusScreenBlock("待完成任务", "当前没有待完成任务", "暂无记录", { muted: true, ellipsis: true })}
                            ${renderStatusScreenBlock("上次派单任务", "暂无派单记录", "暂无记录", { muted: true, ellipsis: true })}
                            ${renderStatusScreenBlock("上次任务完成情况", "暂无完成记录", "暂无记录", { muted: true })}
                        </div>
                    </article>
                `;
            }

            return `
                <article class="mab-status-screen-card">
                    <div class="mab-status-screen-head">
                        <span class="mab-status-screen-badge is-${H.esc(details.statusTone || "muted")}">${H.esc(details.statusLabel || "空闲")}</span>
                        <span class="mab-status-screen-id">ID：${H.esc(agent.id)}</span>
                    </div>
                    <div class="mab-status-screen-avatar-wrap">
                        ${renderAgentAvatarMarkup(agent, {
                            shellClass: "mab-status-screen-avatar",
                            imageClass: "mab-status-screen-avatar-img",
                            fallbackClass: "mab-status-screen-avatar-fallback"
                        })}
                        <div class="mab-status-screen-name-wrap">
                            <div class="mab-status-screen-name">${H.esc(agent.name || agent.id)}</div>
                            <div class="mab-status-screen-role">${H.esc(agent.id === state.team.draft?.mainAgentId ? "主 Agent" : "子 Agent")}</div>
                        </div>
                    </div>
                    <div class="mab-status-screen-body">
                        ${renderStatusScreenBlock("当前状态", details.task || "暂无任务", details.currentStatusAt)}
                        ${renderStatusScreenBlock("实时工作日志", details.workLog || "当前没有实时工作日志", details.workLogAt)}
                        ${renderStatusScreenBlock("上次工作内容", details.lastWorkContent || "暂无工作记录", details.lastWorkAt, { ellipsis: true })}
                        ${renderStatusScreenBlock("待完成任务", details.pendingTask || "当前没有待完成任务", details.pendingAt, { ellipsis: true })}
                        ${renderStatusScreenBlock("上次派单任务", details.lastDispatchTask || "暂无派单记录", details.lastDispatchAt, { ellipsis: true })}
                        ${renderStatusScreenBlock("上次任务完成情况", details.lastCompletion || "暂无完成记录", details.lastCompletionAt)}
                    </div>
                </article>
            `;
        }

        function closeAgentStatusScreen() {
            if (typeof state.team.statusScreenClose === "function") {
                try {
                    state.team.statusScreenClose();
                } catch (_) {}
            }
            state.team.statusScreenClose = null;
        }

        function openAgentStatusScreen() {
            closeAgentStatusScreen();
            const overlay = document.createElement("div");
            overlay.className = "mab-status-screen-overlay";
            overlay.innerHTML = `
                <div class="mab-status-screen-shell" aria-label="Agent 状态全屏总览" role="dialog" aria-modal="true">
                    <div class="mab-status-screen-hint">Agent 状态全屏总览，点击任意位置退出</div>
                    <div class="mab-status-screen-grid">
                        ${renderStatusScreenGrid()}
                    </div>
                </div>
            `;

            const close = () => {
                if (!overlay.isConnected) return;
                document.removeEventListener("keydown", handleKeydown);
                overlay.remove();
                if (state.team.statusScreenClose === close) {
                    state.team.statusScreenClose = null;
                }
            };

            const handleKeydown = (event) => {
                if (event.key === "Escape") close();
            };

            overlay.addEventListener("click", () => close());
            document.addEventListener("keydown", handleKeydown);
            document.body.appendChild(overlay);
            state.team.statusScreenClose = close;
        }

        function syncTopbarRosterOffset() {
            if (!state.host) return;
            const topbar = state.host.querySelector(".mab-topbar");
            const roster = state.host.querySelector(".mab-topbar-roster");
            const actions = state.host.querySelector(".mab-topbar-actions");
            const modeMeta = state.host.querySelector(".mab-topbar-mode-meta");
            if (!topbar || !roster || !actions || !modeMeta) return;

            const targetButton = actions.querySelector("[data-create-team]") || actions.querySelector(".mab-btn");
            if (!targetButton) {
                topbar.style.setProperty("--mab-roster-offset", "0px");
                topbar.style.setProperty("--mab-actions-offset", "0px");
                return;
            }

            const modeRect = modeMeta.getBoundingClientRect();
            const desiredLeft = Math.round(modeRect.left + 100);
            const rosterRect = roster.getBoundingClientRect();
            const targetRect = targetButton.getBoundingClientRect();
            const rosterOffset = Math.round(desiredLeft - rosterRect.left);
            const actionsOffset = Math.round(desiredLeft - targetRect.left);
            topbar.style.setProperty("--mab-roster-offset", `${rosterOffset}px`);
            topbar.style.setProperty("--mab-actions-offset", `${actionsOffset}px`);
        }

        function renderMemberCard(agent) {
            const bindingText = H.getBindingStatusText(agent);
            return `
                <div class="mab-member-card ${state.team.selectedAgentId === agent.id ? "is-active" : ""}" data-select-agent="${H.esc(agent.id)}" role="button" tabindex="0">
                    <div class="mab-member-card-head">
                        <div class="mab-member-card-main">
                            <button class="mab-member-avatar-trigger" data-avatar-picker="${H.esc(agent.id)}" type="button" title="选择头像">
                                ${renderAgentAvatarMarkup(agent, {
                                    shellClass: "mab-member-avatar",
                                    imageClass: "mab-member-avatar-img",
                                    fallbackClass: "mab-member-avatar-fallback"
                                })}
                            </button>
                            <div class="mab-member-copy">
                                <div class="mab-member-title">${H.esc(agent.name || agent.id)}</div>
                                <div class="mab-member-subtitle">ID：${H.esc(agent.id)}</div>
                            </div>
                        </div>
                        ${agent.id !== state.team.draft?.mainAgentId ? `<span class="mab-member-remove" data-delete-agent="${H.esc(agent.id)}" title="删除子 Agent">×</span>` : ""}
                    </div>
                    <div class="mab-chip-row">
                        <span class="mab-chip ${agent.id === state.team.draft?.mainAgentId ? "is-primary" : ""}">${agent.id === state.team.draft?.mainAgentId ? "主 Agent" : "子 Agent"}</span>
                        <span class="mab-chip">${H.esc(state.team.draft?.team?.name || "默认团队")}</span>
                        ${agent.fallbackExecution ? `<span class="mab-chip is-warning">兜底执行</span>` : ""}
                        ${agent.id === state.team.draft?.mainAgentId ? `<span class="mab-chip">${state.team.draft?.team?.dispatchMode === "manual" ? "人工确认" : "自动分配"}</span>` : ""}
                    </div>
                    <div class="mab-member-meta">${H.esc(bindingText === "未绑定" ? "未绑定聊天入口" : bindingText)}${H.ensureArray(agent.capabilityTags).length ? ` · ${H.esc(H.ensureArray(agent.capabilityTags).join(" / "))}` : ""}</div>
                </div>
            `;
        }

        function renderBindingSection(agent) {
            let bindings = H.ensureArray(agent?.bindings);
            if (!bindings.length) {
                agent.bindings = [H.createBindingRow()];
                bindings = agent.bindings;
            }

            return `
                <div class="mab-binding-list">
                    ${bindings.map((binding) => {
                        const sessions = getChannelSessions(binding.channel);
                        return `
                            <div class="mab-binding-row">
                                <div class="mab-field">
                                    <label>聊天工具 <span class="mab-required-mark">*</span></label>
                                    <select data-binding-channel="${H.esc(agent.id)}" data-row-id="${H.esc(binding.rowId)}">
                                        <option value="">请选择渠道</option>
                                        ${H.ensureArray(state.team.data?.channels).map((channel) => `
                                            <option value="${H.esc(channel.key)}" ${channel.key === binding.channel ? "selected" : ""}>${H.esc(channel.label)}</option>
                                        `).join("")}
                                    </select>
                                </div>
                                <div class="mab-field">
                                    <label>自动获取的私聊/群聊 ID</label>
                                    <select data-binding-session="${H.esc(agent.id)}" data-row-id="${H.esc(binding.rowId)}">
                                        <option value="">从配置文件里选择</option>
                                        ${sessions.map((session) => `
                                            <option value="${H.esc(session.key)}" ${!binding.manual && session.targetId === binding.targetId ? "selected" : ""}>${H.esc(session.label)}</option>
                                        `).join("")}
                                    </select>
                                </div>
                                <div class="mab-field">
                                    <label>私聊/群聊 ID <span class="mab-required-mark">*</span></label>
                                    <input data-binding-manual="${H.esc(agent.id)}" data-row-id="${H.esc(binding.rowId)}" value="${H.esc(binding.manual ? binding.targetId : "")}" placeholder="配置文件里没有时再手动输入">
                                </div>
                                <button class="mab-icon-btn is-danger" data-remove-binding="${H.esc(agent.id)}" data-row-id="${H.esc(binding.rowId)}" type="button" title="删除绑定">×</button>
                            </div>
                        `;
                    }).join("")}
                    <div class="mab-chip-row">
                        <span class="mab-chip is-primary">绑定到团队：${H.esc(state.team.draft?.team?.name || "默认团队")}</span>
                        <span class="mab-chip">直属主 Agent：${H.esc(state.team.draft?.mainAgentId || "main")}</span>
                        <span class="mab-chip is-success">${H.esc(H.getBindingStatusText(agent) === "未绑定" ? "当前入口：未绑定" : H.getBindingStatusText(agent))}</span>
                    </div>
                    <div class="mab-binding-actions">
                        <button class="mab-btn mab-btn-secondary" data-add-binding="${H.esc(agent.id)}" type="button">新增绑定</button>
                        <button class="mab-btn mab-btn-danger" data-clear-bindings="${H.esc(agent.id)}" type="button">取消绑定</button>
                    </div>
                </div>
            `;
        }

        function getIncompleteBindingsSummary() {
            const invalidRows = [];
            teamAgents().forEach((agent) => {
                H.ensureArray(agent.bindings).forEach((binding) => {
                    const channel = H.ensureString(binding?.channel);
                    const targetId = H.ensureString(binding?.targetId);
                    const hasAnyValue = Boolean(channel || targetId);
                    const isComplete = Boolean(channel && targetId);
                    if (!hasAnyValue || isComplete) return;
                    invalidRows.push({
                        agentId: agent.id,
                        agentName: agent.name || agent.id,
                        channel,
                        targetId
                    });
                });
            });
            return invalidRows;
        }

        function renderWorkspaceFilesSection(agent) {
            return `
                <div class="mab-section">
                    <div class="mab-section-title">工作区文件</div>
                    <div class="mab-section-desc">这里直接对应当前 Agent 工作区里的 5 个文件。点击输入框会临时展开，点击别处后恢复紧凑高度。</div>
                    <div class="mab-grid two mab-file-grid">
                        <div class="mab-field">
                            <label>IDENTITY.md</label>
                            <textarea class="mab-file-editor" data-agent-field="${H.esc(agent.id)}" data-field="identityContent" data-auto-expand-editor="true" spellcheck="false" placeholder="身份说明、团队归属、模型与入口等信息会写到这里">${H.esc(agent.identityContent || "")}</textarea>
                        </div>
                        <div class="mab-field">
                            <label>SOUL.md</label>
                            <textarea class="mab-file-editor" data-agent-field="${H.esc(agent.id)}" data-field="soulContent" data-auto-expand-editor="true" spellcheck="false" placeholder="角色定位、风格、长期约束、输出偏好">${H.esc(agent.soulContent || "")}</textarea>
                        </div>
                        <div class="mab-field">
                            <label>USER.md</label>
                            <textarea class="mab-file-editor" data-agent-field="${H.esc(agent.id)}" data-field="userContent" data-auto-expand-editor="true" spellcheck="false" placeholder="用户背景、协作约定、默认上下文">${H.esc(agent.userContent || "")}</textarea>
                        </div>
                        <div class="mab-field">
                            <label>AGENTS.md</label>
                            <textarea class="mab-file-editor" data-agent-field="${H.esc(agent.id)}" data-field="agentsContent" data-auto-expand-editor="true" spellcheck="false" placeholder="团队结构、协作说明、当前 Agent 在团队中的位置">${H.esc(agent.agentsContent || "")}</textarea>
                        </div>
                        <div class="mab-field">
                            <label>TOOLS.json</label>
                            <textarea class="mab-file-editor is-json" data-agent-field="${H.esc(agent.id)}" data-field="toolsContent" data-auto-expand-editor="true" spellcheck="false" placeholder="{\n  \"tools\": []\n}">${H.esc(agent.toolsContent || "")}</textarea>
                        </div>
                    </div>
                </div>
            `;
        }

        function renderTeamControlSection() {
            return `
                <div class="mab-section">
                    <div class="mab-section-title">主 Agent 控制项</div>
                    <div class="mab-section-desc">这是团队级设置，固定放在右侧底部，方便直接看到主 Agent 的分配方式。</div>
                    <div class="mab-main-control">
                        <div class="mab-field mab-team-name-field">
                            <label>团队名称</label>
                            <input data-team-name value="${H.esc(state.team.draft?.team?.name || "默认团队")}" placeholder="例如：某某管家">
                        </div>
                        <div class="mab-main-control-row">
                            <span>收到消息后的分配方式</span>
                            <div class="mab-segmented">
                                <button class="mab-segment ${state.team.draft?.team?.dispatchMode === "auto" ? "is-active" : ""}" data-dispatch-mode="auto" type="button">自动分配</button>
                                <button class="mab-segment ${state.team.draft?.team?.dispatchMode === "manual" ? "is-active" : ""}" data-dispatch-mode="manual" type="button">人工确认后分配</button>
                            </div>
                        </div>
                        <div class="mab-section-desc">说明：如果选择“自动分配”，之后给主 Agent 发消息，就会直接进入规划和派单流程。</div>
                    </div>
                </div>
            `;
        }

        function renderTeamNameControl() {
            const selectorOptions = getTeamSelectorOptions();
            const teamCount = teamOptions().length;
            const activeTeamId = H.ensureString(state.team.draft?.mainAgentId || state.team.mainAgentId || "main") || "main";
            return `
                <div class="mab-team-switcher">
                    <label class="mab-team-select-wrap is-prominent">
                        <span class="mab-team-headline-label">切换团队</span>
                        <select class="mab-team-inline-select" data-team-selector>
                            ${selectorOptions.map((team) => `
                                <option value="${H.esc(team.mainAgentId || team.id)}" ${(team.mainAgentId || team.id) === activeTeamId ? "selected" : ""}>
                                    ${H.esc(team.name || team.mainAgentId || team.id)}
                                </option>
                            `).join("")}
                        </select>
                    </label>
                    <div class="mab-team-switcher-hint">当前共 ${H.esc(String(teamCount))} 个团队，在这里直接切换团队。</div>
                </div>
            `;
        }

        function renderSelectedAgent() {
            const agent = currentAgent();
            if (!agent) {
                return `
                    <section class="mab-panel">
                        <div class="mab-empty-title">当前没有可编辑的 Agent</div>
                        <div class="mab-empty-desc">请先创建一个团队成员。</div>
                    </section>
                `;
            }

            return `
                <section class="mab-panel mab-detail-panel">
                    <div class="mab-panel-head mab-panel-head-agent">
                        <div>
                            <h3>当前选中：${H.esc(agent.name || agent.id)}</h3>
                            <p>配置按“基础信息、聊天绑定、团队级控制项”分组，右侧结构始终保持一致，减少新手理解成本。</p>
                        </div>
                        <button class="mab-agent-avatar-trigger" data-avatar-picker="${H.esc(agent.id)}" type="button" title="选择头像">
                            ${renderAgentAvatarMarkup(agent, {
                                shellClass: "mab-agent-avatar",
                                imageClass: "mab-agent-avatar-img",
                                fallbackClass: "mab-agent-avatar-fallback"
                            })}
                            <span class="mab-agent-avatar-copy">
                                <strong>选择头像</strong>
                                <small>点击从内置像素头像库里挑选</small>
                            </span>
                        </button>
                    </div>

                    <div class="mab-section">
                        <div class="mab-section-title">基础信息</div>
                        <div class="mab-section-desc">这些是最常用字段，优先放在前面。</div>
                        <div class="mab-grid four">
                            <div class="mab-field">
                                <label>Agent ID</label>
                                <input value="${H.esc(agent.id)}" readonly>
                            </div>
                            <div class="mab-field">
                                <label>名称</label>
                                <input data-agent-field="${H.esc(agent.id)}" data-field="name" value="${H.esc(agent.name)}" placeholder="例如：写作助手">
                            </div>
                            <div class="mab-field">
                                <label>模型</label>
                                <select data-agent-field="${H.esc(agent.id)}" data-field="model">
                                    <option value="">留空则使用默认模型</option>
                                    ${modelOptions().map((option) => `<option value="${H.esc(option.value)}" ${option.value === agent.model ? "selected" : ""}>${H.esc(option.label)}</option>`).join("")}
                                </select>
                            </div>
                            <div class="mab-field">
                                <label>workspace</label>
                                <input data-agent-field="${H.esc(agent.id)}" data-field="workspace" value="${H.esc(agent.workspace)}" placeholder="留空则自动创建">
                            </div>
                        </div>
                        <div class="mab-grid two">
                            <div class="mab-field">
                                <label>身份说明</label>
                                <input data-agent-field="${H.esc(agent.id)}" data-field="responsibilities" value="${H.esc(agent.responsibilities)}" placeholder="描述这个 Agent 负责什么">
                            </div>
                            <div class="mab-field">
                                <label>能力标签</label>
                                <input data-agent-field="${H.esc(agent.id)}" data-field="capabilityTags" value="${H.esc(H.ensureArray(agent.capabilityTags).join(", "))}" placeholder="例如：research, writing, image">
                            </div>
                        </div>
                        ${agent.id !== state.team.draft?.mainAgentId ? `
                            <div class="mab-inline-toggle-row">
                                <label class="mab-inline-toggle">
                                    <input type="checkbox" data-agent-toggle="${H.esc(agent.id)}" data-field="fallbackExecution" ${agent.fallbackExecution ? "checked" : ""}>
                                    <span>设为兜底执行 Agent</span>
                                </label>
                                <span class="mab-inline-toggle-desc">没有明确匹配子 Agent 时，主 Agent 会优先把任务派给它。</span>
                            </div>
                        ` : `
                            <div class="mab-inline-toggle-row is-readonly">
                                <span class="mab-inline-toggle-desc">主 Agent 固定只负责调度，不参与具体执行。</span>
                            </div>
                        `}
                    </div>

                    ${renderWorkspaceFilesSection(agent)}

                    <div class="mab-section">
                        <div class="mab-section-title">聊天绑定</div>
                    <div class="mab-section-desc">先选聊天工具，再从配置文件里自动读取私聊/群聊 ID；如果有多个就直接下拉选择，没有时再手动输入。</div>
                        ${renderBindingSection(agent)}
                    </div>

                    ${renderTeamControlSection()}

                    <div class="mab-detail-footer">
                        <button class="mab-btn mab-btn-primary" data-save-team type="button">${state.team.draft?.dirty ? "保存配置*" : "保存配置"}</button>
                    </div>
                </section>
            `;
        }

        function bindTeamEvents() {
            if (!state.host) return;

            state.host.querySelector("[data-team-selector]")?.addEventListener("change", async (event) => {
                const nextTeamId = H.ensureString(event.target.value);
                if (!nextTeamId || nextTeamId === state.team.mainAgentId) return;
                if (state.team.draft?.dirty) {
                    const confirmed = await window.showConfirmDialog("当前团队有未保存修改，切换团队会放弃这些修改。确定继续吗？", {
                        title: "切换团队",
                        confirmText: "继续切换",
                        cancelText: "取消"
                    });
                    if (!confirmed) {
                        event.target.value = state.team.mainAgentId;
                        return;
                    }
                }
                state.team.mainAgentId = nextTeamId;
                state.team.notice = { text: "", tone: "" };
                state.team.needsReload = true;
                await mountTeamManager();
            });

            state.host.querySelector("[data-create-team]")?.addEventListener("click", () => {
                openCreateTeamDialog().catch((error) => setNotice(error.message || String(error), "danger"));
            });

            state.host.querySelector("[data-delete-team]")?.addEventListener("click", () => {
                deleteCurrentTeam().catch((error) => setNotice(error.message || String(error), "danger"));
            });

            state.host.querySelector("[data-import-team]")?.addEventListener("click", () => {
                importTeamConfig().catch((error) => setNotice(error.message || String(error), "danger"));
            });

            state.host.querySelector("[data-export-team]")?.addEventListener("click", () => {
                exportTeamConfig().catch((error) => setNotice(error.message || String(error), "danger"));
            });

            bindStatusScreenTriggers(state.host);

            state.host.querySelectorAll("[data-select-agent]").forEach((button) => {
                button.addEventListener("click", (event) => {
                    if (event.target.closest("[data-delete-agent]") || event.target.closest("[data-avatar-picker]")) return;
                    state.team.selectedAgentId = button.getAttribute("data-select-agent") || state.team.selectedAgentId;
                    renderTeamView();
                });
                button.addEventListener("keydown", (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    if (event.target.closest("[data-delete-agent]") || event.target.closest("[data-avatar-picker]")) return;
                    event.preventDefault();
                    state.team.selectedAgentId = button.getAttribute("data-select-agent") || state.team.selectedAgentId;
                    renderTeamView();
                });
            });

            state.host.querySelectorAll("[data-delete-agent]").forEach((button) => {
                button.addEventListener("click", (event) => {
                    event.stopPropagation();
                    deleteChildAgent(button.getAttribute("data-delete-agent")).catch((error) => setNotice(error.message || String(error), "danger"));
                });
            });

            state.host.querySelectorAll("[data-add-child]").forEach((button) => {
                button.addEventListener("click", () => {
                    openCreateChildDialog().catch((error) => setNotice(error.message || String(error), "danger"));
                });
            });

            state.host.querySelectorAll("[data-avatar-picker]").forEach((button) => {
                button.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const agentId = button.getAttribute("data-avatar-picker") || "";
                    openAvatarPickerDialog(agentId).catch((error) => setNotice(error.message || String(error), "danger"));
                });
            });

            state.host.querySelector("[data-save-team]")?.addEventListener("click", () => {
                persistDraft().catch((error) => setNotice(error.message || String(error), "danger"));
            });

            state.host.querySelector("[data-team-name]")?.addEventListener("input", (event) => {
                state.team.draft.team.name = event.target.value;
                markDirty();
            });

            state.host.querySelectorAll("[data-agent-field]").forEach((field) => {
                const handler = () => updateAgentField(field.getAttribute("data-agent-field"), field.getAttribute("data-field"), field.value);
                field.addEventListener("input", handler);
                field.addEventListener("change", handler);
            });

            state.host.querySelectorAll("[data-agent-toggle]").forEach((field) => {
                field.addEventListener("change", () => {
                    const agent = H.getAgentDraft(state.team.draft, field.getAttribute("data-agent-toggle"));
                    if (!agent) return;
                    const enabled = field.checked;
                    childAgents().forEach((entry) => {
                        if (entry.id !== agent.id) entry.fallbackExecution = false;
                    });
                    agent.fallbackExecution = enabled;
                    if (enabled && !H.ensureArray(agent.capabilityTags).includes("generalist")) {
                        agent.capabilityTags = H.ensureArray(agent.capabilityTags).concat("generalist");
                    }
                    markDirty();
                    renderTeamView();
                });
            });

            state.host.querySelectorAll("[data-auto-expand-editor]").forEach((field) => {
                const resizeExpanded = () => {
                    field.classList.add("is-expanded");
                    field.style.height = "auto";
                    field.style.height = `${Math.min(Math.max(field.scrollHeight, 188), 320)}px`;
                };
                const resetCollapsed = () => {
                    field.classList.remove("is-expanded");
                    field.style.height = "";
                };
                field.addEventListener("focus", resizeExpanded);
                field.addEventListener("input", () => {
                    if (document.activeElement === field) resizeExpanded();
                });
                field.addEventListener("blur", resetCollapsed);
            });

            state.host.querySelectorAll("[data-dispatch-mode]").forEach((button) => {
                button.addEventListener("click", () => {
                    state.team.draft.team.dispatchMode = button.getAttribute("data-dispatch-mode") || "auto";
                    markDirty();
                    renderTeamView();
                });
            });

            state.host.querySelectorAll("[data-add-binding]").forEach((button) => {
                button.addEventListener("click", () => {
                    const agent = H.getAgentDraft(state.team.draft, button.getAttribute("data-add-binding"));
                    if (!agent) return;
                    agent.bindings.push(H.createBindingRow());
                    markDirty();
                    renderTeamView();
                });
            });

            state.host.querySelectorAll("[data-clear-bindings]").forEach((button) => {
                button.addEventListener("click", () => {
                    const agent = H.getAgentDraft(state.team.draft, button.getAttribute("data-clear-bindings"));
                    if (!agent) return;
                    agent.bindings = [];
                    markDirty();
                    renderTeamView();
                });
            });

            state.host.querySelectorAll("[data-remove-binding]").forEach((button) => {
                button.addEventListener("click", () => {
                    const agent = H.getAgentDraft(state.team.draft, button.getAttribute("data-remove-binding"));
                    if (!agent) return;
                    agent.bindings = H.ensureArray(agent.bindings).filter((binding) => binding.rowId !== button.getAttribute("data-row-id"));
                    markDirty();
                    renderTeamView();
                });
            });

            state.host.querySelectorAll("[data-binding-channel]").forEach((field) => {
                field.addEventListener("change", () => {
                    const agentId = field.getAttribute("data-binding-channel");
                    const rowId = field.getAttribute("data-row-id");
                    updateBindingRow(agentId, rowId, {
                        channel: field.value,
                        targetId: "",
                        targetKind: "group",
                        match: null,
                        manual: false
                    });
                    const agent = H.getAgentDraft(state.team.draft, agentId);
                    const row = H.ensureArray(agent?.bindings).find((binding) => binding.rowId === rowId);
                    if (row) syncBindingAutoSelection(row);
                    renderTeamView();
                });
            });

            state.host.querySelectorAll("[data-binding-session]").forEach((field) => {
                field.addEventListener("change", () => {
                    const agentId = field.getAttribute("data-binding-session");
                    const rowId = field.getAttribute("data-row-id");
                    const agent = H.getAgentDraft(state.team.draft, agentId);
                    const row = H.ensureArray(agent?.bindings).find((binding) => binding.rowId === rowId);
                    if (!row) return;
                    const session = getChannelSessions(row.channel).find((item) => item.key === field.value);
                    if (!session) {
                        updateBindingRow(agentId, rowId, {
                            targetId: "",
                            match: null,
                            manual: true
                        });
                    } else {
                        updateBindingRow(agentId, rowId, {
                            targetId: session.targetId,
                            targetKind: session.targetKind,
                            match: session.match,
                            manual: false
                        });
                    }
                    renderTeamView();
                });
            });

            state.host.querySelectorAll("[data-binding-manual]").forEach((field) => {
                field.addEventListener("input", () => {
                    const value = field.value;
                    updateBindingRow(field.getAttribute("data-binding-manual"), field.getAttribute("data-row-id"), {
                        targetId: value,
                        targetKind: H.inferTargetKind(value),
                        match: null,
                        manual: true
                    });
                });
            });
        }

        function renderTeamView() {
            closeAgentStatusScreen();
            state.team.disposeFns.forEach((dispose) => {
                try { dispose(); } catch (_) {}
            });
            state.team.disposeFns = [];
            if (!state.host || !state.team.draft) return;
            syncAllBindingAutoSelections();
            const mainAgent = H.getAgentDraft(state.team.draft, state.team.draft?.mainAgentId);
            state.host.innerHTML = `
                <div class="mab-shell">
                    <header class="mab-page-head">
                        <h1>OpenClaw 多 Agent 团队配置</h1>
                        <p>把配置文件可视化。主 Agent 负责分配、监控、回收，子 Agent 负责执行。</p>
                    </header>

                    <section class="mab-topbar">
                        <div class="mab-topbar-main">
                            <div class="mab-topbar-title">${renderTeamNameControl()}</div>
                            <div class="mab-topbar-meta">
                                主 Agent：${H.esc(mainAgent?.name || state.team.draft?.mainAgentId || "main")}　子 Agent：${H.esc(String(childAgents().length))} 个
                                <span class="mab-topbar-mode-meta">当前模式：${state.team.draft?.team?.dispatchMode === "manual" ? "人工确认后分配" : "自动分配"}</span>
                            </div>
                        </div>
                        ${renderTopbarRoster()}
                        <div class="mab-topbar-toolbar">
                            <div class="mab-topbar-chips">
                                <span class="mab-chip is-primary">团队视图</span>
                                <span class="mab-chip is-success">绑定来源：现有配置 + 手动补录</span>
                            </div>
                            <div class="mab-topbar-actions">
                                <button class="mab-btn mab-btn-secondary" data-create-team type="button">新建团队</button>
                                <button class="mab-btn mab-btn-secondary" data-import-team type="button">导入配置</button>
                                <button class="mab-btn mab-btn-secondary" data-export-team type="button">导出配置</button>
                                ${state.team.mainAgentId !== "main" ? `<button class="mab-btn mab-btn-danger" data-delete-team type="button">解散并删除团队</button>` : ""}
                            </div>
                        </div>
                    </section>

                    ${renderNotice()}

                    <div class="mab-layout">
                        <aside class="mab-panel mab-sidebar">
                            <div class="mab-panel-head">
                                <div>
                                    <h3>团队成员</h3>
                                    <p>左侧只解决一件事：看清主从关系与成员归属。</p>
                                </div>
                                <button class="mab-btn mab-btn-secondary mab-btn-inline" data-add-child type="button">添加</button>
                            </div>
                            <div class="mab-member-list">
                                ${teamAgents().map((agent) => renderMemberCard(agent)).join("")}
                            </div>
                            <div class="mab-sidebar-foot">说明：点击右上角红色 × 会弹出“删除子 Agent”确认框。</div>
                        </aside>
                        ${renderSelectedAgent()}
                    </div>
                </div>
            `;
            bindTeamEvents();
            const handleResize = () => syncTopbarRosterOffset();
            window.addEventListener("resize", handleResize);
            state.team.disposeFns.push(() => window.removeEventListener("resize", handleResize));
            requestAnimationFrame(syncTopbarRosterOffset);
        }

        function updateAgentField(agentId, field, value) {
            const agent = H.getAgentDraft(state.team.draft, agentId);
            if (!agent) return;
            if (field === "capabilityTags") {
                agent.capabilityTags = H.normalizeTagList(value);
            } else {
                agent[field] = String(value ?? "");
            }
            markDirty();
        }

        function updateBindingRow(agentId, rowId, patch = {}) {
            const agent = H.getAgentDraft(state.team.draft, agentId);
            if (!agent) return;
            const row = H.ensureArray(agent.bindings).find((binding) => binding.rowId === rowId);
            if (!row) return;
            Object.assign(row, patch);
            markDirty();
        }

        function buildTeamSavePayload() {
            const nextFallbackAgentId = fallbackAgentId();
            return {
                mainAgentId: state.team.draft.mainAgentId,
                team: {
                    name: H.ensureString(state.team.draft.team.name) || "默认团队",
                    mainAgentId: state.team.draft.mainAgentId,
                    childAgentIds: H.ensureArray(state.team.draft.team.childAgentIds),
                    dispatchMode: state.team.draft.team.dispatchMode,
                    templateId: H.ensureString(state.team.draft.team.templateId || "custom") || "custom",
                    fallbackAgentId: nextFallbackAgentId,
                    strictDispatchOnly: state.team.draft.team.strictDispatchOnly !== false
                },
                agents: teamAgents().map((agent) => ({
                    id: agent.id,
                    name: agent.name,
                    model: agent.model,
                    workspace: agent.workspace,
                    agentDir: agent.agentDir,
                    roleTitle: agent.id === state.team.draft.mainAgentId ? "主 Agent" : "子 Agent",
                    responsibilities: agent.responsibilities,
                    capabilityTags: H.normalizeTagList(agent.capabilityTags || []),
                    fallbackExecution: agent.id === nextFallbackAgentId,
                    identityContent: agent.identityContent,
                    soulContent: agent.soulContent,
                    userContent: agent.userContent,
                    agentsContent: agent.agentsContent,
                    toolsContent: agent.toolsContent,
                    avatar: agent.avatar ? H.clone(agent.avatar) : null,
                    bindings: H.ensureArray(agent.bindings)
                        .filter((binding) => H.ensureString(binding.channel) && H.ensureString(binding.targetId))
                        .map((binding) => ({
                            channel: binding.channel,
                            targetId: binding.targetId,
                            targetKind: binding.targetKind,
                            match: binding.manual ? null : binding.match,
                            manual: binding.manual === true
                        }))
                }))
            };
        }

        function applyImportedTeamDraft(importedDraft = {}, sourcePath = "") {
            const nextDraft = H.buildDraft(importedDraft);
            nextDraft.dirty = true;
            state.team.mainAgentId = nextDraft.mainAgentId || state.team.mainAgentId || "main";
            state.team.data = {
                ...(state.team.data || {}),
                mainAgentId: nextDraft.mainAgentId,
                team: H.clone(nextDraft.team),
                agents: H.clone(nextDraft.agents),
                workflows: [],
                sessionActivity: {}
            };
            state.team.draft = nextDraft;
            syncAllBindingAutoSelections();
            syncSelection();
            const sourceLabel = H.ensureString(sourcePath) ? `：${sourcePath}` : "";
            setNotice(`团队配置已导入到当前编辑区${sourceLabel}，请确认后再点保存配置。`, "warning");
        }

        async function exportTeamConfig() {
            clearNotice();
            const result = await window.api.exportAgentTeamConfig({ draft: buildTeamSavePayload() });
            if (result?.canceled) return;
            if (!result?.ok) throw new Error(result?.error || "导出团队配置失败");
            setNotice(`团队配置已导出到 ${H.ensureString(result.path || "") || "目标文件"}`, "success");
        }

        async function importTeamConfig() {
            if (state.team.draft?.dirty) {
                const confirmed = await window.showConfirmDialog("导入配置会覆盖当前未保存的团队修改。确定继续吗？", {
                    title: "导入团队配置",
                    confirmText: "继续导入",
                    cancelText: "取消"
                });
                if (!confirmed) return;
            }
            clearNotice();
            const result = await window.api.importAgentTeamConfig();
            if (result?.canceled) return;
            if (!result?.ok) throw new Error(result?.error || "导入团队配置失败");
            applyImportedTeamDraft(result.draft || {}, result.path || "");
        }

        async function persistDraft(noticeText = "团队配置已保存。") {
            clearNotice();
            const incompleteBindings = getIncompleteBindingsSummary();
            const payload = buildTeamSavePayload();
            const result = await window.api.saveAgentTeamBuilderData(payload);
            if (!result?.ok) throw new Error(result?.error || "保存团队配置失败");
            state.team.data = result;
            state.team.mainAgentId = result.mainAgentId || payload.mainAgentId || state.team.mainAgentId;
            state.team.teams = H.ensureArray(result.teams);
            state.team.draft = H.buildDraft(result);
            state.team.needsReload = false;
            syncSelection();
            if (incompleteBindings.length) {
                const preview = incompleteBindings
                    .slice(0, 2)
                    .map((item) => `${item.agentName}${item.channel ? ` / ${item.channel}` : ""}`)
                    .join("、");
                const suffix = incompleteBindings.length > 2 ? ` 等 ${incompleteBindings.length} 条` : ` 共 ${incompleteBindings.length} 条`;
                setNotice(`${noticeText} 但有未填完整的聊天绑定未生效：${preview}${suffix}。请补全带 * 的字段。`, "warning");
                return;
            }
            setNotice(noticeText, "success");
        }

        function createTeamBuilderAgentDraft(role, index = 0, overrides = {}) {
            const defaultModel = modelOptions()[0]?.value || "";
            const isMain = role === "main";
            const base = isMain
                ? {
                    id: "",
                    name: "任务总管",
                    model: defaultModel,
                    workspace: "",
                    responsibilities: "只负责分配、监控、回收，不直接执行任务。",
                    capabilityTags: ["dispatch", "monitoring"],
                    fallbackExecution: false,
                    soulContent: ""
                }
                : {
                    id: "",
                    name: `子 Agent ${index + 1}`,
                    model: defaultModel,
                    workspace: "",
                    responsibilities: "负责执行主 Agent 分配的任务。",
                    capabilityTags: [],
                    fallbackExecution: false,
                    soulContent: ""
                };
            const next = { ...base, ...(overrides || {}) };
            next.capabilityTags = H.normalizeTagList(next.capabilityTags || []);
            next.fallbackExecution = next.fallbackExecution === true;
            next.soulContent = String(next.soulContent || "");
            return next;
        }

        function createFallbackTeamBuilderAgentDraft(overrides = {}) {
            const defaultModel = modelOptions()[0]?.value || "";
            const next = {
                id: "backstop",
                name: "兜底",
                model: defaultModel,
                workspace: "",
                responsibilities: "负责兜底执行未明确归属的任务，并把结果回传给主 Agent。",
                capabilityTags: ["generalist", "research"],
                fallbackExecution: true,
                soulContent: "",
                ...(overrides || {})
            };
            next.capabilityTags = H.normalizeTagList(next.capabilityTags || []);
            if (!next.capabilityTags.includes("generalist")) {
                next.capabilityTags = next.capabilityTags.concat("generalist");
            }
            next.fallbackExecution = true;
            next.soulContent = String(next.soulContent || "");
            return next;
        }

        function ensureTeamBuilderFallbackChild(builder) {
            if (!builder) return;
            if (builder.includeFallbackAgent) {
                builder.fallbackChild = createFallbackTeamBuilderAgentDraft(builder.fallbackChild || {});
                return;
            }
            builder.fallbackChild = null;
        }

        function getTeamBuilderChildAgents(builder) {
            const regularChildren = H.ensureArray(builder?.children);
            if (builder?.includeFallbackAgent && builder?.fallbackChild) {
                return regularChildren.concat(builder.fallbackChild);
            }
            return regularChildren.slice();
        }

        function createTeamBuilderDraft(templateId = "custom") {
            const defaultModel = modelOptions()[0]?.value || "";
            const preset = TEAM_TEMPLATE_PRESETS.find((item) => item.id === templateId) || TEAM_TEMPLATE_PRESETS[0];
            const built = preset.build(defaultModel);
            const builtChildren = H.ensureArray(built.children).map((agent, index) => createTeamBuilderAgentDraft("child", index, agent));
            const fallbackChild = builtChildren.find((agent) => agent.fallbackExecution) || null;
            const regularChildren = builtChildren.filter((agent) => agent !== fallbackChild);
            return {
                templateId: preset.id,
                teamName: built.teamName || "",
                dispatchMode: built.dispatchMode === "manual" ? "manual" : "auto",
                main: createTeamBuilderAgentDraft("main", 0, built.main),
                includeFallbackAgent: Boolean(fallbackChild),
                fallbackChild: fallbackChild ? createFallbackTeamBuilderAgentDraft(fallbackChild) : null,
                children: regularChildren
            };
        }

        function syncTeamBuilderChildren(builder, nextCount) {
            const maxRegularCount = builder?.includeFallbackAgent ? 7 : 8;
            const safeCount = Math.max(0, Math.min(maxRegularCount, Number(nextCount) || 0));
            while (builder.children.length < safeCount) {
                builder.children.push(createTeamBuilderAgentDraft("child", builder.children.length));
            }
            while (builder.children.length > safeCount) {
                builder.children.pop();
            }
            ensureTeamBuilderFallbackChild(builder);
            return safeCount;
        }

        function renderTeamBuilderAgentCard(agent, role, index, modelSelectHtml) {
            const isMain = role === "main";
            const isFallback = role === "fallback";
            const title = isMain ? "主 Agent" : (isFallback ? "兜底子 Agent" : `子 Agent ${index + 1}`);
            const desc = isMain
                ? "这个 Agent 只负责接单、派单、监控和回收结果，不直接执行任务。"
                : (isFallback
                    ? "这个 Agent 专门接住模糊任务、临时杂活和没有明确归属的派单。"
                    : "这个 Agent 负责执行主 Agent 分配过来的任务。");
            const cardActions = role === "child"
                ? `<button type="button" class="ocp-dialog-btn" data-builder-remove-child="${index}">删除这个子 Agent</button>`
                : `<span class="mab-team-builder-role-badge">${isFallback ? "兜底专用" : "团队主控"}</span>`;
            const capabilityValue = H.ensureArray(agent.capabilityTags).join(", ");
            const fallbackControl = isMain
                ? `<div class="mab-team-builder-inline-note">主 Agent 固定只负责调度，不参与具体执行。</div>`
                : (isFallback
                    ? `<div class="mab-team-builder-inline-note">这个 Agent 会被固定作为团队兜底目标，普通子 Agent 不再承担兜底职责。</div>`
                    : `<div class="mab-team-builder-inline-note">这是常规执行 Agent，不会被自动当作团队兜底。</div>`);
            return `
                <section class="mab-team-builder-card">
                    <div class="mab-team-builder-card-head">
                        <div>
                            <div class="mab-team-builder-card-title">${H.esc(title)}</div>
                            <div class="mab-team-builder-card-desc">${H.esc(desc)}</div>
                        </div>
                        <div class="mab-team-builder-card-actions">${cardActions}</div>
                    </div>
                    <div class="mab-team-builder-grid">
                        <label class="mab-team-builder-field">
                            <span>ID</span>
                            <input
                                class="ocp-dialog-input"
                                data-builder-agent-role="${H.esc(role)}"
                                data-builder-agent-index="${isMain ? "" : String(index)}"
                                data-builder-agent-field="id"
                                value="${H.esc(agent.id)}"
                                placeholder="${isMain ? "例如 manager_ops" : (isFallback ? "例如 daza" : `例如 worker_${index + 1}`)}">
                        </label>
                        <label class="mab-team-builder-field">
                            <span>名称</span>
                            <input
                                class="ocp-dialog-input"
                                data-builder-agent-role="${H.esc(role)}"
                                data-builder-agent-index="${isMain ? "" : String(index)}"
                                data-builder-agent-field="name"
                                value="${H.esc(agent.name)}"
                                placeholder="${isMain ? "例如 任务总管" : (isFallback ? "例如 打杂助手" : `例如 执行助手 ${index + 1}`)}">
                        </label>
                        <label class="mab-team-builder-field">
                            <span>模型</span>
                            <select
                                class="ocp-dialog-input ocp-dialog-select"
                                data-builder-agent-role="${H.esc(role)}"
                                data-builder-agent-index="${isMain ? "" : String(index)}"
                                data-builder-agent-field="model">
                                ${modelSelectHtml(agent.model)}
                            </select>
                        </label>
                        <label class="mab-team-builder-field">
                            <span>workspace</span>
                            <input
                                class="ocp-dialog-input"
                                data-builder-agent-role="${H.esc(role)}"
                                data-builder-agent-index="${isMain ? "" : String(index)}"
                                data-builder-agent-field="workspace"
                                value="${H.esc(agent.workspace)}"
                                placeholder="留空则自动创建">
                        </label>
                    </div>
                    <div class="mab-team-builder-grid">
                        <label class="mab-team-builder-field">
                            <span>角色说明</span>
                            <input
                                class="ocp-dialog-input"
                                data-builder-agent-role="${H.esc(role)}"
                                data-builder-agent-index="${isMain ? "" : String(index)}"
                                data-builder-agent-field="responsibilities"
                                value="${H.esc(agent.responsibilities)}"
                                placeholder="说明这个 Agent 主要负责什么">
                        </label>
                        <label class="mab-team-builder-field">
                            <span>能力标签</span>
                            <input
                                class="ocp-dialog-input"
                                data-builder-agent-role="${H.esc(role)}"
                                data-builder-agent-index="${isMain ? "" : String(index)}"
                                data-builder-agent-field="capabilityTags"
                                value="${H.esc(capabilityValue)}"
                                placeholder="例如：research, writing, image">
                        </label>
                    </div>
                    <div class="mab-team-builder-grid is-stacked">
                        <label class="mab-team-builder-field">
                            <span>SOUL.md 摘要</span>
                            <textarea
                                class="ocp-dialog-input ocp-dialog-textarea mab-team-builder-textarea"
                                data-builder-agent-role="${H.esc(role)}"
                                data-builder-agent-index="${isMain ? "" : String(index)}"
                                data-builder-agent-field="soulContent"
                                placeholder="可填写这个 Agent 的风格、角色和输出要求">${H.esc(agent.soulContent)}</textarea>
                        </label>
                        <div class="mab-team-builder-card-foot">${fallbackControl}</div>
                    </div>
                </section>
            `;
        }

        function openTeamBuilderDialog(options = {}) {
            if (typeof window.__openclawActiveFormDialogClose === "function") {
                try {
                    window.__openclawActiveFormDialogClose("replace");
                } catch (_) {}
            }

            const builder = createTeamBuilderDraft("custom");
            const existingTeamIds = new Set(teamOptions().map((team) => H.ensureString(team.mainAgentId || team.id)).filter(Boolean));
            const existingAgentIds = new Set(H.ensureArray(state.team.data?.agents).map((agent) => H.ensureString(agent.id)).filter(Boolean));
            const overlay = document.createElement("div");
            overlay.className = "ocp-dialog-overlay";
            const modelList = modelOptions();
            const renderModelOptions = (selectedValue = "") => {
                const optionsHtml = [`<option value="">留空则使用默认模型</option>`];
                modelList.forEach((option) => {
                    optionsHtml.push(`<option value="${H.esc(option.value)}" ${option.value === selectedValue ? "selected" : ""}>${H.esc(option.label)}</option>`);
                });
                return optionsHtml.join("");
            };
            const applyTemplatePreset = (templateId) => {
                const nextBuilder = createTeamBuilderDraft(templateId);
                builder.templateId = nextBuilder.templateId;
                builder.teamName = nextBuilder.teamName;
                builder.dispatchMode = nextBuilder.dispatchMode;
                builder.main = nextBuilder.main;
                builder.includeFallbackAgent = nextBuilder.includeFallbackAgent;
                builder.fallbackChild = nextBuilder.fallbackChild;
                builder.children = nextBuilder.children;
                builder.main.soulContent = builder.main.soulContent || buildMainAgentSoul(builder.teamName, builder.main, getTeamBuilderChildAgents(builder));
                builder.children = builder.children.map((agent) => ({
                    ...agent,
                    soulContent: String(agent.soulContent || buildChildAgentSoul(builder.teamName, builder.main, agent))
                }));
                if (builder.fallbackChild) {
                    builder.fallbackChild = {
                        ...builder.fallbackChild,
                        soulContent: String(builder.fallbackChild.soulContent || buildChildAgentSoul(builder.teamName, builder.main, builder.fallbackChild))
                    };
                }
            };
            applyTemplatePreset(builder.templateId);

            const getAgentRef = (role, indexValue) => {
                if (role === "main") return builder.main;
                if (role === "fallback") return builder.fallbackChild;
                if (role === "child") return builder.children[Number(indexValue)] || null;
                return null;
            };

            overlay.innerHTML = `
                <div class="ocp-dialog mab-team-builder-dialog" role="dialog" aria-modal="true" aria-label="一键创建团队">
                    <div class="ocp-dialog-title">一键创建团队</div>
                    <div class="ocp-dialog-lead">一次性完成团队名称、主 Agent、子 Agent 数量和每个 Agent 的基础配置。点“完成并创建团队”后会直接生成整支团队。</div>
                    <div class="mab-team-builder-form" data-role="team-builder-form"></div>
                    <div data-role="status" class="ocp-dialog-status"></div>
                    <div class="ocp-dialog-actions">
                        <button data-action="cancel" class="ocp-dialog-btn" type="button">取消</button>
                        <button data-action="confirm" class="ocp-dialog-btn primary" type="button">完成并创建团队</button>
                    </div>
                </div>
            `;

            const formEl = overlay.querySelector('[data-role="team-builder-form"]');
            const statusEl = overlay.querySelector('[data-role="status"]');
            const confirmBtn = overlay.querySelector('[data-action="confirm"]');
            let closed = false;

            const close = (reason = "cancel") => {
                if (closed) return;
                closed = true;
                if (window.__openclawActiveFormDialogClose === close) {
                    window.__openclawActiveFormDialogClose = null;
                }
                overlay.remove();
                if (typeof options.onClose === "function") {
                    try { options.onClose(reason); } catch (_) {}
                }
            };

            const setStatus = (text = "", color = "#ff8080") => {
                statusEl.textContent = text;
                statusEl.style.color = color;
            };

            const render = () => {
                const childCount = syncTeamBuilderChildren(builder, builder.children.length);
                const maxRegularCount = builder.includeFallbackAgent ? 7 : 8;
                formEl.innerHTML = `
                    <section class="mab-team-builder-section">
                        <div class="mab-team-builder-section-head">
                            <div>
                                <div class="mab-team-builder-section-title">团队基础信息</div>
                                <div class="mab-team-builder-section-desc">先确认团队模板、团队名称、主 Agent 的分配模式，以及是否额外创建兜底子 Agent。</div>
                            </div>
                        </div>
                        <div class="mab-team-builder-grid">
                            <label class="mab-team-builder-field">
                                <span>团队模板</span>
                                <select class="ocp-dialog-input ocp-dialog-select" data-builder-team-field="templateId">
                                    ${TEAM_TEMPLATE_PRESETS.map((preset) => `<option value="${H.esc(preset.id)}" ${builder.templateId === preset.id ? "selected" : ""}>${H.esc(preset.label)}</option>`).join("")}
                                </select>
                            </label>
                            <label class="mab-team-builder-field">
                                <span>团队名称</span>
                                <input class="ocp-dialog-input" data-builder-team-field="teamName" value="${H.esc(builder.teamName)}" placeholder="例如 某某管家">
                            </label>
                            <label class="mab-team-builder-field">
                                <span>任务分配模式</span>
                                <select class="ocp-dialog-input ocp-dialog-select" data-builder-team-field="dispatchMode">
                                    <option value="auto" ${builder.dispatchMode === "auto" ? "selected" : ""}>自动分配</option>
                                    <option value="manual" ${builder.dispatchMode === "manual" ? "selected" : ""}>人工确认后分配</option>
                                </select>
                            </label>
                        </div>
                        <label class="mab-team-builder-checkbox">
                            <input type="checkbox" data-builder-team-checkbox="includeFallbackAgent" ${builder.includeFallbackAgent ? "checked" : ""}>
                            <span>同时创建 1 个专用兜底子 Agent</span>
                        </label>
                        <div class="mab-team-builder-section-desc">${H.esc((TEAM_TEMPLATE_PRESETS.find((preset) => preset.id === builder.templateId) || TEAM_TEMPLATE_PRESETS[0]).description)}</div>
                    </section>

                    ${renderTeamBuilderAgentCard(builder.main, "main", 0, renderModelOptions)}

                    <section class="mab-team-builder-section">
                        <div class="mab-team-builder-section-head">
                            <div>
                                <div class="mab-team-builder-section-title">子 Agent 设置</div>
                                <div class="mab-team-builder-section-desc">先确认常规执行子 Agent 的数量，再分别填写职责和能力标签。兜底 Agent 会单独管理，不再从普通子 Agent 里隐式推断。</div>
                            </div>
                            <div class="mab-team-builder-count-bar">
                                <label class="mab-team-builder-field is-compact">
                                    <span>常规数量</span>
                                    <input class="ocp-dialog-input" data-builder-child-count type="number" min="0" max="${maxRegularCount}" value="${childCount}">
                                </label>
                                <button type="button" class="ocp-dialog-btn" data-builder-add-child>添加一个子 Agent</button>
                            </div>
                        </div>
                        <div class="mab-team-builder-children">
                            ${builder.children.length ? builder.children.map((child, index) => renderTeamBuilderAgentCard(child, "child", index, renderModelOptions)).join("") : `
                                <div class="mab-team-builder-empty">当前没有常规子 Agent。你可以只保留兜底 Agent，也可以继续补充明确分工的执行角色。</div>
                            `}
                            ${builder.includeFallbackAgent && builder.fallbackChild ? renderTeamBuilderAgentCard(builder.fallbackChild, "fallback", builder.children.length, renderModelOptions) : `
                                <div class="mab-team-builder-empty">当前没有专用兜底子 Agent。关闭时，团队创建流程不会自动指定任何兜底角色。</div>
                            `}
                        </div>
                    </section>
                `;
            };
            const validateBuilder = () => {
                const seenIds = new Set();
                const normalizedTeamName = H.ensureString(builder.teamName);
                const builderChildren = getTeamBuilderChildAgents(builder);
                if (!normalizedTeamName) {
                    throw new Error("请填写团队名称。");
                }
                if (!builderChildren.length) {
                    throw new Error("至少需要 1 个子 Agent。");
                }

                const allAgents = [{ ...builder.main, roleTitle: "主 Agent", isMain: true }].concat(
                    builder.children.map((agent, index) => ({ ...agent, roleTitle: `子 Agent ${index + 1}`, isMain: false })),
                    builder.includeFallbackAgent && builder.fallbackChild
                        ? [{ ...builder.fallbackChild, roleTitle: "兜底子 Agent", isMain: false }]
                        : []
                );

                allAgents.forEach((agent) => {
                    const id = H.ensureString(agent.id);
                    if (!id) {
                        throw new Error(`${agent.roleTitle} 的 ID 不能为空。`);
                    }
                    if (!/^[a-z0-9_-]+$/.test(id)) {
                        throw new Error(`${agent.roleTitle} 的 ID 格式不合法，只能使用小写字母、数字、_ 和 -。`);
                    }
                    if (existingAgentIds.has(id) || existingTeamIds.has(id)) {
                        throw new Error(`${agent.roleTitle} 的 ID「${id}」已存在，请换一个。`);
                    }
                    if (seenIds.has(id)) {
                        throw new Error(`团队内有重复的 Agent ID「${id}」，请修改后再创建。`);
                    }
                    seenIds.add(id);
                });

                return {
                    teamName: normalizedTeamName,
                    templateId: H.ensureString(builder.templateId || "custom") || "custom",
                    dispatchMode: builder.dispatchMode === "manual" ? "manual" : "auto",
                    main: {
                        ...builder.main,
                        id: H.ensureString(builder.main.id),
                        name: H.ensureString(builder.main.name) || H.ensureString(builder.main.id),
                        model: H.ensureString(builder.main.model),
                        workspace: H.ensureString(builder.main.workspace),
                        responsibilities: H.ensureString(builder.main.responsibilities),
                        capabilityTags: H.normalizeTagList(builder.main.capabilityTags || []),
                        soulContent: String(builder.main.soulContent || buildMainAgentSoul(normalizedTeamName, builder.main, builderChildren))
                    },
                    children: builderChildren.map((agent) => ({
                        ...agent,
                        id: H.ensureString(agent.id),
                        name: H.ensureString(agent.name) || H.ensureString(agent.id),
                        model: H.ensureString(agent.model),
                        workspace: H.ensureString(agent.workspace),
                        responsibilities: H.ensureString(agent.responsibilities),
                        capabilityTags: H.normalizeTagList(agent.capabilityTags || []),
                        fallbackExecution: agent.fallbackExecution === true,
                        soulContent: String(agent.soulContent || buildChildAgentSoul(normalizedTeamName, builder.main, agent))
                    }))
                };
            };

            const createTeamFromBuilder = async () => {
                const payload = validateBuilder();
                const createdAgentIds = [];
                const allAgents = [payload.main].concat(payload.children);

                try {
                    for (const agent of allAgents) {
                        const createResult = await window.api.createAgent({
                            id: agent.id,
                            name: agent.name,
                            model: agent.model,
                            workspace: agent.workspace
                        });
                        if (!createResult?.ok) {
                            throw new Error(createResult?.error || `创建 Agent「${agent.id}」失败`);
                        }
                        createdAgentIds.push(agent.id);
                    }

                    const saveResult = await window.api.saveAgentTeamBuilderData({
                        mainAgentId: payload.main.id,
                        team: {
                            name: payload.teamName,
                            mainAgentId: payload.main.id,
                            childAgentIds: payload.children.map((agent) => agent.id),
                            dispatchMode: payload.dispatchMode,
                            templateId: payload.templateId,
                            fallbackAgentId: payload.children.find((agent) => agent.fallbackExecution)?.id || "",
                            strictDispatchOnly: true
                        },
                        agents: allAgents.map((agent) => ({
                            id: agent.id,
                            name: agent.name,
                            model: agent.model,
                            workspace: agent.workspace,
                            responsibilities: agent.responsibilities,
                            capabilityTags: H.normalizeTagList(agent.capabilityTags || []),
                            fallbackExecution: agent.fallbackExecution === true,
                            soulContent: agent.soulContent,
                            roleTitle: agent.id === payload.main.id ? "主 Agent" : "子 Agent",
                            bindings: []
                        }))
                    });
                    if (!saveResult?.ok) {
                        throw new Error(saveResult?.error || "创建团队失败");
                    }

                    state.team.mainAgentId = payload.main.id;
                    state.team.data = saveResult;
                    state.team.teams = H.ensureArray(saveResult.teams);
                    state.team.draft = H.buildDraft(saveResult);
                    state.team.selectedAgentId = payload.main.id;
                    state.team.needsReload = false;
                    setNotice("团队已创建。", "success");
                    close("confirm");
                } catch (error) {
                    for (const agentId of createdAgentIds.reverse()) {
                        try {
                            await window.api.deleteAgent(agentId);
                        } catch (_) {}
                    }
                    throw error;
                }
            };

            formEl.addEventListener("input", (event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;

                if (target.hasAttribute("data-builder-team-field")) {
                    if (target.getAttribute("data-builder-team-field") === "templateId") return;
                    builder[target.getAttribute("data-builder-team-field")] = target.value;
                    return;
                }

                if (target.hasAttribute("data-builder-agent-field")) {
                    const agent = getAgentRef(target.getAttribute("data-builder-agent-role"), target.getAttribute("data-builder-agent-index"));
                    if (!agent) return;
                    const field = target.getAttribute("data-builder-agent-field");
                    agent[field] = field === "capabilityTags" ? H.normalizeTagList(target.value) : target.value;
                    return;
                }

                if (target.hasAttribute("data-builder-child-count")) {
                    syncTeamBuilderChildren(builder, target.value);
                    render();
                }
            });

            formEl.addEventListener("change", (event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;

                if (target.hasAttribute("data-builder-team-field")) {
                    const field = target.getAttribute("data-builder-team-field");
                    if (field === "templateId") {
                        applyTemplatePreset(target.value);
                        render();
                        return;
                    }
                    builder[field] = target.value;
                    return;
                }

                if (target.hasAttribute("data-builder-team-checkbox")) {
                    if (target.getAttribute("data-builder-team-checkbox") === "includeFallbackAgent") {
                        builder.includeFallbackAgent = target.checked;
                        ensureTeamBuilderFallbackChild(builder);
                        render();
                    }
                    return;
                }

                if (target.hasAttribute("data-builder-agent-field")) {
                    const agent = getAgentRef(target.getAttribute("data-builder-agent-role"), target.getAttribute("data-builder-agent-index"));
                    if (!agent) return;
                    const field = target.getAttribute("data-builder-agent-field");
                    agent[field] = field === "capabilityTags" ? H.normalizeTagList(target.value) : target.value;
                    return;
                }
            });

            formEl.addEventListener("click", (event) => {
                const actionEl = event.target.closest("[data-builder-add-child],[data-builder-remove-child]");
                if (!actionEl) return;
                if (actionEl.hasAttribute("data-builder-add-child")) {
                    syncTeamBuilderChildren(builder, builder.children.length + 1);
                    render();
                    return;
                }
                const removeIndex = Number(actionEl.getAttribute("data-builder-remove-child"));
                if (!Number.isInteger(removeIndex) || removeIndex < 0) return;
                if (builder.children.length <= 1) {
                    setStatus("至少保留 1 个子 Agent。", "#ff8080");
                    return;
                }
                builder.children.splice(removeIndex, 1);
                syncTeamBuilderChildren(builder, builder.children.length);
                render();
            });

            overlay.addEventListener("click", (event) => {
                if (event.target === overlay) close("cancel");
            });
            overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close("cancel"));
            confirmBtn.addEventListener("click", async () => {
                confirmBtn.disabled = true;
                setStatus("正在创建团队...", "#8f98ab");
                try {
                    await createTeamFromBuilder();
                } catch (error) {
                    setStatus(error?.message || String(error), "#ff8080");
                }
                if (!closed) {
                    confirmBtn.disabled = false;
                    if (statusEl.textContent === "正在创建团队...") {
                        setStatus("", "#8f98ab");
                    }
                }
            });

            window.__openclawActiveFormDialogClose = close;
            document.body.appendChild(overlay);
            render();
            overlay.querySelector('[data-builder-team-field="teamName"]')?.focus();
        }

        async function openCreateTeamDialog() {
            openTeamBuilderDialog();
        }

        async function openCreateChildDialog() {
            const options = modelOptions();
            window.showFormDialog({
                title: "添加子 Agent",
                description: "添加后会直接加入当前团队。",
                confirmText: "创建并加入团队",
                fields: [
                    { name: "id", label: "Agent ID", value: "", placeholder: "例如 writer" },
                    { name: "name", label: "名称", value: "", placeholder: "例如 写作助手" },
                    options.length
                        ? { name: "model", label: "模型", type: "select", value: options[0].value, options }
                        : { name: "model", label: "模型", value: "", placeholder: "留空则使用默认模型" },
                    { name: "workspace", label: "workspace", value: "", placeholder: "留空则自动创建" },
                    {
                        name: "fallbackExecution",
                        label: "设为兜底执行 Agent",
                        type: "checkbox",
                        value: false,
                        description: "创建后会自动成为当前团队的兜底 Agent，用来接住模糊任务和未明确归属的派单。"
                    }
                ],
                onConfirm: async (values, dialog) => {
                    const asFallback = values.fallbackExecution === true;
                    const id = H.ensureString(values.id) || (asFallback ? "backstop" : "");
                    if (!id) return dialog.setStatus("请填写 Agent ID。");
                    if (!/^[a-z0-9_-]+$/.test(id)) return dialog.setStatus("Agent ID 格式不合法。");
                    const name = H.ensureString(values.name) || (asFallback ? "兜底" : id);
                    dialog.setStatus("正在创建...", "#8f98ab");
                    const result = await window.api.createAgent({
                        id,
                        name,
                        model: H.ensureString(values.model),
                        workspace: H.ensureString(values.workspace)
                    });
                    if (!result?.ok) throw new Error(result?.error || "创建 Agent 失败");
                    await loadTeamData();
                    if (!state.team.draft.team.childAgentIds.includes(id)) {
                        state.team.draft.team.childAgentIds.push(id);
                    }
                    const createdAgent = H.getAgentDraft(state.team.draft, id);
                    if (createdAgent) {
                        createdAgent.name = name;
                        createdAgent.model = H.ensureString(values.model);
                        createdAgent.workspace = H.ensureString(values.workspace);
                        if (asFallback) {
                            childAgents().forEach((entry) => {
                                if (entry.id !== id) entry.fallbackExecution = false;
                            });
                            createdAgent.fallbackExecution = true;
                            if (!H.ensureString(createdAgent.responsibilities)) {
                                createdAgent.responsibilities = "负责兜底执行未明确归属的任务。";
                            }
                            if (!H.ensureArray(createdAgent.capabilityTags).includes("generalist")) {
                                createdAgent.capabilityTags = H.ensureArray(createdAgent.capabilityTags).concat("generalist");
                            }
                        }
                    }
                    state.team.selectedAgentId = id;
                    markDirty();
                    await persistDraft(asFallback ? "兜底子 Agent 已创建并加入团队。" : "子 Agent 已加入团队。");
                    dialog.close();
                }
            });
        }

        async function openAvatarPickerDialog(agentId) {
            const safeAgentId = H.ensureString(agentId);
            const agent = H.getAgentDraft(state.team.draft, safeAgentId);
            if (!agent) throw new Error("当前 Agent 不存在。");

            const presets = await ensureAvatarPresets();
            if (!presets.length) throw new Error("当前没有可用的头像预置。");

            if (typeof window.__openclawActiveFormDialogClose === "function") {
                try {
                    window.__openclawActiveFormDialogClose("replace");
                } catch (_) {}
            }

            const overlay = document.createElement("div");
            overlay.className = "ocp-dialog-overlay";
            overlay.innerHTML = `
                <div class="ocp-dialog mab-avatar-dialog" role="dialog" aria-modal="true" aria-label="选择头像">
                    <div class="ocp-dialog-title">选择头像</div>
                    <div class="ocp-dialog-lead">为 ${H.esc(agent.name || agent.id)} 选择一个内置像素头像。素材已内置到应用中，选择后会立即保存并同步更新团队页。</div>
                    <div class="mab-avatar-dialog-grid" data-role="avatar-grid"></div>
                    <div class="mab-avatar-dialog-meta">
                        <span>素材授权：CC0</span>
                        <a href="https://opengameart.org/content/32-x-32-portraits" target="_blank" rel="noreferrer">查看来源</a>
                    </div>
                    <div class="ocp-dialog-status" data-role="status"></div>
                    <div class="ocp-dialog-actions">
                        <button data-action="cancel" class="ocp-dialog-btn" type="button">取消</button>
                    </div>
                </div>
            `;

            const gridEl = overlay.querySelector('[data-role="avatar-grid"]');
            const statusEl = overlay.querySelector('[data-role="status"]');
            let closed = false;
            let saving = false;

            const setStatus = (text = "", tone = "") => {
                if (!statusEl) return;
                statusEl.textContent = H.ensureString(text);
                statusEl.className = `ocp-dialog-status${tone ? ` is-${tone}` : ""}`;
            };

            const close = (reason = "cancel") => {
                if (closed) return;
                closed = true;
                if (window.__openclawActiveFormDialogClose === close) {
                    window.__openclawActiveFormDialogClose = null;
                }
                document.removeEventListener("keydown", handleKeydown);
                overlay.remove();
            };

            const render = () => {
                const currentPresetId = H.ensureString(H.getAgentDraft(state.team.draft, safeAgentId)?.avatar?.presetId);
                gridEl.innerHTML = presets.map((preset) => `
                    <button
                        class="mab-avatar-preset ${preset.id === currentPresetId ? "is-active" : ""}"
                        type="button"
                        data-avatar-preset-id="${H.esc(preset.id)}"
                        title="${H.esc(preset.label)}">
                        <span class="mab-avatar-preset-preview">
                            <img src="${H.esc(toFileUrl(preset.src || ""))}" alt="${H.esc(preset.label)}">
                        </span>
                        <span class="mab-avatar-preset-label">${H.esc(preset.label)}</span>
                    </button>
                `).join("");

                gridEl.querySelectorAll("[data-avatar-preset-id]").forEach((button) => {
                    button.addEventListener("click", async () => {
                        if (saving) return;
                        const presetId = button.getAttribute("data-avatar-preset-id") || "";
                        const preset = presets.find((entry) => entry.id === presetId);
                        if (!preset?.dataUrl) {
                            setStatus("头像资源读取失败，请重试。", "danger");
                            return;
                        }
                        saving = true;
                        setStatus("正在保存头像...", "info");
                        try {
                            const result = await window.api.setAgentAvatar({
                                mainAgentId: state.team.draft?.mainAgentId,
                                targetAgentId: safeAgentId,
                                dataUrl: preset.dataUrl,
                                presetId: preset.id,
                                label: preset.label,
                                sourceUrl: preset.sourceUrl,
                                license: preset.license
                            });
                            if (!result?.ok || !result.avatar) {
                                throw new Error(result?.error || "保存头像失败");
                            }
                            applyAvatarToState(safeAgentId, result.avatar);
                            renderTeamView();
                            close("confirm");
                        } catch (error) {
                            setStatus(error.message || String(error), "danger");
                        } finally {
                            saving = false;
                        }
                    });
                });
            };

            const handleKeydown = (event) => {
                if (event.key === "Escape") close("escape");
            };

            overlay.addEventListener("click", (event) => {
                if (event.target === overlay) close("backdrop");
            });
            overlay.querySelector('[data-action="cancel"]')?.addEventListener("click", () => close("cancel"));

            window.__openclawActiveFormDialogClose = close;
            document.body.appendChild(overlay);
            document.addEventListener("keydown", handleKeydown);
            render();
        }

        async function deleteChildAgent(agentId) {
            const ok = await window.showConfirmDialog(`确定要删除子 Agent「${agentId}」吗？\n\n这会同时删除 Agent 目录、配置记录和聊天绑定。`, {
                title: "删除子 Agent",
                confirmText: "确认删除",
                cancelText: "取消"
            });
            if (!ok) return;
            const result = await window.api.deleteAgent(agentId);
            if (!result?.ok) throw new Error(result?.error || "删除 Agent 失败");
            await loadTeamData({ noticeText: "子 Agent 已删除。" });
        }

        async function deleteCurrentTeam() {
            const teamName = H.ensureString(state.team.draft?.team?.name || state.team.mainAgentId || "当前团队");
            const mainAgentId = H.ensureString(state.team.draft?.mainAgentId || state.team.mainAgentId);
            if (!mainAgentId || mainAgentId === "main") {
                throw new Error("默认团队不支持解散删除。");
            }
            const ok = await window.showConfirmDialog(`确定要解散并删除团队「${teamName}」吗？\n\n这会删除该团队的主 Agent 和全部子 Agent，并且无法恢复。`, {
                title: "解散并删除团队",
                confirmText: "确认删除团队",
                cancelText: "取消"
            });
            if (!ok) return;
            const result = await window.api.deleteAgentTeam({ mainAgentId });
            if (!result?.ok) throw new Error(result?.error || "删除团队失败");
            const next = result.next;
            if (!next?.ok) throw new Error("删除团队后刷新团队列表失败。");
            state.team.mainAgentId = next.mainAgentId || "main";
            state.team.data = next;
            state.team.teams = H.ensureArray(next.teams);
            state.team.draft = H.buildDraft(next);
            state.team.selectedAgentId = state.team.draft?.mainAgentId || "main";
            state.team.needsReload = false;
            setNotice("团队已解散并删除。", "success");
        }

        function renderShell() {
            container.innerHTML = `
                <div class="mab-hub-shell">
                    <div class="mab-view-switch">
                        <div class="mab-view-switcher" role="tablist" aria-label="Agent 视图切换">
                            <button class="mab-view-tab" data-hub-mode="single" type="button" role="tab" aria-selected="true">Agent 管理</button>
                            <button class="mab-view-tab" data-hub-mode="team" type="button" role="tab" aria-selected="false">Agent 团队管理</button>
                        </div>
                        <div class="mab-view-switch-meta">默认打开单 Agent 管理，切换后在当前页面直接进入团队配置。</div>
                    </div>
                    <div class="mab-hub-body"></div>
                </div>
            `;
            state.host = container.querySelector(".mab-hub-body");
            state.switchButtons = Array.from(container.querySelectorAll("[data-hub-mode]"));
            state.switchButtons.forEach((button) => {
                button.addEventListener("click", () => {
                    const nextMode = button.getAttribute("data-hub-mode");
                    if (!nextMode || nextMode === state.mode) return;
                    if (state.mode === "team" && !state.team.draft?.dirty) {
                        state.team.needsReload = true;
                    }
                    state.mode = nextMode;
                    updateModeSwitch();
                    mountCurrentMode();
                });
            });
            updateModeSwitch();
        }

        function updateModeSwitch() {
            state.switchButtons.forEach((button) => {
                const active = button.getAttribute("data-hub-mode") === state.mode;
                button.classList.toggle("is-active", active);
                button.setAttribute("aria-selected", String(active));
            });
        }

        function cleanupCurrentMode() {
            closeAgentStatusScreen();
            if (typeof state.host?.__openclawCleanupAgentHubMode === "function") {
                try { state.host.__openclawCleanupAgentHubMode(); } catch (_) {}
            }
            if (state.host) {
                delete state.host.__openclawCleanupAgentHubMode;
                state.host.innerHTML = "";
            }
        }

        async function mountSingleManager() {
            const renderer = options.renderSingleAgentManager;
            if (typeof renderer !== "function") {
                state.host.innerHTML = `
                    <section class="mab-panel">
                        <div class="mab-empty-title">原始 Agent 管理页不可用</div>
                        <div class="mab-empty-desc">没有传入 renderSingleAgentManager，暂时无法显示原管理页。</div>
                    </section>
                `;
                return;
            }
            state.host.__openclawCleanupAgentHubMode = () => {};
            await renderer(state.host);
        }

        async function mountTeamManager() {
            state.host.__openclawCleanupAgentHubMode = () => {
                state.team.disposeFns.forEach((dispose) => {
                    try { dispose(); } catch (_) {}
                });
                state.team.disposeFns = [];
                clearLiveSyncDisposers();
            };

            if (!state.team.draft || state.team.needsReload) {
                state.host.innerHTML = `
                    <div class="mab-shell">
                        <section class="mab-panel">
                            <div class="mab-empty-title">正在加载团队配置</div>
                            <div class="mab-empty-desc">正在读取 Agent、模型和聊天绑定配置。</div>
                        </section>
                    </div>
                `;
                await loadTeamData();
                startTeamLiveSync();
                return;
            }

            renderTeamView();
            startTeamLiveSync();
        }

        async function mountCurrentMode() {
            cleanupCurrentMode();
            try {
                if (state.mode === "team") {
                    await mountTeamManager();
                    return;
                }
                await mountSingleManager();
            } catch (error) {
                state.host.innerHTML = `
                    <div class="mab-shell">
                        <section class="mab-panel">
                            <div class="mab-empty-title">${state.mode === "team" ? "团队配置页面加载失败" : "Agent 管理页面加载失败"}</div>
                            <div class="mab-empty-desc">${H.esc(error?.message || String(error))}</div>
                        </section>
                    </div>
                `;
            }
        }

        async function init() {
            container.__openclawCleanupAgentHub = () => {
                closeAgentStatusScreen();
                cleanupCurrentMode();
                state.team.disposeFns.forEach((dispose) => {
                    try { dispose(); } catch (_) {}
                });
                state.team.disposeFns = [];
                clearLiveSyncDisposers();
            };
            if (window.api?.onAgentWorkflowEvent) {
                window.api.onAgentWorkflowEvent((event) => {
                    try {
                        handleWorkflowEvent(event);
                    } catch (_) {}
                });
            }
            renderShell();
            await mountCurrentMode();
        }

        return init();
    }

    window.OpenClawAgentHub = { renderAgentHubPage };
})();
