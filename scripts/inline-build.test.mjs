import { describe, expect, it } from 'vitest';

import { inlineHtml, verifySelfContainedHtml } from './inline-build.mjs';

describe('single-file build', () => {
  it('inlines the Vite module and stylesheet safely', async () => {
    const html = '<!doctype html><html><head><script type="module" crossorigin src="./assets/app.js"></script><link rel="stylesheet" crossorigin href="./assets/app.css"></head><body><main id="app"></main></body></html>';
    const files = new Map([
      ['./assets/app.js', 'console.log("</script>")'],
      ['./assets/app.css', 'body::after{content:"</style>"}'],
    ]);
    const output = await inlineHtml(html, async (path) => files.get(path));

    expect(output).toContain('<script type="module">console.log("<\\/script>")</script>');
    expect(output).toContain('<style>body::after{content:"<\\/style>"}</style>');
    expect(() => verifySelfContainedHtml(output)).not.toThrow();
  });

  it('rejects missing assets and remaining external runtime references', async () => {
    await expect(inlineHtml('<script type="module" src="./assets/missing.js"></script>', async () => undefined))
      .rejects.toThrow('找不到构建资源');
    expect(() => verifySelfContainedHtml('<!doctype html><main id="app"></main><script src="https://example.com/app.js"></script><script type="module">app()</script><style>body{}</style>'))
      .toThrow('仍包含外部脚本');
  });
});
