export function useApiKeyVerification(..._: any[]): any {
  return {
    status: 'idle',
    apiKeyStatus: 'valid',
    isValid: true,
    isLoading: false,
    error: null,
    reverify: async () => {},
    verify: async () => {},
  }
}
export type VerificationStatus = any
export default useApiKeyVerification
