const fs = require('fs');
const path = require('path');
const os = require('os');

const BUILT_IN_COMMANDS = [
  { name: '/clear', description: 'Clear the context and start a new conversation' },
  { name: '/compact', description: 'Compact the context' },
  { name: '/model', description: 'Change the model' },
  { name: '/review', description: 'Review code' },
  { name: '/bug', description: 'Report a bug' },
  { name: '/help', description: 'Show help' },
  { name: '/exit', description: 'Exit the conversation' },
  { name: '/history', description: 'Show history' },
  { name: '/resume', description: 'Resume a conversation' },
  { name: '/goal', description: 'Set an overarching goal' },
  { name: '/schedule', description: 'Schedule a recurring task' },
  { name: '/plan', description: 'Plan step by step' },
];

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

function listCommands(rootPath) {
  const commands = [...BUILT_IN_COMMANDS];

  const searchDirs = [
    path.join(os.homedir(), '.claude'),
    path.join(os.homedir(), '.gemini', 'antigravity-cli'),
  ];
  if (rootPath) {
    searchDirs.push(path.join(rootPath, '.claude'));
    searchDirs.push(path.join(rootPath, '.gemini', 'antigravity-cli'));
  }

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
