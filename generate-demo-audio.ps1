$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$taskRoot = $PSScriptRoot
$taskPhrases = Get-Content -LiteralPath (Join-Path $taskRoot 'content/phrases.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $taskSynth.SelectVoice('Microsoft Huihui Desktop')
    $taskSynth.Rate = -2
    $taskSynth.Volume = 100
    foreach ($taskPhrase in $taskPhrases) {
        $taskSynth.SetOutputToWaveFile((Join-Path $taskRoot $taskPhrase.audio))
        $taskSynth.Speak($taskPhrase.text)
        $taskSynth.SetOutputToNull()
        Write-Output ('Generated: ' + $taskPhrase.id)
    }
} finally {
    $taskSynth.Dispose()
}