import { expect, it } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { OnboardingStep, onboardingSteps } from '#contracts/OnboardingValues.js';
import { readOnboardingMedia } from '../../../../src/desktop/renderer/onboarding/OnboardingMedia.js';
import { readOnboardingContent } from '../../../../src/desktop/renderer/onboarding/OnboardingContent.js';

it('provides both locales and audiences', () => {
  for (const stepId of onboardingSteps) {
    for (const role of Object.values(AccountRole)) {
      for (const locale of Object.values(DesktopLocale)) {
        const content = readOnboardingContent(stepId, locale, role);
        expect(content.copy.title).not.toBe('');
        expect(content.copy.description).not.toBe('');
      }
    }
  }
});

it('uses distinct teacher and student instructions for classroom preparation and released lessons', () => {
  const teacher = readOnboardingContent(
    OnboardingStep.GUIDED_LESSONS,
    DesktopLocale.ENGLISH,
    AccountRole.TEACHER,
  );
  const student = readOnboardingContent(
    OnboardingStep.GUIDED_LESSONS,
    DesktopLocale.ENGLISH,
    AccountRole.STUDENT,
  );
  expect(teacher.copy.description).toContain('Approve the script');
  expect(teacher.copy.takeaway).toContain('Coming soon.');
  expect(student.copy.takeaway).toContain('Coming soon.');
  expect(student.copy.description).toContain('released by your teacher');
});

it('does not invent a recording or transcript for a missing asset entry', () => {
  expect(readOnboardingMedia(DesktopLocale.VIETNAMESE, 'MissingRecordingFixture')).toEqual({});
});

it('loads the five approved student videos, posters and Vietnamese transcripts with labelled English fallback', () => {
  for (const stepId of [
    OnboardingStep.CLASSES,
    OnboardingStep.INSIGHTS,
    OnboardingStep.GUIDED_LESSONS,
    OnboardingStep.MICROPHONE,
    OnboardingStep.PETS,
  ]) {
    const vietnamese = readOnboardingContent(stepId, DesktopLocale.VIETNAMESE, AccountRole.STUDENT);
    const english = readOnboardingContent(stepId, DesktopLocale.ENGLISH, AccountRole.STUDENT);
    expect(vietnamese.video?.source).toMatch(/\.mp4$/);
    expect(vietnamese.video?.poster).toMatch(/\.png$/);
    expect(vietnamese.transcript).toBeTruthy();
    expect(english.video).toEqual(vietnamese.video);
    expect(english.videoLocale).toBe(DesktopLocale.VIETNAMESE);
    expect(english.transcript).toBeNull();
    expect(english.copy.title).not.toBe(vietnamese.copy.title);
  }
});

it('shares microphone and pet clips with teachers', () => {
  for (const stepId of [OnboardingStep.MICROPHONE, OnboardingStep.PETS]) {
    const teacher = readOnboardingContent(stepId, DesktopLocale.VIETNAMESE, AccountRole.TEACHER);
    const student = readOnboardingContent(stepId, DesktopLocale.VIETNAMESE, AccountRole.STUDENT);
    expect(teacher.video).not.toBeNull();
    expect(teacher.video).toEqual(student.video);
  }
});

it('shows teacher-specific classroom videos in both locales without substituting student recordings', () => {
  for (const [stepId, stem] of [
    [OnboardingStep.CLASSES, 'TeacherClasses'],
    [OnboardingStep.INSIGHTS, 'TeacherInsights'],
    [OnboardingStep.GUIDED_LESSONS, 'TeacherGuidedLessons'],
  ] as const) {
    for (const locale of Object.values(DesktopLocale)) {
      const teacher = readOnboardingContent(stepId, locale, AccountRole.TEACHER);
      const student = readOnboardingContent(stepId, locale, AccountRole.STUDENT);
      expect(teacher.video?.source).toContain(`/vi/${stem}.mp4`);
      expect(teacher.videoLocale).toBe(DesktopLocale.VIETNAMESE);
      expect(teacher.video?.source).not.toBe(student.video?.source);
    }
  }
});
