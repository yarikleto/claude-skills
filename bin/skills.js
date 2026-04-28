#!/usr/bin/env node
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkbox, confirm, select } from '@inquirer/prompts';
import pc from 'picocolors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

const SCOPES = {
  user: {
    key: 'user',
    label: 'User',
    target: path.join(homedir(), '.claude', 'skills'),
    display: '~/.claude/skills',
    hint: 'available across all projects',
  },
  project: {
    key: 'project',
    label: 'Project',
    target: path.join(process.cwd(), '.claude', 'skills'),
    display: './.claude/skills',
    hint: 'only the current working directory',
  },
};

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function discoverSkills() {
  let entries;
  try {
    entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const content = await fs.readFile(skillMd, 'utf8');
    const fm = parseFrontmatter(content);
    skills.push({
      slug: entry.name,
      name: fm.name || entry.name,
      description: (fm.description || '').replace(/\s+/g, ' ').trim(),
      dir: path.join(SKILLS_DIR, entry.name),
    });
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug));
  return skills;
}

function isInstalled(slug, scopeKey) {
  return existsSync(path.join(SCOPES[scopeKey].target, slug));
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isSymbolicLink()) await fs.symlink(await fs.readlink(s), d);
    else await fs.copyFile(s, d);
  }
}

async function installSkill(skill, scopeKey) {
  const dest = path.join(SCOPES[scopeKey].target, skill.slug);
  const wasInstalled = existsSync(dest);
  if (wasInstalled) await fs.rm(dest, { recursive: true, force: true });
  await copyDir(skill.dir, dest);
  return { dest, replaced: wasInstalled };
}

async function uninstallSkill(slug, scopeKey) {
  const dest = path.join(SCOPES[scopeKey].target, slug);
  if (!existsSync(dest)) return { dest, removed: false };
  await fs.rm(dest, { recursive: true, force: true });
  return { dest, removed: true };
}

function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + '…';
}

function tildify(p) {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function header(text) {
  return pc.bold(pc.cyan(text));
}

function tag(scopeKey) {
  return scopeKey === 'user' ? pc.magenta('user') : pc.yellow('project');
}

function printBanner() {
  console.log();
  console.log(`${header('claude-skills')} ${pc.dim('· @yarikleto/claude-skills')}`);
  console.log();
}

function parseArgs(argv) {
  const args = {
    command: null,
    names: [],
    scope: null,
    yes: false,
    help: false,
    version: false,
  };
  const tokens = argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-h' || t === '--help') args.help = true;
    else if (t === '-v' || t === '--version') args.version = true;
    else if (t === '-y' || t === '--yes') args.yes = true;
    else if (t === '--scope') args.scope = tokens[++i];
    else if (t.startsWith('--scope=')) args.scope = t.slice('--scope='.length);
    else if (!args.command) args.command = t;
    else args.names.push(t);
  }
  return args;
}

const HELP_TEXT = `${pc.bold('claude-skills')} ${pc.dim('— install Claude Code skills from @yarikleto/claude-skills')}

${pc.bold('Usage')}
  ${pc.cyan('claude-skills')}                       interactive menu
  ${pc.cyan('claude-skills list')}                  show all skills + installed state
  ${pc.cyan('claude-skills add')} ${pc.dim('[names...]')}        install one or more skills
  ${pc.cyan('claude-skills remove')} ${pc.dim('[names...]')}     uninstall one or more skills

${pc.bold('Options')}
  ${pc.cyan('--scope <user|project>')}   target install location (default: prompt)
  ${pc.cyan('-y, --yes')}                skip confirmation prompts
  ${pc.cyan('-h, --help')}               show this help
  ${pc.cyan('-v, --version')}            print version

${pc.bold('Scopes')}
  ${pc.magenta('user')}     ${pc.dim('~/.claude/skills/')}      ${pc.dim('available across all projects')}
  ${pc.yellow('project')}  ${pc.dim('./.claude/skills/')}      ${pc.dim('only the current working dir')}
`;

async function readVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

function ensureTTY() {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(
      pc.red('error: ') +
        'interactive prompt is unavailable in this environment. Pass --scope and skill names explicitly.',
    );
    process.exit(2);
  }
}

async function pickScope({ message = 'Pick a scope' } = {}) {
  return select({
    message,
    choices: [
      {
        name: `${pc.bold('User')} ${pc.dim('— ' + SCOPES.user.display + ' · ' + SCOPES.user.hint)}`,
        value: 'user',
        short: 'user',
      },
      {
        name: `${pc.bold('Project')} ${pc.dim('— ' + SCOPES.project.display + ' · ' + SCOPES.project.hint)}`,
        value: 'project',
        short: 'project',
      },
    ],
  });
}

