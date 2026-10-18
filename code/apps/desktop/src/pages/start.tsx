import { useCallback, useEffect, useState } from 'react';

import type { RecentProject } from '../shared/bridge.js';
import { bridge, mount } from './common.js';

/** The start page: shown when no project window is open. */
function StartPage() {
  const [recent, setRecent] = useState<readonly RecentProject[] | null>(null);
  const refresh = useCallback(() => {
    void bridge.recentProjects().then(setRecent);
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  return (
    <main className="page" aria-labelledby="title">
      <header className="row spread">
        <div>
          <h1 id="title">Janus</h1>
          <p className="muted">Open a folder to run its mock server and see it in the Atlas.</p>
        </div>
        <div className="row">
          <button type="button" className="primary" onClick={() => void bridge.openProject()}>
            Open Project…
          </button>
          <button type="button" onClick={() => void bridge.newProject()}>
            New Project…
          </button>
        </div>
      </header>
      <section
        aria-labelledby="recent-title"
        className="row"
        style={{ flexDirection: 'column', alignItems: 'stretch' }}
      >
        <h2 id="recent-title" className="label">
          Recent projects
        </h2>
        {recent === null ? null : recent.length === 0 ? (
          <p className="muted">No recent projects. Projects you open appear here.</p>
        ) : (
          <ul className="list">
            {recent.map((project) => (
              <li key={project.path} className={project.missing ? 'missing' : undefined}>
                <div className="grow">
                  {project.missing ? (
                    <div className="recent-open">
                      <span>
                        {project.name} <span className="faint">· folder missing</span>
                      </span>
                      <span className="mono muted">{project.path}</span>
                    </div>
                  ) : (
                    <button type="button" className="recent-open" onClick={() => void bridge.openRecent(project.path)}>
                      <span>{project.name}</span>
                      <span className="mono muted">{project.path}</span>
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className="link"
                  aria-label={`Remove ${project.name} from recent projects`}
                  onClick={() => void bridge.removeRecent(project.path).then(refresh)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

mount(<StartPage />);
