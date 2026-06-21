interface StreamingTextProps {
  text: string
}

// Plain span — parent re-renders on each delta, so no ref tricks needed here.
// The blinking cursor below the text is handled by MessageBubble.
export default function StreamingText({ text }: StreamingTextProps) {
  return <>{text}</>
}
