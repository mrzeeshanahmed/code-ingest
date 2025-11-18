#!/usr/bin/env python3
"""Detect orphaned backend or uvicorn processes for Code-Ingest."""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from typing import Iterable, List, Optional

try:
    import psutil  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    psutil = None

TARGET_SUBSTRINGS = [
    'backend/run.py',
]
UVICORN_INDICATORS = ['uvicorn', '127.0.0.1']


@dataclass
class ProcessInfo:
    pid: int
    cmdline: str


def matches_target(cmdline: str) -> bool:
    lowered = cmdline.lower()
    if any(substring in lowered for substring in TARGET_SUBSTRINGS):
        return True
    if all(token in lowered for token in UVICORN_INDICATORS):
        return True
    return False


def collect_via_psutil() -> List[ProcessInfo]:
    if psutil is None:
        return []
    matches: List[ProcessInfo] = []
    for proc in psutil.process_iter(attrs=['pid', 'cmdline']):
        try:
            cmdline_list = proc.info.get('cmdline') or []
            if not cmdline_list:
                continue
            cmdline_str = ' '.join(cmdline_list)
        except (psutil.NoSuchProcess, psutil.AccessDenied):  # pragma: no cover
            continue
        if matches_target(cmdline_str):
            matches.append(ProcessInfo(pid=proc.info['pid'], cmdline=cmdline_str))
    return matches


def collect_via_tasklist() -> List[ProcessInfo]:
    result: List[ProcessInfo] = []
    try:
        output = subprocess.check_output(
            ['tasklist', '/v', '/fo', 'CSV'],
            text=True,
            errors='ignore'
        )
    except (OSError, subprocess.CalledProcessError):  # pragma: no cover
        return result

    rows = output.splitlines()[1:]
    for row in rows:
        columns = [col.strip('"') for col in row.split(',')]
        if len(columns) < 3:
            continue
        image_name, pid_str, _, _, _, _, _, description = (columns + [''] * 8)[:8]
        try:
            pid = int(pid_str)
        except ValueError:
            continue
        cmdline = f"{image_name} {description}"
        if matches_target(cmdline):
            result.append(ProcessInfo(pid=pid, cmdline=cmdline))
    return result


def collect_via_ps() -> List[ProcessInfo]:
    try:
        output = subprocess.check_output(
            ['ps', '-ef'] if os.name != 'nt' else ['ps', 'aux'],
            text=True,
            errors='ignore'
        )
    except (OSError, subprocess.CalledProcessError):  # pragma: no cover
        return []

    matches: List[ProcessInfo] = []
    for line in output.splitlines()[1:]:
        parts = line.split(None, 7)
        if len(parts) < 8:
            continue
        try:
            pid = int(parts[1]) if os.name != 'nt' else int(parts[1])
        except ValueError:
            continue
        cmdline = parts[-1]
        if matches_target(cmdline):
            matches.append(ProcessInfo(pid=pid, cmdline=cmdline))
    return matches


def detect_processes() -> List[ProcessInfo]:
    matches = collect_via_psutil()
    if matches:
        return matches

    if os.name == 'nt':
        matches.extend(collect_via_tasklist())
    else:
        matches.extend(collect_via_ps())
    return matches


def main() -> int:
    matches = detect_processes()
    if matches:
        print('Detected orphan backend processes:')
        for proc in matches:
            print(f"PID {proc.pid}: {proc.cmdline}")
        return 1

    print('No orphan backend processes detected.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
