$projectDir = "C:\Users\eminm\Desktop\code 22 - 11.09.26\code 22 - 11.09.26\istanbulls-6064-yonetim paneli"
$extensions = @('.js', '.jsx', '.html', '.json', '.css', '.md')

$replacements = @(
    @{from='istanbulls-logo\.png'; to='ituas-logo.jpg'},
    @{from='Istanbulls 6064'; to='İTÜAS Otonom Tekne Takımı'},
    @{from='ISTANBULLS 6064'; to='İTÜAS OTONOM TEKNE TAKIMI'},
    @{from='Istanbulls'; to='İTÜAS'},
    @{from='ISTANBULLS'; to='İTÜAS'},
    @{from='istanbulls-6064'; to='ituas-otonom'},
    @{from='istanbulls6064'; to='ituasotonom'},
    @{from='istanbulls'; to='ituas'}
)

function Process-Directory($dir) {
    Get-ChildItem -Path $dir | ForEach-Object {
        if ($_.Name -in @('node_modules', '.git', 'dist')) { return }
        
        if ($_.PSIsContainer) {
            Process-Directory $_.FullName
        } else {
            if ($extensions -contains $_.Extension -or $_.Name -eq '.env') {
                $content = Get-Content $_.FullName -Raw
                if ($null -ne $content) {
                    $newContent = $content
                    foreach ($rep in $replacements) {
                        # We use simple string replacement where possible to avoid regex escaping issues, 
                        # but PowerShell's -replace uses regex, so we'll use string.Replace for exact strings
                        # Wait, we want exact matches mostly. Let's use .Replace().
                        $newContent = [regex]::Replace($newContent, $rep.from, $rep.to)
                    }
                    if ($content -cne $newContent) {
                        Set-Content -Path $_.FullName -Value $newContent -Encoding UTF8
                        Write-Host "Updated: $($_.FullName)"
                    }
                }
            }
        }
    }
}

Process-Directory $projectDir
Write-Host "Done!"

