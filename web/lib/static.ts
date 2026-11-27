const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const notFound = () => new Response('Not found', { status: 404 });

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot < 0 ? undefined : TYPES[path.slice(dot).toLowerCase()]) ?? 'application/octet-stream';
}

/** Serve a file under `root`. Anything that resolves outside it, or is not a regular file, is a plain 404. */
export async function serveStatic(root: string, pathname: string): Promise<Response> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return notFound();
  }
  if (rel.includes('\0') || rel.includes('\\')) return notFound();
  const segments = rel.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return notFound();
  if (segments.length === 0) segments.push('index.html');

  try {
    const realRoot = await Deno.realPath(root);
    const target = await Deno.realPath(`${realRoot}/${segments.join('/')}`);
    if (!target.startsWith(`${realRoot}/`)) return notFound();
    if (!(await Deno.stat(target)).isFile) return notFound();
    const body = await Deno.readFile(target);
    return new Response(body, { headers: { 'content-type': contentType(target) } });
  } catch {
    return notFound();
  }
}
