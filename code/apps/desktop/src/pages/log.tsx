import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { LogLine } from '../shared/bridge.js';
import { bridge, mount } from './common.js';

/** The server log: lines as they arrive, staying put unless scrolled to the bottom. */
function LogPage() {
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const view = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const pending: LogLine[] = [];
    let loaded = false;
    const unsubscribe = bridge.onLogLine((line) => {
      if (!loaded) pending.push(line);
      else setLines((current) => [...current, line].slice(-5000));
    });
    void bridge.logLines().then((initial) => {
      loaded = true;
      setLines([...initial, ...pending].slice(-5000));
    });
    return unsubscribe;
  }, []);

  useLayoutEffect(() => {
    const element = view.current;
    if (element !== null && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <main className="log-page" aria-labelledby="title">
      <header className="row spread">
        <h1 id="title">Server log</h1>
        <button type="button" onClick={() => void bridge.openLogFile()}>
          Open Log File
        </button>
      </header>
      <pre
        ref={view}
        className="log mono"
        tabIndex={0}
        aria-label="Log lines"
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 4;
        }}
      >
        {lines.map((line, index) => (
          <div key={index} className={line.stream === 'err' ? 'err' : undefined}>
            {line.line}
          </div>
        ))}
      </pre>
    </main>
  );
}

mount(<LogPage />);
