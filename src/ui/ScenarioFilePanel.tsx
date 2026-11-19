/**
 * Scenario files panel: export the current scenario, import one from disk.
 *
 * Presentational plus two browser APIs (a Blob download and a file input) that cannot be tested
 * in jsdom. Everything that can be wrong - the serialisation, the filename, the parsing, the
 * error text - lives in `scenarios/io.ts` and is unit tested there. This file is the plumbing:
 * a link, an input, and a message.
 *
 * Import errors are shown in place rather than as `alert()`. A modal alert on a failed import
 * tells the user nothing they can act on and blocks the app; a listed field path does both.
 */

import { useRef, useState } from 'react';
import {
  exportScenario,
  importScenario,
  scenarioFilename,
  type ImportResult,
} from '../scenarios/io.js';
import type { KeyValueStore } from '../scenarios/persist.js';
import type { Scenario } from '../scenarios/types.js';

export interface ScenarioFilePanelProps {
  readonly scenario: Scenario;
  /** Called with a validated scenario the user chose to open. */
  readonly onImport: (scenario: Scenario) => void;
  /** The browser store, or null when there is none. */
  readonly store: KeyValueStore | null;
  /** Clears the remembered scenario. The current session is not affected. */
  readonly onClear: () => void;
}

export function ScenarioFilePanel({ scenario, onImport, store, onClear }: ScenarioFilePanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [failure, setFailure] = useState<ImportResult | null>(null);
  const [loadedName, setLoadedName] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);

  const handleExport = (): void => {
    setCleared(false);
    const text = exportScenario(scenario, { pretty: true });
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = scenarioFilename(scenario);
    // Firefox requires the link to be in the document for a programmatic click to count.
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking immediately can race the download in some builds; a tick is enough and the
    // handle is released either way when the document unloads.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const handleFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const result = importScenario(text);
    if (result.ok) {
      setFailure(null);
      setLoadedName(result.scenario.name);
      onImport(result.scenario);
      return;
    }
    setLoadedName(null);
    setFailure(result);
  };

  return (
    <div className="section" data-testid="scenario-files">
      <h2>Scenario file</h2>
      <div className="scenario-file-actions">
        <button type="button" onClick={handleExport} data-testid="scenario-export">
          Download scenario
        </button>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          data-testid="scenario-import-button"
        >
          Open a scenario file
        </button>
        {/*
          Only offered when there is a store to clear. A button that cannot do anything is worse
          than no button, and the app is honest about not remembering when storage is blocked.
        */}
        {store !== null && (
          <button
            type="button"
            onClick={() => {
              onClear();
              setCleared(true);
              setLoadedName(null);
              setFailure(null);
            }}
            data-testid="scenario-clear"
          >
            Forget saved scenario
          </button>
        )}
        {/*
          The input is visually hidden but still the real control. `tabIndex={-1}` keeps it out of
          the tab order so a keyboard user gets one stop, the visible button, rather than two
          controls that do the same thing; clicking that button still opens the file dialog for
          them. It keeps an `aria-label` anyway, because a control that can receive focus should
          have a name even when the only route to it is through another control.
        */}
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          className="visually-hidden"
          tabIndex={-1}
          aria-label="Open a file from disk"
          data-testid="scenario-import-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset first, so picking the same file twice fires a change event the second time.
            e.target.value = '';
            if (file) void handleFile(file);
          }}
        />
      </div>

      {loadedName && (
        <p className="hint" role="status" data-testid="scenario-import-ok">
          Opened “{loadedName}”.
        </p>
      )}

      {cleared && (
        <p className="hint" role="status" data-testid="scenario-clear-ok">
          The saved scenario was cleared. This session is unaffected, and saving begins again the
          next time you choose a scenario.
        </p>
      )}

      {failure && !failure.ok && (
        <div className="caveat" role="alert" data-testid="scenario-import-error">
          <p>{failure.summary}</p>
          {failure.issues.length > 1 && (
            <ul>
              {failure.issues.slice(0, 8).map((issue, index) => (
                <li key={`${issue.path}-${index}`}>
                  <code>{issue.path || '(file)'}</code> {issue.message}
                </li>
              ))}
              {failure.issues.length > 8 && <li>and {failure.issues.length - 8} more</li>}
            </ul>
          )}
        </div>
      )}

      <p className="hint">
        A scenario file is plain JSON with a version number, so it can be edited by hand and kept in
        version control. Opening one does not send it anywhere.
      </p>
    </div>
  );
}
