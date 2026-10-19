# Lexmount 云端只读观察

检查日期：2026-10-15，Asia/Shanghai，约 17:58-18:12。

执行：项目 .env 凭据，lexmount 0.6.1、Playwright 1.63.0、Node v24.22.0。

工具：[inspect.mjs](../tools/lexmount-probe/inspect.mjs)。

## 结论

项目 Key 和 Project ID 已实际用于创建云端会话及 CDP 连接。
t1-t6 均执行 light 只读观察；t5 另外用 normal 对照。t2 共观察两次，合计 8 个会话，
结束后逐个查询均为 closed。没有填写、点击、勾选协议、提交、下载或补发邮件。

| 案例 | 云端实际观察 | 后续处理 |
| --- | --- | --- |
| t1 / light | HTTP 404，页面显示“您访问的页面不存在！” | 页面事实是访问错误；客户端分类仍只来自已记录的用户确认规则 |
| t2 / light | 成功跳转申请 H5，截图显示 346.25 元、企业/个人、名称/税号、收票邮箱及提交按钮；枚举 15 个控件 | 可进入申请适配；保留商户短信套餐提示，下一步单独验证定位/填表事件 |
| t3 / light | 原始入口跳转票通，截图显示“发票已提交”和抬头查询输入框 | 已有申请，不点击查询或重新申请 |
| t4 / light | 截图及 DOM 显示 85 元已开票交付详情和下载入口 | 已开票，不点击下载 |
| t5 / light | DOM 含 2913 元、发票号和已开票详情；截图内容挤在左侧且文字重叠 | 数据可读取，但本次视觉布局不合格 |
| t5 / normal | 同一原始入口显示 2913 元发票详情，截图排版正常 | 当前详情流程可把 normal 记为待验证引擎偏好；不泛化到美团所有申请流程 |
| t6 / light | 跳转微信 OAuth，实际提示为“Oops! Something went wrong:(” | 本次未进入申请流程；未复现旧记录的“请在微信客户端打开链接”，不以通用错误证明具体原因 |

## 读取差异

- light 下 t2 的 innerText 缺金额、提交按钮等部分文本，截图和 DOM textContent 有内容。
- light 下 t3 的 innerText 为空，截图及 DOM 可见已有申请；t4 的 innerText 也遗漏详情。
- t2 的提交按钮在截图可见，但 getBoundingClientRect 返回零尺寸；部分折叠字段返回了坐标。
  因此不能仅凭该矩形判断是否可见/可点击，本轮没有尝试点击来验证实际动作。
- t5 的原生 button/a 等控件枚举为零，不代表没有“查看发票/发送邮箱”交互，页面使用其他元素。
- textContent 会包含隐藏提示和脚本。工具另保存去 script/style 的 contentText，仍不能把隐藏文本
  直接当作当前状态。正式观察需结合当前结构、截图和业务证据。

上述是本次具体页面和调用方式的观察，不把所有页面都判为 light 不适用。
完整填表、点击事件、协议处理、实际受理以及 Harness 集成都不在本次只读检查范围。

## 私有证据

原始 URL、HTML、文本、控件和截图保存在 data/，不作为网页静态资源或公共测试样本。
本文件中的 data/ 等目录均相对于项目根目录；2026-10-16 整理后案例索引位于
[data/samples/invoice-cases.json](../data/samples/invoice-cases.json)，以下历史运行目录保持原位。

| 运行记录 | 内容 |
| --- | --- |
| data/lexmount-observations/2026-10-15T09-58-24-050Z/ | t2 首次 light 截图、结构观察及关闭核实 |
| data/lexmount-observations/2026-10-15T09-59-38-227Z/ | t1/t3/t4/t5/t6 light 的 HTML、截图及观察 |
| data/lexmount-observations/2026-10-15T10-11-31-100Z/ | t5 normal 对照 |
| data/lexmount-observations/2026-10-15T10-12-03-857Z/ | t2 light 复核，包含 HTML 与去脚本文本 |

每个目录的 summary.json 记录只读动作计数、实际会话标识及 cleanup.finalStatus。
旧的本地 Chromium 观察保留为历史；本轮云端观察另行记录，不覆盖过往网页事实。

## 重复观察

从项目根目录运行，下列命令会创建收费云会话并只读访问指定案例：

```powershell
node tools/lexmount-probe/inspect.mjs --check-config
node tools/lexmount-probe/inspect.mjs --cases t2
node tools/lexmount-probe/inspect.mjs --cases t5 --engine normal
```

脚本按自身位置解析项目 .env 和案例库，不依赖终端所在目录。
只读探测默认不回退引擎；对照由显式 --engine 指定。
verify-sessions.mjs 只核实本工具报告中记录的会话，并关闭仍未结束的这些会话。
这是一项调研工具，不是已实现的开票应用或通用适配器。

## 2026-10-16 方案复核与待验证项

本次未创建云会话、未执行 t2 填写或真实提交。下面是历史证据和官方资料复核，
不能代替实际的 light/normal 填写对照或人工接管测试。资料由用户在应用“开票资料”页保存，
对照安排在资料页、任务快照及最小填写流程完成之后，不要求用户在开发对话中提供资料。

| 项目 | 已核对事实 | 尚需验证 |
| --- | --- | --- |
| 正常填写可用性 | Playwright 官方说明 fill 检查可见、启用、可编辑；可见性包含非空边界框。t2 提交按钮矩形为零是已有观察 | 输入框及安全切换在 light/normal 的正常动作能否成功；不能由按钮异常直接推出所有 fill 失败 |
| 引擎选择 | Lexmount 官方区分完整 Chromium 流程与需按页面验证的 light 能力，特别提示布局/截图/DevTools 兼容性 | 同资料快照的双引擎对照；失败流程直接使用已验证引擎，新商户不再重复失败 |
| 人工通道 | SDK 0.6.1 声明 session.inspectUrl 和 sessions.listTargets() 的 target.inspectUrl；实现会为 session.inspectUrl 拼接后备地址 | 链接能否打开、是否需控制台登录、是否有同会话实时画面和输入/拖动、两引擎支持及过期行为 |
| t6 分类 | 历史 summary.json 的 finalUrl 精确主机 open.weixin.qq.com、路径 /connect/oauth2/authorize，scope=snsapi_base、response_type=code；页面为 Oops | 入口规则按实际主 frame 地址判断，不依赖错误文字；不是本次重新在线复现 |
| 探索预算 | 当前没有真实填表完整轮次或模型耗时样本 | 分项记录观察、模型、动作、回读、截图；无模型对照只用于浏览器耗时，不编造 P95 |

资料准备好后的 t2 对照正常使用商家表单的联想、blur 和页面校验，分别保存截图与耗时，
停在真实提交之前。断网、强制改 DOM 或合成字段诊断只能作为局部能力排查，不记 A0 通过。
短信套餐提示可能只影响通知，不能凭提示推断一定要验证码；以当时实际控件和步骤为准。
实时 DevTools 也不自动保证 dry_run 的提交限制，人工通道必须单独验证该限制。

官方依据与安装包位置：

```text
https://browser.lexmount.com/docs/guides/browser-modes
https://browser.lexmount.com/docs/nodejs-sdk/capabilities
https://playwright.dev/docs/actionability
node_modules/lexmount/dist/index.d.ts
node_modules/lexmount/dist/index.mjs
```

核对摘录私有保存在 diagnostics/design-review-20261016/，本轮方案修订前版本位于其 before/ 子目录。
观察工具复用项目根 `node_modules/`，不需要在工具目录单独安装。
当前表单暂用 normal 的策略是 v3.4 待验证的实现选择，不修改上述 2026-10-15 的历史观察结论。

## 2026-10-16 t6 语言与引擎对照

本轮从本机样本索引中的原入口只读访问，没有填写、点击、微信授权确认或发票申请。
受保护诊断仅允许精确微信授权 GET 主文档观察，未知接口和写请求仍关闭；
正式应用继续按微信授权地址停止，不引入授权绕过。

| 环境 | 语言设置 | 实际文案 |
| --- | --- | --- |
| 云端 light、normal | 原默认配置 | Oops! Something went wrong:( |
| 本机桌面 Chromium | zh-CN | 请在微信客户端打开链接 |
| 同一本机 Chromium | en-US | Oops! Something went wrong:( |
| 同一本机 Chromium 再次检查 | zh-CN | 请在微信客户端打开链接 |
| 云端 light、normal | Accept-Language: zh-CN,zh;q=0.9 | 请在微信客户端打开链接 |

各次最终均进入精确微信授权地址。切换语言可复现文案切换，说明本次差异主要来自语言环境，
不能据 Oops 判断 light 引擎不兼容，也不能据中文提示判断普通 Chrome 已进入开票表单。
其余浏览器/网络/会话因素未隔离，不把结论泛化到所有网站。
原始截图、HTML、语言设置和只读计数保存在 `test-results/browser-engine-t6-*/report.json`，
详细运行索引见 [实现记录](IMPLEMENTATION_STATUS.md)。

正式运行新增填写前 light 异常的 normal 单次复核，使用原入口和相同网络/提交限制，
先确认 light 关闭再新建 normal；正常 normal 页面才继续规则或 Harness 分析。
双引擎异常保留证据并停止，不认定填写成功，不自动发布跨商户引擎配置。
应用云会话统一发送中文 Accept-Language。此修改不是 t6 商家填写验收。

## 2026-10-16 t5 安全拦截复核

用户 PC Chrome 正常打开，但应用 normal 显示“网络异常／服务出错”。
原任务轨迹表明 `/api/invoice/process/queryReceiptQrCode` 的 POST 被应用拦截；
本机桌面 Chromium 使用同样拦截时也复现错误，因此不能归因于云端或 light。
当前美团静态前端源码中该接口在初始化时读取 `{url: window.location.href}`，
返回后判断已开票/已有申请/待填写；真正申请使用独立的 apply 接口。
实际小票查询请求还携带空 appChannel、env=3、空 identifyToken。

应用仅放行这个读取接口、当前原入口和完整已核对参数，以及特定 CDN 路径的带版本 JS/CSS
fetch 读取。申请、发送邮件、其他订单和未核验接口仍拦截，没有放开整站权限。
修复后的本机桌面与云端 normal 均显示 2913 元既有发票；真实任务控制器正确返回
`already_issued`，未填、未点、未下载、未发送邮件、未申请，云会话 closed。
这是已有发票只读状态验证，不是商家填写或真实提交验收。
修改前 light 观察超时且已清理关闭，未验证修复后 light 完整可用性。

详尽报告与安全边界见 [实现记录](IMPLEMENTATION_STATUS.md) 的 t5 条目。
