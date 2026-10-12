/** Quote one argv value for the actual CMD/POSIX shell used by run_shell. */
export function quoteShellArg(value: string): string {
  if (process.platform === "win32")
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
