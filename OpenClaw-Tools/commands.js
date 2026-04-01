window.commandsDB = [
  {
    "id": "cmd-1",
    "name": "openclaw --version",
    "desc": "查看当前安装版本",
    "code": "openclaw --version",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-2",
    "name": "openclaw --help",
    "desc": "显示所有可用命令列表",
    "code": "openclaw --help",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-3",
    "name": "openclaw tui",
    "desc": "启动终端交互界面",
    "code": "openclaw tui",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-4",
    "name": "openclaw dashboard",
    "desc": "打开网页管理控制台",
    "code": "openclaw dashboard",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-5",
    "name": "openclaw restart",
    "desc": "重启 OpenClaw 服务",
    "code": "openclaw restart",
    "tags": [
      "通用"
    ],
    "isFavorite": true
  },
  {
    "id": "cmd-6",
    "name": "openclaw stop",
    "desc": "停止运行中的服务",
    "code": "openclaw stop",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-7",
    "name": "openclaw update",
    "desc": "一键更新到最新版本",
    "code": "openclaw update",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-8",
    "name": "openclaw onboard",
    "desc": "启动交互式配置向导",
    "code": "openclaw onboard",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-9",
    "name": "openclaw onboard --install-daemon",
    "desc": "配置向导 + 安装为系统服务",
    "code": "openclaw onboard --install-daemon",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-10",
    "name": "openclaw configure",
    "desc": "重新进入配置向导",
    "code": "openclaw configure",
    "tags": [
      "配置"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-11",
    "name": "openclaw doctor",
    "desc": "全面健康检查",
    "code": "openclaw doctor",
    "tags": [
      "通用"
    ],
    "isFavorite": true
  },
  {
    "id": "cmd-12",
    "name": "openclaw doctor --fix",
    "desc": "健康检查 + 自动修复",
    "code": "openclaw doctor --fix",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-13",
    "name": "openclaw status",
    "desc": "查看运行状态（网关在线状态、端口占用）",
    "code": "openclaw status",
    "tags": [
      "通用"
    ],
    "isFavorite": true
  },
  {
    "id": "cmd-14",
    "name": "openclaw status --deep",
    "desc": "深度状态检测（含网关健康探测）",
    "code": "openclaw status --deep",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-15",
    "name": "openclaw logs",
    "desc": "查看最近运行日志",
    "code": "openclaw logs",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-16",
    "name": "openclaw models list",
    "desc": "列出所有已配置的模型",
    "code": "openclaw models list",
    "tags": [
      "模型"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-17",
    "name": "openclaw models set <提供商/模型名>",
    "desc": "切换默认模型",
    "code": "openclaw models set <提供商/模型名>",
    "tags": [
      "模型"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-18",
    "name": "openclaw models auth login --provider <提供商>",
    "desc": "OAuth 方式登录模型商",
    "code": "openclaw models auth login --provider <提供商>",
    "tags": [
      "模型"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-19",
    "name": "openclaw models auth paste-token --provider <提供商>",
    "desc": "粘贴 API Token 认证",
    "code": "openclaw models auth paste-token --provider <提供商>",
    "tags": [
      "模型"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-20",
    "name": "openclaw gateway",
    "desc": "启动网关服务",
    "code": "openclaw gateway",
    "tags": [
      "网关"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-21",
    "name": "openclaw gateway --port 18789",
    "desc": "指定端口启动",
    "code": "openclaw gateway --port 18789",
    "tags": [
      "网关"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-22",
    "name": "openclaw gateway --verbose",
    "desc": "启动并显示详细日志",
    "code": "openclaw gateway --verbose",
    "tags": [
      "网关"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-23",
    "name": "openclaw gateway restart",
    "desc": "重启网关",
    "code": "openclaw gateway restart",
    "tags": [
      "网关"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-24",
    "name": "openclaw gateway --token <你的token>",
    "desc": "带认证 Token 启动",
    "code": "openclaw gateway --token <你的token>",
    "tags": [
      "网关"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-25",
    "name": "openclaw channels status",
    "desc": "查看所有通道实时状态",
    "code": "openclaw channels status",
    "tags": [
      "通道"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-26",
    "name": "openclaw channels list",
    "desc": "列出已配置的所有通道",
    "code": "openclaw channels list",
    "tags": [
      "通道"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-27",
    "name": "openclaw channels add",
    "desc": "交互式添加新通道",
    "code": "openclaw channels add",
    "tags": [
      "通道"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-28",
    "name": "openclaw channels add --channel telegram --token <BOT_TOKEN>",
    "desc": "非交互式添加 Telegram",
    "code": "openclaw channels add --channel telegram --token <BOT_TOKEN>",
    "tags": [
      "通道"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-29",
    "name": "openclaw channels add --channel feishu",
    "desc": "添加飞书通道",
    "code": "openclaw channels add --channel feishu",
    "tags": [
      "通道"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-30",
    "name": "openclaw channels remove --channel <名称>",
    "desc": "移除指定通道",
    "code": "openclaw channels remove --channel <名称>",
    "tags": [
      "通道"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-31",
    "name": "openclaw channels logs",
    "desc": "查看通道日志",
    "code": "openclaw channels logs",
    "tags": [
      "通道"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-32",
    "name": "openclaw channels login",
    "desc": "登录通道（如 WhatsApp Web 扫码）",
    "code": "openclaw channels login",
    "tags": [
      "通道"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-33",
    "name": "openclaw channels logout",
    "desc": "登出通道",
    "code": "openclaw channels logout",
    "tags": [
      "通道"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-34",
    "name": "openclaw plugins list",
    "desc": "查看所有可用插件",
    "code": "openclaw plugins list",
    "tags": [
      "扩展"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-35",
    "name": "openclaw plugins enable <插件名>",
    "desc": "启用指定插件",
    "code": "openclaw plugins enable <插件名>",
    "tags": [
      "扩展"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-36",
    "name": "openclaw plugins disable <插件名>",
    "desc": "禁用指定插件",
    "code": "openclaw plugins disable <插件名>",
    "tags": [
      "扩展"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-37",
    "name": "openclaw plugins install <插件名>",
    "desc": "从仓库安装新插件",
    "code": "openclaw plugins install <插件名>",
    "tags": [
      "扩展"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-38",
    "name": "openclaw plugins doctor",
    "desc": "检查插件加载错误",
    "code": "openclaw plugins doctor",
    "tags": [
      "扩展"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-39",
    "name": "openclaw skills list",
    "desc": "列出已安装的所有技能",
    "code": "openclaw skills list",
    "tags": [
      "扩展"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-40",
    "name": "openclaw skills install <技能名>",
    "desc": "安装新技能",
    "code": "openclaw skills install <技能名>",
    "tags": [
      "扩展"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-41",
    "name": "openclaw message send --to <号码> --message \"内容\"",
    "desc": "主动发送消息",
    "code": "openclaw message send --to <号码> --message \"内容\"",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-42",
    "name": "openclaw agent --message \"任务内容\"",
    "desc": "直接向 Agent 派发任务",
    "code": "openclaw agent --message \"任务内容\"",
    "tags": [
      "Agent"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-43",
    "name": "openclaw agent --message \"任务\" --thinking high",
    "desc": "高思考深度模式",
    "code": "openclaw agent --message \"任务\" --thinking high",
    "tags": [
      "Agent"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-44",
    "name": "openclaw pairing approve <通道> <配对码>",
    "desc": "批准设备配对",
    "code": "openclaw pairing approve <通道> <配对码>",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-45",
    "name": "openclaw sandbox explain",
    "desc": "查看当前沙箱配置状态",
    "code": "openclaw sandbox explain",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-46",
    "name": "openclaw sandbox explain --json",
    "desc": "JSON 格式输出（供脚本解析）",
    "code": "openclaw sandbox explain --json",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-47",
    "name": "openclaw sandbox list",
    "desc": "列出所有沙箱容器",
    "code": "openclaw sandbox list",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-48",
    "name": "openclaw sandbox list --browser",
    "desc": "仅查看浏览器相关容器",
    "code": "openclaw sandbox list --browser",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-49",
    "name": "openclaw sandbox recreate --all",
    "desc": "重建所有容器（解决环境问题）",
    "code": "openclaw sandbox recreate --all",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-50",
    "name": "openclaw sandbox recreate --all --force",
    "desc": "强制重建（跳过确认提示）",
    "code": "openclaw sandbox recreate --all --force",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-51",
    "name": "openclaw browser open <URL>",
    "desc": "打开指定网页",
    "code": "openclaw browser open <URL>",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-52",
    "name": "openclaw browser snapshot",
    "desc": "获取当前页面 DOM 快照",
    "code": "openclaw browser snapshot",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-53",
    "name": "openclaw browser click <元素>",
    "desc": "点击页面元素",
    "code": "openclaw browser click <元素>",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-54",
    "name": "openclaw browser type <元素> <文字>",
    "desc": "在输入框输入文字",
    "code": "openclaw browser type <元素> <文字>",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-55",
    "name": "openclaw browser screenshot",
    "desc": "截取页面截图",
    "code": "openclaw browser screenshot",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-56",
    "name": "openclaw browser close",
    "desc": "关闭浏览器实例",
    "code": "openclaw browser close",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-57",
    "name": "openclaw browser console",
    "desc": "查看浏览器控制台日志",
    "code": "openclaw browser console",
    "tags": [
      "通用"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-58",
    "name": "openclaw config",
    "desc": "查看当前配置（只读）",
    "code": "openclaw config",
    "tags": [
      "配置"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-59",
    "name": "openclaw config edit",
    "desc": "编辑配置文件（自动打开编辑器）",
    "code": "openclaw config edit",
    "tags": [
      "配置"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-60",
    "name": "openclaw update --channel stable",
    "desc": "明确指定稳定版通道",
    "code": "openclaw update --channel stable",
    "tags": [
      "通道"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-61",
    "name": "openclaw update --channel beta",
    "desc": "切换到测试版（体验新功能）",
    "code": "openclaw update --channel beta",
    "tags": [
      "通道"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-62",
    "name": "/new",
    "desc": "开始全新会话（清除上下文，节省 Token）",
    "code": "/new",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": true
  },
  {
    "id": "cmd-63",
    "name": "/new 任务描述",
    "desc": "新建会话并直接带上任务",
    "code": "/new 任务描述",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-64",
    "name": "/compact",
    "desc": "压缩上下文（保留要点，大幅减少 Token 消耗）",
    "code": "/compact",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-65",
    "name": "/status",
    "desc": "查看当前会话状态（Token 用量、模型信息）",
    "code": "/status",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-66",
    "name": "/help 或 /commands",
    "desc": "显示所有可用斜杠命令",
    "code": "/help 或 /commands",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-67",
    "name": "/model",
    "desc": "查看当前正在使用的模型",
    "code": "/model",
    "tags": [
      "模型",
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-68",
    "name": "/model <模型名>",
    "desc": "实时切换到指定模型",
    "code": "/model <模型名>",
    "tags": [
      "模型",
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-69",
    "name": "/sessions list",
    "desc": "列出所有历史会话",
    "code": "/sessions list",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-70",
    "name": "/sessions history",
    "desc": "查看当前会话的详细历史",
    "code": "/sessions history",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-71",
    "name": "/sessions send <会话ID> <消息>",
    "desc": "向指定会话发送消息（跨会话通信）",
    "code": "/sessions send <会话ID> <消息>",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-72",
    "name": "/sessions spawn <任务>",
    "desc": "创建子会话执行独立任务",
    "code": "/sessions spawn <任务>",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-73",
    "name": "/approve",
    "desc": "批准待确认的操作",
    "code": "/approve",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-74",
    "name": "/deny",
    "desc": "拒绝待确认的操作",
    "code": "/deny",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-75",
    "name": "/cancel",
    "desc": "取消当前执行中的任务",
    "code": "/cancel",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-76",
    "name": "/undo",
    "desc": "撤销上一步操作",
    "code": "/undo",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-77",
    "name": "/skills",
    "desc": "查看当前已加载的所有技能",
    "code": "/skills",
    "tags": [
      "扩展",
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-78",
    "name": "/memory",
    "desc": "查看 AI 的记忆内容（长期记忆）",
    "code": "/memory",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-79",
    "name": "/forget <内容>",
    "desc": "删除指定的记忆条目",
    "code": "/forget <内容>",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-80",
    "name": "/cost",
    "desc": "查看本次会话的 Token 消耗和费用估算",
    "code": "/cost",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-81",
    "name": "/version",
    "desc": "查看当前 OpenClaw 版本",
    "code": "/version",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  },
  {
    "id": "cmd-82",
    "name": "/ping",
    "desc": "测试与网关的连接是否正常",
    "code": "/ping",
    "tags": [
      "聊天命令"
    ],
    "isFavorite": false
  }
];