function skillCheckboxItem(skill, scopeKey, { onlyInstalled = false } = {}) {
  const installed = isInstalled(skill.slug, scopeKey);
  if (onlyInstalled && !installed) return null;
  const desc = truncate(skill.description, 90);
  const marker = installed ? pc.green('✓ ') : '  ';
  const trailing = !onlyInstalled && installed ? ' ' + pc.dim('(installed)') : '';
  return {
    name: `${marker}${pc.bold(skill.slug)}${trailing}\n   ${pc.dim(desc)}`,
    value: skill.slug,
    short: skill.slug,
    checked: false,
    disabled: onlyInstalled && !installed ? pc.dim('(not installed)') : false,
  };
}

function findSkillsByNames(skills, names) {
  const found = [];
  const missing = [];
  for (const requested of names) {
    const skill = skills.find((s) => s.slug === requested || s.name === requested);
    if (skill) found.push(skill);
    else missing.push(requested);
  }
  return { found, missing };
}

async function commandList() {
  const skills = await discoverSkills();
  printBanner();
  if (!skills.length) {
    console.log(pc.dim('No skills found in this repo.'));
    return 0;
  }

  const widths = {
    slug: Math.max(4, ...skills.map((s) => s.slug.length)),
  };
  const userPath = tildify(SCOPES.user.target);
  const projPath = tildify(SCOPES.project.target);
  const headerLine =
    pc.dim(
      `${'SKILL'.padEnd(widths.slug)}   USER  PROJ   DESCRIPTION`,
    );
  console.log(headerLine);
  console.log(pc.dim('─'.repeat(Math.min(process.stdout.columns || 80, 100))));
  for (const skill of skills) {
    const u = isInstalled(skill.slug, 'user') ? pc.green(' ✓ ') : pc.dim(' · ');
    const p = isInstalled(skill.slug, 'project') ? pc.green(' ✓ ') : pc.dim(' · ');
    const cols = process.stdout.columns || 80;
    const descRoom = Math.max(20, cols - widths.slug - 14);
    console.log(
      `${pc.bold(skill.slug.padEnd(widths.slug))}    ${u}   ${p}  ${pc.dim(truncate(skill.description, descRoom))}`,
    );
  }
  console.log();
  console.log(`${pc.magenta('user')}    ${pc.dim(userPath)}`);
  console.log(`${pc.yellow('project')} ${pc.dim(projPath)}`);
  return 0;
}

async function performInstall(skills, scopeKey) {
  const results = [];
  for (const skill of skills) {
    const r = await installSkill(skill, scopeKey);
    results.push({ skill, ...r });
  }
  console.log();
  for (const r of results) {
    const verb = r.replaced ? pc.yellow('reinstalled') : pc.green('installed');
    console.log(`  ${verb} ${pc.bold(r.skill.slug)} ${pc.dim('→ ' + tildify(r.dest))}`);
  }
  console.log();
  return results;
}

async function performRemove(slugs, scopeKey) {
  const results = [];
  for (const slug of slugs) {
    const r = await uninstallSkill(slug, scopeKey);
    results.push({ slug, ...r });
  }
  console.log();
  for (const r of results) {
    if (r.removed)
      console.log(`  ${pc.red('removed')}     ${pc.bold(r.slug)} ${pc.dim('← ' + tildify(r.dest))}`);
    else
      console.log(
        `  ${pc.dim('skipped')}     ${pc.bold(r.slug)} ${pc.dim('(not installed at ' + tildify(r.dest) + ')')}`,
      );
  }
  console.log();
  return results;
}

