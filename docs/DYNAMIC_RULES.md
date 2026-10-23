# 填写记录与通用执行器

同一发票页面填对一次后，下次直接复用或参考上次的步骤，减少模型调用；light 在某网站不兼容时记住，不再白等。填写完成后由用户在对话中确认才执行一次真实提交；业务 Agent 与填写记录都不能提交。

## 1. 目录与职责

```text
src/rules/
  schema.mjs       记录结构、允许动作
  contract.mjs     页面结构和资料字段范围的契约摘要
  registry.mjs     按 host + path 读写记录、选择回放或提示、作废
  executor.mjs     通过现有开票工具回放可信记录，不调用模型
  candidate.mjs    从实际完成的工具操作导出待定步骤

data/rules/<完整域名>/<路径摘要>.json
                    一个页面的记录，按购买方类型分 enterprise / personal 两套
data/artifacts/<taskId>/learned-steps.json
                    本任务完成的待定步骤，按用户回复决定记成什么
data/artifacts/<taskId>/rule-snapshot.json
                    本任务回放时使用的记录快照
```

不逐站写 JavaScript；不需要人工审核、Git 提交或重启，记录由程序按用户回复自动写入。

## 2. 记录键与级别

记录按入口跳转后的页面 `host + pathname + hash 路由（# 后 ? 前）` 索引，订单号等网址参数全部不参与，同一商家的新二维码会命中同一记录。个人/企业由客户在页面上选择，步骤不同，所以同一页面下按购买方类型分别学习、互不覆盖。

| 用户对截图的回复                                  | 记录                   |
| ------------------------------------------------- | ---------------------- |
| 确认提交（页面成功、无结果、或没有反应）          | 可信                   |
| 确认提交，但页面明确提示失败，或出现新字段/新提示 | 提示                   |
| 认可但不提交（如“填得没问题，先不提交”）          | 可信                   |
| 放弃 / 5 分钟超时 / 发新二维码顶掉                | 提示                   |
| 修正                                              | 作废该购买方类型的记录 |

- 可信覆盖任何旧记录；提示只覆盖提示或空，不把已有可信降级。
- 修正作废的是这张任务回放/参考的那条，以及这张自己产生的那条（按修订号匹配，别的任务后写入的新记录不受影响）。不区分问题出在资料还是步骤。修正后的重填走纯模型加修正说明，再次被认可后重新生成记录。

## 3. 运行流程

1. 任务建立资料快照，安装页面操作拦截和内网访问限制，读取页面、订单和金额。
2. 按 host + path + 购买方类型读取记录：
   - 可信，且引擎、资料字段集合相同、首步页面契约一致 → 通用执行器零模型回放；
   - 其余有记录（提示，或可信但不完全匹配）→ 业务 Harness 分析，把上次的操作顺序（动作、控件标签/文字、资料引用、选项，不含契约摘要）放进提示词作参考；
   - 无记录或记录文件无效 → 业务 Harness 从头分析。
3. 回放每步重新观察页面、核对该步契约，按 frameIndex 和控件语义唯一定位，调用已有开票工具；短暂异步变化有界等待（默认 1500 ms，最多 5000 ms）。任一步对不上就带着本任务工具状态（已回读字段、企业查询来源、步骤编号）交给 Harness 继续，并附上记录步骤作参考。
4. 回放使用选中时的记录快照，运行中其他任务写入的新记录不影响本次。
5. 最终由同一开票工具核对全部必填项、购买方资料、选项和金额，保存截图等待用户回复。回放和模型填写都会导出本次的待定步骤。

## 4. 记录结构

```json
{
  "schemaVersion": 2,
  "host": "invoice.example.com",
  "path": "/invoice",
  "hashPath": "",
  "variants": {
    "enterprise": {
      "level": "trusted",
      "engine": "normal",
      "profileFields": ["email", "taxId", "title"],
      "sourceTaskId": "<来源任务>",
      "learnedAt": "2026-10-23T00:00:00Z",
      "revision": "<记录内容摘要>",
      "steps": [
        {
          "action": "fill",
          "contract": "<本步骤操作前页面的 SHA-256 摘要>",
          "target": {
            "frameIndex": 0,
            "identity": { "tag": "input", "type": "text", "label": "收票邮箱", "name": "email" }
          },
          "valueRef": "email"
        },
        { "action": "finish", "contract": "<最终提交前页面的 SHA-256 摘要>" }
      ]
    }
  }
}
```

