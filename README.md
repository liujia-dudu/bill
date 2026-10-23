# 秒开票

用于学习 Agent 的本地单用户 Demo：在聊天里保存开票资料、发二维码开票，填写截图在对话中确认后才提交。由 DeepSeek Harness 驱动。

## 启动

需要 Node.js 24+、Python 3.10+：

```powershell
npm install
python -m pip install -r requirements.txt
npm run browser:install
npm run build
npm start
```

打开 http://127.0.0.1:3180 ，开发运行用 `npm run dev`。

- 模型与云浏览器配置写在本项目 `.env`，变量见 [.env.example](.env.example)。仓库不附带账号配置；Key 不进入前端，API Key CSV 不进版本控制。
- 数据目录默认在项目根 `data/`，可用 `INVOICE_AGENT_DATA_DIR` 覆盖；端口用 `INVOICE_AGENT_PORT` 设置。
- Windows 下 `tools/patch-harness-windows.mjs` 会在安装和启动前给 Harness SDK 打幂等补丁，避免弹出额外命令行窗口。

## 在聊天中使用

- “看看我保存了哪些开票资料。”
- “记住我的个人抬头是张三，收票邮箱是……，以后默认使用。”
- “把这家公司的收票邮箱改成……。”企业资料可只存公司全名和邮箱，税号在开票页面查询核对后自动补入。
- 上传二维码图片：“这张帮我开发票。”
- “这次用个人。”——只对本次生效，不改长期默认。个人发票会询问一次姓名或姓氏作抬头；不愿提供时用“个人”，页面不要求填名称就留空。
- “忘掉这个抬头”“进度怎么样”“取消这张票”。

填写完成后截图发回对话，5 分钟内回复：

- **确认提交**：程序在同一页面提交一次。页面有“我已阅读并同意《…协议》”时，截图前会代为勾选（不提交），勾选状态见截图。
- **指出问题**：整页重填并重新截图；只说“不对”会先追问是哪一项。
- **放弃**：直接关闭页面。

超时后页面关闭，回复“重来”重新填写。同一入口链接只允许一次真实提交。

可建立多个对话：资料和偏好跨对话共享；附件、临时选择、任务和审核各自独立。删除对话会停止其任务并清理消息、附件和任务结果，共享资料保留。

附件支持 PNG/JPEG（≤10 MB）和 TXT/MD/CSV（≤200 KB），不解析 PDF、Word。

## 设计文档

- [对话架构](docs/CONVERSATIONAL_AGENT_DESIGN.md)：对话、记忆、任务与审核。
- [填写记录架构](docs/DYNAMIC_RULES.md)：同一页面按用户回复自动学习填写步骤（可信回放 / 提示参考 / 修正作废）及 light 不兼容记忆。

## 目录

```text
src/
  web/                 聊天界面与消息卡片
  server/              对话 API、附件、事件推送、配置和启动
  core/                对话服务、附件与二维码解码、任务执行与审核
  agent/               Harness 运行时、主对话能力定义、浏览器填写工具
  rules/               填写记录的读写、校验、回放和步骤导出
  browser/             浏览器连接、页面观察、提交拦截与确认后提交
  storage/             SQLite 存储与迁移
tests/                 自动化测试与合成样本
tools/                 二维码、配置检查、清理等工具
data/
  invoice.sqlite       资料、对话、消息、记忆、任务
  uploads/             附件原件
  artifacts/<taskId>/  截图、字段回读、浏览器轨迹、提交证据
  harness/             Harness 会话与调用记录
  rules/<域名>/        自动学习的填写记录（按路径，已脱敏，随仓库上传）
```

`data/` 是本机普通文件，备份前先停止服务；其中只有 `data/rules/` 进入版本控制。只读接口 `/api/profiles`、`/api/tasks` 仅用于本机诊断，产品写操作都通过对话完成。

`tools/cleanup.mjs` 在 `npm test`、`npm start`、`npm run dev` 前自动运行（`npm run cleanup -- --dry-run` 只列出不删除）：

- `test-results/`：同类保留最近 3 份，超过 7 天删除。
- `diagnostics/`：数据库备份保留最近 3 份，其他超过 7 天删除。
- `data/logs/`：超过 7 天删除。
- 不清理 `data/invoice.sqlite`、`data/samples/`、`data/lexmount-observations/`、`.env`。

## 验证

```powershell
npm test
npm run test:e2e
python -m unittest discover -s tests -p test_decode_qr.py -v
```

普通测试不调用真实模型；依赖本机 `data/samples/` 的回归在样本缺失时跳过。真实模型检查（不提交真实发票）：

```powershell
npm run test:chat      # 资料、续聊、跨对话共享、记忆与遗忘
npm run test:harness   # 合成表单上的企业查询、税号回读与截图审核
node tests/chat-tax-live.mjs
node tests/chat-qr-live.mjs
```

## 当前限制

合成测试和早期只读观察不能当作真实商家已通过：

- 真实商家页面尚未验证过真实提交；能否识别真实平台的成功页面、“页面无结果视为已提交”是否准确，待首单验证。
- 真实填写（未提交）已在两家开票平台跑通：客如云（invoice.keruyun.com，会跳转到 cube-inv.jcsk100.com）和 pos.mzdpgroup.com。均为企业票、最终使用 normal；个人票尚未在真实页面验证。
- light 在这两家平台上都不兼容，已真实触发“light 失败转 normal”并记住（light 145.0.0.0），后续直接用 normal；light 版本变化后的重试仅在合成页面验证。
- 填写记录零模型回放已在上述两家真实页面验证（2026-10-23，未提交）：客如云由模型 9 次、约 68 秒降到 0 次、约 15 秒；pos.mzdpgroup.com 由约 128 秒降到约 9 秒。“提示”参考对模型调用次数帮助有限，修正作废只在合成页面验证。
- 回放要求页面结构逐步一致，页面改版或出现新字段会退回模型分析，首次及改版后的速度仍取决于模型。
- 仅限微信内打开的入口（如部分餐饮商家）在两种浏览器下都无法办理，会直接说明。
- 跨站验证码、人工远程接管未实现；遇到验证码、候选有歧义或税号冲突时停止并说明。
- 页面税号查询加格式检查不等于工商权威认证。
- 浏览器任务串行执行，最多排队 20 个；本地单用户版本，无多账号与公网服务。

## 提交与隐私

只上传源码、设计文档、依赖锁文件和合成测试；`.env`、真实资料与链接、数据库、截图、Harness 历史和诊断产物留在本机。暂存后运行 `npm run check:publish`，再人工核对 `git diff --cached`，失败时不要提交。详见 [SECURITY.md](SECURITY.md)。

本项目使用 MIT License，见 [LICENSE](LICENSE)。
