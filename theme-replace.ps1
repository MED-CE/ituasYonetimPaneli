$cssPath = "C:\Users\eminm\Desktop\code 22 - 11.09.26\code 22 - 11.09.26\istanbulls-6064-yonetim paneli\src\App.css"
$content = Get-Content $cssPath -Raw

$content = $content -replace '#ff9d22', '#00b4d8'
$content = $content -replace '#d86d06', '#0077b6'
$content = $content -replace '#f07b08', '#0096c7'
$content = $content -replace '#c96505', '#0077b6'
$content = $content -replace '#984800', '#03045e'
$content = $content -replace '#ff8a0b', '#00b4d8'
$content = $content -replace '#ff9b1c', '#00b4d8'
$content = $content -replace '#e88312', '#0096c7'
$content = $content -replace '#ffad47', '#48cae4'
$content = $content -replace '#ff941d', '#00b4d8'
$content = $content -replace '#ff981e', '#00b4d8'
$content = $content -replace '#ff8b00', '#00b4d8'
$content = $content -replace '#e27a0c', '#0077b6'

Set-Content -Path $cssPath -Value $content -Encoding UTF8
Write-Host "CSS updated for marine theme!"

