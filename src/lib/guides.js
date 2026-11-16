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
            text: 'WPXen adopts a Herd site in place: it serves the same folder, under the same domain, from the same database. Nothing is copied or moved, so your git checkouts, editor workspaces and agent sessions keep working.',
          },
          {
            type: 'p',
            text: 'WPXen reads Herd’s own configuration files to find the sites, so Herd doesn’t need to be running. Only WordPress sites are listed: other Herd projects (Laravel, static sites, Node apps) are left out.',
          },
        ],
      },
      {
        heading: 'Before you start',
        blocks: [
          {
            type: 'list',
            items: [
              'MySQL is running in WPXen (Services). WPXen needs it to find each site’s database.',
              'The PHP version Herd uses is installed in WPXen (PHP Versions). If it isn’t, you can pick another version during the import.',
              'The site’s database is on this Mac’s MySQL (localhost, port 3306). Herd’s free edition has no MySQL of its own, so this is usually already true.',
            ],
          },
        ],
      },
      {
        heading: 'Import a single site',
        blocks: [
          {
            type: 'steps',
            items: [
              'Open Sites and click “From Herd”. The button only appears when Herd is installed.',
              'Every importable site starts ticked. Untick “Select all importable”, then tick the one site you want.',
              'Check the PHP version on the right of its row. A ✓ marks the version Herd uses.',
              'Click “Import 1 site”.',
              'When the row shows a link, click it to open the site.',
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
              'Open Sites and click “From Herd”. Every importable site is already ticked.',
              'Untick any site you want to keep only in Herd.',
              'Adjust the PHP version of any row that needs it.',
              'Click “Import N sites”. Sites are imported one after another, and each row shows its progress.',
              'When it finishes, the summary shows how many were imported. If any failed, click “Retry failed” to go back with just those sites ticked, fix the cause, and import again.',
            ],
          },
          {
            type: 'note',
            tone: 'info',
            text: 'One site failing never stops the rest. Each site is checked on its own, and a site that fails leaves nothing behind.',
          },
        ],
      },
      {
        heading: 'Why a site is greyed out',
        blocks: [
          {
            type: 'table',
            head: ['Message', 'What to do'],
            rows: [
              ['Already in WPXen as …', 'Nothing. That site was imported before.'],
              [
                'Multisite networks are not supported yet',
                'Keep the site in Herd. WPXen serves single sites only.',
              ],
              [
                'wp-config.php has no literal DB_NAME',
                'The database name is computed (for example from getenv). Write it into wp-config.php as plain text, then click Rescan.',
              ],
              [
                'The database is on …, not WPXen’s MySQL',
                'Move the database to this Mac’s MySQL (export and import it), update DB_HOST, then Rescan.',
              ],
              [
                'Database … was not found on WPXen’s MySQL',
                'Check DB_NAME in wp-config.php, or create the database, then Rescan.',
              ],
              [
                'Start MySQL to check this database',
                'Start MySQL in Services, then Rescan.',
              ],
              [
                'WPXen’s nginx already has a config for …',
                'Another WPXen site uses that domain. Remove or rename it first.',
              ],
            ],
          },
        ],
      },
      {
        heading: 'What changes, and what doesn’t',
        blocks: [
          {
            type: 'list',
            items: [
              'WPXen adds its own nginx config for the domain and, where Herd served the site over HTTPS, its own local certificate.',
              'WPXen adds its local-trust mu-plugin to wp-content/mu-plugins, so the site can call other local HTTPS sites.',
              'The site’s files, wp-config.php and database are not changed, and neither is anything in Herd.',
            ],
          },
          {
            type: 'note',
            tone: 'info',
            text: 'Removing an imported site in WPXen only unregisters it: its folder and database stay, because Herd may still use them.',
          },
        ],
      },
      {
        heading: 'After importing',
        blocks: [
          {
            type: 'note',
            tone: 'warning',
            text: 'Quit Herd before you test. While Herd runs, its nginx answers every .test address, WPXen’s sites included.',
          },
          {
            type: 'p',
            text: 'If you plan to uninstall Herd afterwards:',
          },
          {
            type: 'steps',
            items: [
              'Import every WordPress site you want to keep, and check that each one loads with Herd quit.',
              'Back up ~/Herd. Your site folders live there, and the Herd uninstaller may not leave it alone.',
              'Uninstall Herd from its own settings, so its helper service and certificate authority go too.',
              'Remove the lines Herd added to ~/.zshrc: the Herd PATH entry, the HERD_PHP_*_INI_SCAN_DIR exports and NODE_EXTRA_CA_CERTS. Open a new terminal and check that `which php` shows Homebrew’s PHP.',
            ],
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
