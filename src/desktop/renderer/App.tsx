import { useState, type ReactElement, type SyntheticEvent } from 'react';
import { AuthStatus } from '#contracts/Auth.js';
import { DatabaseAvailability, type SystemStatusResult } from '#contracts/SystemStatus.js';
import { useAuthentication } from './UseAuthentication.js';

export function App(): ReactElement {
  const { authState, isWorking, message, authenticateWithGoogle, createWorkspace, logout } =
    useAuthentication();

  if (!authState) {
    return <main className="centered">Loading Tro…</main>;
  }

  if (authState.status === AuthStatus.SIGNED_OUT) {
    return (
      <main className="centered">
        <div className="auth-card">
          <p className="eyebrow">TRO · DESKTOP</p>
          <h1>Build your next look.</h1>
          <p className="description">
            Sign in to reach your private workspace. Authentication opens in your system browser.
          </p>
          <button disabled={isWorking} onClick={() => void authenticateWithGoogle()}>
            {isWorking ? 'Opening Google…' : 'Continue with Google'}
          </button>
          <StatusMessage message={message} />
        </div>
      </main>
    );
  }

  if (authState.status === AuthStatus.NEEDS_WORKSPACE) {
    return (
      <WorkspaceSetup
        email={authState.profile.email}
        isWorking={isWorking}
        message={message}
        onLogout={logout}
        onSubmit={createWorkspace}
      />
    );
  }

  return (
    <AuthenticatedWorkspace
      displayName={authState.workspace.displayName}
      email={authState.profile.email}
      isWorking={isWorking}
      message={message}
      onLogout={logout}
    />
  );
}

function WorkspaceSetup(props: {
  email: string;
  isWorking: boolean;
  message: string;
  onLogout(): Promise<void>;
  onSubmit(displayName: string): Promise<void>;
}): ReactElement {
  const [displayName, setDisplayName] = useState('');

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    void props.onSubmit(displayName);
  }

  return (
    <main className="centered">
      <div className="auth-card">
        <p className="eyebrow">SIGNED IN AS {props.email}</p>
        <h1>Create your workspace</h1>
        <p className="description">
          Your workspace keeps your team and product activity together. You’ll be its owner.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="workspace-name">Workspace name</label>
          <input
            id="workspace-name"
            autoComplete="organization"
            maxLength={80}
            minLength={2}
            required
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
            }}
          />
          <button disabled={props.isWorking} type="submit">
            {props.isWorking ? 'Creating…' : 'Create workspace'}
          </button>
        </form>
        <button
          className="secondary setup-logout"
          disabled={props.isWorking}
          onClick={() => void props.onLogout()}
        >
          Sign out
        </button>
        <StatusMessage message={props.message} />
      </div>
    </main>
  );
}

function AuthenticatedWorkspace(props: {
  displayName: string;
  email: string;
  isWorking: boolean;
  message: string;
  onLogout(): Promise<void>;
}): ReactElement {
  const [serviceResult, setServiceResult] = useState<SystemStatusResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  async function checkConnection(): Promise<void> {
    setIsChecking(true);
    setServiceResult(await window.tro.readServiceStatus());
    setIsChecking(false);
  }

  return (
    <main>
      <div className="workspace-header">
        <div>
          <p className="eyebrow">YOUR WORKSPACE</p>
          <h1>{props.displayName}</h1>
          <p className="description">Signed in as {props.email}</p>
        </div>
        <button
          className="secondary"
          disabled={props.isWorking}
          onClick={() => void props.onLogout()}
        >
          Sign out
        </button>
      </div>
      <section aria-label="Service connection">
        <h2>Workspace connection</h2>
        <p>Confirm that the service and migrated database are available.</p>
        <button disabled={isChecking} onClick={() => void checkConnection()}>
          {isChecking ? 'Checking…' : 'Check connection'}
        </button>
        <div role="status" aria-live="polite">
          {serviceResult?.success && (
            <p>
              Backend connected.{' '}
              {serviceResult.status.database === DatabaseAvailability.READY
                ? 'Database ready.'
                : 'Database unavailable. Start PostgreSQL and apply migrations.'}
            </p>
          )}
          {serviceResult && !serviceResult.success && <p>{serviceResult.message}</p>}
        </div>
      </section>
      <StatusMessage message={props.message} />
      <footer>Try-on generation and assistant actions are not connected yet.</footer>
    </main>
  );
}

function StatusMessage({ message }: { message: string }): ReactElement {
  return (
    <div className="status-message" role="status" aria-live="polite">
      {message}
    </div>
  );
}
