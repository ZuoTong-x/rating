$out = 'D:\v030_data\converted_20260829'
$scriptPath = Join-Path (Get-Location).Path 'scripts\convert_first_batch_webp.py'
Get-ChildItem -LiteralPath $out -Filter '*.partial' -Force -ErrorAction SilentlyContinue | Remove-Item -Force

$archives = @(
    'flux.2.tar', 'gemini-3.1-flash.tar', 'glm-image.tar', 'gpt-image-2.tar',
    'hidream-o1.tar', 'hunyuan-image-3.tar', 'ideogram-4.tar', 'midjourney.tar',
    'qwen-image-2512.tar', 'qwen-image-3.0.tar', 'sd3.5-large.tar',
    'seedream-5-pro.tar', 'u1-fast.tar', 'u1.5.tar', 'u1.tar', 'wan-2.7-image.tar'
)

$jobs = @()
for ($i = 0; $i -lt 4; $i++) {
    $group = @()
    for ($j = $i; $j -lt $archives.Count; $j += 4) {
        $group += $archives[$j]
    }
    $jobs += Start-Job -ArgumentList ($group -join '|'), $scriptPath -ScriptBlock {
        param($names, $scriptPath)
        foreach ($name in ($names -split '\|')) {
            & python $scriptPath `
                --input-dir D:\v030_data `
                --output-dir D:\v030_data\converted_20260829 `
                --manifest C:\annot_v03\manifest.json `
                --tasks C:\annot_v03\tasks.json `
                --quality 90 --archive-name $name
            if ($LASTEXITCODE -ne 0) {
                Write-Output "FAIL $name exit=$LASTEXITCODE"
            }
        }
    }
}

Write-Output 'CONVERSION_STARTED workers=4 archives=16'
while (($jobs | Where-Object { $_.State -in 'Completed', 'Failed', 'Stopped' }).Count -lt $jobs.Count) {
    foreach ($job in $jobs) {
        if ($job.HasMoreData) {
            Receive-Job $job
        }
    }
    Start-Sleep -Seconds 10
}
$jobs | ForEach-Object { Receive-Job $_ }
$jobs | Remove-Job
Write-Output 'CONVERSION_WORKERS_FINISHED'
