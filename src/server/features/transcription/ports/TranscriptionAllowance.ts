export interface TranscriptionReservation {
  captureId: string;
  userId: string;
  expiresAt: Date;
  maximumSamples: number;
  dailySamples: number;
}

/** Reservations are atomic across API replicas; a credential can be claimed once. */
export interface TranscriptionAllowance {
  reserveTranscription(reservation: TranscriptionReservation): Promise<boolean>;
  claimTranscription(captureId: string, userId: string): Promise<boolean>;
  releaseUnusedTranscription(captureId: string, userId: string): Promise<void>;
  settleTranscription(captureId: string, samples: number): Promise<void>;
}
