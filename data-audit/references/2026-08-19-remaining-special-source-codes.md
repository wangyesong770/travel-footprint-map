# 剩余特殊来源代码主权与治理口径核验

采集日期：2026-08-19。适用 Overture release：`2026-06-17.0`。

本文只记录全球审核输入，不改变 `sovereign-registry.json`、selector、`verified` 状态或发布产物。结论遵循以下门槛：优先采用中华人民共和国外交部、国务院等中国官方口径；必要时以联合国文件、直接条约或相关主权政府的原始法律文本交叉核验。实际控制、地图标签、单方主张和历史材料中的宽泛地域称呼均不能单独生成产品 owner。

发布决策（2026-08-19）：用户选择继续严格阻断上线。本文列出的未决区域不得作为“已审核排除项”放行；在取得满足上述门槛的新直接证据前，全球发布门禁必须保持失败。

## 结论摘要

| 分类 | 来源代码 | 发布处理 |
|---|---|---|
| 可明确归属 | 无 | 本轮没有发现足以新增 sovereign owner 的直接证据。 |
| 需要 stable ID 处理 | `XB`、`XZ` | `XB` 是单一主张范围覆盖层，应按唯一 ID 精确排除而不是归属；`XZ` 混合无人区与居民点，必须逐 ID 审定，禁止代码级 owner。 |
| 证据不足，继续阻断 | `GS`、`EH`、`XA`、`XI`、`XL`、`XM`、`XN`、`XO`、`XQ`、`XU`、`XY` | 全球门禁继续失败；不得用实际控制或邻接关系补 owner。 |

## 逐项核验

### `GS`：南乔治亚和南桑威奇群岛

