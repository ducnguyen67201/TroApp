import { useState, type ReactElement } from 'react';
import { Button, Checkbox, Group, NativeSelect, Paper, Stack, Text } from '@mantine/core';
import { AccountRole } from '#contracts/AccountRole.js';
import { OrganizationAction, type OrganizationClass } from '#contracts/Organizations.js';
import { useLocale } from '../localization/UseLocale.js';
import { teamMessages } from './TeamMessages.js';
import type { OrganizationTeam, TeamView } from './UseTeam.js';

interface OrganizationClassesProps {
  team: OrganizationTeam;
  view: TeamView;
}

function ClassTeacherRow({
  schoolClass,
  team,
  view,
}: OrganizationClassesProps & { schoolClass: OrganizationClass }): ReactElement {
  const { locale } = useLocale();
  const messages = teamMessages[locale];
  const assignedTeacherIds = schoolClass.teacherIds ?? [schoolClass.teacherId];
  const [teacherIds, setTeacherIds] = useState(assignedTeacherIds);
  const teachers = team.members.filter((member) => member.role === AccountRole.TEACHER);
  const choices = teachers.map((member) => ({
    value: member.userId,
    label: member.name || member.email,
  }));
  for (const teacherId of assignedTeacherIds) {
    if (!teachers.some((teacher) => teacher.userId === teacherId)) {
      const member = team.members.find((entry) => entry.userId === teacherId);
      choices.push({
        value: teacherId,
        label: `${member?.name || member?.email || messages.unavailableTeacher} · ${messages.unavailableTeacher}`,
      });
    }
  }
  const hasChanges =
    teacherIds.length !== assignedTeacherIds.length ||
    teacherIds.some((id) => !assignedTeacherIds.includes(id));
  const isBusy = view.isSaving || view.isLoading;
  return (
    <Paper withBorder p="sm" component="section" aria-label={schoolClass.name}>
      <Stack gap="sm">
        <Text fw={500}>{schoolClass.name}</Text>
        <Checkbox.Group
          label={messages.assignedTeacher}
          value={teacherIds}
          onChange={setTeacherIds}
        >
          <Stack gap="sm" mt="sm">
            {choices.map((choice) => (
              <Checkbox
                key={choice.value}
                value={choice.value}
                label={choice.label}
                disabled={isBusy || schoolClass.hasLiveSession}
              />
            ))}
          </Stack>
        </Checkbox.Group>
        <Text size="xs" c="dimmed">
          {schoolClass.hasLiveSession ? messages.liveClassHint : messages.assignTeacherHint}
        </Text>
        <Group justify="flex-end">
          <Button
            variant="default"
            disabled={
              isBusy ||
              schoolClass.hasLiveSession ||
              !hasChanges ||
              teacherIds.length === 0 ||
              teacherIds.some((id) => !teachers.some((teacher) => teacher.userId === id))
            }
            onClick={() => {
              void view.sendCommand({
                kind: OrganizationAction.SET_CLASS_TEACHERS,
                organizationId: team.organization.id,
                classId: schoolClass.id,
                teacherIds,
                expectedTeacherIds: assignedTeacherIds,
              });
            }}
          >
            {messages.assignTeacher}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

/** Owner-only metadata and commands do not grant the owner access to classroom content. */
export function OrganizationClassesPanel({ team, view }: OrganizationClassesProps): ReactElement {
  const { locale } = useLocale();
  const messages = teamMessages[locale];
  const [classId, setClassId] = useState('');
  const [isConfirming, setConfirming] = useState(false);
  const personalClasses = team.personalClasses ?? [];
  const selected = personalClasses.find((item) => item.id === classId);
  const isBusy = view.isSaving || view.isLoading;
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {messages.classesHint}
      </Text>
      {team.classes?.length ? (
        team.classes.map((schoolClass) => (
          <ClassTeacherRow
            key={`${schoolClass.id}:${(schoolClass.teacherIds ?? [schoolClass.teacherId]).join(',')}`}
            schoolClass={schoolClass}
            team={team}
            view={view}
          />
        ))
      ) : (
        <Text size="sm">{messages.noClasses}</Text>
      )}
      {personalClasses.length > 0 && (
        <Paper withBorder p="sm">
          <Stack gap="sm">
            <Text fw={500}>{messages.linkClass}</Text>
            <Text size="sm" c="dimmed">
              {messages.linkClassHint}
            </Text>
            <NativeSelect
              label={messages.personalClass}
              value={classId}
              disabled={isBusy}
              data={[
                { value: '', label: '—' },
                ...personalClasses.map((item) => ({ value: item.id, label: item.name })),
              ]}
              onChange={(event) => {
                setClassId(event.currentTarget.value);
                setConfirming(false);
              }}
            />
            {selected?.hasLiveSession && <Text size="sm">{messages.liveClassHint}</Text>}
            <Group justify="flex-end">
              <Button
                disabled={isBusy || !selected || selected.hasLiveSession}
                onClick={() => {
                  if (!selected) {
                    return;
                  }
                  if (!isConfirming) {
                    setConfirming(true);
                    return;
                  }
                  void view.sendCommand({
                    kind: OrganizationAction.LINK_CLASS,
                    organizationId: team.organization.id,
                    classId: selected.id,
                  });
                }}
              >
                {isConfirming ? messages.confirmLinkClass : messages.linkClass}
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
