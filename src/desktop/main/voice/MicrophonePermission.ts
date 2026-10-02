interface MicrophonePermissionRequest {
  permission: string;
  isTrustedFrame: boolean;
  isMainFrame: boolean;
  mediaTypes: readonly string[];
  isAudioAuthorized: boolean;
}

/** Main owns authorization; renderer device selection cannot grant media access. */
export function isMicrophonePermissionAllowed(request: MicrophonePermissionRequest): boolean {
  return (
    request.permission === 'media' &&
    request.isTrustedFrame &&
    request.isMainFrame &&
    request.isAudioAuthorized &&
    request.mediaTypes.length === 1 &&
    request.mediaTypes[0] === 'audio'
  );
}
