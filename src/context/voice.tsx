import React, { createContext, useContext } from 'react'
export const VoiceContext = createContext<any>(null)
export function useVoice(): any { return useContext(VoiceContext) }
export function useVoiceState(): any { return undefined }
export default VoiceContext
