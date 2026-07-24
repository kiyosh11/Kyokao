import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTINS,
  loadTemplates,
  renderTemplate,
  type AgentTemplate,
} from '../packages/cli/src/templates.js';

describe('renderTemplate', () => {
  const base: AgentTemplate = {
    name: 'demo',
    description: 'd',
    body: 'Hello {{args}}',
  };

  it('substitutes {{args}} with the joined prompt', () => {
    expect(renderTemplate(base, ['fix', 'the bug'], {})).toBe('Hello fix the bug');
  });

  it('handles an empty args list', () => {
    expect(renderTemplate(base, [], {})).toBe('Hello');
  });

  it('substitutes {{flags.<name>}} with the parsed flag value', () => {
    const t: AgentTemplate = { ...base, body: 'msg={{flags.message}}' };
    expect(renderTemplate(t, [], { message: 'ship it' })).toBe('msg=ship it');
  });

  it('includes {{#flags.x}}…{{/flags.x}} only when the flag is set', () => {
    const t: AgentTemplate = {
      ...base,
      body: 'start{{#flags.dryRun}} dry{{/flags.dryRun}} end',
    };
    expect(renderTemplate(t, [], { dryRun: true })).toBe('start dry end');
    expect(renderTemplate(t, [], { dryRun: false })).toBe('start end');
    expect(renderTemplate(t, [], {})).toBe('start end');
  });

  it('renders the {{#passthrough}}…{{/passthrough}} block when -- args are present', () => {
    const t: AgentTemplate = {
      ...base,
      passthrough: true,
      body: 'run{{#passthrough}} with: {{passthrough}}{{/passthrough}}',
    };
    expect(renderTemplate(t, [], {}, ['--pattern', '*.test.ts'])).toBe(
      'run with: --pattern *.test.ts',
    );
    expect(renderTemplate(t, [], {}, [])).toBe('run');
  });

  it('commit built-in: --message flows into the prompt', () => {
    const commit = BUILTINS.find((t) => t.name === 'commit')!;
    const rendered = renderTemplate(commit, ['focus on auth'], { message: 'fix login' });
    expect(rendered).toContain('fix login');
    expect(rendered).toContain('focus on auth');
  });

  it('commit built-in: --no-verify omits verification', () => {
    const commit = BUILTINS.find((t) => t.name === 'commit')!;
    expect(renderTemplate(commit, [], { noVerify: true })).toContain('Skip pre-commit');
    expect(renderTemplate(commit, [], { noVerify: false })).not.toContain('Skip pre-commit');
  });

  it('review built-in: --base flows into the prompt', () => {
    const review = BUILTINS.find((t) => t.name === 'review')!;
    expect(renderTemplate(review, [], { base: 'main' })).toContain('main');
  });

  it('test built-in: passthrough args flow into the prompt', () => {
    const testTpl = BUILTINS.find((t) => t.name === 'test')!;
    expect(renderTemplate(testTpl, [], {}, ['--grep', 'auth'])).toContain('--grep auth');
  });
});

describe('loadTemplates', () => {
  it('returns built-ins when no commands dir exists', async () => {
    const loaded = await loadTemplates(join(tmpdir(), `kyokao-none-${Date.now()}`));
    expect(loaded.map((t) => t.name).sort()).toEqual(['commit', 'explain', 'review', 'test']);
  });

  it('a user .md file overrides the built-in of the same name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-templates-'));
    await mkdir(join(dir), { recursive: true });
    await writeFile(
      join(dir, 'commit.md'),
      'Custom commit description\nCustom commit body: {{args}}',
    );
    const loaded = await loadTemplates(dir);
    const commit = loaded.find((t) => t.name === 'commit');
    expect(commit?.description).toBe('Custom commit description');
    expect(commit?.body).toContain('Custom commit body');
  });

  it('a user .md file can introduce a brand-new verb', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-templates-'));
    await mkdir(join(dir), { recursive: true });
    await writeFile(join(dir, 'refactor.md'), 'Refactor something\nRefactor: {{args}}');
    const loaded = await loadTemplates(dir);
    expect(loaded.map((t) => t.name)).toContain('refactor');
  });

  it('ignores files with invalid verb names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-templates-'));
    await mkdir(join(dir), { recursive: true });

    await writeFile(join(dir, 'UPPER.md'), 'bad\nbad');
    await writeFile(join(dir, '1digit.md'), 'bad\nbad');

    await writeFile(join(dir, 'has-space.md'), 'ok\nok body');
    const loaded = await loadTemplates(dir);
    expect(loaded.find((t) => t.name === 'UPPER')).toBeUndefined();
    expect(loaded.find((t) => t.name === '1digit')).toBeUndefined();
    expect(loaded.find((t) => t.name === 'has-space')).toBeDefined();
  });

  it('ignores non-markdown files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-templates-'));
    await mkdir(join(dir), { recursive: true });
    await writeFile(join(dir, 'commit.txt'), 'not markdown\nbody');
    const loaded = await loadTemplates(dir);
    const commit = loaded.find((t) => t.name === 'commit');
    expect(commit?.body).not.toContain('not markdown');
  });
});
