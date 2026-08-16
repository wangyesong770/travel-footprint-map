# Travel Footprint Map

一张可点亮全球市镇级城市足迹的清新旅行手账地图。城市搜索完全离线；点亮后按需请求城市行政边界，失败时自动保留城市光点。

## 功能

- 235,403 座全球城市/市镇离线索引，中文优先、原名辅助
- 搜索或点击二维世界地图后选择附近城市
- 到访城市统一珊瑚橙填充；无边界时显示光点
- 可选单次模糊日期（年 / 月 / 日）和纯文本备注
- IndexedDB 本地保存，完整 JSON 合并/替换导入与导出
- 横版 1600×1000、方形 1200×1200 PNG 海报
- 桌面侧栏与手机底部手账响应式布局
- 可直接打开的单个自包含 HTML

## 本地运行

要求 Node.js 22+。

```bash
npm ci
npm run dev
```

质量门禁与单文件构建：

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

最终文件为 `dist/travel-map.html`，可以直接双击打开。若浏览器禁止 `file://` 页面访问 Nominatim，城市仍会保存并显示为光点；部署到 HTTPS 后可手动重试边界。

## 数据与隐私

- 城市名称来自 GeoNames `cities500` / `alternateNamesV2` / `countryInfo`，构建后嵌入页面。
- 国家底图来自 Natural Earth，构建后嵌入页面。
- 只有用户首次获取某座城市边界时，页面才向 OpenStreetMap Nominatim 发送该城市原名和国家代码；不会发送备注、日期或完整足迹。
- 到访记录、边界缓存和标题只保存在当前浏览器 IndexedDB；没有账户或云端数据库。

完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 部署与回滚

推送到 `main` 后，GitHub Actions 会依次执行 lint、类型检查、单元测试、单文件构建，并把 `travel-map.html` 作为 Pages 的 `index.html` 部署。

回滚时，在 GitHub 上恢复上一个通过验证的提交并重新运行 `Deploy GitHub Pages` 工作流。用户数据在浏览器本地，不随静态站点版本部署或回滚；升级前建议导出 JSON 备份。

## 已知限制

- 公共 Nominatim 有使用政策与限流；本应用限制为每秒最多一次且不自动重试。
- 个别城市没有可匹配的行政边界，会持续使用城市光点。
- 单文件约 24 MB，首次解析完整城市库时在低端手机上可能需要数秒。
- PNG 中文字体使用系统字体，不同平台字形可能略有差异。
