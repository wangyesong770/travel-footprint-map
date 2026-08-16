# 全球城市行政边界审核设计规格

## 决策背景

国家下钻地图要求每个国家展示最接近城市治理范围的行政区域，而全球不存在统一可靠的行政层级编号或名称。Overture Divisions 中的 `subtype`、`admin_level` 和 `local_type` 在不同国家含义不同；自动选择最深层、统一选择 `locality` 或回退到 `county` 都可能把社区、统计区或市内区误作城市。

因此，新版必须完成全球逐国审核后再上线。当前生产版本在整套全球数据通过前保持不变；不得发布部分国家、混用不同数据 release，或把未审核 fallback 标记为可用。

本规格补充并覆盖 `2026-08-16-country-drilldown-redesign.md` 中关于全球边界来源、国家口径和发布条件的内容。

## 数据来源与固定版本

- 主来源为 Overture Maps Divisions 的 `division` 与 `division_area`。
- 每次全球审核固定到一个明确 release；同一生产版本内所有国家必须来自同一 release。
- `division_area` 提供 Polygon/MultiPolygon；通过 `division_id = division.id` 联表读取 `local_type`、层级关系和政治视角。
- 稳定到访身份使用 `division_id`，不使用可能因 land/territorial 表达变化而改变的 `division_area.id`。
- 只选择 `is_land = true` 的几何；territorial 几何不得用于城市点亮区域。
- 来源 release、获取时间、选择器版本、处理算法和上游许可写入 manifest 与审核报告。

官方参考：

- Overture Divisions Guide: https://docs.overturemaps.org/guides/divisions/
- DivisionArea schema: https://docs.overturemaps.org/schema/reference/divisions/division_area/
- Division schema: https://docs.overturemaps.org/schema/reference/divisions/division/
- GERS registry/changelog: https://docs.overturemaps.org/gers/
- Attribution: https://docs.overturemaps.org/attribution/

## 政治视角与主权归属

### 中国

- 涉及中国的国界、名称和归属采用中国官方视角。
- 大陆、香港、澳门和台湾统一归入“中国”国家地图；世界层不提供独立国家入口。
- 用户侧国家统计统一计为中国。
- 底层保留原始来源代码和 `division_id`，用于更新、审计与撤并迁移，但不改变用户可见归属。

### 其他国家与属地

- 其他地区采用 Overture 默认国际视角，除非国家审核文件明确记录例外。
- 海外属地与自治领按主权国家合并；世界层只提供主权国家入口。
- `sourceCountryCodes` 保存被合并的 ISO 来源代码。
- 跨洲属地的大洲统计按城市所在地大洲计算，国家统计按主权国家计算。
- 争议地区、多个 perspective 或无法确定主权关系的条目必须有显式规则和证据，不得按字符串或空间位置自动归属。

主权国家审核清单以中国官方视角下的国家目录为基线，并与 Natural Earth 世界底图逐项对账。底图中无对应主权入口或审核表中无底图几何均阻断发布。

## 国家审核注册表

每个主权国家必须有一条版本控制的配置：

```ts
interface CountryAuditConfig {
  sovereignCode: string;
  sourceCountryCodes: readonly string[];
  productLevel: string;
  overtureSelector: {
    subtypes: readonly string[];
    adminLevels?: readonly number[];
    localTypeRules?: readonly LocalTypeRule[];
  };
  allowlist: readonly string[];
  denylist: readonly string[];
  expectedCount: CountExpectation;
  officialReferences: readonly AuditReference[];
  perspective: 'china-official' | 'overture-default';
  auditedAt: string;
  status: 'draft' | 'failed' | 'verified';
}
```

规则：

- 未配置国家不得生成国家包。
- `draft` 或 `failed` 国家不得进入生产 manifest。
- 产品层级与 Overture 原始字段分离：例如内部 `prefecture` 由受审 selector 映射而来，不能要求原始 `subtype` 等于 `prefecture`。
- allowlist/denylist 只存稳定 `division_id`，并记录原因。
- 同一 `division_id` 在一个主权国家包内最多出现一次。
- 选择器、例外表或主权归属变化必须产生新的审核报告。

## 提取与构建数据流

```text
固定 Overture release
  → DuckDB 按来源国家读取 division + division_area
  → 按 division_id 联表
  → 应用主权国家映射
  → 应用逐国 selector
  → 应用 allowlist / denylist
  → 映射内部产品层级
  → 几何与拓扑校验
  → 官方基准与统计 QA
  → 简化并生成 TopoJSON
  → 生成同源 area index
  → 生成 checksum 绑定审核报告
  → 全部国家 verified 后生成生产 manifest
```

原始 Overture 数据不得由浏览器直接消费。生成后的 TopoJSON 不能手工编辑；所有差异必须来自注册表、例外表或构建代码。

## 单国通过标准

每个国家必须独立满足：

