import React, { createContext, useContext } from 'react'
export const OverlayContext = createContext<any>(null)
export function useOverlay(): any { return useContext(OverlayContext) }
export function useIsModalOverlayActive(): boolean { return false }
export function useRegisterOverlay(..._args: any[]): any { return undefined }
export default OverlayContext
