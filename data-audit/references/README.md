# 主权注册表证据索引

采集日期：2026-08-16。此目录只记录审核输入及归属依据，不代表任何国家已经完成城市边界审核。`sovereign-registry.json` 中全部 197 个国家均保持 `draft`；未解决项必须继续阻断全球发布。

## 国家集合与名称

中国官方可见国家集合以中华人民共和国外交部“国家（地区）”目录为基线。该目录列出 196 个外国国家（含库克群岛、纽埃），注册表再加入中国，共 197 条；港澳台不建立独立国家入口。

- [外交部：国家和组织](https://www.mfa.gov.cn/web/gjhdq_676201/)（中文名称和洲别入口）
- [外交部：亚洲](https://www.mfa.gov.cn/web/gjhdq_676201/gj_676203/yz_676205/)
- [外交部：非洲](https://www.mfa.gov.cn/web/gjhdq_676201/gj_676203/fz_677316/)
- [外交部：欧洲](https://www.mfa.gov.cn/web/gjhdq_676201/gj_676203/oz_678770/)
- [外交部：北美洲](https://www.mfa.gov.cn/web/gjhdq_676201/gj_676203/bmz_679954/)
- [外交部：南美洲](https://www.mfa.gov.cn/web/gjhdq_676201/gj_676203/nmz_680924/)
- [外交部：大洋洲](https://www.mfa.gov.cn/web/gjhdq_676201/gj_676203/dyz_681240/)
- [联合国：193 个会员国](https://www.un.org/en/library/unms)及[两个非会员观察员国](https://www.un.org/en/about-us/non-member-states)（交叉核验，不覆盖外交部单列的库克群岛和纽埃）
- [联合国统计司 M49](https://unstats.un.org/unsd/methodology/m49/overview/)（ISO alpha-2、联合国短名称和地理区域；联合国明确说明统计分组不表达政治立场）
- [联合国地名专家组国家名称资料](https://ungegn.un.org/dashboard/countries/index)（本地官方语名称和联合国六种正式语言名称）

中文名称以外交部页面为准。`nameLocal` 使用联合国 M49 的英文正式短名作为本轮可审计兜底；逐国审核时再用国家官方名录替换为当地官方语短名。`auditRegion` 是审核工作分区，不代表政治或统计归属；它与名称、显式 `worldGeometryIds` 均是注册表独立字段，不得混入 selector 或从 `productLevel` 推断。

## 中国官方视角

| 规则 | 注册表处理 | 直接依据 |
|---|---|---|
| 香港属于中国 | `HK → CN`，无 HK 世界入口 | [香港特别行政区基本法第一条](https://www.npc.gov.cn/npc/c34354/xgjbfwyh/xgjbfwyh002/xgjbfwyh004/xgjbfwyh023/202408/t20240828_438872.html) |
| 澳门属于中国 | `MO → CN`，无 MO 世界入口 | [澳门特别行政区基本法第一条](https://www.npc.gov.cn/WZWSREL25wYy9jMjU5Ny9jMTc3Ni9jMTc4MS8yMDE5MDUvdDIwMTkwNTIzXzIwMjU1Lmh0bWw%3D) |
| 台湾属于中国 | `TW/TWN → CN`，无 TW 世界入口 | [中华人民共和国宪法序言](https://www.npc.gov.cn/WZWSREL3pncmR3L25wYy96dC9xdC9nanhmei8yMDE0LTEyLzAzL2NvbnRlbnRfMTg4ODA5My5odG0%3D) |
| 黄岩岛属于中国 | Natural Earth `SCR → CN` | [外交部声明：黄岩岛和南沙群岛历来都是中国领土的一部分](https://www.mfa.gov.cn/web/ziliao_674904/1179_674909/200902/t20090218_7947208.shtml) |
| 科索沃不设主权国家入口 | Natural Earth `KOS → RS` | [外交部：尊重塞尔维亚主权和领土完整](https://www.mfa.gov.cn/fyrbt_673021/202409/t20240916_11491613.shtml) |
| 北塞浦路斯不设主权国家入口 | Natural Earth `CYN → CY` | [中国领事服务：塞浦路斯共和国拥有全岛法理主权](https://cs.mfa.gov.cn/zggmcg/ljmdd/oz_652287/spls_654583/rjjl_654593/) |
| 索马里兰不设主权国家入口 | Natural Earth `SOL → SO` | [外交部：索马里兰是索马里领土的一部分](https://www.mfa.gov.cn/web/wjdt_674879/fyrbt_674889/202504/t20250430_11614167.shtml) |
| 马尔维纳斯群岛归入阿根廷视图 | `FK → AR` | [中阿联合声明：支持阿根廷完全行使主权的要求](https://www.mfa.gov.cn/ziliao_674904/1179_674909/202202/t20220206_10639419.shtml)；[联合国确认存在主权争议、英国为管理国](https://www.un.org/dppa/decolonization/en/content/falkland-islands-malvinas) |

这些映射只控制产品世界入口和审核 owner；原始 `sourceCountryCode` 与 Natural Earth ID 必须原样保留在证据中。

## Natural Earth 10m 世界几何对账

固定源为 Natural Earth 5.1.1 `ne_10m_admin_0_countries_chn.zip`，SHA-256 为 `16e7589083527d01208b9f645fc8643c767170258e9d13b59d37bc5a1f6a8758`。生成器按 `ISO_A2 → ADM0_A3_CN → ADM0_A3 → ISO_A3` 选择第一个非 `-99` 的 ID；注册表只登记最终 ID，不在运行时推断 alias。

2026-08-16 对固定 ZIP 的 DBF 属性逐要素复核结果如下。`SOV_A3/SOVEREIGNT/NOTE_ADM0/TYPE` 仅用于本次书面审核；owner 还必须与本页上方的主权/属地直接依据一致。

| Owner/处理 | 显式 `worldGeometryIds` | Natural Earth 关键字段与审核结论 |
|---|---|---|
| 各自主权国家 | `AD AG BB BH CK CV DM FM GD KI KM KN LC LI MC MH MT MU MV NR NU PW SC SG SM ST TO TV VA VC WS` | `TYPE=Sovereign country`（CK/NU 在数据中为与新西兰联系的 dependency，但按外交部目录和新西兰 Cabinet Manual 保留独立入口）；最终 ID 均为 `ISO_A2` |
| `AU` | `ATC AU CSI HM IOA NF` | `SOVEREIGNT=Australia`、`SOV_A3=AU1`、`NOTE_ADM0=Auz.`；与澳政府外领地依据交叉核验 |
| `CN` | `CN HK MO SCR` | HK/MO 为 `SOVEREIGNT=China`、`SOV_A3=CH1`；SCR 单独采用上方外交部黄岩岛声明 |
| `DK` | `DK FO GL` | FO 为 `SOVEREIGNT=Denmark`、`NOTE_ADM0=Den.` |
| `FI` | `AX FI` | AX 为 `SOVEREIGNT=Finland`、`NOTE_ADM0=Fin.` |
| `FR` | `BL CLP FRA MF NC PF PM TF WF` | 属地要素为 `SOVEREIGNT=France`、`SOV_A3=FR1`、`NOTE_ADM0=Fr.`；与法国海外部依据交叉核验 |
| `GB` | `AI BM ESB GB GG GI IM IO JE KY MS PN SH TC VG WSB` | 属地/基地为 `SOVEREIGNT=United Kingdom`、`SOV_A3=GB1`、`NOTE_ADM0=U.K.`；与英国政府属地清单交叉核验。GS 不在此列 |
| `NL` | `AW CW NL SX` | 属地为 `SOVEREIGNT=Netherlands`、`SOV_A3=NL1`、`NOTE_ADM0=Neth.` |
| `US` | `AS GU MP PR UM US VI` | 属地为 `SOVEREIGNT=United States of America`、`SOV_A3=US1`、`NOTE_ADM0=U.S.A.` |
| 非主权排除 | `AQ BRI BRT` | AQ 依据南极条约；BRI/BRT 的 `TYPE=Indeterminate`，`NOTE_BRK` 分别为 `Claimed by Brazil and Uruguay`、`Between Egypt and Sudan`，均不创建产品国家入口 |

旧 110m 的 `TWN/CYN/KOS/SOL` 不存在于固定 10m China POV 最终 ID 集，已从 `worldGeometryIds` 删除；台湾几何已统一进入 `CN`，塞浦路斯、塞尔维亚、索马里使用实际最终 ID `CY/RS/SO`。

## 其他属地归属

注册表将下列 ISO 来源代码合并到一个产品主权 owner；未列出的主权国家默认只拥有自身代码。

| Owner | 来源代码（除自身外） | 依据与备注 |
|---|---|---|
| AU | `CC CX HM NF` | [澳大利亚外交贸易部对外领地定义](https://www.dfat.gov.au/trade/agreements/in-force/aclfta/fta-text-implementation/Pages/chapter-2-general-definitions) |
| CN | `HK MO TW` | 见“中国官方视角” |
| DK | `FO GL` | 丹麦王国内归属；仍需逐国审核补丹麦政府机器可读直接证据 |
| FI | `AX` | 芬兰主权下自治地区；仍需逐国审核补芬兰政府机器可读直接证据 |
| FR | `BL GF GP MF MQ NC PF PM RE TF WF YT` | [法国海外部列出的 12 个海外领地](https://www.outre-mer.gouv.fr/)；[TAAF 范围](https://www.outre-mer.gouv.fr/territoires/terres-australes-et-antarctiques-francaises) |
| GB | `AI BM GG GI IM IO JE KY MS PN SH TC VG` | [英国政府海外领地清单](https://www.gov.uk/government/publications/geographical-names-and-information)；GG/IM/JE 为王室属地、由英国负责国际关系。`IO` 仅按当前仍有效状态暂列，见下方动态门禁 |
| NL | `AW BQ CW SX` | [荷兰政府：王国四个构成国与加勒比公共实体](https://www.government.nl/faq/what-are-the-different-parts-of-the-kingdom-of-the-netherlands) |
| NO | `BV SJ` | 挪威主权下地区；仍需逐国审核补挪威政府机器可读直接证据 |
| NZ | `TK` | [新西兰外交贸易部：托克劳是新西兰王国内非自治领地](https://www.mfat.govt.nz/en/countries-and-regions/australia-and-pacific/tokelau) |
| US | `AS GU MP PR UM VI` | [美国内政部岛屿事务办公室](https://www.doi.gov/oia/islands/acquisitionprocess) |
| AR | `FK` | 中国官方视角，见上表 |

库克群岛 `CK`、纽埃 `NU` 按外交部国家目录保留各自国家入口，不并入 `NZ`。新西兰官方将二者描述为与新西兰自由联系的自治国家：[新西兰总理与内阁部 Cabinet Manual](https://www.dpmc.govt.nz/our-business-units/cabinet-office/supporting-work-cabinet/cabinet-manual/1-sovereign-governor-general-and-executive-council/governor-general)。

## 明确未解决并阻断发布

- `AQ`：南极洲没有单一主权 owner；注册表以受限 `nonSovereignExclusions/antarctica` 精确排除。依据：[南极条约秘书处条约说明](https://www.ats.aq/e/antarctictreaty.html)（第四条冻结既有主权主张且禁止以条约期间行为建立新主张）。
- `BRI/BRT`：Natural Earth 明确标作 `Indeterminate` 的非国家要素，分别由受限 `brazilian-island/bir-tawil` 条目精确排除。排除策略只接受 `AQ/BRI/BRT`，代码层禁止用于 `EH/GS` 或任意新增 ID。
- `EH`：西撒哈拉最终地位未解决。外交部公开材料要求通过对话协商妥善解决；当前不把 `EH` 推断给摩洛哥或其他 owner。
- `GS`：南乔治亚和南桑威奇群岛存在与马尔维纳斯争端相关的竞争主张，当前没有足以落实本产品中国官方 owner 的直接新证据，暂不分配。
因此，当前执行 `list-audit-queue` 应对 `AQ/BRI/BRT` 做可审计的非主权排除，并继续仅因 `EH`、`GS` 的世界归属问题安全失败；不得生成任何 `verified` 状态。

## 动态事实复核

- 英国与毛里求斯已于 2025-05-22 签署查戈斯群岛条约，但英国政府说明主权在条约生效后才转移；截至本次采集，官方页面仍将 BIOT 作为英国海外领地。因此 `IO → GB` 仅为本 release 的暂定 owner，每次季度 release 必须重新检查[英国政府条约页面](https://www.gov.uk/government/publications/ukmauritius-agreement-concerning-the-chagos-archipelago-including-diego-garcia-cs-mauritius-no12025)及[英国政府生物多样性策略中的生效条件](https://www.gov.uk/government/publications/uk-overseas-territories-biodiversity-strategy/uk-overseas-territories-biodiversity-strategy)。
- Natural Earth 用 `FRA/NOR/TWN/CYN/KOS/SOL` 等非 ISO2 ID。其 owner 已逐项写入注册表 `worldGeometryIds`；队列不包含 alias 推断、空间包含或字符串相似度 fallback。

## 使用说明

1. 本页链接必须保持 HTTPS 直链；抓取日期、页面标题和使用说明进入逐国 selector 证据。
2. 国家官方名录优先于本页全局目录；出现变更时保持国家 `draft/failed`，更新证据后才能审核。
3. 任何新增 Overture `sourceCountryCode` 必须恰好有一个 owner；任何新 Natural Earth ID 必须显式对账。
4. 引用公开政府资料不等于取得其数据库再分发许可；逐国审核必须单独记录许可/使用说明。
