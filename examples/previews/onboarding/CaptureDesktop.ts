import type { OnboardingProgress } from '#contracts/Onboarding.js';
import { OnboardingAction } from '#contracts/OnboardingValues.js';
import { OnboardingService } from '../../../src/desktop/onboarding/application/OnboardingService.js';
import { createOnboardingProgress } from '../../../src/desktop/onboarding/domain/OnboardingProgress.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import type { ClassroomHome } from '#contracts/Classroom.js';
import type { InsightStudentProgress } from '#contracts/ClassroomInsights.js';
import { PetAction, createPetPreferences, type PetSnapshot } from '#contracts/Pet.js';

/* Only the authoring capture page loads this in-memory bridge. No API, account,
   microphone capture, model or native desktop capabilities are connected. */
const classId = '11111111-1111-4111-8111-111111111111';
const courseId = '22222222-2222-4222-8222-222222222222';
const user = { id: 'demo-minh', name: 'Minh', email: 'minh@example.test', isAdmin: false };
const home: ClassroomHome = {
  role: 'student',
  isAdmin: false,
  courses: [],
  classes: [
    {
      schoolClass: {
        id: classId,
        teacherId: 'demo-teacher',
        name: 'Lập trình Python · Cơ bản',
        courseRevisionId: courseId,
      },
      meetings: [],
    },
    {
      schoolClass: {
        id: '33333333-3333-4333-8333-333333333333',
        teacherId: 'demo-teacher',
        name: 'Tư duy máy tính · Khám phá',
        courseRevisionId: courseId,
      },
      meetings: [],
    },
  ],
};
const progress: InsightStudentProgress = {
  identity: {
    classId,
    studentId: user.id,
    window: {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-11T00:00:00.000Z',
      timezone: 'Asia/Ho_Chi_Minh',
    },
    sourceRevision: '1',
    privacyRevision: '1',
    coverageRevision: '1',
    derivationVersion: 'classroom-insights-v1',
    planIds: [],
    mappingIds: [],
    planVersions: [],
    mappingVersions: [],
  },
  studentId: user.id,
  name: user.name,
  coverage: 'partial',
  coverageReason: 'Earlier work is not captured.',
  handedIn: 4,
  assigned: null,
  independentTasks: 2,
  sessions: [
    {
      classSessionId: '44444444-4444-4444-8444-444444444444',
      observedAt: '2026-10-04T09:00:00.000Z',
      counts: {
        met: 2,
        needsChanges: 1,
        insufficient: 0,
        notChecked: 0,
        conflict: 0,
        removed: 0,
        total: 3,
        sourceIds: [],
      },
    },
    {
      classSessionId: '55555555-5555-4555-8555-555555555555',
      observedAt: '2026-10-08T09:00:00.000Z',
      counts: {
        met: 3,
        needsChanges: 0,
        insufficient: 0,
        notChecked: 0,
        conflict: 0,
        removed: 0,
        total: 3,
        sourceIds: [],
      },
    },
  ],
  assessments: [],
  submissions: [],
  support: [],
  nextTask: null,
  comparisons: [],
  delayedChecks: [],
};
let pet: PetSnapshot = {
  revision: 0,
  preferences: createPetPreferences(),
  reaction: 'idle',
  isVisible: false,
  hasPresentationError: false,
  encouragement: false,
  backdropId: null,
};

window.localStorage.setItem('tro.desktop.locale', 'vi');
const unavailable = (): Promise<never> =>
  Promise.reject(new Error('This authoring page has no native capabilities.'));
/* Opt-in preview progress is ephemeral; it cannot read or reset a real account. */
let onboardingProgress: OnboardingProgress = createOnboardingProgress();
const onboardingService = new OnboardingService({
  readProgress: () => Promise.resolve(onboardingProgress),
  saveProgress: (_accountId, saved) => {
    onboardingProgress = saved;
    return Promise.resolve();
  },
});
const onboardingBridge: Pick<
  DesktopBridge,
  'readOnboardingProgress' | 'updateOnboardingProgress' | 'restartOnboarding'
> = {
  readOnboardingProgress: (request) => onboardingService.readProgress(request.expectedAccountId),
  updateOnboardingProgress: (request) =>
    onboardingService.changeProgress(
      request.expectedAccountId,
      request.expectedRevision,
      request.action,
    ),
  restartOnboarding: (request) =>
    onboardingService.changeProgress(
      request.expectedAccountId,
      request.expectedRevision,
      OnboardingAction.RESTART,
    ),
};

