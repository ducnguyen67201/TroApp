interface StudentCameraRequest {
  permission: string;
  trustedFrame: boolean;
  mainFrame: boolean;
  mediaTypes: readonly string[];
  leaseUntilMs: number;
  nowMs: number;
}

/** Only the explicit scan lease permits video; it cannot authorize audio or another surface. */
export function isStudentCameraAllowed(request: StudentCameraRequest): boolean {
  return (
    request.permission === 'media' &&
    request.trustedFrame &&
    request.mainFrame &&
    request.leaseUntilMs > request.nowMs &&
    request.mediaTypes.length === 1 &&
    request.mediaTypes[0] === 'video'
  );
}
