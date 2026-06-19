import React, { createContext, useContext } from 'react'
export const PromptOverlayContext = createContext<any>(null)
export function usePromptOverlay(): any { return useContext(PromptOverlayContext) }
export default PromptOverlayContext
