import { expect, it } from 'vitest';
import { MaterialCommandSchema } from '#contracts/ClassroomMaterials.js';

it('rejects incomplete and malformed reference URLs without throwing during validation', () => {
  for (const url of ['', 'https:', 'not a URL', 'https://user:password@example.test/']) {
    const result = MaterialCommandSchema.safeParse({
      kind: 'add-link',
      classId: '306b1f29-6d1f-4327-9228-f76f72b1f701',
      version: 0,
      name: 'Practice',
      url,
    });
    expect(result.success).toBe(false);
  }
});

it('bounds AI revision instructions without changing the ordinary preparation command', () => {
  const command = {
    kind: 'prepare',
    classId: '306b1f29-6d1f-4327-9228-f76f72b1f701',
    version: 2,
    teacherInstructions: '',
    locale: 'en',
  };
  expect(MaterialCommandSchema.safeParse(command).success).toBe(true);
  expect(
    MaterialCommandSchema.parse({ ...command, revisionRequest: '  Add more practice.  ' }),
  ).toMatchObject({ revisionRequest: 'Add more practice.' });
  for (const revisionRequest of ['', '  ', 'x'.repeat(4001)]) {
    expect(MaterialCommandSchema.safeParse({ ...command, revisionRequest }).success).toBe(false);
  }
});
