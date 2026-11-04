# Build the minimal accessibility helper APK with the installed Android SDK.
# No Gradle or network dependencies are required.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$buildTools = Join-Path $sdk 'build-tools\35.0.0'
$androidJar = Join-Path $sdk 'platforms\android-34\android.jar'
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { 'C:\Program Files\Android\Android Studio\jbr' }
$java = Join-Path $jdk 'bin\java.exe'
$javac = Join-Path $jdk 'bin\javac.exe'
$keytool = Join-Path $jdk 'bin\keytool.exe'
$jar = Join-Path $jdk 'bin\jar.exe'
$d8 = Join-Path $buildTools 'd8.bat'
$aapt2 = Join-Path $buildTools 'aapt2.exe'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksigner = Join-Path $buildTools 'apksigner.bat'

foreach ($file in @($androidJar, $javac, $d8, $aapt2, $zipalign, $apksigner)) {
    if (-not (Test-Path $file)) { throw "missing build dependency: $file" }
}

$build = Join-Path $root 'build'
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force -Path $build, (Join-Path $build 'classes'), (Join-Path $build 'dex'), (Join-Path $build 'gen') | Out-Null

& $aapt2 compile --dir (Join-Path $root 'res') -o (Join-Path $build 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

& $aapt2 link -o (Join-Path $build 'base.apk') `
    -I $androidJar `
    --manifest (Join-Path $root 'AndroidManifest.xml') `
    -R (Join-Path $build 'res.zip') `
    --auto-add-overlay `
    --java (Join-Path $build 'gen') `
    --min-sdk-version 26 --target-sdk-version 29 `
    --version-code 1 --version-name '1.0'
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

$sources = Get-ChildItem (Join-Path $root 'src') -Recurse -Filter *.java | ForEach-Object { $_.FullName }
& $javac --release 8 -encoding UTF-8 -classpath $androidJar -d (Join-Path $build 'classes') $sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

$classes = Get-ChildItem (Join-Path $build 'classes') -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& $d8 --lib $androidJar --release --output (Join-Path $build 'dex') $classes
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

Copy-Item (Join-Path $build 'dex\classes.dex') (Join-Path $build 'classes.dex')
Push-Location $build
try {
    & $jar uf (Join-Path $build 'base.apk') classes.dex
    if ($LASTEXITCODE -ne 0) { throw 'jar update failed' }
} finally {
    Pop-Location
}

& $zipalign -f 4 (Join-Path $build 'base.apk') (Join-Path $build 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

$keystore = Join-Path $root 'debug.keystore'
if (-not (Test-Path $keystore)) {
    & $keytool -genkeypair -v -keystore $keystore -storepass android -alias androiddebugkey `
        -keypass android -keyalg RSA -keysize 2048 -validity 10000 `
        -dname 'CN=Android Debug,O=Android,C=US'
    if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}

& $apksigner sign --ks $keystore --ks-pass pass:android --key-pass pass:android `
    --out (Join-Path $root 'dsh-a11y.apk') (Join-Path $build 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

& $apksigner verify --verbose (Join-Path $root 'dsh-a11y.apk')
if ($LASTEXITCODE -ne 0) { throw 'apksigner verify failed' }

Write-Host "built: $(Join-Path $root 'dsh-a11y.apk')"
