# WebSense — Safe Process Cleanup
# Only kills node processes running our server/test, NEVER all node processes
# Usage: powershell -File scripts/kill-server.ps1
$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*websense*server.js*' -or $_.CommandLine -like '*websense*test*' }
if ($targets) {
  foreach ($t in $targets) {
    Write-Output "Killing PID $($t.ProcessId): $($t.CommandLine)"
    Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Output "No WebSense server/test processes found."
}
