import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('map selection styles', () => {
  it('highlights a selected area with color only', () => {
    const stylesheet = readFileSync('src/styles.css', 'utf8');
    const selectedAreaRule = stylesheet.match(
      /\.area-selected,\s*\.area-selected:hover,\s*\.area-selected:focus-visible\s*\{([^}]*)\}/,
    );

    expect(selectedAreaRule?.[1]).toContain('fill: #55b8ad');
    expect(selectedAreaRule?.[1]).not.toContain('filter:');
  });

  it('suppresses Chromium SVG focus outlines while retaining focus-visible strokes', () => {
    const stylesheet = readFileSync('src/styles.css', 'utf8');

    expect(stylesheet).toMatch(/\[data-area-id\]:focus\s*\{\s*outline: none;/);
    expect(stylesheet).toMatch(/\[data-area-id\]:focus-visible\s*\{[^}]*stroke:/);
  });
});