- 实包主边界：dependency `cf0e2ce7-fd36-41d8-ad1c-7d352bf2ff3a` / area `7cf85864-12ee-46a7-836b-dcb42567a34a`；另有 South Georgia、South Sandwich Islands、Bird Island 及若干 locality。
- 联合国条约保管资料同时记录阿根廷与英国对 South Georgia、South Sandwich Islands 的相反主权声明，证明争议不能由本产品自行消解：[UN Treaty Collection](https://treaties.un.org/Pages/ViewDetails.aspx?chapter=21&mtdsg_no=XXI-7&src=TREATY)。
- 中国代表在联合国公开支持的是阿根廷对马尔维纳斯群岛的主权主张；该直接表述没有把支持范围扩展到 GS：[联合国 2025 年非殖民化委员会会议报道](https://press.un.org/en/2025/gacol3394.doc.htm)。
- 结论：**证据不足继续阻断**。不能把中国对马尔维纳斯的支持外推为 `GS → AR`，也不能按英国实际管理写成 `GS → GB`。GS 内部要素共享同一争议，不需要 stable-ID 拆分来规避政治结论。

### `EH`：西撒哈拉

- 当前实包没有待归属 Overture 来源行；阻断来自世界底图 `EH`。
- 中阿官方联合文件支持在联合国框架内实现西撒哈拉人民自决，没有把 EH 归入摩洛哥：[中阿尔及利亚联合声明](https://www.mfa.gov.cn/zyxw/202307/t20230718_11114859.shtml)。
- 联合国仍将 Western Sahara 列为 Non-Self-Governing Territory：[联合国非殖民化页面](https://www.un.org/dppa/decolonization/en/nsgt/western-sahara)。
- 结论：**证据不足继续阻断**。不得写 `EH → MA`，也不得创建未经审核的独立 sovereign owner。

### `XA`、`XI`、`XO`、`XU`：北方四岛／南千岛群岛相关要素

| 代码 | 实包范围 | 主边界 stable ID |
|---|---|---|
| `XA` | Habomai 单一 country | `27b5ecfd-6867-4946-9b59-f10ba05694bd` |
| `XI` | Iturup country、6 个 locality、1 个 microhood | `419b2f2b-651e-40bd-a7f8-776f10d4f37d` |
| `XO` | Shikotan country、2 个 locality | `5c6058ea-b13a-4e15-98e0-ed1c28c98011` |
| `XU` | Kunashir country、1 个 county、多个 locality | `39d6f33f-0f6c-432e-9359-7030fd9b8313` |

- 外交部把相关问题定义为俄日双边问题并要求双方妥善解决，没有选定俄、日 owner：[2010 年答记者问](https://www.mfa.gov.cn/web/gjhdq_676201/gj_676203/yz_676205/1206_676836/fyrygth_676844/201011/t20101102_7992849.shtml)、[2021 年答记者问](https://www.mfa.gov.cn/web/wjb_673085/zzjg_673183/gjs_673893/gjzz_673897/lhgyffz_673913/fyrth_673921/202110/t20211018_10410392.shtml)、[2022 年答记者问](https://www.mfa.gov.cn/web/fyrbt_673021/202202/t20220211_10641427.shtml)。
- 1951 年周恩来声明曾使用“千岛群岛交还苏联”的历史表述，但没有逐岛界定本批四个 Overture 边界：[外交部历史声明](https://www.mfa.gov.cn/nanhai/chn/zcfg/201605/t20160530_8523552.htm)。
- 1956 年《苏日联合宣言》第九条把 Habomai、Shikotan 的实际移交置于缔结和平条约之后，不能证明当前 owner：[UN Treaty Series, vol. 263](https://treaties.un.org/doc/Publication/UNTS/Volume%20263/v263.pdf)。
- 结论：四码均为**证据不足继续阻断**。不得用实际控制写 `RU`，不得用日方单边主张写 `JP`；每码内部地域一致，现阶段不靠 stable-ID 拆分解决。

### `XB`：Liancourt Rocks 日本主张范围

- 实包只有一个 country 要素 `cd5b36c5-d7c6-4595-b009-c54c11fec925` / area `a760ade6-5c7e-49c0-a918-5c98d7458e20`，名称明确是 `Extent of Japanese claim at Liancourt Rocks`。它是主张覆盖层，不是城市或行政边界。
- 中国驻韩大使公开表示理解韩方关切并希望韩日妥善处理，没有确认韩、日任一方主权：[中国驻韩国大使馆转外交部页面](https://www.mfa.gov.cn/web/zwbd_673032/yjcf/202106/t20210611_9172621.shtml)。
- 韩国与日本政府分别发布直接相反的主权立场：[韩国外交部](https://dokdo.mofa.go.kr/m/eng/dokdo/government_position.jsp)、[日本外务省](https://www.mofa.go.jp/region/asia-paci/takeshima/)。这些单方主张不能替代中国官方 owner。
- 结论：**需要按 stable ID 精确排除**。该唯一 UUID 可进入受审的“非行政、主张覆盖层”排除契约；不得写 `XB → KR` 或 `XB → JP`，也不得扩大成代码通配排除新要素。

### `XL`：均郎、乌热、然冲、香扎、拉不底地区

- 实包只有一个聚合 country 边界 `b177c266-834b-48f9-a786-52fa46412405` / area `d66b3e8e-a14e-4297-bf6e-77778d110cd7`。
- 中印 1993 年协定明确以“边界问题最终解决之前”的实际控制线安排维持和平，不构成最终边界归属：[中华人民共和国外交部条约文本](https://www.mfa.gov.cn/web/ziliao_674904/tytj_674911/tyfg_674913/199309/t19930907_7949320.shtml)。
- 2025 年双方仍就“边界划分谈判”设置机制，表明不能从临时边境管理安排生成 sovereign owner：[第 24 次中印边界问题特别代表会晤共识](https://www.mfa.gov.cn/eng/wjb/wjbz/hd/202508/t20250820_11692839.html)。
- 1962 年国务院公报是有效历史审核输入，但当前能直接核实的文本没有为这个五地名聚合几何给出逐一、可机器绑定的最终 owner：[国务院公报 1962 年第 14 号](https://www.gov.cn/gongbao/shuju/1962/gwyb196214.pdf)。
- 结论：**证据不足继续阻断**。该 Overture 要素本身把五处合成一个 polygon；如果未来五处证据不一致，需要上游几何拆分或受审替代边界，单纯给这个 UUID 指派 owner 仍会过度覆盖。

### `XQ`：Nilang–Jadhang disputed area

- 主边界 `f9116ff4-9091-4217-adea-f677f68e2fc0` / area `60e48510-bd66-4237-8fc1-c9aa71e53e6e`，另混有 Nilapani、Sumla、Tirpani、桑村、波林三多、葱莎等 locality。
- 同一套中印 1993 年协定和 2025 年特别代表会晤共识证明相关边界仍需双方最终划定，不能把临时实际控制或任一方地图当作 owner 证据：[1993 年协定](https://www.mfa.gov.cn/web/ziliao_674904/tytj_674911/tyfg_674913/199309/t19930907_7949320.shtml)、[2025 年共识](https://www.mfa.gov.cn/eng/wjb/wjbz/hd/202508/t20250820_11692839.html)。
- 结论：**证据不足继续阻断**。不得代码级写 `CN` 或 `IN`。若后续取得逐点官方证据，应分别审核 country cover 与每个 locality 的 stable ID，不能让一个聚合争议标签替所有居民点决定归属。

### `XM`、`XN`：阿布穆萨及大小通布岛

| 代码 | 实包范围 | 主边界 stable ID |
|---|---|---|
| `XM` | Abu Musa 单一 country | `a43d592a-fad4-4a24-89f3-8ecbd0326a2d` |
| `XN` | Tunb 单一 country | `aed548b9-2f89-4515-b023-4a50e0f3b6c0` |

- 2024 年中阿联酋联合声明支持阿方依国际法通过双边谈判和平解决三岛问题，但没有宣布三岛属于阿联酋或伊朗：[中华人民共和国外交部联合声明](https://www.mfa.gov.cn/ziliao_674904/1179_674909/202406/t20240602_11368960.shtml)。
- 结论：两码均为**证据不足继续阻断**。不得把支持和平解决误写成 `AE` owner，也不得按伊朗实际控制写 `IR`；每码单一边界，不需 stable-ID 拆分。

### `XY`：阿卜耶伊

- 主边界 `e6c26737-e4e1-468a-b152-ddacd1e920c7` / area `a24f7743-562b-44c8-9ca2-b636ddec296a`，另有多批 locality 与 `NGO Compound` neighborhood。
- 中国常驻联合国代表明确主张政治解决，并要求苏丹、南苏丹落实临时协议，没有选定最终 sovereign owner：[外交部 2026 年安理会发言](https://www.mfa.gov.cn/zwbd_673032/wjzs/202605/t20260509_11907600.shtml)。
- 联合国材料明确 2011 年安排不预判阿卜耶伊最终解决：[秘书长报告 S/2011/816](https://digitallibrary.un.org/record/719376/files/S_2011_816-EN.pdf)；[苏丹与 SPLM 临时安排原文](https://peacemaker.un.org/sites/default/files/document/files/2024/05/sd110620agreementtemporaryarrangementsabyeiarea.pdf)。
- 结论：**证据不足继续阻断**。不得写 `XY → SD` 或 `XY → SS`；代码内要素都属于同一未决区域，stable-ID 拆分不能替代最终政治解决。

### `XZ`：Latrun 无人区及周边居民点

- `XZ` 同时包含：
  - `No man's land` country `5f9327fb-5f13-4aab-9b89-e347a261a8af` / area `04a6dbd9-5315-46be-a730-30bb41836992`；
  - Kfar Ruth、Lapid、Neve Shalom、Shilat 等 locality 和 Maccabim macrohood，其中有的有 area、有的仅 metadata。
- 联合国资料把 Latrun 明确描述为 1949 年停战协定形成的 no-man's land：[1965 年联合国年鉴摘录](https://www.un.org/unispal/document/auto-insert-196187/)、[1949 年以色列—约旦停战协定](https://peacemaker.un.org/sites/default/files/document/files/2024/05/il20jo490403hashemite20jordan20kingdom-israel20general20armistice20agreement.pdf)。
- 联合国特别委员会还记录 Kfar Ruth 建于 former no-man's land，证明 `XZ` 的 locality 不能因为现代居民点名称而自动取得 sovereign owner：[联合国 A/33/356 相关摘录](https://www.un.org/unispal/document/auto-insert-185813/)。
- 中国官方支持以 1967 年边界为基础的“两国方案”，但这不足以自动判定每个 `XZ` UUID 位于最终哪一方：[中国对阿拉伯国家政策文件](https://www.mfa.gov.cn/web/ziliao_674904/zcwj_674915/201601/t20160113_7949944.shtml)。
- 结论：**需要按 stable ID 拆分**。禁止代码级 `XZ → IL/PS`。无人区 polygon 保持未归属；每个 locality 必须与权威停战线/1967 基线逐要素叠加并人工复核，无法核定者继续阻断。

## 门禁建议

1. 全球 exact-set 门禁继续把本文“证据不足”代码视为阻断项；本文不是状态白名单。
2. `XB` 只能以唯一 `(divisionId, divisionAreaId)` 进入受审非产品排除，且需绑定 release、快照 checksum 与“主张覆盖层”理由。
3. `XZ` 必须采用稳定 ID 清单，不得使用 `sourceCountryCode=XZ` 的通配 owner；所有现有及未来新增 UUID 都必须显式对账。
4. `XL/XQ` 不得使用地名相似、空间邻接或当前控制线自动归属。若需要产品化，先取得逐几何直接证据；聚合边界与证据范围不一致时必须替换/拆分几何。
5. 任何后续季度 release 若改变 UUID、名称、要素数量或范围，以上结论自动回到 `draft`，重新核验后方可使用。