window.tro = {
  ...(new URL(window.location.href).searchParams.has('onboarding') ? onboardingBridge : {}),
  readAuthSession: () => Promise.resolve({ kind: 'signed-in', user }),
  signInWithGoogle: () => Promise.resolve({ kind: 'signed-in', user }),
  signOut: () => Promise.resolve({ kind: 'signed-out' }),
  readDesktopPermissions: () =>
    Promise.resolve({ kind: 'ready', accessibility: 'granted', screenRecording: 'granted' }),
  requestDesktopPermissions: () => Promise.resolve({ kind: 'opened' }),
  openDesktopPermissionSettings: () => Promise.resolve({ kind: 'opened' }),
  startCursorCompanion: () =>
    Promise.resolve({ kind: 'started', sessionId: '66666666-6666-4666-8666-666666666666' }),
  startAgentSession: unavailable,
  sendAgentMessage: unavailable,
  answerTeachingLesson: unavailable,
  stopAgentSession: unavailable,
  subscribeVoiceInput: () => () => {},
  subscribeAgentProgress: () => () => {},
  controlVoiceInput: (command) =>
    Promise.resolve({
      kind: 'ok',
      status: {
        state: command.kind === 'enable' ? 'idle' : 'disabled',
        shortcut: 'command-control',
        globalShortcutAvailable: true,
      },
    }),
  appendVoiceAudio: () => Promise.resolve({ kind: 'failed' }),
  updateVoiceMeter: () => {},
  controlMicrophoneTest: () => Promise.resolve({ kind: 'failed' }),
  subscribeMicrophoneTest: () => () => {},
  readAppUpdate: () => Promise.resolve({ revision: 0, status: { state: 'disabled' } }),
  subscribeAppUpdate: () => () => {},
  checkAppUpdate: () => Promise.resolve({ kind: 'failed', reason: 'unavailable' }),
  downloadAppUpdate: () => Promise.resolve({ kind: 'failed', reason: 'unavailable' }),
  restartForAppUpdate: () => Promise.resolve({ kind: 'failed', reason: 'unavailable' }),
  controlClassroom: (command) =>
    Promise.resolve(command.kind === 'home' ? { kind: 'home', home } : { kind: 'ok' }),
  controlClassroomInsights: (command) =>
    Promise.resolve(
      command.kind === 'status'
        ? {
            kind: 'status',
            enabled: true,
            teacher: false,
            students: [{ id: user.id, name: user.name }],
            activities: [],
            plans: [],
            mappings: [],
          }
        : command.kind === 'read-student-progress'
          ? { kind: 'student-progress', progress }
          : { kind: 'failed', code: 'forbidden' },
    ),
  readPets: () => Promise.resolve({ kind: 'ok', snapshot: pet }),
  subscribePet: () => () => {},
  controlPet: (command) => {
    if (command.kind === PetAction.ADOPT) {
      pet = {
        ...pet,
        revision: pet.revision + 1,
        isVisible: true,
        preferences: {
          ...pet.preferences,
          enabled: true,
          activePetId: command.petId,
          names: { ...pet.preferences.names, [command.petId]: command.name },
        },
      };
    } else if (command.kind === PetAction.PREFERENCES) {
      pet = {
        ...pet,
        revision: pet.revision + 1,
        preferences: { ...pet.preferences, quiet: command.quiet, motion: command.motion },
      };
    } else if (command.kind === PetAction.HIDE) {
      pet = {
        ...pet,
        revision: pet.revision + 1,
        isVisible: false,
        preferences: { ...pet.preferences, enabled: false },
      };
    }
    return Promise.resolve({ kind: 'ok', snapshot: pet });
  },
} satisfies DesktopBridge;

function createDemoMicrophone(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    label,
    kind: 'audioinput',
    groupId: 'demo',
    toJSON: () => ({ deviceId, label, kind: 'audioinput', groupId: 'demo' }),
  };
}

Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
  value: () =>
    Promise.resolve([
      createDemoMicrophone('default', 'MacBook Pro Microphone'),
      createDemoMicrophone('demo-built-in', 'MacBook Pro Microphone'),
      createDemoMicrophone('demo-usb', 'USB Microphone'),
    ]),
});

await import('../../../src/desktop/renderer/Render.js');
