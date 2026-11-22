export interface LogLine {
  ts: string | null;
  stream: 'stdout';
  line: string;
}

// `docker compose logs --timestamps` prints "<container>  | <timestamp> <message>". Compose
// merges stdout and stderr, so every line is reported as stdout.
const PREFIX = /^\S+\s+\| ?/;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) ?/;

export function parseComposeLine(raw: string): LogLine | null {
  if (raw === '') return null;
  const rest = raw.replace(PREFIX, '');
  const match = TIMESTAMP.exec(rest);
  return {
    ts: match?.[1] ?? null,
    stream: 'stdout',
    line: match ? rest.slice(match[0].length) : rest,
  };
}

export function* parseComposeLogs(output: string): Generator<LogLine> {
  for (const raw of output.split('\n')) {
    const parsed = parseComposeLine(raw);
    if (parsed) yield parsed;
  }
}
