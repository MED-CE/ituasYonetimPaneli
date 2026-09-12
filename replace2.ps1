$projectDir = "C:\Users\eminm\Desktop\code 22 - 11.09.26\code 22 - 11.09.26\istanbulls-6064-yonetim paneli"
$extensions = @('.js', '.jsx', '.html', '.json', '.css', '.md')

$replacements = @(
    @{from='istanbulls-logo\.png'; to='ituas-logo.jpg'},
    @{from='Istanbulls 6064'; to='İTÜAS Otonom Tekne Takımı'},
    @{from='ISTANBULLS 6064'; to='İTÜAS OTONOM TEKNE TAKIMI'},
    @{from='Istanbulls'; to='İTÜAS Otonom'},
    @{from='ISTANBULLS'; to='İTÜAS'},
    @{from='istanbulls-6064'; to='ituas-otonom'},
    @{from='istanbulls6064'; to='ituas_otonom'},
    @{from='istanbulls'; to='ituas'}
)

$cssReplacements = @(
    @{from='#ff9d22'; to='#00b4d8'},
    @{from='#d86d06'; to='#0077b6'},
    @{from='#f07b08'; to='#0096c7'},
    @{from='#c96505'; to='#0077b6'},
    @{from='#984800'; to='#03045e'},
    @{from='#ff8a0b'; to='#00b4d8'},
    @{from='#ff9b1c'; to='#00b4d8'},
    @{from='#e88312'; to='#0096c7'},
    @{from='#ffad47'; to='#48cae4'},
    @{from='#ff941d'; to='#00b4d8'},
    @{from='#ff981e'; to='#00b4d8'},
    @{from='#ff8b00'; to='#00b4d8'},
    @{from='#e27a0c'; to='#0077b6'}
)

$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Process-Directory($dir) {
    Get-ChildItem -Path $dir | ForEach-Object {
        if ($_.Name -in @('node_modules', '.git', 'dist', 'replace2.ps1', 'replace.ps1', 'theme-replace.ps1')) { return }
        
        if ($_.PSIsContainer) {
            Process-Directory $_.FullName
        } else {
            if ($extensions -contains $_.Extension -or $_.Name -eq '.env') {
                $content = [System.IO.File]::ReadAllText($_.FullName, $utf8NoBom)
                if ($null -ne $content) {
                    $newContent = $content
                    foreach ($rep in $replacements) {
                        $newContent = [regex]::Replace($newContent, $rep.from, $rep.to)
                    }
                    if ($_.Extension -eq '.css') {
                        foreach ($rep in $cssReplacements) {
                            $newContent = [regex]::Replace($newContent, $rep.from, $rep.to)
                        }
                    }
                    if ($content -cne $newContent) {
                        [System.IO.File]::WriteAllText($_.FullName, $newContent, $utf8NoBom)
                        Write-Host "Updated: $($_.FullName)"
                    }
                }
            }
        }
    }
}

Process-Directory $projectDir
Write-Host "Done!"

