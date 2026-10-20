# 域名规则与通用执行器

填写完成后由用户在对话中确认才执行一次真实提交；业务 Agent 与规则本身都不能提交。

## 1. 目录与职责

```text
src/rules/
  schema.mjs       JSON 结构、允许动作、填写审核条件
  contract.mjs     页面结构和资料字段范围的契约摘要
  registry.mjs     运行时读取、域名索引、唯一匹配和变更检查
  executor.mjs     通过现有开票工具执行规则，不调用模型
  candidate.mjs    从实际成功的工具操作导出候选

src/adapters/<完整域名>/
  flow.json        网站、入口、流程变体和结构化步骤
  policy.json      填写审核记录；真实提交 enabled 必须为 false

data/adapters/candidates/<taskId>.json
                    待审核候选，包含 flow/policy，不参与运行时匹配
data/artifacts/<taskId>/rule-snapshot.json
                    本任务实际加载的规则、审核配置和修订摘要
```

`src/adapters/` 只放正式规则数据，不放每个网站的 JavaScript。目录缺失或为空不会影响启动；没有匹配规则时调用业务 Harness。旧 `keruyun` 预置配置、`fillCube()` 和启动时硬读取已删除，不迁移为已审核规则。

默认一个域名一个 `flow.json`，内部默认一个 `default` 变体。确有企业/个人、入口、页面或引擎差异再增加变体；不能把域名相同解释为所有流程一致。`hosts` 可明确列出同系统的其他完整域名；多个文件或变体同时命中时转模型，不任取一项。商户标识仍用于任务核对和后续交易去重，不成为规则目录名。

## 2. 运行流程

1. 任务建立资料快照，先安装页面操作拦截（阻止我们自己点提交/勾协议/回车）和内网访问限制，读取当前网页状态、订单和金额。
2. 每个新任务重新读取规则 JSON，按完整域名、协议/端口、路径前缀、hash 前缀、完整参数契约、购买方类型、资料字段有无和实际引擎查找候选。
3. 仅有一项满足绑定流程内容的填写审核、完整契约人工核验和首步页面摘要匹配时，交通用执行器。
4. 每步重新观察页面、核对该步契约摘要，使用 frameIndex 和控件语义唯一定位，调用已有开票工具。控件短暂异步变化可有界等待，默认 1500 ms，最多 5000 ms。
5. 规则变化、停用审核或删除时，在下一动作前停止并要求重新准备；不能静默切换到新版。页面或控件不匹配时由 Runner 转 Harness 重新观察，复用本任务工具状态以保留已回读字段、企业查询来源、步骤编号和轨迹，不沿用其他任务或旧截图审核权限。
6. 无规则、规则 JSON 无效、未审核、资料范围/引擎变化或多个规则命中，都调用 Harness 分析当前页面，不使用正则映射代替模型。
7. 最终仍由同一开票工具核对全部必填项、购买方资料、选项和金额，确认抵达最终提交前页面，保存原始截图并等待人工审核。

新增、修改和删除正式 JSON 在运行时可见，不需要重新部署或重启。运行中的任务保存不可变副本，复核磁盘配置与已加载副本；已完成任务不因规则更新改写历史结果。只改文件不能开启真实提交。

## 3. JSON 契约

以下仅说明结构，省略的步骤和占位摘要不是可直接启用的规则。应从成功探索的候选出发审核，而非手填一个猜测摘要。

```json
{
  "schemaVersion": 1,
  "id": "invoice.example.com",
  "hosts": ["invoice.example.com"],
  "variants": [
    {
      "id": "default",
      "engine": "normal",
      "match": {
        "protocol": "https:",
        "port": "",
        "pathPrefix": "/invoice",
        "hashPrefix": "",
        "parameters": {
          "query": {
            "order": { "kind": "transaction" },
            "invoiceType": { "kind": "exact", "values": ["normal"] }
          },
          "hashQuery": {}
        },
        "buyerType": "enterprise",
        "profileFields": ["email", "taxId", "title"]
      },
      "steps": [
        {
          "action": "fill",
          "contract": "<本步骤操作前页面的 SHA-256 摘要>",
          "target": {
            "frameIndex": 0,
            "identity": {
              "tag": "input",
              "type": "text",
              "role": "",
              "label": "收票邮箱",
              "context": "购买方信息",
              "placeholder": "",
              "name": "email",
              "stableId": "buyer-email"
            }
          },
          "valueRef": "email"
        },
        {
          "action": "finish",
          "contract": "<最终提交前页面的 SHA-256 摘要>"
        }
      ]
    }
  ]
}
```

每个动作必须有操作前契约。摘要包含购买方类型、可用资料字段集合、各 frame 标题/标题层级/协议链接/已选选项，以及控件类型、标签、上下文、ID、必填/禁用/可见/可编辑状态、勾选状态和下拉选项。真实抬头、税号、邮箱输入值不成为通用参数；它们由工具按任务快照填写并回读。

资料字段集合是适用范围的一部分：已存税号和页面查税号是不同路径，有/无手机号也是不同组合。发现新组合走模型，不猜默认分支。当前使用有界线性步骤和变体，不支持任意条件表达式、循环、脚本或通用网络请求。

