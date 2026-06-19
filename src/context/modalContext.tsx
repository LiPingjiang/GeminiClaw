import React, { createContext, useContext } from 'react'
export const ModalContext = createContext<any>(null)
export function useModal(): any { return useContext(ModalContext) }
export default ModalContext
