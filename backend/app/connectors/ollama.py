from __future__ import annotations

from typing import Any, Dict

import requests

DEFAULT_TIMEOUT = 1.0


class OllamaConnector:
	"""Lightweight HTTP client for a local Ollama server."""

	def __init__(self, host: str = "127.0.0.1", port: int = 11434) -> None:
		self.base = f"http://{host}:{port}".rstrip('/')

	def health(self) -> bool:
		"""Return True when the Ollama server responds with HTTP 200."""
		try:
			response = requests.get(self.base, timeout=DEFAULT_TIMEOUT)
			return response.status_code == 200
		except requests.RequestException:
			return False

	def generate(self, prompt: str, options: Dict[str, Any] | None = None) -> Dict[str, Any]:
		"""Generate text through Ollama's /api/generate endpoint."""
		if not self.health():
			raise RuntimeError('Ollama not available')

		payload: Dict[str, Any] = {"prompt": prompt}
		if options:
			payload.update(options)

		try:
			response = requests.post(
				f"{self.base}/api/generate",
				json=payload,
				timeout=DEFAULT_TIMEOUT
			)
			result = response.json()
			return {
				"text": result.get("response") or result.get("text", ""),
				"model_metadata": {
					"model": result.get("model"),
					"created_at": result.get("created_at"),
					"done": result.get("done")
				}
			}
		except requests.RequestException as exc:
			raise RuntimeError(f"Ollama request failed: {exc}") from exc
		except ValueError as exc:
			raise RuntimeError('Failed to parse Ollama response as JSON') from exc


if __name__ == '__main__':
	connector = OllamaConnector()
	print('Ollama healthy:', connector.health())
	try:
		result = connector.generate('Hello, Ollama!', {"model": "llama3"})
		print('Response text:', result['text'])
	except RuntimeError as error:
		print('Generation error:', error)
	# Expected: when Ollama is offline, health() -> False and generate raises RuntimeError.
