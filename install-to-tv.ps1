# Builds the APK and installs it over the one on the TV (settings are kept).
#   .\install-to-tv.ps1 -TvHost 192.168.1.50            release build
#   .\install-to-tv.ps1 -TvHost 192.168.1.50 -DebugBuild     debuggable build (WebView inspection on)
# Needs JDK 17 and the Android SDK (platform 34, build-tools 34.0.0), and adb authorised on the TV.
param(
    [Parameter(Mandatory = $true)][string]$TvHost,
    [switch]$DebugBuild
)
$ErrorActionPreference = "Stop"
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = "$env:LOCALAPPDATA\Android\jdk17" }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
$Adb = Join-Path $env:ANDROID_HOME "platform-tools\adb.exe"
$Variant = if ($DebugBuild) { "debug" } else { "release" }
$Task = if ($DebugBuild) { "assembleDebug" } else { "assembleRelease" }
if ($TvHost -notmatch ":\d+$") { $TvHost = "${TvHost}:5555" }

Push-Location $PSScriptRoot
try {
    & .\gradlew.bat --no-daemon -q $Task
    if ($LASTEXITCODE -ne 0) { throw "Gradle $Task failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$Apk = Join-Path $PSScriptRoot "app\build\outputs\apk\$Variant\app-$Variant.apk"
& $Adb connect $TvHost | Out-Null
& $Adb -s $TvHost install -r $Apk
if ($LASTEXITCODE -ne 0) { throw "adb install failed with exit code $LASTEXITCODE" }
Write-Host "VAG11TV ($Variant) installed on $TvHost"
