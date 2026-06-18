import React from 'react';
import { Box, Text } from 'ink';
import type { TuiEvent } from '../types.js';

interface MessageItemProps {
  event: TuiEvent;
}

export function MessageItem({ event }: MessageItemProps) {
  switch (event.kind) {
    case 'user_message':
      return (
        <Box>
          <Text color="yellow" bold>{'> '}</Text>
          <Text color="yellow">{event.content}</Text>
        </Box>
      );

    case 'response':
      return (
        <Box marginLeft={2}>
          <Text color="green">{event.content}</Text>
        </Box>
      );

    case 'tool_start':
      return (
        <Box>
          <Text color="magenta">▶ {event.name}</Text>
          <Text color="gray"> {JSON.stringify(event.args).slice(0, 100)}</Text>
        </Box>
      );

    case 'tool_end':
      return (
        <Box>
          <Text color={event.isError ? 'red' : 'green'}>
            {event.isError ? '✗' : '✓'} {event.name} ({event.durationMs}ms)
          </Text>
        </Box>
      );

    case 'turn_start':
      return (
        <Box justifyContent="flex-end">
          <Text color="gray" dimColor>{'─ TURN '}{event.turn}{' ─'}</Text>
        </Box>
      );

    case 'agent_end':
      return (
        <Box>
          <Text color="gray">
            ✓ {event.totalTurns} turns, {event.stopReason}
          </Text>
        </Box>
      );

    case 'error':
      return (
        <Box>
          <Text color="red">✗ {event.message}</Text>
        </Box>
      );

    case 'system':
      return (
        <Box>
          <Text color="gray">ℹ {event.message}</Text>
        </Box>
      );

    case 'guardrail_warn':
      return (
        <Box>
          <Text color="yellow">⚠ [{event.toolName}] {event.message}</Text>
        </Box>
      );

    case 'guardrail_halt':
      return (
        <Box>
          <Text color="red">✗ HALT [{event.toolName}] {event.message}</Text>
        </Box>
      );

    case 'delta':
    case 'turn_end':
      return null;

    default:
      return null;
  }
}
