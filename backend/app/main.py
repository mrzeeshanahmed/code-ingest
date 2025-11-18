import os
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class QueryRequest(BaseModel):
	repo_id: Optional[str] = None
	query: str


@app.on_event("startup")
async def log_startup() -> None:
	port = os.getenv("CODE_INGEST_PORT") or "auto"
	print(f"BACKEND_STARTUP port={port}", flush=True)


@app.get("/health")
async def health() -> dict:
	return {"status": "ok"}


@app.post("/query")
async def query_endpoint(payload: QueryRequest) -> dict:
	print(f"RECEIVED_QUERY {payload.json()}", flush=True)
	print(f"QUERY_BODY {payload.json()}", flush=True)
	return {
		"echo": payload.query,
		"repo_id": payload.repo_id,
		"msg": "backend received it"
	}
