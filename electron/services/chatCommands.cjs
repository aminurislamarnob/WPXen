const fs = require('fs');
const path = require('path');
const os = require('os');

// Each Agent's own built-in commands — the CLIs publish no machine-readable
// catalog, so these are curated (ported from Orca's
// native-chat-slash-commands.ts). An Agent without a list gets the commands
// every TUI here has.
const COMMON_COMMANDS = [
  { name: '/clear', description: 'Clear the conversation' },
  { name: '/help', description: 'Show available commands' },
];

const CLAUDE_COMMANDS = [
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Summarize and compact the conversation' },
  { name: '/init', description: 'Initialize a CLAUDE.md' },
  // The chat's own model picker sends /model.
  { name: '/model', description: 'Change the model' },
  { name: '/review', description: 'Review the current changes' },
  { name: '/help', description: 'Show available commands' },
];

const CODEX_COMMANDS = [
  ['model', 'Choose the model and reasoning effort'],
  ['ide', 'Include IDE context'],
  ['permissions', 'Choose what Codex is allowed to do'],
  ['keymap', 'Remap TUI shortcuts'],
  ['vim', 'Toggle Vim mode'],
  ['experimental', 'Toggle experimental features'],
  ['approve', 'Approve one auto-review retry'],
  ['memories', 'Configure memory use'],
  ['skills', 'Manage and use skills'],
  ['import', 'Import setup from Claude Code'],
  ['hooks', 'View lifecycle hooks'],
  ['review', 'Review the current changes'],
  ['rename', 'Rename the current thread'],
  ['new', 'Start a new chat'],
  ['archive', 'Archive this session and exit'],
  ['delete', 'Delete this session and exit'],
  ['resume', 'Resume a saved chat'],
  ['fork', 'Fork the current chat'],
  ['app', 'Continue in Codex Desktop'],
  ['init', 'Create an AGENTS.md file'],
  ['compact', 'Compact the conversation'],
  ['plan', 'Switch to Plan mode'],
  ['goal', 'Set or view the goal'],
  ['agent', 'Switch the active agent thread'],
  ['side', 'Start a side conversation'],
  ['copy', 'Copy the last response as markdown'],
  ['raw', 'Toggle raw scrollback mode'],
  ['diff', 'Show the working diff'],
  ['mention', 'Mention a file'],
  ['status', 'Show session configuration and usage'],
  ['usage', 'View account usage'],
  ['title', 'Configure the terminal title'],
  ['statusline', 'Configure the status line'],
  ['theme', 'Choose a syntax highlighting theme'],
  ['pets', 'Choose or hide the terminal pet'],
  ['mcp', 'List configured MCP tools'],
  ['plugins', 'Browse plugins'],
  ['logout', 'Log out of Codex'],
  ['exit', 'Exit Codex'],
  ['feedback', 'Send logs to maintainers'],
  ['ps', 'List background terminals'],
  ['stop', 'Stop all background terminals'],
  ['clear', 'Clear the terminal and start a new chat'],
  ['personality', 'Choose a communication style'],
  ['subagents', 'Switch the active agent thread'],
].map(([name, description]) => ({ name: `/${name}`, description }));

// Per chat kind (the registry's `chat`): its built-ins, and the config
// folders — under home and under the Site — whose commands/ and skills/
// it reads. Only an Agent's own folders: Claude never lists Antigravity's
// commands and the other way round.
const AGENT_COMMANDS = {
  claude: { builtIn: CLAUDE_COMMANDS, dirs: ['.claude'] },
  codex: { builtIn: CODEX_COMMANDS, dirs: [] },
  antigravity: { builtIn: COMMON_COMMANDS, dirs: ['.gemini/antigravity-cli'] },
};

function readFrontmatterName(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/);
    if (match) {
      const lines = match[1].split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('name:')) {
          return line
            .replace(/^name:\s*/, '')
            .replace(/^['"](.*)['"]$/, '$1')
            .trim();
        }
      }
    }
  } catch {}
  return null;
}

function findCustom(dir, ext = '.md') {
  let results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const d of entries) {
      if (d.isDirectory()) {
        results = results.concat(findCustom(path.join(dir, d.name), ext));
      } else if (d.isFile() && d.name.endsWith(ext)) {
        results.push(path.join(dir, d.name));
      }
    }
  } catch {}
  return results;
}

function listCommands(rootPath, agent, { home = os.homedir() } = {}) {
  const entry = AGENT_COMMANDS[agent] || { builtIn: COMMON_COMMANDS, dirs: [] };
  const commands = [...entry.builtIn];

  const searchDirs = entry.dirs.map((d) => path.join(home, d));
  if (rootPath) searchDirs.push(...entry.dirs.map((d) => path.join(rootPath, d)));

  for (const base of searchDirs) {
    // Custom commands
    const cmdsDir = path.join(base, 'commands');
    const cmdFiles = findCustom(cmdsDir);
    for (const file of cmdFiles) {
      let rel = path.relative(cmdsDir, file);
      rel = rel.replace(/\\/g, '/').replace(/\.md$/, '').replace(/\//g, ':');
      commands.push({ name: `/${rel}`, description: 'Custom command' });
    }

    // Skills
    const skillsDir = path.join(base, 'skills');
    const skillFiles = findCustom(skillsDir, 'SKILL.md');
    for (const file of skillFiles) {
      const name = readFrontmatterName(file);
      if (name) {
        commands.push({ name: `/${name}`, description: 'Skill' });
      } else {
        // Fallback to directory name
        const dirName = path.basename(path.dirname(file));
        commands.push({ name: `/${dirName}`, description: 'Skill' });
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  return commands.filter((c) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
}

module.exports = { listCommands };
