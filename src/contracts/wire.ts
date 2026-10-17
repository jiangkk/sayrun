// External JSON has runtime schemas in each adapter. Keep its dynamic shape at
// the parsing boundary; application code consumes the typed backend contract.
export type WireObject = Record<string, any>;
export interface PendingReply<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
