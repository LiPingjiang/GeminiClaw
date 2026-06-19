import React, { createContext, useContext } from 'react'
export const OverlayContext = createContext<any>(null)
export function useOverlay(): any { return useContext(OverlayContext) }
export default OverlayContext
