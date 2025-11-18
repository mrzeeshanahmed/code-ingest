from typing import Dict, List


def chunk_file_text(text: str, max_lines: int = 200, overlap_lines: int = 20) -> List[Dict[str, object]]:
	"""Split file contents into overlapping line-based chunks.

	Args:
		text: Full text of a file.
		max_lines: Maximum number of lines allowed per chunk (must be > 0).
		overlap_lines: Number of lines that overlap between consecutive chunks (must be >= 0).

	Returns:
		List of dictionaries containing chunk id, text, and metadata with 1-based line numbers.
	"""

	if max_lines <= 0:
		raise ValueError('max_lines must be greater than 0')
	if overlap_lines < 0:
		raise ValueError('overlap_lines must be non-negative')

	lines = text.splitlines()
	if not lines:
		return []

	total_lines = len(lines)
	overlap = min(overlap_lines, max_lines - 1) if max_lines > 1 else 0
	step = max(1, max_lines - overlap)

	chunks: List[Dict[str, object]] = []
	start_index = 0

	while start_index < total_lines:
		end_index = min(total_lines, start_index + max_lines)
		chunk_lines = lines[start_index:end_index]

		start_line = start_index + 1
		end_line = start_index + len(chunk_lines)
		chunk_id = f"chunk-{start_line}-{end_line}"
		chunk_text = "\n".join(chunk_lines)

		chunks.append({
			"id": chunk_id,
			"text": chunk_text,
			"metadata": {
				"start_line": start_line,
				"end_line": end_line
			}
		})

		if end_index >= total_lines:
			break

		start_index += step

	return chunks


if __name__ == "__main__":
	SIMULATED_TOTAL_LINES = 450
	EXAMPLE_MAX_LINES = 200
	EXAMPLE_OVERLAP = 20

	sample_text = "\n".join(f"Line {i}" for i in range(1, SIMULATED_TOTAL_LINES + 1))
	demo_chunks = chunk_file_text(sample_text, max_lines=EXAMPLE_MAX_LINES, overlap_lines=EXAMPLE_OVERLAP)

	print(f"Total chunks: {len(demo_chunks)}")
	for chunk in demo_chunks:
		meta = chunk["metadata"]
		print(f"{chunk['id']} -> start={meta['start_line']} end={meta['end_line']}")

	# Expected output for a 450-line file with max_lines=200 and overlap_lines=20:
	# Total chunks: 3
	# chunk-1-200 -> start=1 end=200
	# chunk-181-380 -> start=181 end=380
	# chunk-361-450 -> start=361 end=450
