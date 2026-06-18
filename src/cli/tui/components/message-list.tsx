import React from 'react';
import { Box } from 'ink';
import { MessageItem } from './message-item.js';
import type { TuiEvent } from '../types.js';

interface MessageListProps {
  events: TuiEvent[];
  streamingContent: string;
  columns: number;  // added — used by StreamingMd in Task 7
}

export function MessageList({ events, streamingContent }: MessageListProps) {
  const visibleEvents = events.slice(-50);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visibleEvents.map((event, i) => (
        <MessageItem key={i} event={event} />
      ))}
      {streamingContent && (
        <MessageItem event={{ kind: 'response', content: streamingContent }} />
      )}
    </Box>
  );
}
