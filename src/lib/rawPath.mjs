/**
 * Validate a path for the /api/raw passthrough. Returns null when the path is
 * acceptable, otherwise a short reason string. Pure: no I/O.
 */
export function rawPathError(path) {
  if (typeof path !== 'string') return 'Path must be a string.';
  if (path.includes('://') || path.startsWith('//')) {
    return 'Path must be a bare path, not a URL.';
  }
  if (!path.startsWith('/api/')) {
    return `Path must start with /api/ — got '${path}'`;
  }
  // Decode repeatedly so %252e%252e is caught too; a malformed escape is rejected.
  let decoded = path;
  for (let i = 0; i < 3; i++) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return 'Path contains an invalid percent-escape.';
    }
    if (next === decoded) break;
    decoded = next;
  }
  const pathOnly = decoded.split(/[?#]/)[0];
  if (pathOnly.split(/[/\\]/).includes('..')) {
    return "Path must not contain '..' segments.";
  }
  if (decoded.includes('://') || decoded.startsWith('//')) {
    return 'Path must be a bare path, not a URL.';
  }
  return null;
}
