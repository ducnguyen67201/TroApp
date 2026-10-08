import { RunContext } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import { ClassroomToolClient } from '../../../../src/desktop/worker/teaching/ClassroomToolClient.js';
import { TeachingLessonContext } from '../../../../src/desktop/worker/teaching/TeachingLessonContext.js';
import {
  createClassroomTeachingTools,
  type ClassroomTeachingSession,
} from '../../../../src/desktop/worker/teaching/ClassroomTeachingTools.js';
import { ClassroomToolCommandSchema } from '#contracts/Classroom.js';
import { createTeachingContext } from '../../../server/features/classroom/ClassroomFixtures.js';
import { randomUUID } from 'node:crypto';

describe('classroom teaching context', () => {
  it('seeds a new question with the activity and progress, without restoring stale cues', () => {
    const context = createTeachingContext();
    const lesson = new TeachingLessonContext('What next?', context);
    const input = JSON.stringify(lesson.buildInput('new request', null));
    expect(input).toContain(context.activity.objective);
    expect(input).toContain(context.attempt.id);
    expect(input).toContain('green-flag');
    expect(lesson.readCaptureId()).toBeNull();
    expect(lesson.readCurrentStep()).toBeNull();
  });

  it('offers recovery, progress and preparation without teacher actions or submission commit', () => {
    const callTool = vi.fn<ClassroomTeachingSession['callTool']>();
    const tools = createClassroomTeachingTools({ context: createTeachingContext(), callTool });
    expect(tools.map((tool) => tool.name)).toEqual([
      'read_class_material_note',
      'search_class_material',
      'read_class_material_source',
      'resume_activity_workspace',
      'save_activity_workspace',
      'report_activity_progress',
      'prepare_task_submission',
    ]);
    expect(ClassroomToolCommandSchema.safeParse({ kind: 'submit-work' }).success).toBe(false);
  });

  it('publishes the workspace URL as a strict string without the unsupported URI format', () => {
    const tools = createClassroomTeachingTools({
      context: createTeachingContext(),
      callTool: vi.fn<ClassroomTeachingSession['callTool']>(),
    });
    const workspaceTool = tools.find((entry) => entry.name === 'save_activity_workspace');
    expect(workspaceTool?.strict).toBe(true);
    expect(workspaceTool?.parameters).toMatchObject({
      type: 'object',
      properties: { url: { type: 'string', maxLength: 2000 } },
      required: ['url'],
      additionalProperties: false,
    });
    expect(JSON.stringify(workspaceTool?.parameters)).not.toContain('"format":"uri"');
  });

  it('saves a valid HTTPS workspace through the SDK execution boundary', async () => {
    const callTool = vi
      .fn<ClassroomTeachingSession['callTool']>()
      .mockResolvedValue({ kind: 'ok' });
    const workspaceTool = createClassroomTeachingTools({
      context: createTeachingContext(),
      callTool,
    }).find((entry) => entry.name === 'save_activity_workspace');
    if (!workspaceTool) {
      throw new Error('Expected workspace tool.');
    }
    await workspaceTool.invoke(
      new RunContext(),
      JSON.stringify({ url: 'https://scratch.mit.edu/projects/123/' }),
    );
    expect(callTool).toHaveBeenCalledExactlyOnceWith({
      kind: 'save-workspace',
      url: 'https://scratch.mit.edu/projects/123/',
    });
  });

  it.each([
    { url: 'http://scratch.mit.edu/projects/123/' },
    { url: 'https://user:password@example.test/project' },
    { url: 'not a URL' },
    { url: 'https://example.test/' + 'x'.repeat(2000) },
    { url: 123 },
    { url: 'https://example.test/project', extra: 'unexpected' },
  ])('rejects invalid workspace arguments before dispatch: $url', async (input) => {
    const callTool = vi.fn<ClassroomTeachingSession['callTool']>();
    const workspaceTool = createClassroomTeachingTools({
      context: createTeachingContext(),
      callTool,
    }).find((entry) => entry.name === 'save_activity_workspace');
    if (!workspaceTool) {
      throw new Error('Expected workspace tool.');
    }
    await workspaceTool.invoke(new RunContext(), JSON.stringify(input));
    expect(callTool).not.toHaveBeenCalled();
  });

  it('settles correlated tools on cancellation and ignores late responses', async () => {
    const signal = new AbortController();
    const send = vi.fn<ConstructorParameters<typeof ClassroomToolClient>[0]>();
    const client = new ClassroomToolClient(send, randomUUID(), randomUUID(), signal.signal);
    const pending = client.request({ kind: 'resume-workspace' });
    const request = send.mock.calls[0]?.[0];
    signal.abort();
    expect(await pending).toEqual({ kind: 'failed', code: 'stale' });
    if (request) {
      client.receive({
        kind: 'classroom-tool-result',
        requestId: request.requestId,
        reply: { kind: 'ok' },
      });
    }
    client.dispose();
  });
});
