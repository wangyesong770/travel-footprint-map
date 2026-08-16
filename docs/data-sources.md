# 行政边界数据来源与许可

## 生产数据基线

- 来源：Overture Maps Foundation Divisions，固定 release `2026-06-17.0`、schema `v1.17.0`。
- 上游地址：`https://overturemaps-us-west-2.s3.amazonaws.com/release/2026-06-17.0/`
- 源对象、字节数、ETag 与 SHA-256 记录在 `data-audit/source-snapshots/2026-06-17.0.json`。
- 每个国家的实际获取日期、官方基准、许可和选择器版本记录在对应审核报告中；不得以构建时间代替获取日期。
- 行政区域稳定身份来自 Overture `division.id`；`division_area.id`、名称和简化后的几何均不作为到访身份。

## 处理方法

构建流程按主权注册表合并来源国家代码，以逐国审核过的 subtype、admin level 和 local type 规则筛选陆地区域，再应用显式 allowlist/denylist。输出经过几何校验、确定性排序、TopoJSON 量化与简化；最终包字节的 SHA-256 同时绑定国家 manifest 与审核报告。

中国采用 `china-official` 视角，`CN`、`HK`、`MO`、`TW` 统一归入中国地图。其他属地按版本控制的主权注册表归入对应主权国家。运行时不推断或覆盖这些关系。

全球发布采用 exact-set 门禁：主权注册表、国家包、manifest、国家报告和 summary 的国家集合必须完全相同；所有国家必须为 `verified`，且 release、checksum、大小、署名和运行时包校验全部通过。门禁还要求至少 190 个主权条目，防止四国 seed、测试 fixture 或其他局部注册表被误标为全球完成；该下限只是防误发布护栏，不能替代逐国审核和完整注册表复核。失败证据仅作为诊断产物保留，不得成为生产 manifest。

## ODbL 与署名

Overture Divisions 包含 OpenStreetMap 贡献数据，按 [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 使用，并遵循 [Overture attribution 指引](https://docs.overturemaps.org/attribution/)。地图、海报及数据下载界面必须显示：

> © OpenStreetMap contributors, Overture Maps Foundation · ODbL 1.0

公开的筛选、重命名、合并、量化和简化结果按衍生数据库管理。完整机器可读国家包、对应审核证据以及生成算法随同公开仓库提供，不对其施加与 ODbL 冲突的附加限制。上游原始数据库仍由各来源方按各自许可提供。

## 复现、发布与回滚

1. 先校验固定 release 的 source snapshot，再执行提取；不得静默切换 release 或数据引擎。
2. 按国家生成包和报告，报告必须记录来源 release、获取日期、处理算法版本、官方参考及最终 checksum。
3. 运行 `npm run audit:global -- --release 2026-06-17.0 --packages public/data/countries --reports data-audit/reports/2026-06-17.0`。
4. 只有成功生成 `release-ready.json` 的完整版本可以上传为生产 artifact。artifact 名含 release 与 CI run ID，避免缓存或覆盖造成版本混用。
5. 发布系统保留上一套完整全球 artifact；新版本部署失败时整体回滚，禁止逐国回滚形成混合 release。

常规 CI 中的 fixture 任务只验证提取、QA、报告和全局门禁的程序契约，不产生生产就绪声明。生产 artifact 只能在 `main` 分支手动触发，经 `production-boundaries` 环境审批，并对仓库内的完整包和报告重新执行门禁。CI 只缓存 npm 下载，不缓存国家包、审核报告或 `release-ready.json`；artifact 上传前再次检查 manifest、area index、release-ready 和 summary 均存在且非空。artifact 名同时包含 Overture release 和 CI run ID，因此失败或新版本不会覆盖上一套可回滚 artifact。

仓库分支保护应把 `extract-fixture`、`country-qa`、`evidence`、`global-gate` 和 `build` 设为必需检查。生产发布仅允许从受保护分支手动触发，并由环境审批控制；本工作流不假定仓库已开启这些外部治理设置。
