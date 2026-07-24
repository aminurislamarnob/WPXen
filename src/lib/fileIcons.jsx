import {
  File,
  FileCode,
  FileJson,
  FileText,
  FileImage,
  FileCog,
  FileTerminal,
  FileLock,
  FileArchive,
  FileKey,
  Database,
  Package,
  BookOpen,
  GitBranch,
} from 'lucide-react';

// Map a file's extension to a lucide icon + a recognisable brand-ish colour,
// so the tree reads like VS Code / Superset. Folders are handled by the tree
// itself; this is only for files.
const BY_EXT = {
  js: [FileCode, '#f0db4f'],
  mjs: [FileCode, '#f0db4f'],
  cjs: [FileCode, '#f0db4f'],
  jsx: [FileCode, '#61dafb'],
  ts: [FileCode, '#3178c6'],
  tsx: [FileCode, '#61dafb'],
  json: [FileJson, '#cbcb41'],
  html: [FileCode, '#e34c26'],
  htm: [FileCode, '#e34c26'],
  xml: [FileCode, '#e34c26'],
  vue: [FileCode, '#41b883'],
  svg: [FileImage, '#ffb13b'],
  css: [FileCode, '#2965f1'],
  scss: [FileCode, '#cd6799'],
  sass: [FileCode, '#cd6799'],
  less: [FileCode, '#2965f1'],
  php: [FileCode, '#8892bf'],
  py: [FileCode, '#3572a5'],
  rb: [FileCode, '#cc342d'],
  go: [FileCode, '#00add8'],
  rs: [FileCode, '#dea584'],
  java: [FileCode, '#b07219'],
  c: [FileCode, '#555555'],
  cpp: [FileCode, '#f34b7d'],
  sh: [FileTerminal, '#4eaa25'],
  bash: [FileTerminal, '#4eaa25'],
  zsh: [FileTerminal, '#4eaa25'],
  sql: [Database, '#dad8d8'],
  yml: [FileCog, '#cb171e'],
  yaml: [FileCog, '#cb171e'],
  toml: [FileCog, '#9c4221'],
  ini: [FileCog, '#8a8a8a'],
  conf: [FileCog, '#8a8a8a'],
  md: [FileText, '#519aba'],
  markdown: [FileText, '#519aba'],
  txt: [FileText, '#9aa0a6'],
  log: [FileText, '#9aa0a6'],
  png: [FileImage, '#a074c4'],
  jpg: [FileImage, '#a074c4'],
  jpeg: [FileImage, '#a074c4'],
  gif: [FileImage, '#a074c4'],
  webp: [FileImage, '#a074c4'],
  ico: [FileImage, '#a074c4'],
  zip: [FileArchive, '#f0c674'],
  tar: [FileArchive, '#f0c674'],
  gz: [FileArchive, '#f0c674'],
  tgz: [FileArchive, '#f0c674'],
  env: [FileKey, '#e5c07b'],
  key: [FileKey, '#e5c07b'],
  pem: [FileKey, '#e5c07b'],
  lock: [FileLock, '#8a8a8a'],
};

// Exact filename overrides (win over extension matching).
const BY_NAME = {
  'package.json': [Package, '#cb3837'],
  'package-lock.json': [FileLock, '#cb3837'],
  'composer.json': [Package, '#885630'],
  'composer.lock': [FileLock, '#885630'],
  dockerfile: [FileCode, '#2496ed'],
  '.gitignore': [GitBranch, '#f14e32'],
  '.gitattributes': [GitBranch, '#f14e32'],
  '.env': [FileKey, '#e5c07b'],
  'readme.md': [BookOpen, '#519aba'],
  'readme': [BookOpen, '#519aba'],
  'license': [FileText, '#cbcb41'],
};

function lookup(name) {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return BY_EXT[ext] || [File, '#9aa0a6'];
}

// Render a file's type icon. `size`/`className` mirror a lucide icon's props.
export function FileGlyph({ name, size = 14, className = '' }) {
  const [Icon, color] = lookup(name);
  return <Icon size={size} className={className} style={{ color }} />;
}
