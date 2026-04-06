const { contextBridge, ipcRenderer } = require('electron');

// 暴露给前端的安全 API (挂载在 window.api 下)
contextBridge.exposeInMainWorld('api', {
    // 触发后端执行命令
    executeCommand: (id, command, timeout, interactive = false, commandOptions = {}) => ipcRenderer.send('execute-command', { id, command, timeout, interactive, commandOptions }),

    // 向正在运行的命令写入交互输入
    sendCommandInput: (id, input, appendNewline = false) => ipcRenderer.send('command-input', { id, input, appendNewline }),

    // 触发首页的生命周期动作
    executeDashboardAction: (payload) => ipcRenderer.send('execute-dashboard-action', payload),
    startDashboardLogFollow: (payload) => ipcRenderer.send('dashboard-log-follow-start', payload),
    stopDashboardLogFollow: () => ipcRenderer.send('dashboard-log-follow-stop'),
    getDashboardGatewayStatus: (payload) => ipcRenderer.invoke('get-dashboard-gateway-status', payload),
    getDashboardActionDefinitions: (payload) => ipcRenderer.invoke('get-dashboard-action-definitions', payload),
    checkAutoStartStatus: (payload) => ipcRenderer.invoke('check-auto-start-status', payload),
    checkPm2RuntimeInstalled: () => ipcRenderer.invoke('check-pm2-runtime-installed'),
    ensurePm2RuntimeInstalled: () => ipcRenderer.invoke('ensure-pm2-runtime-installed'),
    checkPm2ServiceInstalled: () => ipcRenderer.invoke('check-pm2-service-installed'),
    ensurePm2ServiceInstalled: () => ipcRenderer.invoke('ensure-pm2-service-installed'),
    getChannelEnvironmentStatus: (payload) => ipcRenderer.invoke('get-channel-environment-status', payload),
    getChannelInstallSources: (payload) => ipcRenderer.invoke('get-channel-install-sources', payload),
    installChannelEnvironment: (payload) => ipcRenderer.invoke('install-channel-environment', payload),
    checkWeixinPluginStatus: (payload) => ipcRenderer.invoke('check-weixin-plugin-status', payload),
    generateQrCodeDataUrl: (payload) => ipcRenderer.invoke('generate-qr-code-data-url', payload),
    verifyChannelCredentials: (payload) => ipcRenderer.invoke('verify-channel-credentials', payload),
    verifyBotToken: (payload) => ipcRenderer.invoke('verify-bot-token', payload),
    
    // 终止正在运行的命令
    killCommand: (id) => ipcRenderer.send('kill-command', { id }),

    // 监听：命令执行开始（防内存泄漏：注册前先清除旧监听器）
    onCommandStarted: (callback) => {
        ipcRenderer.removeAllListeners('command-started');
        ipcRenderer.on('command-started', (event, data) => callback(data));
    },
    
    // 监听：流式日志返回
    onCommandStream: (callback) => {
        ipcRenderer.removeAllListeners('command-stream');
        ipcRenderer.on('command-stream', (event, data) => callback(data));
    },
    
    // 监听：命令执行结束
    onCommandFinished: (callback) => {
        ipcRenderer.removeAllListeners('command-finished');
        ipcRenderer.on('command-finished', (event, data) => callback(data));
    },
    onDashboardLogStream: (callback) => {
        ipcRenderer.removeAllListeners('dashboard-log-stream');
        ipcRenderer.on('dashboard-log-stream', (event, data) => callback(data));
    },
    onDashboardLogState: (callback) => {
        ipcRenderer.removeAllListeners('dashboard-log-state');
        ipcRenderer.on('dashboard-log-state', (event, data) => callback(data));
    },
    onChannelInstallStream: (callback) => {
        ipcRenderer.removeAllListeners('channel-install-stream');
        ipcRenderer.on('channel-install-stream', (event, data) => callback(data));
    },

    // 获取 token
    getChatBootstrap: () => ipcRenderer.invoke('get-chat-bootstrap'),
    getOpenClawToken: () => ipcRenderer.invoke('get-openclaw-token'),

    // 获取完整配置（只读）
    getOpenClawConfig: () => ipcRenderer.invoke('get-openclaw-config'),
    validateOpenClawConfig: (payload) => ipcRenderer.invoke('validate-openclaw-config', payload),
    restoreLastKnownGoodConfig: () => ipcRenderer.invoke('restore-last-known-good-config'),

    // 写入完整配置（用于模型管理、Gateway 配置等页面保存）
    writeOpenClawConfig: (config) => ipcRenderer.invoke('write-openclaw-config', config),
    getRuntimeModelCatalog: (payload) => ipcRenderer.invoke('get-runtime-model-catalog', payload),
    listRemoteModels: (payload) => ipcRenderer.invoke('list-remote-models', payload),
    testProviderModel: (payload) => ipcRenderer.invoke('test-provider-model', payload),
    removeInvalidModels: (payload) => ipcRenderer.invoke('remove-invalid-models', payload),
    listMemoryFiles: (payload) => ipcRenderer.invoke('list-memory-files', payload),
    readMemoryFile: (payload) => ipcRenderer.invoke('read-memory-file', payload),
    writeMemoryFile: (payload) => ipcRenderer.invoke('write-memory-file', payload),
    deleteMemoryFile: (payload) => ipcRenderer.invoke('delete-memory-file', payload),
    exportMemoryZip: (payload) => ipcRenderer.invoke('export-memory-zip', payload),
    listCronJobs: (payload) => ipcRenderer.invoke('list-cron-jobs', payload),
    getCronStatus: (payload) => ipcRenderer.invoke('get-cron-status', payload),
    createCronJob: (payload) => ipcRenderer.invoke('create-cron-job', payload),
    updateCronJob: (payload) => ipcRenderer.invoke('update-cron-job', payload),
    toggleCronJob: (payload) => ipcRenderer.invoke('toggle-cron-job', payload),
    removeCronJob: (payload) => ipcRenderer.invoke('remove-cron-job', payload),
    runCronJob: (payload) => ipcRenderer.invoke('run-cron-job', payload),
    listPairingRequests: (payload) => ipcRenderer.invoke('list-pairing-requests', payload),
    approvePairingRequest: (payload) => ipcRenderer.invoke('approve-pairing-request', payload),
    getUsageReport: (payload) => ipcRenderer.invoke('get-usage-report', payload),

    // 获取应用路径
    getAppPath: () => ipcRenderer.invoke('get-app-path'),

    // === 新增：Agent 相关 ===
    listAgents: () => ipcRenderer.invoke('list-agents'),
    readAgentFile: (agentName, fileName) => ipcRenderer.invoke('read-agent-file', agentName, fileName),
    writeAgentFile: (agentName, fileName, content) => ipcRenderer.invoke('write-agent-file', agentName, fileName, content),
    createAgent: (name) => ipcRenderer.invoke('create-agent', name),
    deleteAgent: (name) => ipcRenderer.invoke('delete-agent', name),
    renameAgent: (oldName, newName) => ipcRenderer.invoke('rename-agent', { oldName, newName }),
    getAgentTeamBuilderData: (payload) => ipcRenderer.invoke('get-agent-team-builder-data', payload),
    saveAgentTeamBuilderData: (payload) => ipcRenderer.invoke('save-agent-team-builder-data', payload),
    importAgentTeamConfig: (payload) => ipcRenderer.invoke('import-agent-team-config', payload),
    exportAgentTeamConfig: (payload) => ipcRenderer.invoke('export-agent-team-config', payload),
    deleteAgentTeam: (payload) => ipcRenderer.invoke('delete-agent-team', payload),
    getAgentCollaboration: (payload) => ipcRenderer.invoke('get-agent-collaboration', payload),
    saveAgentCollaboration: (payload) => ipcRenderer.invoke('save-agent-collaboration', payload),
    startAgentWorkflow: (payload) => ipcRenderer.invoke('start-agent-workflow', payload),
    submitAgentTeamMessage: (payload) => ipcRenderer.invoke('submit-agent-team-message', payload),
    applyAgentDispatchPlan: (payload) => ipcRenderer.invoke('apply-agent-dispatch-plan', payload),
    startAgentCollection: (payload) => ipcRenderer.invoke('start-agent-collection', payload),
    updateAgentWorkItem: (payload) => ipcRenderer.invoke('update-agent-work-item', payload),
    listAgentWorkRuns: (payload) => ipcRenderer.invoke('list-agent-work-runs', payload),
    listAgentAvatarPresets: () => ipcRenderer.invoke('list-agent-avatar-presets'),
    setAgentAvatar: (payload) => ipcRenderer.invoke('set-agent-avatar', payload),
    readAgentAvatar: (payload) => ipcRenderer.invoke('read-agent-avatar', payload),
    onAgentWorkflowEvent: (callback) => {
        ipcRenderer.removeAllListeners('agent-workflow-event');
        ipcRenderer.on('agent-workflow-event', (_, data) => callback(data));
    },

    // === 新增：日志相关 ===
    listLogFiles: (agentName) => ipcRenderer.invoke('list-log-files', agentName),
    readLogFile: (logFilePath, linesCount) => ipcRenderer.invoke('read-log-file', logFilePath, linesCount),
    readServiceLog: (logKey, linesCount) => ipcRenderer.invoke('read-service-log', logKey, linesCount),
    readGatewayLog: (linesCount) => ipcRenderer.invoke('read-gateway-log', linesCount),
    readGatewayLogDetails: (linesCount) => ipcRenderer.invoke('read-gateway-log-details', linesCount),
    getActiveGatewayLogSource: (linesCount) => ipcRenderer.invoke('get-active-gateway-log-source', linesCount),
});
