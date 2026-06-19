import React, { createContext, useCallback, useContext, useState } from 'react'

const defaultValue = {
  addNotification: (..._args: any[]) => undefined as any,
  removeNotification: (..._args: any[]) => undefined as any,
  notifications: [] as any[],
  removeByFilter: (..._args: any[]) => [] as any[],
}

export const NotificationsContext = createContext<any>(defaultValue)

export function useNotifications(): any {
  return useContext(NotificationsContext)
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<any[]>([])
  
  const addNotification = useCallback((notification: any) => {
    setNotifications(prev => [...prev, { ...notification, id: Math.random().toString(36) }])
  }, [])
  
  const removeNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id))
  }, [])
  
  const removeByFilter = useCallback((pred: (n: any) => boolean) => {
    const removed: any[] = []
    setNotifications(prev => {
      const keep = prev.filter(n => { const r = pred(n); if (r) removed.push(n); return !r })
      return keep
    })
    return removed
  }, [])
  
  return React.createElement(NotificationsContext.Provider, 
    { value: { addNotification, removeNotification, notifications, removeByFilter } },
    children
  )
}

export default NotificationsContext
