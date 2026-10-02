import { Alert, Button, Group, Stack, Table, Text } from '@mantine/core';
import type { ReactElement } from 'react';
import { useLocale } from '../localization/UseLocale.js';
import { MicrophoneTestPhase } from './MicrophoneMeasurements.js';
import type { MicrophoneView } from './UseMicrophones.js';
import type { MicrophoneTestsView } from './UseMicrophoneTests.js';

interface MicrophoneToolsProps {
  microphones: MicrophoneView;
  tests: MicrophoneTestsView;
  canTest: boolean;
  isEditingRanking: boolean;
  isComparing: boolean;
}

/** Ranking is a saved preference; comparison is temporary evidence for an explicit choice. */
export function MicrophoneTools({
  microphones,
  tests,
  canTest,
  isEditingRanking,
  isComparing,
}: MicrophoneToolsProps): ReactElement {
  const { messages } = useLocale();
  const phases = {
    [MicrophoneTestPhase.OPENING]: messages.microphoneTestOpening,
    [MicrophoneTestPhase.QUIET]: messages.microphoneTestQuiet,
    [MicrophoneTestPhase.SPEAKING]: messages.microphoneTestSpeak,
  };
  const isTesting = tests.activeDeviceId !== null;
  const formatDeviceName = (deviceId: string): string => {
    const index = microphones.microphones.findIndex(
      (microphone) => microphone.deviceId === deviceId,
    );
    return (
      microphones.microphones[index]?.label || `${messages.microphoneUnnamed} ${String(index + 1)}`
    );
  };

  return (
    <Stack gap="sm">
      {isEditingRanking && (
        <>
          {!microphones.hasCustomRanking && <Text size="sm">{messages.microphoneRankingHint}</Text>}
          <ol className="microphone-ranking" aria-label={messages.microphoneEditRanking}>
            {microphones.microphones.map((microphone, index) => (
              <li key={microphone.deviceId}>
                <Text component="span" size="sm">
                  {formatDeviceName(microphone.deviceId)}
                </Text>
                <Group gap="xs" wrap="nowrap">
                  <Button
                    size="compact-xs"
                    variant="default"
                    aria-label={messages.microphoneMoveUp(formatDeviceName(microphone.deviceId))}
                    disabled={index === 0 || isTesting}
                    onClick={() => {
                      microphones.moveMicrophone(microphone.deviceId, -1);
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="default"
                    aria-label={messages.microphoneMoveDown(formatDeviceName(microphone.deviceId))}
                    disabled={index === microphones.microphones.length - 1 || isTesting}
                    onClick={() => {
                      microphones.moveMicrophone(microphone.deviceId, 1);
                    }}
                  >
                    ↓
                  </Button>
                </Group>
              </li>
            ))}
          </ol>
          <Button
            variant="subtle"
            disabled={!microphones.hasCustomRanking || isTesting}
            onClick={microphones.resetRanking}
          >
            {messages.microphoneResetRanking}
          </Button>
        </>
      )}
      {isComparing && (
        <>
          <Text size="sm">{messages.microphoneTestPrivacy}</Text>
          <Text size="sm">{messages.microphoneTestInstructions}</Text>
          {!canTest && !isTesting && <Text size="sm">{messages.microphoneTestBusy}</Text>}
          {tests.hasError && (
            <Alert role="alert" color="charcoal">
              {messages.microphoneTestError}
            </Alert>
          )}
          {isTesting ? (
            <Stack gap="xs">
              <Text size="sm" role="status" aria-live="polite">
                {formatDeviceName(tests.activeDeviceId ?? '')} · {phases[tests.phase]}{' '}
                {tests.secondsRemaining > 0 ? String(tests.secondsRemaining) : ''}
              </Text>
              {tests.phase === MicrophoneTestPhase.SPEAKING && (
                <Text size="sm" fw={600}>
                  {messages.microphoneTestPhrase}
                </Text>
              )}
              <Button variant="default" onClick={tests.cancelTest}>
                {messages.microphoneTestCancel}
              </Button>
            </Stack>
          ) : (
            <Group gap="xs">
              {microphones.microphones.map((microphone) => (
                <Button
                  key={microphone.deviceId}
                  variant="default"
                  size="xs"
                  disabled={!canTest}
                  onClick={() => void tests.startTest(microphone.deviceId)}
                >
                  {messages.microphoneTestDevice(formatDeviceName(microphone.deviceId))}
                </Button>
              ))}
            </Group>
          )}
          {tests.results.length > 0 && (
            <Table.ScrollContainer minWidth={420}>
              <Table captionSide="bottom">
                <Table.Caption>{messages.microphoneTestLimitations}</Table.Caption>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{messages.microphone}</Table.Th>
                    <Table.Th>{messages.microphoneNoise}</Table.Th>
                    <Table.Th>{messages.microphoneSpeech}</Table.Th>
                    <Table.Th>{messages.microphoneClipping}</Table.Th>
                    <Table.Th>{messages.microphoneStartup}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {tests.results.map((result) => (
                    <Table.Tr key={result.deviceId}>
                      <Table.Td>{formatDeviceName(result.deviceId)}</Table.Td>
                      <Table.Td>{result.noiseDb.toFixed(1)} dBFS</Table.Td>
                      <Table.Td>{result.speechDb.toFixed(1)} dBFS</Table.Td>
                      <Table.Td>{(result.clippedFraction * 100).toFixed(1)}%</Table.Td>
                      <Table.Td>{String(result.startupMs)} ms</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </>
      )}
    </Stack>
  );
}
