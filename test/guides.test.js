import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GUIDES, findGuide, guideText } from '../src/lib/guides';
import { SECTIONS, SETTINGS_ITEMS } from '../src/lib/settingsRegistry';
import { matchesQuery } from '../src/lib/settingsSearch';

const BLOCK_TYPES = new Set(['p', 'steps', 'list', 'note', 'table', 'code']);

describe('guides', () => {
  it('have unique ids and well-formed blocks', () => {
    const ids = GUIDES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of GUIDES) {
      expect(g.title && g.summary, g.id).toBeTruthy();
      expect(g.sections.length, g.id).toBeGreaterThan(0);
      for (const s of g.sections) {
        expect(s.heading, g.id).toBeTruthy();
        for (const b of s.blocks) {
          expect(BLOCK_TYPES.has(b.type), `${g.id}: ${b.type}`).toBe(true);
          if (b.type === 'steps' || b.type === 'list')
            expect(b.items.length).toBeGreaterThan(0);
          if (b.type === 'note') expect(['info', 'warning']).toContain(b.tone);
          if (b.type === 'table') {
            for (const row of b.rows) expect(row.length).toBe(b.head.length);
          }
        }
      }
    }
  });

  it('live in their own Settings section and are searchable', () => {
    expect(SECTIONS.flatMap((g) => g.items.map((i) => i.id))).toContain('guides');
    for (const g of GUIDES) {
      const entry = SETTINGS_ITEMS.find((i) => i.id === `guides.${g.id}`);
      expect(entry?.section, g.id).toBe('guides');
    }
    const found = SETTINGS_ITEMS.filter((i) => matchesQuery(i, 'herd bulk import'));
    expect(found.map((i) => i.id)).toEqual(['guides.herd-import']);
    expect(findGuide('nope')).toBeNull();
  });

  it('covers both single and bulk Herd import', () => {
    const headings = findGuide('herd-import').sections.map((s) => s.heading);
    expect(headings).toContain('Import a single site');
    expect(headings).toContain('Import several sites at once');
  });

  // The guide tells people which buttons to press. If a label in the dialog
  // is renamed, this fails rather than the guide quietly lying.
  it('quotes only UI labels that still exist in the Herd import UI', () => {
    const src = ['src/components/HerdImportModal.jsx', 'src/components/Sites.jsx']
      .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))
      .join('\n');
    const quoted = [...guideText(findGuide('herd-import')).matchAll(/“([^”]+)”/g)].map(
      (m) => m[1]
    );
    // Labels with a live count ("Import 3 sites") are built in code.
    const fixed = quoted.filter((label) => !/\d|\bn\b/.test(label));
    expect(fixed.length).toBeGreaterThan(2);
    for (const label of fixed) {
      expect(src.toLowerCase(), `“${label}”`).toContain(label);
    }
  });
});
