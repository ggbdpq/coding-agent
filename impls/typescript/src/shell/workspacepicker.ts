// 浏览器版也调用本机系统目录对话框；路径来自用户选择，页面不上传文件。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function pickWorkspace(): Promise<string | null> {
  let command: string, args: string[];
  if (process.platform === 'darwin') {
    command = '/usr/bin/osascript';
    args = ['-e', 'try\nreturn POSIX path of (choose folder with prompt "选择 tcode 项目目录")\non error number -128\nreturn ""\nend try'];
  } else if (process.platform === 'win32') {
    command = 'powershell.exe';
    args = ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "选择 tcode 项目目录"; if ($picker.ShowDialog() -eq "OK") { [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Console]::WriteLine($picker.SelectedPath) }; $picker.Dispose()'];
  } else {
    command = 'zenity'; args = ['--file-selection', '--directory', '--title=选择 tcode 项目目录'];
  }
  try {
    const result = await run(command, args, { timeout: 120000, maxBuffer: 64 * 1024, windowsHide: false });
    return result.stdout.replace(/\r?\n$/, '') || null;
  } catch (error) {
    if (process.platform === 'linux' && (error as { code?: unknown }).code === 1) return null;
    throw new Error('系统目录选择器不可用或已超时，请使用桌面版打开项目');
  }
}
