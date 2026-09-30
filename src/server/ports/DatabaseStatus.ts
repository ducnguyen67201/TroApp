/** Checks migrated database availability; does not expose provider errors or records. */
export interface DatabaseStatus {
  isDatabaseReady(): Promise<boolean>;
}
