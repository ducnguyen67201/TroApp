import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { AccountRole } from '#contracts/AccountRole.js';
import { PetId } from '#contracts/Pet.js';
import {
  PetCorrectionKind,
  PetRecognitionCategory,
  PetWalletEntryKind,
  PetWorldCommandKind,
  PetWorldFailure,
  PetWorldLimits,
  type PetWorldCommand,
} from '#contracts/PetWorld.js';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { PetWorldService } from '../../../src/server/features/petWorld/application/PetWorldService.js';
import { petCatalog } from '../../../src/server/features/petWorld/domain/PetCatalog.js';
import { createPrismaClassroomStore } from '../../../src/server/persistence/PrismaClassroomStore.js';
import { createPrismaPetWorldStore } from '../../../src/server/persistence/PrismaPetWorldStore.js';
import { createCourseContent } from '../features/classroom/ClassroomFixtures.js';

const environment = readServerEnv(process.env);
const classroom = createPrismaClassroomStore(environment.DATABASE_URL);
const database = createPrismaPetWorldStore(environment.DATABASE_URL);
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
});
const service = new PetWorldService(database.store);

afterAll(async () => {
  await database.close();
  await classroom.close();
  await client.$disconnect();
});

async function createFixture() {
  const teacher = randomUUID();
  const first = `a-${randomUUID()}`;
  const second = `z-${randomUUID()}`;
  const stranger = randomUUID();
  await client.user.createMany({
    data: [teacher, first, second, stranger].map((id) => ({
      id,
      name: id === teacher ? 'Teacher' : 'Student',
      email: `${id}@example.test`,
      emailVerified: true,
      role: id === teacher ? AccountRole.TEACHER : AccountRole.STUDENT,
    })),
  });
  const course = await classroom.store.saveCourse(
    teacher,
    'Pet World integration',
    createCourseContent(),
  );
  const schoolClass = await classroom.store.saveClass(teacher, 'Our classroom', course.id);
  await client.classroomEnrollment.createMany({
    data: [first, second].map((studentId) => ({ classId: schoolClass.id, studentId })),
  });
  return { teacher, first, second, stranger, classId: schoolClass.id };
}

function createGrant(classId: string, studentIds: string[], pointsPerStudent = '50') {
  return {
    kind: PetWorldCommandKind.GRANT_POINTS,
    requestId: randomUUID(),
    classId,
    studentIds,
    pointsPerStudent,
    category: PetRecognitionCategory.PERSISTENCE,
    note: 'Tried a second approach.',
  } satisfies PetWorldCommand;
}

async function initializeWorld(studentId: string) {
  return await service.execute(studentId, {
    kind: PetWorldCommandKind.INITIALIZE_WORLD,
    requestId: randomUUID(),
    activePetId: PetId.FOX,
    names: { cat: 'Saved Mochi', fox: 'Saved Maple' },
  });
}

function createPurchase(itemId: string, equipAfterPurchase = false, expectedWorldRevision = 0) {
  const item = petCatalog.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new Error('Missing integration catalog item.');
  }
  return {
    kind: PetWorldCommandKind.BUY_ITEM,
    requestId: randomUUID(),
    itemId,
    catalogRevision: petCatalog.revision,
    displayedPrice: item.price,
    equipAfterPurchase,
    expectedWorldRevision,
  } satisfies PetWorldCommand;
}

async function expectBalancedWallet(studentId: string, expectedBalance: bigint) {
  const [wallet, entries] = await Promise.all([
    client.petWallet.findUnique({ where: { studentId } }),
    client.petWalletEntry.findMany({ where: { studentId } }),
  ]);
  expect(wallet?.balance).toBe(expectedBalance);
  expect(entries.reduce((balance, entry) => balance + entry.delta, 0n)).toBe(expectedBalance);
}

