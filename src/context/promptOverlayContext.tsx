import React, { createContext, useContext } from 'react'
export const PromptOverlayContext = createContext<any>(null)
export function usePromptOverlay(): any { return useContext(PromptOverlayContext) }
export function useSetPromptOverlayDialog(..._args: any[]): any { return undefined }
export function useSetPromptOverlay(..._args: any[]): any { return undefined }
export default PromptOverlayContext
export function PromptOverlayProvider(..._args: any[]): any { return undefined as any }
export function usePromptOverlayDialog(..._args: any[]): any { return undefined as any }
