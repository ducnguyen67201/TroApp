import { expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  ClassroomFailure,
  type ClassroomCommand,
  type ClassroomReply,
} from '#contracts/Classroom.js';
import { ClassroomViewAs, type ClassroomPerson } from '#contracts/ClassroomViewAs.js';
import { ClassroomViewAsController } from '../../../../src/desktop/main/classroom/ClassroomViewAsController.js';
import { AccountTransitionGate } from '../../../../src/desktop/main/accounts/AccountTransitionGate.js';

const person: ClassroomPerson = {
  id: 'teacher',
  name: 'Teacher',
  email: 'teacher@example.test',
  role: AccountRole.TEACHER,
};

it('keeps admin cookies, scopes the subject header, and clears it when returning or changing accounts', async () => {
  let cookie = 'admin-cookie';
  const execute = vi
    .fn<(command: ClassroomCommand) => Promise<ClassroomReply>>()
    .mockResolvedValue({ kind: 'admin-view-as', person });
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response('{}')));
  const reset = vi.fn<() => void>();
  const controller = new ClassroomViewAsController({ execute }, () => cookie, reset, request);
  await controller.selectPerson(person.id);
  await controller.fetch('https://api.example.test/api/v1/classroom/materials', {
    headers: { cookie },
  });
  const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
  expect(headers.get('cookie')).toBe('admin-cookie');
  expect(headers.get(ClassroomViewAs.HEADER)).toBe('teacher');
  const classroomApi = {
    execute: vi.fn<(command: ClassroomCommand) => Promise<ClassroomReply>>().mockResolvedValue({
      kind: 'home',
      home: { role: AccountRole.TEACHER, isAdmin: false, classes: [], courses: [] },
    }),
  };
  expect(await controller.execute({ kind: 'home' }, classroomApi)).toMatchObject({
    kind: 'home',
    home: { viewingAs: person, isAdmin: true },
  });
  execute.mockResolvedValue({ kind: 'failed', code: ClassroomFailure.FORBIDDEN });
  expect(await controller.selectPerson(null)).toEqual({ kind: 'admin-view-as', person: null });
  await controller.fetch('https://api.example.test/api/v1/classroom/command');
  expect(new Headers(request.mock.calls[1]?.[1]?.headers).has(ClassroomViewAs.HEADER)).toBe(false);
  execute.mockResolvedValue({ kind: 'admin-view-as', person });
  await controller.selectPerson(person.id);
  cookie = 'another-account-cookie';
  await controller.fetch('https://api.example.test/api/v1/classroom/command');
  expect(new Headers(request.mock.calls[2]?.[1]?.headers).has(ClassroomViewAs.HEADER)).toBe(false);
  expect(reset).toHaveBeenCalledTimes(4);
});

it('discards selection and response results from a previous account or view', async () => {
  let resolveSelection: (reply: ClassroomReply) => void = () => {};
  let cookie = 'admin';
  const execute = () =>
    new Promise<ClassroomReply>((resolve) => {
      resolveSelection = resolve;
    });
  let resolveRequest: (reply: Response) => void = () => {};
  const request = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }),
  );
  const controller = new ClassroomViewAsController(
    { execute },
    () => cookie,
    () => {},
    request,
  );
  const selecting = controller.selectPerson('teacher');
  cookie = 'someone-else';
  resolveSelection({ kind: 'admin-view-as', person });
  expect(await selecting).toEqual({ kind: 'failed', code: ClassroomFailure.STALE });
  const fetching = controller.fetch('https://api.example.test/api/v1/classroom/materials');
  controller.reset();
  resolveRequest(new Response('{}'));
  await expect(fetching).rejects.toThrow('Classroom view changed.');
});

it('excludes view changes during requests and excludes requests during a view change', async () => {
  const gate = new AccountTransitionGate(
    () => false,
    () => false,
  );
  let finish: () => void = () => {};
  const request = gate.runRequest(
    () =>
      new Promise<string>((resolve) => {
        finish = () => {
          resolve('done');
        };
      }),
    'blocked',
  );
  expect(await gate.changeContext(() => Promise.resolve('changed'), 'blocked')).toBe('blocked');
  finish();
  await request;
  const changing = gate.changeContext(
    () =>
      new Promise<string>((resolve) => {
        finish = () => {
          resolve('changed');
        };
      }),
    'blocked',
  );
  expect(await gate.runRequest(() => Promise.resolve('sent'), 'blocked')).toBe('blocked');
  finish();
  expect(await changing).toBe('changed');
});
