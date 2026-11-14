Add-Type -AssemblyName System.Speech
$vo = Get-Content "$PSScriptRoot\vo.json" -Raw | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Zira Desktop'); $s.Rate = 2
foreach ($p in $vo.PSObject.Properties) { $s.SetOutputToWaveFile("$PSScriptRoot\public\vo\$($p.Name).wav"); $s.Speak($p.Value) }
$s.Dispose()
