import React, { createContext } from 'react'
export const KeybindingContext = createContext<any>(null)
export function useOptionalKeybindingContext(): any { return undefined }
export default KeybindingContext
