const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'installer', 'NorwaysDiffCheckerInstaller.bat');
const outputPath = path.join(root, 'installer', 'NorwaysDiffCheckerInstaller.exe');
const iconPath = path.join(root, 'assets', 'app-icon.ico');
const marker = '# NDC_POWERSHELL';

function findCompiler() {
  const windowsDirectory = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ];
  return candidates.find(candidate => fs.existsSync(candidate));
}

if (process.platform !== 'win32') throw new Error('The installer executable can only be built on Windows.');
const compiler = findCompiler();
if (!compiler) throw new Error('The .NET Framework 4 C# compiler was not found.');

const source = fs.readFileSync(sourcePath, 'utf8');
const lines = source.split(/\r?\n/);
const markerIndex = lines.findIndex(line => line === marker);
if (markerIndex < 0) throw new Error('Installer payload marker not found.');
const payload = lines.slice(markerIndex + 1).join('\r\n');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-installer-build-'));
const payloadPath = path.join(temporaryDirectory, 'InstallerPayload.ps1');
const bootstrapPath = path.join(temporaryDirectory, 'InstallerBootstrap.cs');
const bootstrap = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

[assembly: AssemblyTitle("Norways Diff Checker Setup")]
[assembly: AssemblyProduct("Norways Diff Checker")]
[assembly: AssemblyCompany("Norway174")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class InstallerBootstrap
{
    private const string ResourceName = "NorwaysDiffChecker.InstallerPayload.ps1";

    private static int Main()
    {
        string executablePath = Assembly.GetExecutingAssembly().Location;
        string payloadPath = Path.Combine(Path.GetTempPath(), "NorwaysDiffChecker-" + Guid.NewGuid().ToString("N") + ".ps1");
        try
        {
            using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName))
            using (FileStream output = File.Create(payloadPath))
            {
                if (input == null) throw new InvalidOperationException("The installer payload is missing.");
                input.CopyTo(output);
            }

            var start = new ProcessStartInfo("powershell.exe")
            {
                UseShellExecute = false,
                Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"" + payloadPath.Replace("\"", "\\\"") + "\""
            };
            start.EnvironmentVariables["NDC_INSTALLER"] = executablePath;
            using (Process process = Process.Start(start))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Norways Diff Checker Setup failed: " + error.Message);
            return 1;
        }
        finally
        {
            try { File.Delete(payloadPath); } catch { }
        }
    }
}
`;

try {
  fs.writeFileSync(payloadPath, payload, 'utf8');
  fs.writeFileSync(bootstrapPath, bootstrap, 'utf8');
  const result = spawnSync(compiler, [
    '/nologo',
    '/target:exe',
    '/optimize+',
    `/win32icon:${iconPath}`,
    `/resource:${payloadPath},NorwaysDiffChecker.InstallerPayload.ps1`,
    `/out:${outputPath}`,
    bootstrapPath
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status || 1);
  }
  console.log(`Built ${path.relative(root, outputPath)}`);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}