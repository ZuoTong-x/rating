$root = 'D:\v030_data\第三和第四批'
$alias3 = 'D:\v030_data\batch34_batch3_link'
$alias4 = 'D:\v030_data\batch34_batch4_link'

$remote3 = '/mnt/aigc/users/sunqingping/infographics/rl_data/data/aestheic_v0.3/siwen/jpeg_data_3/images_tar'
$remote4 = '/mnt/aigc/users/sunqingping/infographics/rl_data/data/aestheic_v0.3/siwen/jpeg_data_4/images_tar'

$files3 = @{
    'crawled-source-image.tar' = 1409228800
    'flux.1.tar' = 524707840
    'flux.2.tar' = 519782400
    'gemini-3.1-flash.tar' = 448655360
    'gpt-image-2.tar' = 502784000
    'hidream-o1.tar' = 514355200
    'hunyuan-image-3.tar' = 110848000
    'ideogram-4.tar' = 193105920
    'midjourney.tar' = 784261120
    'qwen-image-2512.tar' = 634593280
    'qwen-image-3.0.tar' = 274933760
    'sd3.5-large.tar' = 233830400
    'seedream-5-pro.tar' = 296140800
    'u1.5.tar' = 565872640
    'u1-fast.tar' = 653414400
    'u1.tar' = 688578560
    'wan-2.7-image.tar' = 538122240
}
$files4 = @{
    'crawled-source-image.tar' = 1033697280
    'flux.1.tar' = 240302080
    'flux.2.tar' = 416901120
    'gemini-3.1-flash.tar' = 296028160
    'glm-image.tar' = 167157760
    'gpt-image-2.tar' = 418048000
    'hidream-o1.tar' = 224952320
    'hunyuan-image-3.tar' = 59125760
    'ideogram-4.tar' = 155125760
    'midjourney.tar' = 701255680
    'qwen-image-2512.tar' = 458567680
    'qwen-image-3.0.tar' = 235489280
    'sd3.5-large.tar' = 111738880
    'seedream-5-pro.tar' = 287447040
    'u1.5.tar' = 413593600
    'u1-fast.tar' = 350494720
    'u1.tar' = 344924160
    'wan-2.7-image.tar' = 355399680
}

$specs = @()
foreach ($name in $files3.Keys) {
    $specs += "3|$name|$($files3[$name])|$remote3|$alias3"
}
foreach ($name in $files4.Keys) {
    $specs += "4|$name|$($files4[$name])|$remote4|$alias4"
}

$jobs = @()
for ($worker = 0; $worker -lt 8; $worker++) {
    $group = @()
    for ($i = $worker; $i -lt $specs.Count; $i += 8) {
        $group += $specs[$i]
    }
    $specText = $group -join "`n"
    $jobs += Start-Job -ArgumentList $specText -ScriptBlock {
        param($specText)
        foreach ($line in ($specText -split "`n")) {
            $parts = $line -split '\|', 5
            $batch = $parts[0]
            $name = $parts[1]
            $remote = $parts[3]
            $dest = $parts[4]
            $local = Join-Path $dest $name
            for ($try = 1; $try -le 5; $try++) {
                Write-Output "START batch=$batch file=$name try=$try"
                $commands = "reget -a $remote/$name $local`nbye"
                $commands | sftp -b - zta
                if ($LASTEXITCODE -eq 0) {
                    Write-Output "DONE batch=$batch file=$name"
                    break
                }
                Write-Output "RETRY batch=$batch file=$name exit=$LASTEXITCODE"
                Start-Sleep -Seconds 5
            }
        }
    }
}

$totals = @{}
$totals['3'] = ($files3.Values | Measure-Object -Sum).Sum
$totals['4'] = ($files4.Values | Measure-Object -Sum).Sum
$lastBytes = @{ '3' = 0; '4' = 0 }
$lastTime = Get-Date
Write-Output ('BATCH34_STARTED workers=8 totalGB={0:N2}' -f (($totals['3'] + $totals['4']) / 1GB))

while (($jobs | Where-Object { $_.State -in 'Completed', 'Failed', 'Stopped' }).Count -lt $jobs.Count) {
    $now = Get-Date
    $interval = [math]::Max(1, ($now - $lastTime).TotalSeconds)
    foreach ($batch in @('3', '4')) {
        $dest = if ($batch -eq '3') { $alias3 } else { $alias4 }
        $table = if ($batch -eq '3') { $files3 } else { $files4 }
        $bytes = 0
        foreach ($name in $table.Keys) {
            $path = Join-Path $dest $name
            if (Test-Path -LiteralPath $path) {
                $bytes += [math]::Min((Get-Item -LiteralPath $path).Length, $table[$name])
            }
        }
        $speed = ($bytes - $lastBytes[$batch]) / $interval
        $remaining = if ($speed -gt 0) { ($table.Values | Measure-Object -Sum).Sum - $bytes } else { 0 }
        $eta = if ($speed -gt 0) { [timespan]::FromSeconds($remaining / $speed).ToString('hh\:mm\:ss') } else { 'unknown' }
        Write-Output ('PROGRESS batch={0} {1:N2}% {2:N2}/{3:N2}GB speed={4:N2}MB/s ETA={5}' -f $batch, (100 * $bytes / $totals[$batch]), ($bytes / 1GB), ($totals[$batch] / 1GB), ($speed / 1MB), $eta)
        $lastBytes[$batch] = $bytes
    }
    $lastTime = $now
    foreach ($job in $jobs) {
        if ($job.HasMoreData) { Receive-Job $job }
    }
    Start-Sleep -Seconds 10
}
$jobs | ForEach-Object { Receive-Job $_ }
$jobs | Remove-Job
Write-Output 'BATCH34_WORKERS_FINISHED'
