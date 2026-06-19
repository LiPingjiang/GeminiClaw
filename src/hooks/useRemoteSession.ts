export function useRemoteSession(..._args: any[]): any {
  return { isRemoteMode: false, isConnected: false, isLoading: false, error: null, send: (..._: any[]) => undefined, abort: () => {}, config: null }
}
export default useRemoteSession
