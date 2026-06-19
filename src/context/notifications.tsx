import React, { createContext, useContext } from 'react'
export const NotificationsContext = createContext<any>(null)
export function useNotifications(): any { return useContext(NotificationsContext) }
export default NotificationsContext
