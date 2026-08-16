import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATTERN = /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*><\/script>/giu;
const STYLE_PATTERN = /<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/giu;

function assertLocalAsset(path) {
  if (!/^\.\/assets\/[A-Za-z0-9._-]+$/u.test(path)) {
    throw new Error(`不安全的构建资源路径：${path}`);
  }
}

async function replaceAssets(html, pattern, render, readAsset) {
  const matches = [...html.matchAll(pattern)];
  let output = html;
  for (const match of matches.reverse()) {
    const path = match[1];
    if (!path || match.index === undefined) throw new Error('无法解析构建资源');
    assertLocalAsset(path);
    const content = await readAsset(path);
    if (typeof content !== 'string' || content.length === 0) throw new Error(`找不到构建资源：${path}`);
    output = `${output.slice(0, match.index)}${render(content)}${output.slice(match.index + match[0].length)}`;
  }
  return output;
}

export async function inlineHtml(html, readAsset) {
  let output = await replaceAssets(
    html,
    SCRIPT_PATTERN,
    (source) => `<script type="module">${source.replaceAll('</script>', '<\\/script>')}</script>`,
    readAsset,
  );
  output = await replaceAssets(
    output,
    STYLE_PATTERN,
    (source) => `<style>${source.replaceAll('</style>', '<\\/style>')}</style>`,
    readAsset,
  );
  return output;
}

export function verifySelfContainedHtml(html) {
  if (!/<!doctype html>/iu.test(html) || !/<main\b[^>]*id=["']app["']/iu.test(html)) {
    throw new Error('单文件产物缺少完整 HTML 外壳');
  }
  if (/<script\b[^>]*\bsrc=/iu.test(html)) throw new Error('单文件产物仍包含外部脚本');
  if (/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=/iu.test(html)) {
    throw new Error('单文件产物仍包含外部样式');
  }
  if (!/<script\b[^>]*\btype=["']module["'][^>]*>[^<]/iu.test(html)) {
    throw new Error('单文件产物缺少内联应用脚本');
  }
  if (!/<style>[^<]/iu.test(html)) throw new Error('单文件产物缺少内联样式');
}

async function buildSingleFile() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const distribution = join(repositoryRoot, 'dist');
  const inputPath = join(distribution, 'index.html');
  const outputPath = join(distribution, 'travel-map.html');
  const inputStats = await stat(inputPath);
  if (!inputStats.isFile() || inputStats.size === 0) throw new Error('Vite HTML 构建产物不存在或为空');
  const html = await readFile(inputPath, 'utf8');
  const output = await inlineHtml(html, async (assetPath) => {
    const absolutePath = join(distribution, assetPath.slice(2));
    try {
      const assetStats = await stat(absolutePath);
      if (!assetStats.isFile() || assetStats.size === 0) return undefined;
      return await readFile(absolutePath, 'utf8');
    } catch {
      return undefined;
    }
  });
  verifySelfContainedHtml(output);
  await writeFile(outputPath, output, 'utf8');
  const outputStats = await stat(outputPath);
  if (!outputStats.isFile() || outputStats.size === 0) throw new Error('单文件 HTML 写入失败');
  process.stdout.write(`singleFile=${outputPath}\nbytes=${outputStats.size}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildSingleFile();
}
