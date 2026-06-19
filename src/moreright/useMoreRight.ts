export function useMoreRight(..._: any[]): any {
  return {
    onBeforeQuery: undefined,
    onTurnComplete: undefined,
    render: () => null,  // mrRender - returns null when called
    recommendation: null,
    isLoading: false,
    error: null,
    enabled: false,
  }
}
export default useMoreRight
