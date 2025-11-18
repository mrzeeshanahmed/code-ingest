#!/usr/bin/env python3
"""Verify backend shutdown behavior when VS Code reloads."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional, Sequence, Tuple

try:
    import psutil  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    psutil = None

VSIX_TEST_CLI = Path('node_modules/@vscode/test-cli/out/bin.mjs')
SHUTDOWN_SUITE = Path('tools/tests/shutdown-suite.js')
START_TIMEOUT = 120
SHUTDOWN_TIMEOUT = 5
POLL_INTERVAL = 0.2
BACKEND_PID_REGEX = re.compile(r'Started server process \[(\d+)\]')


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def build_vscode_test_command() -> Sequence[str]:
    cli_path = repo_root() / VSIX_TEST_CLI
    if not cli_path.exists():
        raise FileNotFoundError('VS Code test CLI script not found. Run npm install.')
    node_exe = shutil.which('node')
    if not node_exe:
        raise FileNotFoundError('Node.js executable not found in PATH.')
    return [node_exe, str(cli_path)]


def start_vscode_and_capture_logs(log_dir: Path) -> Tuple[subprocess.Popen[str], Path, Path]:
    env = os.environ.copy()
    env.setdefault('CODE_INGEST_PORT', '0')
    env.setdefault('CODE_INGEST_SHUTDOWN_DELAY', '8000')
    trigger_file = log_dir / 'reload.trigger'
    env['CODE_INGEST_SHUTDOWN_TRIGGER'] = str(trigger_file)
    base_cmd = list(build_vscode_test_command())

    extension_dev_path = repo_root()
    config_path = extension_dev_path / '.vscode-test.mjs'
    if not config_path.exists():
        raise FileNotFoundError('Missing .vscode-test.mjs configuration')
    shutdown_suite_path = extension_dev_path / SHUTDOWN_SUITE
    if not shutdown_suite_path.exists():
        raise FileNotFoundError(f'Shutdown suite not found: {shutdown_suite_path}')

    cmd = [
        *base_cmd,
        '--config',
        str(config_path),
        '--label',
        'shutdown',
        '--extensionDevelopmentPath',
        str(extension_dev_path),
    ]

    print('Launching VS Code test host:', ' '.join(cmd))

    process = subprocess.Popen(
        cmd,
        cwd=str(extension_dev_path),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    if process.stdout is None:
        raise RuntimeError('Failed to capture VS Code stdout')

    log_file = log_dir / 'vscode.log'
    log_file.parent.mkdir(parents=True, exist_ok=True)
    log_file.write_text('', encoding='utf-8')

    def tee_output() -> None:
        with log_file.open('a', encoding='utf-8') as handle:
            for line in process.stdout:  # pragma: no cover - interactive stream
                handle.write(line)

    import threading

    threading.Thread(target=tee_output, daemon=True).start()
    return process, log_file, trigger_file


def stop_vscode_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def wait_for_process_exit(process: subprocess.Popen[str], timeout: float) -> None:
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        stop_vscode_process(process)


def find_backend_pid() -> Optional[int]:
    if psutil is None:
        return find_backend_pid_fallback()

    for proc in psutil.process_iter(['pid', 'cmdline']):
        cmdline = proc.info.get('cmdline') or []
        if any('backend' in part and 'run.py' in part for part in cmdline):
            return int(proc.info['pid'])
    return None


def find_backend_pid_fallback() -> Optional[int]:
    if os.name == 'nt':
        pid = powershell_find_backend_pid()
        if pid is not None:
            return pid
        wmic_path = shutil.which('wmic')
        if not wmic_path:
            return None
        result = subprocess.run(['tasklist', '/fo', 'CSV'], capture_output=True, text=True, check=False)
        lines = result.stdout.splitlines()[3:]
        for line in lines:
            if 'python' in line.lower():
                fields = line.split(',')
                if len(fields) > 1:
                    try:
                        pid = int(fields[1].strip('"'))
                    except ValueError:
                        continue
                    detail = subprocess.run([wmic_path, 'process', 'where', f'processid={pid}', 'get', 'commandline'], capture_output=True, text=True, check=False)
                    if 'backend' in detail.stdout and 'run.py' in detail.stdout:
                        return pid
    else:
        result = subprocess.run(['ps', '-ef'], capture_output=True, text=True, check=False)
        for line in result.stdout.splitlines():
            if 'backend' in line and 'run.py' in line:
                parts = line.split()
                if len(parts) > 1:
                    try:
                        return int(parts[1])
                    except ValueError:
                        continue
    return None


def powershell_find_backend_pid() -> Optional[int]:
    if os.name != 'nt':
        return None
    powershell = shutil.which('pwsh') or shutil.which('powershell')
    if not powershell:
        return None
    script = r"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'backend\\run.py' } | Select-Object -First 1 -ExpandProperty ProcessId"
    result = subprocess.run(
        [powershell, '-NoLogo', '-NonInteractive', '-Command', script],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        return int(result.stdout.strip()) if result.stdout.strip() else None
    except ValueError:
        return None


def read_backend_pid_from_log(log_file: Path) -> Optional[int]:
    try:
        data = log_file.read_text(encoding='utf-8')
    except FileNotFoundError:
        return None
    match = BACKEND_PID_REGEX.search(data)
    if match:
        return int(match.group(1))
    return None


def wait_for_backend_pid(log_file: Path, timeout: float = START_TIMEOUT) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        pid_from_log = read_backend_pid_from_log(log_file)
        if pid_from_log is not None:
            return pid_from_log
        pid = find_backend_pid()
        if pid is not None:
            return pid
        time.sleep(POLL_INTERVAL)
    raise TimeoutError('Backend PID not detected within timeout')


def wait_for_pid_exit(pid: int, timeout: float = SHUTDOWN_TIMEOUT) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if not pid_exists(pid):
            return True
        time.sleep(POLL_INTERVAL)
    return False


def pid_exists(pid: int) -> bool:
    if psutil is not None:
        return psutil.pid_exists(pid)

    if os.name == 'nt':
        result = subprocess.run(['tasklist', '/fi', f'PID eq {pid}'], capture_output=True, text=True, check=False)
        return str(pid) in result.stdout

    result = subprocess.run(['ps', '-p', str(pid)], capture_output=True, text=True, check=False)
    return str(pid) in result.stdout


def count_uvicorn_processes() -> int:
    if psutil is not None:
        count = 0
        for proc in psutil.process_iter(['name', 'cmdline']):
            try:
                name = (proc.info.get('name') or '').lower()
                cmdline = ' '.join(proc.info.get('cmdline') or []).lower()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
            if 'uvicorn' in name or 'uvicorn' in cmdline:
                count += 1
        return count

    if os.name == 'nt':
        result = subprocess.run(['tasklist'], capture_output=True, text=True, check=False)
        return sum(1 for line in result.stdout.splitlines() if 'uvicorn' in line.lower())

    result = subprocess.run(['ps', '-ef'], capture_output=True, text=True, check=False)
    return sum(1 for line in result.stdout.splitlines() if 'uvicorn' in line.lower())


def main() -> int:
    parser = argparse.ArgumentParser(description='Test backend shutdown when VS Code reloads.')
    parser.add_argument('--timeout', type=int, default=START_TIMEOUT, help='Startup timeout seconds')
    args = parser.parse_args()

    log_dir = Path(tempfile.mkdtemp(prefix='code-ingest-shutdown-logs-'))
    process, log_file, trigger_file = start_vscode_and_capture_logs(log_dir)
    backend_pid: Optional[int] = None

    try:
        backend_pid = wait_for_backend_pid(log_file, args.timeout)
        print(f'Detected backend PID: {backend_pid}')
        trigger_file.write_text('reload', encoding='utf-8')
        wait_for_process_exit(process, args.timeout)
        if backend_pid and not wait_for_pid_exit(backend_pid):
            raise RuntimeError(f'Backend PID {backend_pid} is still alive after VS Code exit')
        remaining = count_uvicorn_processes()
        if remaining:
            raise RuntimeError(f'Found {remaining} uvicorn processes still running')
        print('PASS: backend shutdown verified')
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f'FAIL: {exc}')
        if log_dir.exists():
            for path in sorted(log_dir.glob('**/*')):
                if path.is_file():
                    print(f'--- {path} ---')
                    try:
                        print(path.read_text(encoding='utf-8'))
                    except Exception as read_error:  # noqa: BLE001
                        print(f'[Unable to read log: {read_error}]')
        return 1
    finally:
        if process.poll() is None:
            process.kill()


if __name__ == '__main__':
    sys.exit(main())
