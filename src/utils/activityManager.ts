export const activityManager = {
  recordUserActivity: (): void => {},
  recordActivity: (): void => {},
  getLastActivityTime: (): number => Date.now(),
  isActive: (): boolean => false,
}
export default activityManager
