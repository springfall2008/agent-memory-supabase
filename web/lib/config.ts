export type Config = { apiUrl: string; token: string; runnerHome: string; port: number };

const DEFAULT_PORT = 8787;

function derivedApiUrl(memoryUrl: string): string {
  const trimmed = memoryUrl.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0 || trimmed.slice(cut + 1) !== 'agent-memory') {
    throw new Error('AGENT_MEMORY_URL must end in /agent-memory (or set WEB_API_URL)');
  }
  return `${trimmed.slice(0, cut)}/web-api`;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WEB_PORT must be an integer from 1 to 65535');
  }
  return port;
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? `${home}${path.slice(1)}` : path;
}

/** Read the server settings. Errors name a key and never a value. */
export function loadConfig(env: (k: string) => string | undefined, home: string): Config {
  const token = env('AGENT_MEMORY_TOKEN');
  if (!token) throw new Error('AGENT_MEMORY_TOKEN is not set');

  const webApi = env('WEB_API_URL');
  const memoryUrl = env('AGENT_MEMORY_URL');
  if (!webApi && !memoryUrl) throw new Error('neither WEB_API_URL nor AGENT_MEMORY_URL is set');
  const apiUrl = webApi || derivedApiUrl(memoryUrl as string);

  const runnerHome = expandHome(env('BOARD_RUNNER_HOME') || '~/.board-runner', home);
  return { apiUrl, token, runnerHome, port: parsePort(env('WEB_PORT')) };
}
