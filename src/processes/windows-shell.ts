/** Fixed byte transport. The approved command is data, not PowerShell source.
 * Keep Bun's Windows process job alive until core confirms owned-tree cleanup. */
export const WINDOWS_SHELL_TRANSPORT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$command = [Environment]::GetEnvironmentVariable('CHISEL_SHELL_COMMAND')
$executable = [Environment]::GetEnvironmentVariable('CHISEL_SHELL_EXECUTABLE')
$cwd = [Environment]::GetEnvironmentVariable('CHISEL_SHELL_CWD')
[Environment]::SetEnvironmentVariable('CHISEL_SHELL_COMMAND', $null)
[Environment]::SetEnvironmentVariable('CHISEL_SHELL_EXECUTABLE', $null)
[Environment]::SetEnvironmentVariable('CHISEL_SHELL_CWD', $null)
function Send-Frame($frame) {
  [Console]::Out.WriteLine(($frame | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $executable
$info.WorkingDirectory = $cwd
$info.Arguments = '/d /s /c "' + $command + '"'
$info.UseShellExecute = $false
# Inherit the transport's hidden console after configuring its code page.
$info.CreateNoWindow = $false
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $info
try {
  if (-not $child.Start()) { throw 'Не удалось запустить CMD.' }
  $null = $child.Handle
  $child.StandardInput.Close()
  Send-Frame @{type='started'; pid=$child.Id}
  $outBuffer = New-Object byte[] 4096
  $errBuffer = New-Object byte[] 4096
  $outOpen = $true
  $errOpen = $true
  $exitSent = $false
  $outRead = $child.StandardOutput.BaseStream.ReadAsync($outBuffer, 0, $outBuffer.Length)
  $errRead = $child.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
  while ($outOpen -or $errOpen -or -not $exitSent) {
    if ($outOpen -and $outRead.IsCompleted) {
      $count = $outRead.GetAwaiter().GetResult()
      if ($count -eq 0) { $outOpen = $false }
      else {
        Send-Frame @{type='output'; stream='stdout'; data=[Convert]::ToBase64String($outBuffer, 0, $count)}
        $outRead = $child.StandardOutput.BaseStream.ReadAsync($outBuffer, 0, $outBuffer.Length)
      }
    }
    if ($errOpen -and $errRead.IsCompleted) {
      $count = $errRead.GetAwaiter().GetResult()
      if ($count -eq 0) { $errOpen = $false }
      else {
        Send-Frame @{type='output'; stream='stderr'; data=[Convert]::ToBase64String($errBuffer, 0, $count)}
        $errRead = $child.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
      }
    }
    if (-not $exitSent -and $child.HasExited) {
      Send-Frame @{type='exit'; code=$child.ExitCode}
      $exitSent = $true
    }
    $waiting = @()
    if ($outOpen) { $waiting += $outRead }
    if ($errOpen) { $waiting += $errRead }
    if ($waiting.Count) { $null = [System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]$waiting, 50) }
    elseif (-not $exitSent) { $null = $child.WaitForExit(50) }
  }
  Send-Frame @{type='eof'}
  if ([Console]::In.ReadLine() -ne 'finish') { throw 'Передача процессного владения прервана.' }
  $code = $child.ExitCode
  $child.Dispose()
  exit $code
} catch {
  Send-Frame @{type='error'; message=$_.Exception.Message}
  exit 1
}
`;
