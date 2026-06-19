export function useReplBridge(..._: any[]): any { return { sendBridgeResult: () => {}, handleBackgroundQuery: () => {}, handleBackgroundSession: () => {}, status: "idle", isLoading: false, error: null, enabled: false, queue: [], isActive: false, recommendation: null, push: () => {}, pop: () => undefined, onBeforeQuery: undefined, onTurnComplete: undefined } }
export default useReplBridge