1. 存在显式 selector，且没有 fallback。
2. `division_id` 唯一率 100%，并与区域搜索索引 ID 完全一致。
3. Polygon/MultiPolygon、有限 WGS84 坐标、闭合线环、顶点与深度限制 100% 通过。
4. 有机器可读官方名录时，最终数量必须精确匹配；时间差或合法例外逐 ID 记录。
5. 无机器可读官方名录时，必须有第二权威来源、受审数量范围和人工抽检记录。
6. 原名不得缺失；中文名缺失进入翻译补全队列，但不伪造中文名。
7. 重复几何、异常包含和非制度允许的大面积重叠阻断审核。
8. 合法飞地、共同治理区、市县合一、特别区或不覆盖全部国土的制度必须进入例外说明。
9. 单国 Brotli/Gzip p95 目标不超过 5 MiB，硬上限 20 MiB；超限须重新简化并复做拓扑 QA。
10. 报告的包大小、feature 数和 checksum 必须与最终字节完全一致。

市镇制度不覆盖全部国土时允许地图留白；不得为了铺满国家轮廓而选择错误行政层级。

## 全球通过与原子发布标准

只有以下条件全部满足才允许部署：

- 审核清单中的全部主权国家状态为 `verified`；
- 中国官方视角及所有主权/属地合并规则对账通过；
- 所有国家基于同一 Overture release；
- 索引、国家包、manifest 和报告 checksum 一致；
- ODbL 与上游来源清单完整；
- 全球包体积、解析时间、搜索内存和国家地图交互性能通过预算；
- 旧 `cityId` 数据迁移、行政区撤并迁移与完整备份通过；
- 桌面与手机两轮 E2E 全部通过；
- 生产审计与回滚演练通过。

任意国家失败时整版不发布，生产继续使用上一套完整全球版本。不得形成部分国家使用新 release、部分国家使用旧 release 的状态。

## 更新与撤并

- 每季度评估新的 Overture release，不要求每月自动上线。
- 新旧版本区域数量变化超过 2%、出现 ID 删除/拆分/合并、选择器结果变化或政治视角变化时，必须人工复审。
- 几何微调但 `division_id` 不变时保留到访身份。
- 拆分、合并和撤销写入显式 `division-id-migrations.json`。
- 一对多迁移不得自动猜选；旧记录进入用户待确认队列。
- 新全球版本审核完成前，旧版本国家包、索引和 manifest 保持可回滚。

## 审核证据

仓库目录：

```text
data-audit/
├── sovereign-registry.json
├── selectors/<ISO2>.json
├── exceptions/<ISO2>.json
├── migrations/division-id-migrations.json
└── reports/<OVERTURE_RELEASE>/
    ├── summary.json
    └── <ISO2>.json
```

单国报告必须记录：

- 主权国家和合并的来源代码；
- 原始 selector 与内部产品层级；
- 官方/第二权威基准链接、采集日期和许可；
- 候选数、最终数、排除数、allowlist/denylist 数；
- 重复、重叠、缺口、无名称和非法几何统计；
- 原始、TopoJSON、gzip/Brotli 字节数；
- p50/p95/max 顶点及解析性能；
- 抽检样本、例外和失败原因；
- 数据 release、选择器版本、生成提交、审核时间和最终 checksum。

审核报告不得包含 token、宿主绝对路径或用户旅行数据。

## 变更治理

- 选择器、例外和主权注册表只能通过代码提交修改，网页运行时不得覆盖。
- 修改必须带目标国家的失败回归测试和新审核报告。
- CI 重新生成国家包并验证工作树无未提交差异。
- 报告与包 checksum 绑定，不同字节不能复用报告。
- 许可、来源或政治视角变化与几何变化具有同等审核级别。
- 生成产物与审核证据分别可追溯，且保留上一个生产版本以便原子回滚。

## 许可义务

Overture Divisions 使用 ODbL 1.0。公开的筛选、重命名和简化国家包按衍生数据库管理：

- 地图与海报展示 `© OpenStreetMap contributors, Overture Maps Foundation`；
- 链接 ODbL 1.0 与 Overture attribution 页面；
- 每个 release 保留来源、获取时间、处理说明与 license URI；
- 机器可读衍生数据库或完整变更/生成算法公开可得；
- 不对衍生数据库施加与 ODbL 冲突的额外限制。

正式发布前需对最终分发方式进行一次许可审计。

## 子项目与依赖顺序

### 子项目 A：全球审核基础设施

实现固定 release 提取器、主权注册表、selector schema、例外/迁移表、QA 计算器、报告生成器和 CI 门禁。

### 子项目 B：全部国家审核

逐国建立 selector、官方基准、例外和报告。可按区域并行，但每个国家单独验收；全部 verified 才完成。

### 子项目 C：应用集成与部署

完成 IndexedDB v2、V1 无损迁移、全球区域搜索、国家地图 UI、备份、海报、性能门禁、两轮 E2E 和生产部署。

A 是 B 的强依赖；C 的开发可与 B 并行，但生产部署强依赖 B 全部完成。

## 明确不做

- 不自动猜测未配置国家层级。
- 不使用公共 Nominatim/Overpass 实时拼装国家全部边界。
- 不允许手工坐标或光点作为国家层城市边界兜底。
- 不把 CN/US fixture、少量 verified 国家或统一 ADM2 宣称为全球完成。
- 不在全球审核通过前替换当前生产版本。
