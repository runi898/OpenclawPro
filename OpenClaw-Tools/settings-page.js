(function () {
    async function renderSettingsPageModule(container) {
        container.innerHTML = `
            <div style="padding:24px 28px;display:flex;flex-direction:column;gap:18px;min-height:100%;box-sizing:border-box">
                <div id="stHealthCard" style="padding:10px 12px;border-radius:18px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:8px">
                    <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">
                        <div>
                            <div style="color:#eef2f8;font-weight:700;font-size:18px">配置健康</div>
                            <div id="stHealthStatus" style="margin-top:4px;font-size:13px;color:#8f98ab">未检测</div>
                        </div>
                        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;align-items:flex-start;min-width:520px;flex:1">
                            <div style="display:flex;gap:10px;flex-wrap:wrap;padding:6px 8px;border-radius:14px;background:rgba(255,255,255,0.03)">
                                <button id="stHealthCheckBtn" style="padding:8px 14px;background:rgba(120,220,232,0.14);border:1px solid rgba(120,220,232,0.28);border-radius:10px;color:#78dce8;cursor:pointer">配置体检</button>
                                <button id="stRestoreBtn" style="padding:8px 14px;background:rgba(169,220,118,0.16);border:1px solid rgba(169,220,118,0.32);border-radius:10px;color:#a9dc76;cursor:pointer">恢复最近可用版本</button>
                            </div>
                            <div style="display:flex;gap:10px;flex-wrap:wrap;padding:6px 8px;border-radius:14px;background:rgba(255,255,255,0.03)">
                                <button id="stReloadBtn" style="padding:8px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#d7dce5;cursor:pointer">重新加载</button>
                                <button id="stFormatBtn" style="padding:8px 14px;background:rgba(120,220,232,0.14);border:1px solid rgba(120,220,232,0.28);border-radius:10px;color:#78dce8;cursor:pointer">格式化 JSON</button>
                                <button id="stSaveBtn" style="padding:8px 16px;background:#a9dc76;border:none;border-radius:10px;color:#102014;font-weight:700;cursor:pointer">保存配置</button>
                            </div>
                        </div>
                    </div>
                    <div id="stHealthMeta" style="font-size:12px;color:#8f98ab;line-height:1.6"></div>
                    <div id="stHealthDetail" style="font-size:12px;color:#d7dce5;line-height:1.6;white-space:pre-wrap"></div>
                </div>
                <div id="stSummaryGrid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px"></div>
                <div style="padding:16px;border-radius:18px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06)">
                    <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
                        <div style="color:#eef2f8;font-weight:700">openclaw.json</div>
                        <span id="stStatus" style="font-size:12px;color:#8f98ab"></span>
                    </div>
                    <textarea id="stConfigTextarea" spellcheck="false" style="width:100%;min-height:460px;background:#141823;border:1px solid rgba(255,255,255,0.08);border-radius:14px;color:#dbe4ee;font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.7;padding:14px;resize:vertical;box-sizing:border-box"></textarea>
                </div>
            </div>
        `;

        const grid = container.querySelector('#stSummaryGrid');
        const textarea = container.querySelector('#stConfigTextarea');
        const status = container.querySelector('#stStatus');
        const healthStatus = container.querySelector('#stHealthStatus');
        const healthMeta = container.querySelector('#stHealthMeta');
        const healthDetail = container.querySelector('#stHealthDetail');
        const healthCheckBtn = container.querySelector('#stHealthCheckBtn');
        const healthRestoreBtn = container.querySelector('#stRestoreBtn');
        const settingsRoot = container.firstElementChild;
        const settingsHealthCard = container.querySelector('#stHealthCard');
        const settingsHealthTop = settingsHealthCard?.firstElementChild;
        const settingsHealthCopy = settingsHealthTop?.firstElementChild;
        const settingsActionHost = settingsHealthTop?.lastElementChild;
        const settingsSaveBtn = container.querySelector('#stSaveBtn');
        const settingsReloadBtn = container.querySelector('#stReloadBtn');
        const settingsFormatBtn = container.querySelector('#stFormatBtn');

        settingsRoot?.setAttribute('class', 'settings-shell');
        settingsRoot?.removeAttribute('style');
        settingsHealthCard?.setAttribute('class', 'settings-health-card');
        settingsHealthCard?.removeAttribute('style');
        settingsHealthTop?.setAttribute('class', 'settings-health-top');
        settingsHealthTop?.removeAttribute('style');

        if (settingsHealthCopy) {
            settingsHealthCopy.className = 'settings-health-copy';
            const settingsHealthTitle = settingsHealthCopy.firstElementChild;
            if (!settingsHealthCopy.querySelector('.settings-health-eyebrow')) {
                const eyebrow = document.createElement('div');
                eyebrow.className = 'settings-health-eyebrow';
                eyebrow.textContent = 'Config Health';
                settingsHealthCopy.prepend(eyebrow);
            }
            if (settingsHealthTitle) {
                settingsHealthTitle.className = 'settings-health-title';
                settingsHealthTitle.textContent = '配置健康';
                settingsHealthTitle.removeAttribute('style');
            }
        }

        if (settingsActionHost) {
            settingsActionHost.className = 'settings-actions';
            settingsActionHost.removeAttribute('style');
            settingsActionHost.innerHTML = `
                <div class="settings-actions-primary"></div>
                <div class="settings-actions-secondary"></div>
                <div class="settings-actions-danger"></div>
            `;
            settingsActionHost.querySelector('.settings-actions-primary')?.append(settingsSaveBtn);
            settingsActionHost.querySelector('.settings-actions-secondary')?.append(healthCheckBtn, settingsReloadBtn, settingsFormatBtn);
            settingsActionHost.querySelector('.settings-actions-danger')?.append(healthRestoreBtn);
        }

        if (settingsSaveBtn) {
            settingsSaveBtn.className = 'settings-btn settings-btn-primary';
            settingsSaveBtn.textContent = '保存配置';
            settingsSaveBtn.removeAttribute('style');
        }
        if (healthCheckBtn) {
            healthCheckBtn.className = 'settings-btn settings-btn-info';
            healthCheckBtn.textContent = '配置体检';
            healthCheckBtn.removeAttribute('style');
        }
        if (settingsReloadBtn) {
            settingsReloadBtn.className = 'settings-btn';
            settingsReloadBtn.textContent = '重新加载';
            settingsReloadBtn.removeAttribute('style');
        }
        if (settingsFormatBtn) {
            settingsFormatBtn.className = 'settings-btn';
            settingsFormatBtn.textContent = '格式化 JSON';
            settingsFormatBtn.removeAttribute('style');
        }
        if (healthRestoreBtn) {
            healthRestoreBtn.className = 'settings-btn settings-btn-danger';
            healthRestoreBtn.textContent = '恢复最近可用版本';
            healthRestoreBtn.removeAttribute('style');
        }
        if (healthStatus) {
            healthStatus.className = 'settings-health-status';
            healthStatus.textContent = '未检测';
            healthStatus.removeAttribute('style');
        }

        healthMeta?.setAttribute('class', 'settings-health-meta');
        healthMeta?.removeAttribute('style');
        healthDetail?.setAttribute('class', 'settings-health-detail');
        healthDetail?.removeAttribute('style');
        grid?.setAttribute('class', 'settings-summary-grid');
        grid?.removeAttribute('style');

        const settingsEditorCard = textarea?.parentElement;
        settingsEditorCard?.setAttribute('class', 'settings-editor-card');
        settingsEditorCard?.removeAttribute('style');

        const settingsEditorHead = status?.parentElement;
        settingsEditorHead?.setAttribute('class', 'settings-editor-head');
        settingsEditorHead?.removeAttribute('style');
        settingsEditorHead?.firstElementChild?.setAttribute('class', 'settings-editor-title');
        settingsEditorHead?.firstElementChild?.removeAttribute('style');
        status?.setAttribute('class', 'settings-editor-status');
        status?.removeAttribute('style');
        textarea?.setAttribute('class', 'settings-editor-textarea');
        textarea?.removeAttribute('style');

        function setHealthButtonsBusy(kind = '') {
            const checking = kind === 'check';
            const restoring = kind === 'restore';
            if (healthCheckBtn) {
                healthCheckBtn.disabled = Boolean(kind);
                healthCheckBtn.style.opacity = kind && !checking ? '0.6' : '1';
                healthCheckBtn.style.cursor = kind ? 'not-allowed' : 'pointer';
                healthCheckBtn.textContent = checking ? '体检中...' : '配置体检';
            }
            if (healthRestoreBtn) {
                healthRestoreBtn.disabled = Boolean(kind);
                healthRestoreBtn.style.opacity = kind && !restoring ? '0.6' : '1';
                healthRestoreBtn.style.cursor = kind ? 'not-allowed' : 'pointer';
                healthRestoreBtn.textContent = restoring ? '恢复中...' : '恢复最近可用版本';
            }
        }

        function setHealthProgress(statusText, metaText = '', detailText = '') {
            healthStatus.dataset.state = 'progress';
            healthStatus.textContent = statusText;
            healthStatus.style.color = '#78dce8';
            healthMeta.textContent = metaText;
            healthDetail.textContent = detailText;
        }

        function formatTimeStamp(value) {
            if (!value) return '无';
            try {
                return new Date(value).toLocaleString('zh-CN', { hour12: false });
            } catch (_) {
                return String(value);
            }
        }

        function renderHealthResult(result, sourceLabel = '当前编辑器内容') {
            const health = result?.health || {};
            const ok = Boolean(result?.ok);
            healthStatus.dataset.state = ok ? 'ok' : 'error';
            healthStatus.textContent = ok ? '配置体检通过' : '配置体检发现问题';
            healthStatus.style.color = ok ? '#a9dc76' : '#ff6188';

            const metaParts = [
                `来源: ${sourceLabel}`,
                `最后检测: ${formatTimeStamp(health.lastValidatedAt)}`,
                `最近启动: ${health.lastBootStatus || 'unknown'}`
            ];
            if (health.pendingAt) {
                metaParts.push(`待确认: ${formatTimeStamp(health.pendingAt)}`);
            }
            if (health.lastKnownGoodSnapshotPath) {
                metaParts.push(`最近可用快照: ${health.lastKnownGoodSnapshotPath}`);
            }
            healthMeta.textContent = metaParts.join(' | ');

            const errors = Array.isArray(result?.errors) ? result.errors.filter(Boolean) : [];
            const warnings = Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : [];
            const detailParts = [];
            if (errors.length) {
                detailParts.push(`错误:\n- ${errors.slice(0, 5).join('\n- ')}`);
            }
            if (warnings.length) {
                detailParts.push(`警告:\n- ${warnings.slice(0, 5).join('\n- ')}`);
            }
            if (!detailParts.length) {
                detailParts.push(ok ? '当前配置已通过校验。' : '当前配置存在问题，请先修复。');
            }
            healthDetail.textContent = detailParts.join('\n\n');
        }

        async function refreshHealthFromEditor(options = {}) {
            const quiet = options?.quiet === true;
            if (!textarea) return;

            let parsed = null;
            try {
                parsed = JSON.parse(textarea.value || '{}');
            } catch (error) {
                healthStatus.dataset.state = 'error';
                healthStatus.textContent = '配置体检发现问题';
                healthStatus.style.color = '#ff6188';
                healthMeta.textContent = '来源: 当前编辑器内容';
                healthDetail.textContent = `JSON 解析失败: ${error?.message || String(error)}`;
                return;
            }

            if (!quiet) {
                setHealthProgress('正在进行配置体检...', '正在调用校验接口...', '会检查 JSON 结构、主模型、Gateway 和常见渠道字段。');
            }

            try {
                const result = await window.api.validateOpenClawConfig({ config: parsed });
                renderHealthResult(result || {}, '当前编辑器内容');
            } catch (error) {
                healthStatus.dataset.state = 'error';
                healthStatus.textContent = '配置体检失败';
                healthStatus.style.color = '#ff6188';
                healthMeta.textContent = '验证接口调用失败';
                healthDetail.textContent = error?.message || String(error);
            }
        }

        function renderSummary(cfg) {
            const providers = cfg?.models?.providers || {};
            const cards = [
                ['模型服务商', String(Object.keys(providers).length)],
                ['模型总数', String(Object.values(providers).reduce((count, item) => count + (item?.models?.length || 0), 0))],
                ['Agent 配置数', String(Array.isArray(cfg?.agents?.list) ? cfg.agents.list.length : 0)],
                ['绑定规则', String(Array.isArray(cfg?.bindings) ? cfg.bindings.length : 0)],
                ['Gateway 端口', String(cfg?.gateway?.port || 18789)],
                ['默认模型', String(cfg?.agents?.defaults?.model?.primary || '未配置')]
            ];

            grid.innerHTML = cards.map(([label, value]) => `
                <div class="settings-summary-card">
                    <div class="settings-summary-label">${escapeHtml(label)}</div>
                    <div class="settings-summary-value">${escapeHtml(value)}</div>
                </div>
            `).join('');
        }

        async function reload() {
            status.style.color = '#8f98ab';
            status.textContent = '正在读取本地配置...';
            try {
                const cfg = await window.api.getOpenClawConfig() || {};
                textarea.value = JSON.stringify(cfg, null, 2);
                renderSummary(cfg);
                status.textContent = '已加载最新本地配置';
                void refreshHealthFromEditor({ quiet: true });
            } catch (error) {
                status.style.color = '#ff6188';
                status.textContent = error?.message || String(error);
            }
        }

        container.querySelector('#stReloadBtn').onclick = () => reload();
        container.querySelector('#stFormatBtn').onclick = async () => {
            try {
                const cfg = JSON.parse(textarea.value || '{}');
                textarea.value = JSON.stringify(cfg, null, 2);
                renderSummary(cfg);
                status.style.color = '#78dce8';
                status.textContent = 'JSON 已格式化';
                void refreshHealthFromEditor({ quiet: true });
            } catch (error) {
                status.style.color = '#ff6188';
                status.textContent = `JSON 格式错误: ${error?.message || String(error)}`;
            }
        };

        container.querySelector('#stSaveBtn').onclick = async () => {
            let cfg = null;
            try {
                cfg = JSON.parse(textarea.value || '{}');
            } catch (error) {
                status.style.color = '#ff6188';
                status.textContent = `保存失败，JSON 解析错误: ${error?.message || String(error)}`;
                return;
            }

            status.style.color = '#8f98ab';
            status.textContent = '正在写回本地配置...';

            try {
                const result = await window.api.writeOpenClawConfig(cfg);
                if (result && result.ok === false) throw new Error(result.error || '保存失败');
                textarea.value = JSON.stringify(cfg, null, 2);
                renderSummary(cfg);
                status.style.color = '#a9dc76';
                status.textContent = '配置已保存';
                void refreshHealthFromEditor({ quiet: true });
            } catch (error) {
                status.style.color = '#ff6188';
                status.textContent = error?.message || String(error);
            }
        };

        if (healthCheckBtn) {
            healthCheckBtn.onclick = async () => {
                setHealthButtonsBusy('check');
                setHealthProgress('正在进行配置体检...', '正在调用校验接口...', '会检查 JSON 结构、主模型、Gateway 和常见渠道字段。');
                try {
                    await refreshHealthFromEditor();
                } finally {
                    setHealthButtonsBusy('');
                }
            };
        }

        if (healthRestoreBtn) {
            healthRestoreBtn.onclick = async () => {
                const confirmed = await showConfirmDialog('确定要恢复最近可用版本吗？\n\n这会覆盖当前 openclaw.json。', {
                    confirmText: '恢复',
                    confirmTone: 'danger'
                });
                if (!confirmed) return;

                setHealthButtonsBusy('restore');
                setHealthProgress('正在恢复最近可用版本...', '正在写回最近一次可用快照...', '如果不存在最近可用快照，会在这里显示错误原因。');
                status.style.color = '#8f98ab';
                status.textContent = '正在恢复最近可用版本...';

                try {
                    const result = await window.api.restoreLastKnownGoodConfig();
                    if (!result || result.ok === false) {
                        throw new Error(result?.error || '恢复失败');
                    }
                    await reload();
                    status.style.color = '#a9dc76';
                    status.textContent = '已恢复最近可用版本';
                    healthStatus.dataset.state = 'ok';
                    healthStatus.textContent = '已恢复最近可用版本';
                    healthStatus.style.color = '#a9dc76';
                    healthMeta.textContent = result?.sourcePath ? ('恢复来源: ' + result.sourcePath) : '恢复来源: 最近可用配置快照';
                    healthDetail.textContent = result?.hash ? ('恢复完成。\n当前快照哈希: ' + result.hash) : '恢复完成。';
                } catch (error) {
                    status.style.color = '#ff6188';
                    status.textContent = error?.message || String(error);
                    healthStatus.dataset.state = 'error';
                    healthStatus.textContent = '恢复失败';
                    healthStatus.style.color = '#ff6188';
                    healthMeta.textContent = '最近可用版本恢复未完成';
                    healthDetail.textContent = error?.message || String(error);
                } finally {
                    setHealthButtonsBusy('');
                }
            };
        }

        container.dataset.settingsMounted = '1';
        container.__openclawResumeSettingsPage = () => {
            void reload();
        };
        await reload();
    }

    window.renderSettingsPageModule = renderSettingsPageModule;
})();
