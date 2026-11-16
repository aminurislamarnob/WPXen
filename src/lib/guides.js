// In-app guides, shown under Settings → Help → Guides.
//
// Each guide is plain data, so the list, the reader, the settings search and
// the tests all read one source. A guide is `{ id, title, summary, keywords,
// action?, sections: [{ heading, blocks }] }`, and a block is one of:
//
//   { type: 'p', text }                 a paragraph
//   { type: 'steps', items: [text] }    a numbered procedure
//   { type: 'list', items: [text] }     bullet points
//   { type: 'note', tone, text }        a callout; tone 'info' | 'warning'
//   { type: 'table', head: [a, b], rows: [[a, b]] }
//   { type: 'code', text }              a shell command, with a Copy button
//
// `action` is an optional button at the top of the guide: `{ label, to,
// state }`, a route inside the app. Text is plain: write the UI's own labels
// in quotes so a reader can find them on screen.
//
// Adding a guide is appending it here: settingsRegistry.js builds each
// guide's search entry (`guides.<id>`) from this list.

export const GUIDES = [
  {
    id: 'herd-import',
    title: 'Import sites from Laravel Herd',
    summary:
      'Move your Herd WordPress sites into WPXen, one at a time or all at once, without copying anything.',
    keywords: ['herd', 'laravel', 'valet', 'import', 'bulk', 'migrate', 'move', 'adopt'],
    action: { label: 'Open the Herd import', to: '/sites', state: { openHerd: true } },
    sections: [
      {
        heading: 'How it works',
        blocks: [
          {
            type: 'p',
            text: 'WPXen serves each Herd WordPress site in place: same folder, domain and database. Nothing is copied, and Herd’s files are not changed. WPXen only adds its own nginx config, an HTTPS certificate if Herd had one, and its local-trust mu-plugin.',
          },
          {
            type: 'note',
            tone: 'info',
            text: 'Needs MySQL running in WPXen, with the site’s database on this Mac (localhost:3306). Removing an imported site only unregisters it.',
          },
        ],
      },
      {
        heading: 'Import a single site',
        blocks: [
          {
            type: 'steps',
            items: [
              'On Sites, click “From Herd”.',
              'Untick “Select all importable”, tick one site and check its PHP version (✓ is Herd’s).',
              'Click “Import 1 site”, then open it from the link on its row.',
            ],
          },
        ],
      },
      {
        heading: 'Import several sites at once',
        blocks: [
          {
            type: 'steps',
            items: [
              'On Sites, click “From Herd”. Every importable site is already ticked.',
              'Untick any you want to leave in Herd, and adjust PHP per row.',
              'Click “Import N sites”. If any fail, fix the cause and click “Retry failed”.',
            ],
          },
        ],
      },
      {
        heading: 'Why a site is greyed out',
        blocks: [
          {
            type: 'table',
            head: ['Reason', 'Fix'],
            rows: [
              ['Already in WPXen', 'Nothing to do.'],
              ['Multisite networks are not supported', 'Keep it in Herd.'],
              ['No literal DB_NAME', 'Write DB_NAME into wp-config.php as plain text.'],
              [
                'Database is not on WPXen’s MySQL',
                'Move it to localhost:3306 and update DB_HOST.',
              ],
              ['Database was not found', 'Fix DB_NAME, or create the database.'],
              ['Start MySQL to check this database', 'Start MySQL in Services.'],
              [
                'nginx already has a config for it',
                'Remove or rename the other WPXen site.',
              ],
            ],
          },
          { type: 'p', text: 'After fixing, click Rescan.' },
        ],
      },
      {
        heading: 'After importing',
        blocks: [
          {
            type: 'note',
            tone: 'warning',
            text: 'Quit Herd before testing: while it runs, its nginx answers every .test address.',
          },
          {
            type: 'p',
            text: 'To uninstall Herd, back up ~/Herd first, then use Herd’s own uninstaller. Then remove the lines Herd added to ~/.zshrc: each sits under a `# Herd injected …` comment, and `NODE_EXTRA_CA_CERTS` points at Herd’s certificate. Run this in Terminal. It keeps a backup at ~/.zshrc.bak:',
          },
          {
            type: 'code',
            text: "cp ~/.zshrc ~/.zshrc.bak && sed -i '' -e '/^# Herd injected/{N;d;}' -e '/Application Support\\/Herd/d' ~/.zshrc",
          },
          {
            type: 'p',
            text: 'Open a new Terminal window and check: `grep -i herd ~/.zshrc` should print nothing, and `which php` should show Homebrew’s PHP. If anything breaks, restore with `cp ~/.zshrc.bak ~/.zshrc`.',
          },
        ],
      },
    ],
  },
];

export function findGuide(id) {
  return GUIDES.find((g) => g.id === id) || null;
}

// Everything a guide says, lowercased, for the settings search.
export function guideText(guide) {
  const parts = [guide.title, guide.summary, ...guide.keywords];
  for (const section of guide.sections) {
    parts.push(section.heading);
    for (const b of section.blocks) {
      if (b.text) parts.push(b.text);
      if (b.items) parts.push(...b.items);
      if (b.head) parts.push(...b.head);
      if (b.rows) parts.push(...b.rows.flat());
    }
  }
  return parts.join(' ').toLowerCase();
}
