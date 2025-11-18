from __future__ import annotations

from math import sqrt
from typing import Dict, List, Tuple

Vector = List[float]
StoredItem = Tuple[str, Vector, Dict[str, object]]


class SimpleVectorStore:
	"""In-memory vector store keyed by repo identifier."""

	def __init__(self) -> None:
		self.data: Dict[str, List[StoredItem]] = {}

	@staticmethod
	def _cosine_similarity(a: Vector, b: Vector) -> float:
		if len(a) != len(b):
			raise ValueError('Vectors must have the same dimensionality')

		dot = sum(x * y for x, y in zip(a, b))
		norm_a = sqrt(sum(x * x for x in a))
		norm_b = sqrt(sum(y * y for y in b))
		if norm_a == 0 or norm_b == 0:
			return 0.0
		return dot / (norm_a * norm_b)

	@staticmethod
	def _normalize(vector: Vector) -> Vector:
		norm = sqrt(sum(x * x for x in vector))
		if norm == 0:
			return vector
		return [value / norm for value in vector]

	def add_vectors(self, repo_id: str, items: List[StoredItem]) -> None:
		if not repo_id:
			raise ValueError('repo_id must be non-empty')
		if not items:
			return

		normalized_items: List[StoredItem] = []
		for chunk_id, vector, metadata in items:
			if not isinstance(vector, list) or not vector:
				raise ValueError('Each vector must be a non-empty list of floats')
			normalized = self._normalize(vector)
			normalized_items.append((chunk_id, normalized, metadata))

		repo_items = self.data.setdefault(repo_id, [])
		repo_items.extend(normalized_items)

	def search(self, repo_id: str, query_vector: Vector, k: int) -> List[Dict[str, object]]:
		if k <= 0:
			return []
		repo_items = self.data.get(repo_id)
		if not repo_items:
			return []

		query = self._normalize(query_vector)
		results = []
		for chunk_id, vector, metadata in repo_items:
			score = self._cosine_similarity(query, vector)
			results.append({
				"id": chunk_id,
				"score": score,
				"metadata": metadata
			})

		results.sort(key=lambda item: item['score'], reverse=True)
		return results[:k]


if __name__ == '__main__':
	store = SimpleVectorStore()

	v1 = [1.0, 0.0]
	v2 = [0.0, 1.0]
	v3 = [1.0, 1.0]
	store.add_vectors('repo-A', [
		('chunk-1', v1, {'desc': 'unit x'}),
		('chunk-2', v2, {'desc': 'unit y'}),
		('chunk-3', v3, {'desc': 'diag'})
	])

	query = [1.0, 1.0]
	top = store.search('repo-A', query, k=3)
	print(top)
	# Expected: chunk-3 has the highest cosine similarity with query [1,1]
