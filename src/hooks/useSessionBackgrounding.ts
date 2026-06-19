export function useSessionBackgrounding(..._: any[]): any {
  return { 
    handleBackgroundSession: () => {}, 
    handleBackgroundQuery: () => {},
    status: 'idle', isLoading: false, error: null, enabled: false,
    queue: [], isActive: false, recommendation: null,
    push: () => {}, pop: () => undefined,
    onBeforeQuery: undefined, onTurnComplete: undefined 
  }
}
export default useSessionBackgrounding
