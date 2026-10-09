import { useEffect, useState, type ReactElement } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { PetAction, PetId, PetMotion, PetReaction, type PetPreferences } from '#contracts/Pet.js';
import { useLocale } from '../localization/UseLocale.js';
import { PetMascot } from './PetMascot.js';
import { petRenderer } from './PetPresentation.js';
import { petMessages } from './PetMessages.js';
import { usePets, type PetView } from './UsePets.js';

interface PetGalleryProps {
  accountId: string | null;
}
interface PetCardProps {
  petId: PetId;
  preferences: PetPreferences;
  view: PetView;
}

function PetCard({ petId, preferences, view }: PetCardProps): ReactElement {
  const { locale } = useLocale();
  const messages = petMessages[locale];
  const [name, setName] = useState(preferences.names[petId]);
  const [previewReaction, setPreviewReaction] = useState<PetReaction>(PetReaction.IDLE);
  useEffect(() => {
    if (previewReaction === PetReaction.IDLE) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setPreviewReaction(PetReaction.IDLE);
    }, 800);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [previewReaction]);
  const isSelected = preferences.activePetId === petId;
  const label = isSelected ? (preferences.enabled ? messages.save : messages.show) : messages.adopt;
  return (
    <section className="pet-card" aria-label={messages[petId]}>
      <div className="pet-card-preview">
        <PetMascot
          petId={petId}
          label={`${messages.pet} ${preferences.names[petId]}`}
          onPet={() => {
            setPreviewReaction(PetReaction.HAPPY);
          }}
          onSlap={() => {
            setPreviewReaction(PetReaction.STARTLED);
          }}
          reaction={
            previewReaction !== PetReaction.IDLE
              ? previewReaction
              : isSelected
                ? (view.snapshot?.reaction ?? PetReaction.IDLE)
                : PetReaction.IDLE
          }
          reducedMotion={preferences.motion === PetMotion.REDUCED}
        />
      </div>
      <Group justify="space-between">
        <Text fw={600}>{messages[petId]}</Text>
        {isSelected && (
          <Badge variant="light">{preferences.enabled ? messages.active : messages.hidden}</Badge>
        )}
      </Group>
      <TextInput
        label={messages.name}
        value={name}
        maxLength={40}
        disabled={view.isSaving}
        onChange={(event) => {
          setName(event.currentTarget.value);
        }}
      />
      <Button
        variant={isSelected ? 'default' : 'filled'}
        fullWidth
        disabled={view.isSaving || !name.trim()}
        onClick={() => {
          void view.sendCommand({ kind: PetAction.ADOPT, petId, name: name.trim(), locale });
        }}
      >
        {label}
      </Button>
    </section>
  );
}

export function PetGallery({ accountId }: PetGalleryProps): ReactElement {
  const { locale } = useLocale();
  const messages = petMessages[locale];
  const view = usePets(accountId);
  const preferences = view.snapshot?.preferences;
  return (
    <Stack>
      <Title order={3}>{messages.pets}</Title>
      <Text c="dimmed" size="sm">
        {messages.description}
      </Text>
      {!accountId ? (
        <Text>{messages.signIn}</Text>
      ) : !view.isAvailable ? (
        <Alert>{messages.unavailable}</Alert>
      ) : !preferences && !view.hasError ? (
        <Loader size="sm" />
      ) : null}
      {view.hasError && <Alert role="alert">{messages.error}</Alert>}
      {view.snapshot?.hasPresentationError && (
        <Alert role="alert">{messages.presentationError}</Alert>
      )}
      {preferences && (
        <>
          <div className="pet-gallery">
            {Object.values(PetId).map((petId) => (
              <PetCard
                key={`${petId}:${preferences.names[petId]}`}
                petId={petId}
                preferences={preferences}
                view={view}
              />
            ))}
          </div>
          <Text size="sm" c="dimmed">
            {messages.hint}
          </Text>
          <Group>
            {petRenderer.supportsControlledReactions(preferences.activePetId) && (
              <>
                <Button
                  variant="default"
                  disabled={view.isSaving || !view.snapshot?.isVisible}
                  onClick={() => {
                    void view.sendCommand({ kind: PetAction.REACT, reaction: PetReaction.HAPPY });
                  }}
                >
                  {messages.pet}
                </Button>
                <Button
                  variant="default"
                  disabled={view.isSaving || !view.snapshot?.isVisible}
                  onClick={() => {
                    void view.sendCommand({
                      kind: PetAction.REACT,
                      reaction: PetReaction.STARTLED,
                    });
                  }}
                >
                  {messages.slap}
                </Button>
              </>
            )}
            <Button
              variant="subtle"
              disabled={view.isSaving || !preferences.enabled}
              onClick={() => {
                void view.sendCommand({ kind: PetAction.HIDE });
              }}
            >
              {messages.hide}
            </Button>
          </Group>
          <Switch
            label={messages.quiet}
            description={messages.quietHint}
            checked={preferences.quiet}
            disabled={view.isSaving}
            onChange={(event) => {
              void view.sendCommand({
                kind: PetAction.PREFERENCES,
                locale,
                quiet: event.currentTarget.checked,
                motion: preferences.motion,
              });
            }}
          />
          <Switch
            label={messages.reduced}
            description={messages.reducedHint}
            checked={preferences.motion === PetMotion.REDUCED}
            disabled={view.isSaving}
            onChange={(event) => {
              void view.sendCommand({
                kind: PetAction.PREFERENCES,
                locale,
                quiet: preferences.quiet,
                motion: event.currentTarget.checked ? PetMotion.REDUCED : PetMotion.SYSTEM,
              });
            }}
          />
          <Text size="xs" c="dimmed">
            {messages.generation}
          </Text>
        </>
      )}
    </Stack>
  );
}
