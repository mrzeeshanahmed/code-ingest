#!/usr/bin/env python3
"""Run all Milestone 0 verification steps and print a consolidated summary."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Sequence

ROOT_DIR = Path(__file__).resolve().parent.parent
PYTHON_EXE = os.environ.get('PYTHON', sys.executable or 'python')
NPM_EXE = shutil.which('npm') or 'npm'

SUMMARY_ORDER = [
    'Backend Startup',
    '/health API',
    '/query API',
    'VS Code Commands',
    'Logs Emitted',
    'Graceful Shutdown',
    'No Orphan Processes',
]
REQUIRED_KEYS = {
    '/health API',
    '/query API',
    'VS Code Commands',
    'Graceful Shutdown',
    'No Orphan Processes',
}


@dataclass
class TestStep:
    name: str
    command: Sequence[str]
    summary_keys: Sequence[str]


@dataclass
class StepResult:
    step: TestStep
    exit_code: int
    stdout: str
    stderr: str

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


def run_step(step: TestStep) -> StepResult:
    print(f"\n=== {step.name} ===")
    print('Command:', ' '.join(step.command))

    try:
        completed = subprocess.run(
            list(step.command),
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            check=False,
        )
        stdout = completed.stdout or ''
        stderr = completed.stderr or ''
        exit_code = completed.returncode
    except FileNotFoundError as exc:
        stdout = ''
        stderr = f"Command not found: {exc}"
        exit_code = 127

    if stdout.strip():
        print('--- stdout ---')
        print(stdout.rstrip())
    if stderr.strip():
        print('--- stderr ---', file=sys.stderr)
        print(stderr.rstrip(), file=sys.stderr)

    print(f"Exit code: {exit_code}")
    status = 'PASS' if exit_code == 0 else 'FAIL'
    print(f"Result: {status}")

    return StepResult(step=step, exit_code=exit_code, stdout=stdout, stderr=stderr)


def build_steps() -> List[TestStep]:
    python_cmd = [PYTHON_EXE]
    return [
        TestStep(
            name='Backend health test',
            command=[*python_cmd, 'tools/tests/test_backend_health.py'],
            summary_keys=['Backend Startup', '/health API'],
        ),
        TestStep(
            name='Backend query test',
            command=[*python_cmd, 'tools/tests/test_backend_query.py'],
            summary_keys=['/query API'],
        ),
        TestStep(
            name='VS Code extension tests',
            command=[NPM_EXE, 'test'],
            summary_keys=['VS Code Commands', 'Logs Emitted'],
        ),
        TestStep(
            name='Backend shutdown verifier',
            command=[*python_cmd, 'tools/tests/test_backend_shutdown.py'],
            summary_keys=['Graceful Shutdown'],
        ),
        TestStep(
            name='Orphan backend detector',
            command=[*python_cmd, 'tools/check_for_orphan_backend_processes.py'],
            summary_keys=['No Orphan Processes'],
        ),
    ]


def main() -> int:
    summary: Dict[str, bool] = {}
    steps = build_steps()
    results: List[StepResult] = []

    for step in steps:
        result = run_step(step)
        results.append(result)
        for key in step.summary_keys:
            summary[key] = result.passed

    print('\nMilestone 0 Acceptance Summary')
    print('--------------------------------')
    for label in SUMMARY_ORDER:
        status = summary.get(label, False)
        print(f"{label}: {'PASS' if status else 'FAIL'}")

    required_pass = all(summary.get(key, False) for key in REQUIRED_KEYS)
    if not required_pass:
        print('\nOne or more required checks failed.')
        return 1

    print('\nAll required checks passed!')
    return 0


if __name__ == '__main__':
    sys.exit(main())
