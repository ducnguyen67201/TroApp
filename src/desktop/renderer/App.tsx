import { useState, type ReactElement } from 'react';
import { DatabaseAvailability, type SystemStatusResult } from '#contracts/SystemStatus.js';

export function App(): ReactElement {
  const [result, setResult] = useState<SystemStatusResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  /* The renderer asks through the preload bridge. Backend URLs and credentials
     stay outside the page, and the result has one shared contract. */
  async function checkConnection(): Promise<void> {
    setIsChecking(true);

    try {
      setResult(await window.tro.readServiceStatus());
    } catch {
      /* A bridge call may reject during shutdown; keep the check retryable
         without displaying low-level errors in the UI. */
      setResult({ success: false, message: 'Could not check the connection.' });
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <main>
      <p className="eyebrow">TRO · DESKTOP FOUNDATION</p>
      <h1>
        A place to build
        <br />
        your next look.
      </h1>
      <p className="description">
        The desktop foundation is ready. Check your backend connection before connecting try-on and
        your personal assistant.
      </p>
      <section aria-label="Service connection">
        <h2>Workspace connection</h2>
        <p>Run a connection check to confirm the service is available.</p>
        <button
          disabled={isChecking}
          onClick={() => {
            void checkConnection();
          }}
        >
          {isChecking ? 'Checking…' : 'Check connection'}
        </button>
        <div role="status" aria-live="polite">
          {result?.success && (
            <p>
              Backend connected.{' '}
              {result.status.database === DatabaseAvailability.READY
                ? 'Database ready.'
                : 'Database unavailable. Start PostgreSQL and apply migrations.'}
            </p>
          )}
          {result && !result.success && <p>{result.message}</p>}
        </div>
      </section>
      <footer>Try-on generation and assistant actions are not connected yet.</footer>
    </main>
  );
}
