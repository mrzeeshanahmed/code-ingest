#!/usr/bin/env python3
"""Milestone 0 backend /health integration test."""

from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import List, Optional, Tuple

try:
    import requests  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover - fallback for minimal envs
    requests = None

import urllib.error
import urllib.request

STARTUP_TIMEOUT_SECONDS = 60
REQUEST_RETRIES = 5
REQUEST_DELAY_SECONDS = 1.0
HTTP_TIMEOUT_SECONDS = 5
SHUTDOWN_TIMEOUT_SECONDS = 10
URL_PATTERN = re.compile(r"(http://127\.0\.0\.1:(\d+))")


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def launch_backend() -> Tuple[subprocess.Popen[str], List[str], "queue.Queue[str | None]"]:
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    env["CODE_INGEST_PORT"] = "0"
    process = subprocess.Popen(
        [sys.executable, "backend/run.py"],
        cwd=str(repo_root()),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        universal_newlines=True,
    )
    if process.stdout is None:
        raise RuntimeError("Failed to capture backend stdout")

    log_lines: List[str] = []
    line_queue: "queue.Queue[str | None]" = queue.Queue()

    def _reader() -> None:
        try:
            for raw_line in process.stdout:
                line = raw_line.rstrip("\n")
                log_lines.append(line)
                line_queue.put(line)
        finally:
            line_queue.put(None)

    threading.Thread(target=_reader, daemon=True).start()
    return process, log_lines, line_queue


def wait_for_backend_url(process: subprocess.Popen[str], line_queue: "queue.Queue[str | None]") -> str:
    deadline = time.time() + STARTUP_TIMEOUT_SECONDS
    last_line: Optional[str] = None
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Backend exited early with code {process.returncode}: {last_line}")
        try:
            line = line_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        if line is None:
            break
        last_line = line
        match = URL_PATTERN.search(line)
        if match:
            return match.group(1)
    raise TimeoutError("Timed out waiting for backend URL in stdout")


def http_request(base_url: str, path: str, method: str = "GET") -> Tuple[int, dict]:
    target = f"{base_url}{path}"
    last_error: Optional[Exception] = None
    for attempt in range(REQUEST_RETRIES):
        try:
            if requests is not None:
                if method == "GET":
                    response = requests.get(target, timeout=HTTP_TIMEOUT_SECONDS)
                else:
                    response = requests.post(target, timeout=HTTP_TIMEOUT_SECONDS)
                status_code = response.status_code
                payload = response.json()
            else:
                req = urllib.request.Request(target, method=method)
                with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
                    status_code = resp.getcode()
                    payload = json.loads(resp.read().decode("utf-8"))
            return status_code, payload
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(REQUEST_DELAY_SECONDS)
    raise RuntimeError(f"HTTP {method} {target} failed after retries: {last_error}")


def terminate_process(process: Optional[subprocess.Popen[str]]) -> None:
    if not process:
        return
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)


def main() -> int:
    process: Optional[subprocess.Popen[str]] = None
    log_lines: List[str] = []
    line_queue: "queue.Queue[str | None]" = queue.Queue()
    try:
        process, log_lines, line_queue = launch_backend()
        base_url = wait_for_backend_url(process, line_queue)
        status, payload = http_request(base_url, "/health", "GET")
        if status != 200:
            raise AssertionError(f"Unexpected status {status}")
        if payload != {"status": "ok"}:
            raise AssertionError(f"Unexpected payload {payload}")
        print(f"PASS: /health responded correctly at {base_url}")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}")
        if log_lines:
            print("--- backend stdout ---")
            for line in log_lines:
                print(line)
        return 1
    finally:
        terminate_process(process)


if __name__ == "__main__":
    sys.exit(main())
