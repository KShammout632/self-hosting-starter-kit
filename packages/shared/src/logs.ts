// Used by the API to count problems per service and by the web app to highlight lines.
const ERROR_LINE =
  /\b(error|fatal|exception|panic|critical|segfault)\b|\[(ERR|FTL)\]|exited with code [1-9]|out of memory|oom-?killed/i;

export function isErrorLine(line: string): boolean {
  return ERROR_LINE.test(line);
}

interface HintRule {
  match: RegExp;
  message: string;
}

const HINT_RULES: readonly HintRule[] = [
  {
    match: /no such file or directory.*(\/srv|\/media|\/mnt)|(\/srv|\/media|\/mnt).*no such file/i,
    message: 'A media folder is missing. Check that your drive is connected and the folder exists.',
  },
  {
    match: /permission denied|operation not permitted/i,
    message:
      'The service is not allowed to read or write a folder. This usually means a drive was mounted with the wrong permissions.',
  },
  {
    match: /read-only file system/i,
    message: 'A folder is read-only. Check that the drive is healthy and mounted for writing.',
  },
  {
    match: /no space left on device/i,
    message: 'The disk is full. Free up some space or add another drive.',
  },
  {
    match: /address already in use|port is already allocated|bind: .*in use/i,
    message:
      "Another program is using this service's port. Restart the server, or stop the other program.",
  },
  {
    match: /out of memory|cannot allocate memory|oom-?killed/i,
    message: 'The server ran out of memory. Stop a service you are not using, or add more memory.',
  },
  {
    match:
      /connection refused|econnrefused|could not connect to (the )?(database|server)|failed to connect/i,
    message:
      'The service could not reach something it depends on. It may still be starting, so wait a minute and check again.',
  },
];

export function hintsForLines(lines: readonly string[]): string[] {
  const hints = new Set<string>();
  for (const line of lines) {
    for (const rule of HINT_RULES) if (rule.match.test(line)) hints.add(rule.message);
  }
  return [...hints];
}
