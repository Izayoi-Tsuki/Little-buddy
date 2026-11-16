# Little Buddy

Little Buddy is a project focusing on file-dealing and angents working together.
It is a more convenient entrance for people to expose their files to agents and get the results faster.
It is equipped with multi agents creation module so that people could create agents very fast and group them, giving them their own identities.
And it can be vibe coded by user to get more functions since the code is highly modulized.

住在桌面上的像素便利贴桌宠。把文件拖给它，它会在便利贴上和你聊这个文件；几只桌宠还能组成小队、互相派活、彼此对话，卡住时回头找你拿主意。

基于 Electron，模型后端可选 DeepSeek 或 Qoder Agent SDK。桌宠只拿得到受限的附件工具：原文件不删、不改、不移动，所有产出都是副本。

## 功能

- **多只桌宠**：托盘「新建桌宠…」，每只有自己的名字和角色设定，最多 8 只。`Ctrl+Alt+F` 一键显隐全部。
- **拖入文件**：把文件拖到桌宠身上，便利贴自动打开，可以直接用自然语言下指令。也可以用固定动作：查看信息、复制到收纳箱、按类型归档、重命名另存、打开所在文件夹。
- **便利贴聊天**：多轮对话、流式回复、可随时停止。写文件前逐次弹窗确认。
- **组队与军衔**：把一只桌宠拖到另一只身上即可组队，可选择谁带队。臂章颜色区分小队，杠数表示身份：带队三道杠，成员一道杠，没有带队者时每只两道杠。
- **派活与小队文件夹**：带队者可以把任务（连同附件）派给空闲的队员，队员做完把结果交回。每支小队在收纳箱里有一个共享文件夹。
- **斜杠召唤**：在便利贴输入 `/名字 想说的话`，让同队的另一只桌宠过来和它聊。
- **求助门控**：两只桌宠聊到 4 句、内容开始重复、或者互相反问时，会自动停下来向你求助。发起者的便利贴上会出现「需要你」卡片，你可以直接回答，也可以让它们再聊几句。

## 环境要求

- Windows（主要在 Windows 上开发和测试）
- Node.js 22.12 或更高版本

## 安装

```powershell
git clone https://github.com/Izayoi-Tsuki/Little-buddy.git
cd Little-buddy
npm install
```

如果 npm 提示 `@qoder-ai/qoder-agent-sdk` 的安装脚本没有放行，先执行 `npm approve-scripts @qoder-ai/qoder-agent-sdk`，再重新 `npm install`。

如果 Electron 运行时下载失败，可以执行下面的命令重新下载。它会校验 SHA-256，并把运行时缓存在项目内的 `.electron-cache`：

```powershell
npm run desktop:install
```

## 配置模型

启动时按环境变量选择后端，密钥只从环境变量读取，不会写进任何文件：

| 后端 | 环境变量 | 说明 |
| --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` | 只要设置了这个变量，就优先使用 DeepSeek |
| Qoder Agent SDK | `QODER_PERSONAL_ACCESS_TOKEN` | 未设置 DeepSeek 时使用。个人访问令牌在 qoder.com 账户的 Integrations 页面生成 |

两个都没配置也能启动，但发消息时只会提示认证未就绪。

只在当前 PowerShell 窗口里临时生效：

```powershell
$env:DEEPSEEK_API_KEY = "你的密钥"
npm start
```

想长期生效，就在「系统属性 → 环境变量」里新建用户变量。保存后要**新开一个终端**再启动，旧终端读不到新变量。

## 使用

```powershell
npm start
```

- 单击桌宠：打开便利贴聊天。
- 右键桌宠或托盘图标：编辑名字和角色、重置位置、管理小队、删除桌宠、打开收纳箱、退出。
- 产出的副本默认保存在「文档\纸间收纳箱」，小队文件夹在收纳箱的「小队」目录下。
- 桌宠名册和位置保存在 `%APPDATA%\Papertrail File Buddy`。

## 测试

```powershell
npm test       # 单元测试
npm run check  # Electron 离线自检：使用项目内的 .buddy-test-data，不调用真实模型，也不碰你的收纳箱
```

## 目录结构

```text
desktop/   Electron 主进程：桌宠管理、模型会话（DeepSeek / Qoder SDK）、文件动作、小队、安全策略、自检
src/       渲染层：像素桌宠绘制、便利贴、编辑器、组队卡片、对话气泡，以及共享的纯函数
tests/     node:test 单元测试
*.html / *.css   各窗口的页面
```
