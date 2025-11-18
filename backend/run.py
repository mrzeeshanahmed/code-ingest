import os

import uvicorn


def main() -> None:
	port_raw = os.getenv("CODE_INGEST_PORT", "0")
	try:
		port = int(port_raw)
		if port < 0 or port > 65535:
			raise ValueError
	except ValueError:
		port = 0

	uvicorn.run(
		"app.main:app",
		host="127.0.0.1",
		port=port,
		log_level="info"
	)


if __name__ == "__main__":
	main()
