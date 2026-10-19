$server = "C:\Users\user\Desktop\bake\bake_viewer\server.py"
$python = "python"

# Start hidden (no console window)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $python
$psi.Arguments = "`"$server`""
$psi.WorkingDirectory = "C:\Users\user\Desktop\bake\bake_viewer"
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.CreateNoWindow = $true
$psi.UseShellExecute = $false

$process = [System.Diagnostics.Process]::Start($psi)
Write-Host "Server started hidden (PID: $($process.Id)) on http://127.0.0.1:8765"