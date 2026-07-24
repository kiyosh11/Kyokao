// @ts-nocheck
import { Command, Help } from 'commander';

export const HELP_GROUPS = [
  'Interactive',
  'Agent-assisted',
  'Configuration',
  'Sessions & memory',
  'Providers & themes',
  'Listings',
  'Diagnostics',
  'Integration',
  'Commands',
] as const;
export type HelpGroup = (typeof HELP_GROUPS)[number];

export function withGroup(cmd: Command, group: HelpGroup): Command {
  (cmd as unknown as { helpGroup?: string }).helpGroup = group;
  return cmd;
}

export class GroupedHelp extends Help {
  override formatHelp(cmd: Command, helper: Help): string {

    const visible = helper.visibleCommands(cmd);
    if (visible.length <= 1) return super.formatHelp(cmd, helper);
    const grouped = new Map<HelpGroup, Command[]>();
    for (const group of HELP_GROUPS) grouped.set(group, []);
    for (const sub of visible) {
      const g = ((sub as unknown as { helpGroup?: string }).helpGroup as HelpGroup) ?? 'Commands';
      grouped.get(g)?.push(sub);
    }
    return this.renderGroupedHelp(cmd, helper, grouped);
  }

  private renderGroupedHelp(
    cmd: Command,
    helper: Help,
    grouped: Map<HelpGroup, Command[]>,
  ): string {
    const out: string[] = [];
    out.push(helper.commandUsage(cmd));
    out.push('');
    const description = helper.commandDescription(cmd);
    if (description) {
      out.push(description);
      out.push('');
    }
    for (const group of HELP_GROUPS) {
      const subs = grouped.get(group) ?? [];
      if (!subs.length) continue;
      out.push(`${group}:`);
      for (const sub of subs) {
        const term = helper.subcommandTerm(sub);
        const desc = helper.subcommandDescription(sub);
        const indent = '  ' + term;
        out.push(desc ? (indent.length >= 30 ? `${indent}  ${desc}` : `${indent.padEnd(30)}${desc}`) : indent);
      }
      out.push('');
    }
    const options = helper.visibleOptions(cmd);
    if (options.length) {
      out.push('Options:');
      for (const opt of options) {
        const term = helper.optionTerm(opt);
        const desc = helper.optionDescription(opt);
        const indent = '  ' + term;
        out.push(desc ? (indent.length >= 30 ? `${indent}  ${desc}` : `${indent.padEnd(30)}${desc}`) : indent);
      }
      out.push('');
    }
    return out.join('\n');
  }
}

export function createGroupedHelp(): Help {
  return new GroupedHelp();
}
