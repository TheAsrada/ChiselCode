export interface ShellAnalysis {
  commands: { executable: string; args: string[] }[];
  operators: string[];
  redirects: string[];
  dynamicExpansion: boolean;
}
/** Deliberately conservative: only a single literal argv command can match an allow rule. */
export function analyzeShell(command: string): ShellAnalysis {
  const operators = command.match(/&&|\|\||[;|()\r\n]/g) ?? [];
  const redirects = command.match(/>>?|<<?/g) ?? [];
  const dynamicExpansion = /[$`%!]|\\[\r\n]/.test(command);
  const words: string[] = [];
  const expression = /"([^"\\]*)"|'([^']*)'|([^\s"']+)/g;
  for (const match of command.matchAll(expression))
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  return {
    commands: words.length
      ? [{ executable: words[0] ?? "", args: words.slice(1) }]
      : [],
    operators,
    redirects,
    dynamicExpansion,
  };
}
export function simpleCommand(command: string): boolean {
  const analysis = analyzeShell(command);
  return (
    analysis.commands.length === 1 &&
    !analysis.operators.length &&
    !analysis.redirects.length &&
    !analysis.dynamicExpansion &&
    !/[\\]/.test(command) &&
    (command.match(/"/g)?.length ?? 0) % 2 === 0 &&
    (command.match(/'/g)?.length ?? 0) % 2 === 0
  );
}
export function commandMatches(command: string, rule: string): boolean {
  if (!simpleCommand(command) || !simpleCommand(rule)) return false;
  const actual = analyzeShell(command).commands[0];
  const expected = analyzeShell(rule).commands[0];
  return (
    actual?.executable === expected?.executable &&
    !!expected &&
    expected.args.every((arg, index) => actual?.args[index] === arg)
  );
}
