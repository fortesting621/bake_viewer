# Kill python server.py processes
$procs = Get-Process python -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    $cmd = $p.CommandLine
    if ($cmd -and $cmd -like "*server.py*") {
        Stop-Process -Id $p.Id -Force
        Write-Host "Stopped server (PID: $($p.Id))"
    }
}