async function commandAdd({ names, scope, yes }) {
  const skills = await discoverSkills();
  if (!skills.length) {
    console.error(pc.red('error: ') + 'no skills found in this repo.');
    return 1;
  }

  let chosen;
  let scopeKey = scope;

  if (names.length) {
    const { found, missing } = findSkillsByNames(skills, names);
    if (missing.length) {
      console.error(
        pc.red('error: ') +
          `unknown skill${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      );
      console.error(
        pc.dim('available: ') + skills.map((s) => s.slug).join(', '),
      );
      return 1;
    }
    chosen = found;
  }

  if (!scopeKey) {
    ensureTTY();
    printBanner();
    scopeKey = await pickScope({ message: 'Install where?' });
  }
  if (!SCOPES[scopeKey]) {
    console.error(pc.red('error: ') + `invalid scope "${scopeKey}". Use "user" or "project".`);
    return 1;
  }

  if (!chosen) {
    ensureTTY();
    const items = skills.map((s) => skillCheckboxItem(s, scopeKey)).filter(Boolean);
    const picked = await checkbox({
      message: `Skills to install into ${tag(scopeKey)} ${pc.dim('(' + tildify(SCOPES[scopeKey].target) + ')')}`,
      choices: items,
      pageSize: Math.min(20, items.length + 1),
      required: true,
      instructions: pc.dim(
        ' ↑/↓ navigate · space toggle · a all · i invert · enter confirm',
      ),
    });
    chosen = skills.filter((s) => picked.includes(s.slug));
  }

  if (!chosen.length) return 0;

  const willOverwrite = chosen.filter((s) => isInstalled(s.slug, scopeKey));
  if (willOverwrite.length && !yes && process.stdout.isTTY) {
    const ok = await confirm({
      message: `${willOverwrite.length} skill${willOverwrite.length > 1 ? 's are' : ' is'} already installed (${willOverwrite
        .map((s) => s.slug)
        .join(', ')}). Reinstall?`,
      default: true,
    });
    if (!ok) {
      chosen = chosen.filter((s) => !isInstalled(s.slug, scopeKey));
      if (!chosen.length) {
        console.log(pc.dim('Nothing to do.'));
        return 0;
      }
    }
  }

  await performInstall(chosen, scopeKey);
  return 0;
}

async function commandRemove({ names, scope, yes }) {
  const skills = await discoverSkills();
  let scopeKey = scope;
  let chosen;

  if (names.length) {
    chosen = names;
  }

  if (!scopeKey) {
    ensureTTY();
    printBanner();
    scopeKey = await pickScope({ message: 'Remove from where?' });
  }
  if (!SCOPES[scopeKey]) {
    console.error(pc.red('error: ') + `invalid scope "${scopeKey}". Use "user" or "project".`);
    return 1;
  }

  if (!chosen) {
    ensureTTY();
    const items = skills.map((s) => skillCheckboxItem(s, scopeKey, { onlyInstalled: true })).filter(Boolean);
    const installed = items.filter((it) => !it.disabled);
    if (!installed.length) {
      console.log(
        pc.dim(`No skills installed in ${tag(scopeKey)} (${tildify(SCOPES[scopeKey].target)}).`),
      );
      return 0;
    }
    const picked = await checkbox({
      message: `Skills to remove from ${tag(scopeKey)} ${pc.dim('(' + tildify(SCOPES[scopeKey].target) + ')')}`,
      choices: installed,
      pageSize: Math.min(20, installed.length + 1),
      required: true,
      instructions: pc.dim(
        ' ↑/↓ navigate · space toggle · a all · i invert · enter confirm',
      ),
    });
    chosen = picked;
  }

  if (!chosen.length) return 0;

  const present = chosen.filter((slug) => isInstalled(slug, scopeKey));
  if (!present.length) {
    console.log(
      pc.dim(`Nothing to remove — none of those are installed in ${tag(scopeKey)}.`),
    );
    return 0;
  }

  if (!yes && process.stdout.isTTY) {
    const ok = await confirm({
      message: `Remove ${present.length} skill${present.length > 1 ? 's' : ''} from ${SCOPES[scopeKey].label.toLowerCase()} scope?`,
      default: true,
    });
    if (!ok) return 0;
  }

  await performRemove(chosen, scopeKey);
  return 0;
}

async function interactiveMenu() {
  printBanner();
  while (true) {
    const action = await select({
      message: 'What do you want to do?',
      choices: [
        { name: `${pc.green('Add')} skills`, value: 'add' },
        { name: `${pc.red('Remove')} skills`, value: 'remove' },
        { name: `${pc.cyan('List')} skills`, value: 'list' },
        { name: pc.dim('Quit'), value: 'quit' },
      ],
    });
    if (action === 'quit') return 0;
    if (action === 'list') {
      await commandList();
    } else if (action === 'add') {
      await commandAdd({ names: [], scope: null, yes: false });
    } else if (action === 'remove') {
      await commandRemove({ names: [], scope: null, yes: false });
    }

    const again = await confirm({
      message: 'Anything else?',
      default: false,
    });
    if (!again) return 0;
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.version) {
    console.log(await readVersion());
    return 0;
  }
  if (args.scope && !SCOPES[args.scope]) {
    console.error(pc.red('error: ') + `invalid --scope "${args.scope}". Use "user" or "project".`);
    return 1;
  }

  switch (args.command) {
    case null:
    case undefined:
      ensureTTY();
      return interactiveMenu();
    case 'list':
    case 'ls':
      return commandList();
    case 'add':
    case 'install':
      return commandAdd(args);
    case 'remove':
    case 'rm':
    case 'uninstall':
      return commandRemove(args);
    default:
      console.error(pc.red('error: ') + `unknown command "${args.command}"`);
      process.stdout.write('\n' + HELP_TEXT);
      return 1;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    if (err && err.name === 'ExitPromptError') {
      console.log();
      console.log(pc.dim('Cancelled.'));
      process.exit(130);
    }
    console.error(pc.red('error: ') + (err?.message || err));
    process.exit(1);
  });
