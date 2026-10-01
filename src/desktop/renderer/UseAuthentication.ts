import { useCallback, useEffect, useState } from 'react';
import { AuthStatus, type AuthState } from '#contracts/Auth.js';

const signedOutState: AuthState = { status: AuthStatus.SIGNED_OUT };

export interface Authentication {
  authState: AuthState | null;
  isWorking: boolean;
  message: string;
  authenticateWithGoogle: () => Promise<void>;
  createWorkspace: (displayName: string) => Promise<void>;
  logout: () => Promise<void>;
}

/** Owns renderer authentication state while credentials remain in Electron main. */
export function useAuthentication(): Authentication {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [message, setMessage] = useState('');
  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const stopListening = window.tro.onAuthStateChanged((state) => {
      setAuthState(state);
      setIsWorking(false);
      setMessage(
        state.status === AuthStatus.SIGNED_OUT
          ? 'Sign-in was not completed. You can safely try again.'
          : '',
      );
    });

    void window.tro.readAuthState().then((result) => {
      if (!isMounted) {
        return;
      }

      if (result.success) {
        setAuthState(result.state);
      } else {
        setAuthState(signedOutState);
        setMessage(result.message);
      }
    });

    return () => {
      isMounted = false;
      stopListening();
    };
  }, []);

  const authenticateWithGoogle = useCallback(async (): Promise<void> => {
    setIsWorking(true);
    setMessage('');
    const result = await window.tro.startGoogleSignIn();

    if (!result.success) {
      setIsWorking(false);
      setMessage(result.message);
      return;
    }

    setMessage('Finish signing in securely in your browser.');
  }, []);

  const createWorkspace = useCallback(async (displayName: string): Promise<void> => {
    setIsWorking(true);
    setMessage('');
    const result = await window.tro.createWorkspace(displayName);
    setIsWorking(false);

    if (result.success) {
      setAuthState(result.state);
    } else {
      setMessage(result.message);
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    setIsWorking(true);
    setMessage('');
    const result = await window.tro.logout();
    setIsWorking(false);

    if (result.success) {
      setAuthState(result.state);
    } else {
      setMessage(result.message);
    }
  }, []);

  return {
    authState,
    isWorking,
    message,
    authenticateWithGoogle,
    createWorkspace,
    logout,
  };
}