URL 参数必须覆盖 query 和 hashQuery 的完整键集合。候选保守保存每项 `exact` 值；人工审核确认订单号等只用于交易关联、不改变流程后，才能改为 `transaction`，允许唯一非空值变化。未知新增参数、重复交易参数和未审核的值变化都不匹配；不根据参数名字自动删除 token。候选内可能包含真实入口参数，必须保留在私有 data/，正式规则审核时去除敏感值并明确范围，不直接提交候选到 Git。

允许的 `action` 仅为：

| 动作 | 开票工具 | 约束 |
| --- | --- | --- |
| fill | invoice_fill | 只接受 title/taxId/email 等资料字段引用 |
| select | invoice_select | 当前原生下拉或购买方类型，选项仍由工具核对 |
| open_choices | invoice_open_choices | 展开企业联想控件 |
| choose_company | invoice_choose_company | 唯一完整名称匹配；已有税号时同时核对税号 |
| query_company | invoice_query_company | 当前页面允许的企业查询按钮 |
| read_tax | invoice_read_tax | 同页查询结果回读、来源/冲突检查和截图 |
| continue | invoice_continue | 仅受控本地导航，无法排除申请副作用则停止 |
| finish | invoice_finish | 全字段核对和截图，必须是最后一步，不操作提交 |

定位使用结构化控件特征，不提供 CSS/JavaScript/XPath 规则执行入口。候选中的真实资料文字替换为 `[profile.title]` 等引用，回放时只展开已有资料字段。页面查询返回的候选由工具再次核对，不能拿上次企业候选替代本次查询。

## 4. 候选与审核

模型执行成功的每个工具动作会记录动作前页面摘要、控件语义、资料引用和选项。包括展开、页面查询、本地导航和结束检查；不像旧候选只保存部分操作轨迹。只有完整填写、全部回读和截图完成后，后端才导出同一 JSON 结构的候选。模型失败、截图失败、未到最终步骤均不能生成可复用候选。

后端保留来源 taskId，候选统一为 `reviewRequired=true`、`signatureComplete=false`、`enabled=false`、`actualSubmitted=false`。它们不自动复制到正式目录。删除会话时仍按 taskId 删除对应候选，避免与已有清理逻辑冲突。

开发者审核候选、真实资料残留、域名/路径/参数范围、各步定位和完整协议条件，验证通用执行器能从新页面独立填写后，才形成正式规则数据。采用现有 Git diff/提交审查，无新管理令牌、发布表或审核服务。业务 Agent 不获得审核、文件写入或规则发布工具。

`policy.json` 示例：

```json
{
  "enabled": false,
  "minSupervisedSuccess": 1,
  "evidenceRefs": [],
  "preparationReviews": [
    {
      "variantId": "default",
      "flowDigest": "<实际 flow JSON 内容摘要>",
      "reviewedAt": "2026-10-16T00:00:00Z",
      "signatureComplete": true,
      "protocolReviewed": true,
      "agreementVerified": true
    }
  ]
}
```

`preparationReviews` 仅允许复用已审核的填写测试，不是提交授权或真实成功证据。`flowDigest` 绑定解析后的整个 flow 内容，改定位/范围/步骤/引擎使旧审核不匹配。运行期修订摘要另外绑定实际 flow/policy 文件内容，用于检测任务期间变更；Git 用于人工版本审核，不要求为了加载 JSON 重新构建或访问 Git 命令。

`protocolReviewed` 和 `agreementVerified` 表示人工已核对协议条件，绝不表示程序已经勾选协议。页面摘要只观察协议链接等可读状态，不能自动证明完整协议正文和隐藏参数都已覆盖，禁止仅凭摘要将 `signatureComplete` 改为 true。

`tools/check-adapters.mjs` 与运行服务共用 JSON 校验和审核匹配逻辑，只报告结构、审核变体数量或缺项，不修改配置。当前 `enabled=true` 直接拒绝。后续真实受监督成功及执行器版本绑定证据尚未实现，最少一次真实成功的门槛保持，不用模拟成功替代。

## 5. 边界与验证

- 当前生产正式规则集合为空，真实页面仍由模型分析；旧真实填写证据不自动转成新规则已通过的证据。
- 新网站只要使用已支持的控件和动作，新增审核 JSON 即可；通用工具不支持的新能力需要补通用实现，不逐站写 `fillA()`。
- 内网访问限制、操作拦截和订单关联仍由 `browser/guard.mjs`、`browser/observe.mjs` 负责。页面请求按真实访问放行，动态填写规则不能新增可点击的提交、协议或申请动作。
- 同一网站页面变化可能保守地不匹配；动态 ID、协议目标或业务选项不能安全归一化时走模型，不为了复用删除重要契约字段。
- 只导出实际探索步骤，不提供额外模型总结/发布轮次；尚未实现复杂流程自动归纳、完整协议采集和真实提交证据校验。
- 合成浏览器回归验证空目录、热增删改、域名欺骗、审核绑定、歧义、动作拒绝、候选结构、当前资料回放、截图和运行中变更停止。它们不等同于真实商家零模型填写验收。

用户确认截图后由程序在保留的页面上提交一次，不属于规则执行；`enabled` 仍只控制零模型复用。真实链接因此会被消耗，同一入口摘要只允许一次真实提交。
