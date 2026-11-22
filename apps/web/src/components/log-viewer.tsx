import { Download, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isErrorLine, type ServiceName } from '@selfhost/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Line {
  id: number;
  ts: string | null;
  line: string;
}

const MAX_LINES = 1000;

export function LogViewer({ service }: { service: ServiceName }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [paused, setPaused] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [showTimes, setShowTimes] = useState(false);
  const pausedRef = useRef(false);
  const queue = useRef<Line[]>([]);
  const nextId = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  pausedRef.current = paused;

  useEffect(() => {
    setLines([]);
    setProblem(null);
    const source = new EventSource(`/api/services/${service}/logs?follow=1&tail=200`);
    source.addEventListener('ready', () => setConnected(true));
    source.addEventListener('line', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as Omit<Line, 'id'>;
      const entry = { ...data, id: nextId.current++ };
      if (pausedRef.current) queue.current.push(entry);
      else setLines((current) => [...current, entry].slice(-MAX_LINES));
    });
    source.addEventListener('problem', (event) => {
      setProblem((JSON.parse((event as MessageEvent<string>).data) as { message: string }).message);
      source.close();
      setConnected(false);
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [service]);

  useEffect(() => {
    if (!paused && queue.current.length > 0) {
      const waiting = queue.current;
      queue.current = [];
      setLines((current) => [...current, ...waiting].slice(-MAX_LINES));
    }
  }, [paused]);

  useEffect(() => {
    const element = box.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <section aria-label="Logs" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          Logs{' '}
          <span className="text-sm font-normal text-muted-foreground">
            {problem ? '' : connected ? '(live)' : '(connecting...)'}
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showTimes}
              onChange={(event) => setShowTimes(event.target.checked)}
            />
            Show details
          </label>
          <Button variant="outline" size="sm" onClick={() => setPaused((value) => !value)}>
            {paused ? (
              <Play className="size-4" aria-hidden />
            ) : (
              <Pause className="size-4" aria-hidden />
            )}
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/services/${service}/logs/download`} download>
              <Download className="size-4" aria-hidden />
              Download
            </a>
          </Button>
        </div>
      </div>

      {problem ? (
        <p role="alert" className="rounded-md border p-3 text-sm">
          {problem}
        </p>
      ) : (
        <div
          ref={box}
          tabIndex={0}
          aria-label="Log lines"
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          }}
          className="h-96 overflow-auto rounded-md border bg-card p-3 font-mono text-xs leading-5"
        >
          {lines.length === 0 ? (
            <p className="text-muted-foreground">No log lines yet.</p>
          ) : (
            lines.map((entry) => (
              <div
                key={entry.id}
                data-error={isErrorLine(entry.line) || undefined}
                className={cn(
                  'break-words whitespace-pre-wrap',
                  isErrorLine(entry.line) && 'text-destructive',
                )}
              >
                {showTimes && entry.ts ? (
                  <span className="text-muted-foreground">{entry.ts} </span>
                ) : null}
                {entry.line}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
