import hashlib
import math
from typing import List

Vector = List[float]


def _hex_stream(text: str, total_chars: int) -> str:
	digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
	hex_data = digest
	counter = 1
	while len(hex_data) < total_chars:
		counter_digest = hashlib.sha256(f"{text}:{counter}".encode('utf-8')).hexdigest()
		hex_data += counter_digest
		counter += 1
	return hex_data[:total_chars]


def _normalize(vector: Vector) -> Vector:
	norm = math.sqrt(sum(value * value for value in vector))
	if norm == 0:
		return [0.0 for _ in vector]
	return [value / norm for value in vector]


def embed_texts(texts: List[str], dim: int = 64) -> List[Vector]:
	"""Create deterministic embeddings by hashing text with SHA256."""
	if dim <= 0:
		raise ValueError('dim must be positive')

	vectors: List[Vector] = []
	for text in texts:
		hex_data = _hex_stream(text, dim * 2)
		chunk_values = [int(hex_data[i:i + 2], 16) / 255.0 for i in range(0, len(hex_data), 2)]
		# Ensure vector has exactly dim elements (slicing is safe due to hex length)
		vector = chunk_values[:dim]
		vectors.append(_normalize(vector))

	return vectors


if __name__ == '__main__':
	sample_texts = ['hello world', 'hello world', 'different']
	embeddings = embed_texts(sample_texts, dim=8)

	print('Embedding A:', embeddings[0])
	print('Embedding B:', embeddings[1])
	print('Embedding C:', embeddings[2])
	print('A equals B:', embeddings[0] == embeddings[1])
	print('||A|| ~', round(math.sqrt(sum(x * x for x in embeddings[0])), 6))

	# Expected output (values truncated):
	# Embedding A: [...]
	# Embedding B: [...]
	# Embedding C: [...]
	# A equals B: True (same text => same vector)
	# ||A|| ~ 1.0