契约摘要包含购买方类型、可用资料字段集合、各 frame 标题/标题层级/协议链接/已选选项，以及控件类型、标签、上下文、ID、必填/禁用/可见/可编辑状态、勾选状态和下拉选项。真实抬头、税号、邮箱不进记录，导出时替换为 `[profile.title]` 等引用，回放时按本任务资料展开。资料字段集合是适用范围的一部分：已存税号和页面查税号、有无手机号是不同组合，不一致时只作提示。

允许的 `action` 仅为：

| 动作           | 开票工具               | 约束                                         |
| -------------- | ---------------------- | -------------------------------------------- |
| fill           | invoice_fill           | 只接受 title/taxId/email 等资料字段引用      |
| select         | invoice_select         | 当前原生下拉或购买方类型，选项仍由工具核对   |
| open_choices   | invoice_open_choices   | 展开企业联想控件                             |
| choose_company | invoice_choose_company | 唯一完整名称匹配；已有税号时同时核对税号     |
| query_company  | invoice_query_company  | 当前页面允许的企业查询按钮                   |
| read_tax       | invoice_read_tax       | 同页查询结果回读、来源/冲突检查和截图        |
| continue       | invoice_continue       | 仅受控本地导航，无法排除申请副作用则停止     |
| finish         | invoice_finish         | 全字段核对和截图，必须是最后一步，不操作提交 |

定位只用结构化控件特征，不提供 CSS/JavaScript/XPath 执行入口。页面企业查询的候选每次重新核对，不拿上次结果替代本次查询。

## 5. light 不兼容记忆

- 任务以 light 打开时读取 light 浏览器的 `browser.version()`，作为“当前 light 版本”保存。
- 某入口域名上 light 失败（页面异常或 light 类填写失败）、换 normal 后进入截图确认，就记下该域名与当时的 light 版本。
- 以后该域名的任务，只要当前 light 版本与记录相同就直接用 normal；任意任务看到新版本后，该域名会再试一次 light，成功进入截图确认即删除记录。
- 记录在本机数据库 settings 中，不过期，用户无需操作。

## 6. 需客户端办理的入口

- 页面明确要求微信/客户端（`client_required`），或主页面跳转到微信授权（`wechat_oauth_required`）时，按**入口网址**（跳转前）的 host + path 在同一记录文件里写 `entry`，订单参数不参与。
- 同一入口的新码直接回复需用微信或对应 App 办理，不开浏览器；用户回复“重来”时重新打开真实页面，能走到填写就删除 `entry`。
- 404、空白、网络错误不记录：它们说明不了链接只能在客户端打开，可能只是链接失效。
- 不在代码里按网址写站点规则；kiwa 小程序入口作为 `source: user_confirmed` 的数据保存在 `data/rules/www.kiwa-tech.com/`。

```json
{
  "schemaVersion": 2,
  "host": "www.kiwa-tech.com",
  "path": "/scanIOrderIpadfromhdl",
  "hashPath": "",
  "variants": {},
  "entry": {
    "status": "unsupported_browser",
    "reasonCode": "known_client_entry",
    "message": "小程序码，需在微信中打开",
    "source": "user_confirmed",
    "learnedAt": "2026-10-15T00:00:00.000Z"
  }
}
```

## 7. 边界与验证

- 回放和模型填写都不能点提交、勾协议或按回车；提交只在用户确认截图后由程序执行一次，同一入口链接只允许一次真实提交。
- 内网访问限制、操作拦截和订单关联仍由 `browser/guard.mjs`、`browser/observe.mjs` 负责，记录不能放宽。
- 页面改版会使契约不一致，自动退回模型；不为了复用删除重要契约字段。
- 记录只在合成页面验证（键匹配、级别、互不覆盖、作废、新订单回放、中途不一致交接、截图失败不导出、light 版本记忆），尚未在真实商家页面验证提速效果。
