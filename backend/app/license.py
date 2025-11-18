"""License verification helpers."""


def verify_license(token: str | None) -> bool:
	"""Validate a license token.

	This stub is intentionally simple for development builds. In production we would:
	1. Parse the JWT payload.
	2. Verify the RS256 signature using the vendor's public key.
	3. Check standard claims (exp, iat) and product-specific claims (client_id, product_id).
	4. Return True only when all checks succeed.
	"""

	if token is None:
		return False

	if token == "DEV-LICENSE-TRUE":
		return True

	return False
