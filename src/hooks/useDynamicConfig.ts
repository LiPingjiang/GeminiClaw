// Default dynamic config for feedback survey etc.
const DEFAULT_CONFIG = {
  probability: 0,
  minTimeBeforeFeedbackMs: 999999999,
  minTimeBetweenFeedbackMs: 999999999,
  minTimeBetweenGlobalFeedbackMs: 999999999,
  minUserTurnsBetweenFeedback: 999,
  minUserTurnsBeforeFeedback: 999,
  enabled: false,
  disabled: true,
  badTranscriptAskConfig: { probability: 0 },
  goodTranscriptAskConfig: { probability: 0 },
}

export function useDynamicConfig(key?: string, defaultVal?: any): any {
  return defaultVal !== undefined ? defaultVal : DEFAULT_CONFIG
}
export default useDynamicConfig