describe('Pet World PostgreSQL accounting and ownership', () => {
  it('deduplicates concurrent teacher awards and restores their receipt after a new connection', async () => {
    const fixture = await createFixture();
    const command = createGrant(fixture.classId, [fixture.first]);
    const results = await Promise.all([
      service.execute(fixture.teacher, command),
      service.execute(fixture.teacher, command),
    ]);
    expect(results[0]).toEqual(results[1]);
    await expectBalancedWallet(fixture.first, 50n);
    expect(await client.petRecognition.count({ where: { studentId: fixture.first } })).toBe(1);
    expect(await client.petWalletEntry.count({ where: { studentId: fixture.first } })).toBe(1);
    expect(await client.petWorld.findUnique({ where: { studentId: fixture.first } })).toBeNull();

    const restarted = createPrismaPetWorldStore(environment.DATABASE_URL);
    try {
      expect(await new PetWorldService(restarted.store).execute(fixture.teacher, command)).toEqual(
        results[0],
      );
    } finally {
      await restarted.close();
    }
    await initializeWorld(fixture.first);
    const world = await service.execute(fixture.first, { kind: PetWorldCommandKind.OWN_WORLD });
    expect(world).toMatchObject({
      kind: 'world',
      world: {
        wallet: { balance: '50' },
        profile: { activePetId: PetId.FOX, names: { cat: 'Saved Mochi', fox: 'Saved Maple' } },
      },
    });
    await expect(
      service.execute(fixture.teacher, { ...command, pointsPerStudent: '51' }),
    ).rejects.toMatchObject({ code: PetWorldFailure.REQUEST_CONFLICT });
  });

  it('rolls back an entire group when a later recipient would overflow, with no award budget', async () => {
    const fixture = await createFixture();
    await service.execute(
      fixture.teacher,
      createGrant(fixture.classId, [fixture.second], PetWorldLimits.MAX_POINTS),
    );
    const command = createGrant(fixture.classId, [fixture.first, fixture.second], '1');
    await expect(service.execute(fixture.teacher, command)).rejects.toMatchObject({
      code: PetWorldFailure.INVALID,
    });
    expect(await client.petWallet.findUnique({ where: { studentId: fixture.first } })).toBeNull();
    expect(await client.petRecognition.count({ where: { requestId: command.requestId } })).toBe(0);
    expect(await client.petWalletEntry.count({ where: { requestId: command.requestId } })).toBe(0);
    expect(
      await client.petWorldReceipt.findUnique({
        where: { actorId_requestId: { actorId: fixture.teacher, requestId: command.requestId } },
      }),
    ).toBeNull();
    await expectBalancedWallet(fixture.second, BigInt(PetWorldLimits.MAX_POINTS));
  });

  it('serializes competing purchases without losing either debit and charges a duplicate entitlement once', async () => {
    const fixture = await createFixture();
    await initializeWorld(fixture.first);
    await service.execute(fixture.teacher, createGrant(fixture.classId, [fixture.first], '100'));
    await Promise.all([
      service.execute(fixture.first, createPurchase('meadow')),
      service.execute(fixture.first, createPurchase('little-fern')),
    ]);
    await expectBalancedWallet(fixture.first, 70n);
    const outcomes = await Promise.allSettled([
      service.execute(fixture.first, createPurchase('reading-nook')),
      service.execute(fixture.first, createPurchase('reading-nook')),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejection).toMatchObject({ reason: { code: PetWorldFailure.ALREADY_OWNED } });
    await expectBalancedWallet(fixture.first, 35n);
    expect(await client.petInventoryItem.count({ where: { studentId: fixture.first } })).toBe(3);
    expect(await client.petPurchase.count({ where: { studentId: fixture.first } })).toBe(3);
  });

  it('retries a real serializable dependency conflict through commit without duplicating accounting sources', async () => {
    const fixture = await createFixture();
    await initializeWorld(fixture.first);
    await initializeWorld(fixture.second);
    let arrivals = 0;
    let releaseBarrier: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const attempts = new Map<string, number>();
    const awardAfterReadingOtherWallet = (studentId: string, otherStudentId: string) => {
      const recognitionId = randomUUID();
      const entryId = randomUUID();
      const requestId = randomUUID();
      const batchId = randomUUID();
      const createdAt = new Date().toISOString();
      return database.store.runAtomically(async (transaction) => {
        const attempt = (attempts.get(studentId) ?? 0) + 1;
        attempts.set(studentId, attempt);
        await transaction.readWallet(otherStudentId);
        if (attempt === 1) {
          arrivals += 1;
          if (arrivals === 2) {
            releaseBarrier();
          }
          await barrier;
        }
        const wallet = await transaction.readWallet(studentId);
        if (!wallet) {
          throw new Error('Missing initialized wallet.');
        }
        await transaction.saveRecognition({
          id: recognitionId,
          classId: fixture.classId,
          teacherId: fixture.teacher,
          studentId,
          batchId,
          requestId,
          points: '1',
          category: PetRecognitionCategory.CONTRIBUTION,
          note: '',
          classSessionId: null,
          activityId: null,
          correction: null,
          createdAt,
        });
        await transaction.saveWallet(
          { ...wallet, balance: wallet.balance + 1n, revision: wallet.revision + 1 },
          wallet.revision,
        );
        await transaction.appendWalletEntry({
          id: entryId,
          studentId,
          kind: PetWalletEntryKind.TEACHER_GRANT,
          delta: 1n,
          sourceId: recognitionId,
          requestId,
          createdAt,
        });
      });
    };
    await Promise.all([
      awardAfterReadingOtherWallet(fixture.first, fixture.second),
      awardAfterReadingOtherWallet(fixture.second, fixture.first),
    ]);
    expect([...attempts.values()].reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(3);
    await expectBalancedWallet(fixture.first, 1n);
    await expectBalancedWallet(fixture.second, 1n);
    expect(await client.petRecognition.count({ where: { classId: fixture.classId } })).toBe(2);
  });

  it('aborts a stale buy-and-equip intent before any debit, entitlement or receipt survives', async () => {
    const fixture = await createFixture();
    await initializeWorld(fixture.first);
    await service.execute(fixture.teacher, createGrant(fixture.classId, [fixture.first]));
    await service.execute(fixture.first, {
      kind: PetWorldCommandKind.SET_PET_PROFILE,
      requestId: randomUUID(),
      expectedWorldRevision: 0,
      activePetId: PetId.CAT,
      name: 'Cloud Mochi',
    });
    const purchase = createPurchase('meadow', true, 0);
    await expect(service.execute(fixture.first, purchase)).rejects.toMatchObject({
      code: PetWorldFailure.STALE,
    });
    await expectBalancedWallet(fixture.first, 50n);
    expect(await client.petInventoryItem.count({ where: { studentId: fixture.first } })).toBe(0);
    expect(
      await client.petWorldReceipt.findUnique({
        where: { actorId_requestId: { actorId: fixture.first, requestId: purchase.requestId } },
      }),
    ).toBeNull();
    const accepted = createPurchase('meadow', true, 1);
    const receipts = await Promise.all([
      service.execute(fixture.first, accepted),
      service.execute(fixture.first, accepted),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    await expectBalancedWallet(fixture.first, 30n);
    expect(
      await service.execute(fixture.first, { kind: PetWorldCommandKind.OWN_WORLD }),
    ).toMatchObject({
      kind: 'world',
      world: { profile: { backdropItemId: 'meadow', revision: 2 } },
    });
  });

  it('preserves a concurrently initialized cloud profile and both saved pet names', async () => {
    const fixture = await createFixture();
    await Promise.all([
      initializeWorld(fixture.first),
      service.execute(fixture.first, {
        kind: PetWorldCommandKind.INITIALIZE_WORLD,
        requestId: randomUUID(),
        activePetId: PetId.CAT,
        names: { cat: 'Other Mochi', fox: 'Other Maple' },
      }),
    ]);
    const before = await database.store.runAtomically((transaction) =>
      transaction.readWorld(fixture.first),
    );
    await initializeWorld(fixture.first);
    const after = await database.store.runAtomically((transaction) =>
      transaction.readWorld(fixture.first),
    );
    expect(after).toEqual(before);
    expect(await client.petWorld.count({ where: { studentId: fixture.first } })).toBe(1);
    await expectBalancedWallet(fixture.first, 0n);
    expect(await client.petWalletEntry.count({ where: { studentId: fixture.first } })).toBe(0);
  });

  it('keeps spending intact when a recognition is voided after an unavailable full reversal', async () => {
    const fixture = await createFixture();
    await initializeWorld(fixture.first);
    const grant = await service.execute(
      fixture.teacher,
      createGrant(fixture.classId, [fixture.first]),
    );
    if (grant.kind !== 'granted' || !grant.recognitions[0]) {
      throw new Error('Missing recognition.');
    }
    const recognitionId = grant.recognitions[0].id;
    await service.execute(fixture.first, createPurchase('meadow'));
    await expect(
      service.execute(fixture.teacher, {
        kind: PetWorldCommandKind.REVERSE_GRANT,
        requestId: randomUUID(),
        recognitionId,
        reason: 'Incorrect award',
      }),
    ).rejects.toMatchObject({ code: PetWorldFailure.INSUFFICIENT_POINTS });
    expect(await client.petRecognitionCorrection.count({ where: { recognitionId } })).toBe(0);
    const voidCommand = {
      kind: PetWorldCommandKind.VOID_RECOGNITION,
      requestId: randomUUID(),
      recognitionId,
      reason: 'Record corrected without taking purchased items.',
    } satisfies PetWorldCommand;
    const replies = await Promise.all([
      service.execute(fixture.teacher, voidCommand),
      service.execute(fixture.teacher, voidCommand),
    ]);
    expect(replies[0]).toEqual(replies[1]);
    await expectBalancedWallet(fixture.first, 30n);
    expect(await client.petInventoryItem.count({ where: { studentId: fixture.first } })).toBe(1);
    expect(
      await client.petRecognitionCorrection.findUnique({ where: { recognitionId } }),
    ).toMatchObject({ kind: PetCorrectionKind.VOIDED });
    await expect(
      service.execute(fixture.teacher, {
        kind: PetWorldCommandKind.REVERSE_GRANT,
        requestId: randomUUID(),
        recognitionId,
        reason: 'Try later',
      }),
    ).rejects.toMatchObject({ code: PetWorldFailure.REVERSAL_UNAVAILABLE });
  });

  it('reverses an eligible grant once under concurrent duplicate requests', async () => {
    const fixture = await createFixture();
    const grant = await service.execute(
      fixture.teacher,
      createGrant(fixture.classId, [fixture.first]),
    );
    if (grant.kind !== 'granted' || !grant.recognitions[0]) {
      throw new Error('Missing recognition.');
    }
    const recognitionId = grant.recognitions[0].id;
    const reverse = {
      kind: PetWorldCommandKind.REVERSE_GRANT,
      requestId: randomUUID(),
      recognitionId,
      reason: 'Duplicate classroom recognition',
    } satisfies PetWorldCommand;
    const outcomes = await Promise.all([
      service.execute(fixture.teacher, reverse),
      service.execute(fixture.teacher, reverse),
    ]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    await expectBalancedWallet(fixture.first, 0n);
    expect(
      await client.petWalletEntry.count({
        where: { studentId: fixture.first, kind: PetWalletEntryKind.GRANT_REVERSAL },
      }),
    ).toBe(1);
  });

  it('checks teacher authority inside each transaction, including receipt reads after enrollment changes', async () => {
    const fixture = await createFixture();
    const command = createGrant(fixture.classId, [fixture.first]);
    await expect(service.execute(fixture.second, command)).rejects.toMatchObject({
      code: PetWorldFailure.FORBIDDEN,
    });
    const granted = await service.execute(fixture.teacher, command);
    await classroom.store.enrollStudent(fixture.classId, fixture.first, false);
    expect(await service.execute(fixture.teacher, command)).toEqual(granted);
    await expect(
      service.execute(fixture.teacher, createGrant(fixture.classId, [fixture.first])),
    ).rejects.toMatchObject({ code: PetWorldFailure.FORBIDDEN });
    await client.user.update({
      where: { id: fixture.teacher },
      data: { role: AccountRole.STUDENT },
    });
    await expect(service.execute(fixture.teacher, command)).rejects.toMatchObject({
      code: PetWorldFailure.FORBIDDEN,
    });
    await expectBalancedWallet(fixture.first, 50n);
  });
});

describe('Pet World PostgreSQL sharing lifecycle and integrity constraints', () => {
  it('projects shared enrolled homes in bulk and counts distinct nonvoided award batches', async () => {
    const fixture = await createFixture();
    await initializeWorld(fixture.first);
    await initializeWorld(fixture.second);
    await initializeWorld(fixture.stranger);
    await service.execute(fixture.first, {
      kind: PetWorldCommandKind.SET_HOME_SHARING,
      requestId: randomUUID(),
      classId: fixture.classId,
      enabled: true,
      expectedShareRevision: 0,
    });
    /* A stale consent row must never admit an unenrolled owner into the bulk projection. */
    await client.petHomeShare.create({
      data: { studentId: fixture.stranger, classId: fixture.classId, enabled: true, revision: 1 },
    });
    const group = await service.execute(
      fixture.teacher,
      createGrant(fixture.classId, [fixture.first, fixture.second]),
    );
    if (group.kind !== 'granted' || !group.recognitions[0] || !group.recognitions[1]) {
      throw new Error('Missing group award.');
    }
    await service.execute(fixture.teacher, {
      kind: PetWorldCommandKind.VOID_RECOGNITION,
      requestId: randomUUID(),
      recognitionId: group.recognitions[0].id,
      reason: 'One group recipient was selected accidentally.',
    });
    const corrected = await service.execute(
      fixture.teacher,
      createGrant(fixture.classId, [fixture.first]),
    );
    if (corrected.kind !== 'granted' || !corrected.recognitions[0]) {
      throw new Error('Missing corrected award.');
    }
    await service.execute(fixture.teacher, {
      kind: PetWorldCommandKind.REVERSE_GRANT,
      requestId: randomUUID(),
      recognitionId: corrected.recognitions[0].id,
      reason: 'A whole accidental award was reversed.',
    });
    for (let index = 0; index < 4; index += 1) {
      await service.execute(fixture.teacher, createGrant(fixture.classId, [fixture.first]));
    }
    const futureService = new PetWorldService(
      database.store,
      () => new Date('2099-01-01T00:00:00.000Z'),
    );
    await futureService.execute(fixture.teacher, createGrant(fixture.classId, [fixture.first]));
    const neighborhood = await service.execute(fixture.second, {
      kind: PetWorldCommandKind.CLASS_NEIGHBORHOOD,
      classId: fixture.classId,
    });
    expect(neighborhood).toMatchObject({
      kind: 'neighborhood',
      homes: [{ studentId: fixture.first }],
      garden: { classroomMoments: 5, gardenMilestone: 1 },
    });
    if (neighborhood.kind !== 'neighborhood') {
      throw new Error('Expected neighborhood projection.');
    }
    expect(neighborhood.homes).toHaveLength(1);
    expect(JSON.stringify(neighborhood)).not.toMatch(/wallet|recognitions|note|teacherId/);
    await classroom.store.enrollStudent(fixture.classId, fixture.first, false);
    expect(
      await service.execute(fixture.second, {
        kind: PetWorldCommandKind.CLASS_NEIGHBORHOOD,
        classId: fixture.classId,
      }),
    ).toMatchObject({ kind: 'neighborhood', homes: [], garden: { classroomMoments: 5 } });
    await service.execute(fixture.teacher, {
      kind: PetWorldCommandKind.VOID_RECOGNITION,
      requestId: randomUUID(),
      recognitionId: group.recognitions[1].id,
      reason: 'The remaining group recognition was recorded by mistake.',
    });
    expect(
      await service.execute(fixture.second, {
        kind: PetWorldCommandKind.CLASS_NEIGHBORHOOD,
        classId: fixture.classId,
      }),
    ).toMatchObject({ kind: 'neighborhood', garden: { classroomMoments: 4, gardenMilestone: 0 } });
  });

  it('expires private recognition prose while preserving accounting, ownership and receipt replay', async () => {
    const fixture = await createFixture();
    const historicalService = new PetWorldService(
      database.store,
      () => new Date('1900-01-01T12:00:00.000Z'),
    );
    const award = createGrant(fixture.classId, [fixture.first]);
    const granted = await historicalService.execute(fixture.teacher, award);
    if (granted.kind !== 'granted' || !granted.recognitions[0]) {
      throw new Error('Missing historical recognition.');
    }
    const recognitionId = granted.recognitions[0].id;
    await initializeWorld(fixture.first);
    await service.execute(fixture.first, createPurchase('meadow'));
    const correction = {
      kind: PetWorldCommandKind.VOID_RECOGNITION,
      requestId: randomUUID(),
      recognitionId,
      reason: 'Private correction prose that expires.',
    } satisfies PetWorldCommand;
    const corrected = await historicalService.execute(fixture.teacher, correction);
    const entries = await client.petWalletEntry.findMany({
      where: { studentId: fixture.first },
      orderBy: { id: 'asc' },
    });
    const beforeRevision = await database.store.runAtomically((transaction) =>
      transaction.readOwnerRecognitionRevision(fixture.first),
    );
    const result = await database.purgeExpiredSources(new Date('1901-01-01T12:00:00.000Z'), 180);
    expect(result.expired).toBe(2);
    expect(await client.petRecognition.findUnique({ where: { id: recognitionId } })).toMatchObject({
      note: null,
    });
    expect(
      await client.petRecognitionCorrection.findUnique({ where: { recognitionId } }),
    ).toMatchObject({ reason: null, kind: PetCorrectionKind.VOIDED });
    expect(
      await client.petWalletEntry.findMany({
        where: { studentId: fixture.first },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(entries);
    await expectBalancedWallet(fixture.first, 30n);
    expect(await client.petInventoryItem.count({ where: { studentId: fixture.first } })).toBe(1);
    expect(await historicalService.execute(fixture.teacher, award)).toEqual(granted);
    expect(await historicalService.execute(fixture.teacher, correction)).toEqual(corrected);
    expect(JSON.stringify(corrected)).not.toContain(correction.reason);
    expect(
      await database.store.runAtomically((transaction) =>
        transaction.readOwnerRecognitionRevision(fixture.first),
      ),
    ).toBeGreaterThan(beforeRevision);
    expect(await database.purgeExpiredSources(new Date('1901-01-01T12:00:00.000Z'), 180)).toEqual({
      expired: 0,
      more: false,
    });
    await expect(
      client.petRecognitionCorrection.update({
        where: { recognitionId },
        data: { kind: PetCorrectionKind.REVERSED },
      }),
    ).rejects.toThrow();
  });

  it('disables class consent in the enrollment/delete transaction and does not restore it on re-enrollment', async () => {
    const fixture = await createFixture();
    await initializeWorld(fixture.first);
    await service.execute(fixture.first, {
      kind: PetWorldCommandKind.SET_HOME_SHARING,
      requestId: randomUUID(),
      classId: fixture.classId,
      enabled: true,
      expectedShareRevision: 0,
    });
    expect(
      await service.execute(fixture.second, {
        kind: PetWorldCommandKind.VISIT_HOME,
        classId: fixture.classId,
        studentId: fixture.first,
      }),
    ).toMatchObject({ kind: 'home' });

    await expect(
      classroom.store.runAtomically(async (transaction) => {
        await transaction.enrollStudent(fixture.classId, fixture.first, false);
        throw new Error('Synthetic rollback');
      }),
    ).rejects.toThrow('Synthetic rollback');
    expect(
      await client.petHomeShare.findUnique({
        where: { studentId_classId: { studentId: fixture.first, classId: fixture.classId } },
      }),
    ).toMatchObject({ enabled: true, revision: 1n });

    await classroom.store.enrollStudent(fixture.classId, fixture.first, false);
    expect(
      await client.petHomeShare.findUnique({
        where: { studentId_classId: { studentId: fixture.first, classId: fixture.classId } },
      }),
    ).toMatchObject({ enabled: false, revision: 2n });
    await classroom.store.enrollStudent(fixture.classId, fixture.first, true);
    await expect(
      service.execute(fixture.second, {
        kind: PetWorldCommandKind.VISIT_HOME,
        classId: fixture.classId,
        studentId: fixture.first,
      }),
    ).rejects.toMatchObject({ code: PetWorldFailure.HOME_UNAVAILABLE });

    await service.execute(fixture.first, {
      kind: PetWorldCommandKind.SET_HOME_SHARING,
      requestId: randomUUID(),
      classId: fixture.classId,
      enabled: true,
      expectedShareRevision: 2,
    });
    await classroom.store.deleteClass(fixture.classId, new Date());
    expect(
      await client.petHomeShare.findUnique({
        where: { studentId_classId: { studentId: fixture.first, classId: fixture.classId } },
      }),
    ).toMatchObject({ enabled: false, revision: 4n });
    await expect(
      service.execute(fixture.teacher, {
        kind: PetWorldCommandKind.VISIT_HOME,
        classId: fixture.classId,
        studentId: fixture.first,
      }),
    ).rejects.toMatchObject({ code: PetWorldFailure.FORBIDDEN });
    expect(
      await client.petWorld.findUnique({ where: { studentId: fixture.first } }),
    ).not.toBeNull();
  });

  it('rejects negative/unbacked balances, incorrect entry signs, unmatched sources and ledger edits', async () => {
    const fixture = await createFixture();
    await service.execute(fixture.teacher, createGrant(fixture.classId, [fixture.first]));
    await expect(
      client.petWallet.update({ where: { studentId: fixture.first }, data: { balance: -1n } }),
    ).rejects.toThrow();
    await expect(
      client.petWallet.update({ where: { studentId: fixture.first }, data: { balance: 51n } }),
    ).rejects.toThrow();
    await expect(
      client.petWalletEntry.create({
        data: {
          id: randomUUID(),
          studentId: fixture.first,
          kind: PetWalletEntryKind.PURCHASE,
          delta: 1n,
          sourceId: randomUUID(),
          requestId: randomUUID(),
          createdAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    await expect(
      client.petWalletEntry.create({
        data: {
          id: randomUUID(),
          studentId: fixture.first,
          kind: PetWalletEntryKind.TEACHER_GRANT,
          delta: 1n,
          sourceId: randomUUID(),
          recognitionId: randomUUID(),
          requestId: randomUUID(),
          createdAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    const entry = await client.petWalletEntry.findFirst({ where: { studentId: fixture.first } });
    if (!entry) {
      throw new Error('Missing accounting entry.');
    }
    await expect(
      client.petWalletEntry.update({ where: { id: entry.id }, data: { delta: 100n } }),
    ).rejects.toThrow();
    await expect(client.petWalletEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
    await expectBalancedWallet(fixture.first, 50n);
  });

  it('refuses a nonteacher accounting source even when persistence is called without an HTTP route', async () => {
    const fixture = await createFixture();
    await expect(
      client.petRecognition.create({
        data: {
          id: randomUUID(),
          classId: fixture.classId,
          teacherId: fixture.second,
          studentId: fixture.first,
          batchId: randomUUID(),
          requestId: randomUUID(),
          amount: 50n,
          category: PetRecognitionCategory.OTHER,
          note: 'Forged source',
          createdAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    expect(await client.petRecognition.count({ where: { studentId: fixture.first } })).toBe(0);
    expect(await client.petWallet.findUnique({ where: { studentId: fixture.first } })).toBeNull();
  });
});
