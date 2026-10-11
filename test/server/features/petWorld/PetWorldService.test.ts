import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { PetId } from '#contracts/Pet.js';
import {
  PetCorrectionKind,
  PetEquipmentSlot,
  PetHomeSlot,
  PetRecognitionCategory,
  PetWorldAssetId,
  PetWorldCommandKind,
  PetWorldCommandSchema,
  PetWorldFailure,
  PetWorldReplySchema,
  type PetWorldCommand,
  type PetWorldMutationCommand,
} from '#contracts/PetWorld.js';
import { PetWorldService } from '../../../../src/server/features/petWorld/application/PetWorldService.js';
import { petCatalog } from '../../../../src/server/features/petWorld/domain/PetCatalog.js';
import { MemoryPetWorldStore, PetWorldFixtureIds } from './PetWorldFixtures.js';

const now = '2026-10-11T12:00:00.000Z';

function createFixture() {
  const store = new MemoryPetWorldStore();
  const service = new PetWorldService(store, () => new Date(now));
  const grant = (studentIds = ['student'], pointsPerStudent = '100'): PetWorldMutationCommand => ({
    kind: PetWorldCommandKind.GRANT_POINTS,
    requestId: randomUUID(),
    classId: PetWorldFixtureIds.CLASS,
    studentIds,
    pointsPerStudent,
    category: PetRecognitionCategory.PERSISTENCE,
    note: 'Tried another approach.',
  });
  const initialize = (activePetId: PetId = PetId.CAT): PetWorldMutationCommand => ({
    kind: PetWorldCommandKind.INITIALIZE_WORLD,
    requestId: randomUUID(),
    activePetId,
    names: { cat: 'Mochi', fox: 'Maple' },
  });
  const buy = (
    itemId = 'meadow',
    equipAfterPurchase = false,
    expectedWorldRevision = 0,
  ): PetWorldMutationCommand => {
    const item = petCatalog.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw new Error('Missing catalog fixture.');
    }
    return {
      kind: PetWorldCommandKind.BUY_ITEM,
      requestId: randomUUID(),
      itemId,
      catalogRevision: petCatalog.revision,
      displayedPrice: item.price,
      equipAfterPurchase,
      expectedWorldRevision,
    };
  };
  return { store, service, grant, initialize, buy };
}

describe('Pet World accounting and authorization', () => {
  it('keeps owner world, catalog and history reads free of writes before explicit initialization', async () => {
    const { store, service } = createFixture();
    expect(await service.execute('student', { kind: PetWorldCommandKind.OWN_WORLD })).toMatchObject(
      { kind: 'world', world: { wallet: { balance: '0', revision: 0 }, profile: null } },
    );
    await service.execute('student', { kind: PetWorldCommandKind.CATALOG });
    await service.execute('student', { kind: PetWorldCommandKind.OWN_HISTORY });
    expect(store.wallets.size).toBe(0);
    expect(store.worlds.size).toBe(0);
    expect(store.receipts.size).toBe(0);
  });

  it('accepts a large uncapped teacher batch and does not initialize a local pet profile', async () => {
    const { store, service, grant } = createFixture();
    const reply = await service.execute(
      'teacher',
      grant(['student', 'partner'], '9007199254740993'),
    );
    expect(reply.kind).toBe('granted');
    expect(PetWorldReplySchema.safeParse(reply).success).toBe(true);
    expect(store.wallets.get('student')?.balance).toBe(9007199254740993n);
    expect(store.wallets.get('partner')?.balance).toBe(9007199254740993n);
    expect(store.worlds.size).toBe(0);
    expect(JSON.stringify(reply)).not.toContain('balance');
    expect(store.entries.size).toBe(2);
  });

  it('rejects student issuers, unrelated teachers, teacher recipients and nonmembers', async () => {
    const { store, service, grant } = createFixture();
    for (const actorId of ['student', 'other-teacher']) {
      await expect(service.execute(actorId, grant())).rejects.toMatchObject({
        code: PetWorldFailure.FORBIDDEN,
      });
    }
    store.enrollments.add(`${PetWorldFixtureIds.CLASS}:other-teacher`);
    await expect(
      service.execute('teacher', grant(['student', 'other-teacher'])),
    ).rejects.toMatchObject({ code: PetWorldFailure.FORBIDDEN });
    await expect(service.execute('teacher', grant(['student', 'outsider']))).rejects.toMatchObject({
      code: PetWorldFailure.FORBIDDEN,
    });
    await expect(service.execute('teacher', grant(['teacher']))).rejects.toMatchObject({
      code: PetWorldFailure.FORBIDDEN,
    });
    expect(store.wallets.size).toBe(0);
    expect(store.entries.size).toBe(0);
  });

  it('rolls back all recipients on bigint overflow and receipt persistence failure', async () => {
    const { store, service, grant } = createFixture();
    await service.execute('teacher', grant(['student'], '9223372036854775807'));
    await expect(
      service.execute('teacher', grant(['partner', 'student'], '1')),
    ).rejects.toMatchObject({ code: PetWorldFailure.INVALID });
    expect(store.wallets.has('partner')).toBe(false);
    expect(store.entries.size).toBe(1);
    store.failOnReceipt = true;
    await expect(service.execute('teacher', grant(['partner']))).rejects.toThrow('Synthetic');
    expect(store.wallets.has('partner')).toBe(false);
    expect(store.recognitions.size).toBe(1);
    expect(store.receipts.size).toBe(1);
  });

  it('normalizes group ordering for retries and checks current receipt authority without requiring old enrollment', async () => {
    const { store, service, grant } = createFixture();
    const command = grant(['student', 'partner']);
    if (command.kind !== PetWorldCommandKind.GRANT_POINTS) {
      throw new Error('Grant fixture missing.');
    }
    const result = await service.execute('teacher', command);
    store.enrollments.clear();
    expect(
      await service.execute('teacher', { ...command, studentIds: ['partner', 'student'] }),
    ).toEqual(result);
    await expect(
      service.execute('teacher', { ...command, pointsPerStudent: '200' }),
    ).rejects.toMatchObject({ code: PetWorldFailure.REQUEST_CONFLICT });
    expect(store.entries.size).toBe(2);
    store.roles.set('teacher', AccountRole.STUDENT);
    await expect(service.execute('teacher', command)).rejects.toMatchObject({
      code: PetWorldFailure.FORBIDDEN,
    });
    await expect(
      service.execute('teacher', {
        kind: PetWorldCommandKind.COMMAND_RESULT,
        requestId: command.requestId,
      }),
    ).rejects.toMatchObject({ code: PetWorldFailure.FORBIDDEN });
  });

  it('validates optional classroom references before creating any award', async () => {
    const { store, service, grant } = createFixture();
    const command = grant();
    if (command.kind !== PetWorldCommandKind.GRANT_POINTS) {
      throw new Error('Grant fixture missing.');
    }
    await expect(
      service.execute('teacher', { ...command, classSessionId: randomUUID() }),
    ).rejects.toMatchObject({ code: PetWorldFailure.FORBIDDEN });
    expect(store.entries.size).toBe(0);
  });

  it('keeps one personal wallet across classes while each teacher sees only their own class awards', async () => {
    const { store, service, grant } = createFixture();
    await service.execute('teacher', grant());
    store.enrollments.add(`${PetWorldFixtureIds.OTHER_CLASS}:student`);
    const command = grant(['student'], '50');
    if (command.kind !== PetWorldCommandKind.GRANT_POINTS) {
      throw new Error('Grant fixture missing.');
    }
    await service.execute('other-teacher', { ...command, classId: PetWorldFixtureIds.OTHER_CLASS });
    expect(store.wallets.size).toBe(1);
    expect(store.wallets.get('student')?.balance).toBe(150n);
    const view = await service.execute('teacher', {
      kind: PetWorldCommandKind.CLASS_RECOGNITION,
      classId: PetWorldFixtureIds.CLASS,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    });
    if (view.kind !== 'class-recognition') {
      throw new Error('Expected teacher projection.');
    }
    expect(view.recognitions).toHaveLength(1);
    expect(view.recognitions[0]?.teacherId).toBe('teacher');
    expect(JSON.stringify(view)).not.toMatch(/balance|purchaseId|inventory/);
    await expect(
      service.execute('teacher', {
        kind: PetWorldCommandKind.CLASS_RECOGNITION,
        classId: PetWorldFixtureIds.OTHER_CLASS,
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-11-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: PetWorldFailure.FORBIDDEN });
  });

  it('uses explicit initialization once and preserves promoted owners and both pet names', async () => {
    const { store, service, grant, initialize } = createFixture();
    await service.execute('teacher', grant());
    store.roles.set('student', AccountRole.TEACHER);
    await service.execute('student', initialize(PetId.FOX));
    await service.execute('student', initialize(PetId.CAT));
    expect(store.worlds.get('student')?.activePetId).toBe(PetId.FOX);
    await service.execute('student', {
      kind: PetWorldCommandKind.SET_PET_PROFILE,
      requestId: randomUUID(),
      expectedWorldRevision: 0,
      activePetId: PetId.CAT,
      name: 'Pepper',
    });
    expect(store.worlds.get('student')?.names).toEqual({ cat: 'Pepper', fox: 'Maple' });
    await expect(service.execute('other-teacher', initialize())).rejects.toMatchObject({
      code: PetWorldFailure.FORBIDDEN,
    });
  });

  it('purchases once, checks server prices, and preserves ledger reconciliation', async () => {
    const { store, service, grant, initialize, buy } = createFixture();
    await service.execute('teacher', grant());
    await service.execute('student', initialize());
    const command = buy();
    expect(await service.execute('student', command)).toMatchObject({
      kind: 'ok',
      walletRevision: 2,
      worldRevision: null,
    });
    expect(await service.execute('student', command)).toMatchObject({
      kind: 'ok',
      walletRevision: 2,
    });
    await expect(service.execute('student', buy())).rejects.toMatchObject({
      code: PetWorldFailure.ALREADY_OWNED,
    });
    const another = buy('starry-sky');
    if (another.kind !== PetWorldCommandKind.BUY_ITEM) {
      throw new Error('Purchase fixture missing.');
    }
    await expect(
      service.execute('student', { ...another, displayedPrice: '1' }),
    ).rejects.toMatchObject({ code: PetWorldFailure.STALE_CATALOG });
    expect(store.wallets.get('student')?.balance).toBe(80n);
    expect(store.inventory.size).toBe(1);
    expect([...store.entries.values()].reduce((total, entry) => total + entry.delta, 0n)).toBe(80n);
  });

  it('offers and sells only assets the client can render', async () => {
    const { store, service, grant, initialize, buy } = createFixture();
    await service.execute('teacher', grant());
    await service.execute('student', initialize());
    const catalog = await service.execute('student', {
      kind: PetWorldCommandKind.CATALOG,
      supportedAssetIds: [PetWorldAssetId.MEADOW],
    });
    expect(catalog).toMatchObject({ kind: 'catalog', catalog: { items: [{ id: 'meadow' }] } });
    if (catalog.kind !== 'catalog') {
      throw new Error('Expected catalog.');
    }
    expect(catalog.catalog.items).toHaveLength(1);
    const command = buy('starry-sky');
    if (command.kind !== PetWorldCommandKind.BUY_ITEM) {
      throw new Error('Purchase fixture missing.');
    }
    await expect(
      service.execute('student', { ...command, supportedAssetIds: [PetWorldAssetId.MEADOW] }),
    ).rejects.toMatchObject({ code: PetWorldFailure.INCOMPATIBLE_ITEM });
    expect(store.wallets.get('student')?.balance).toBe(100n);
    expect(store.inventory.size).toBe(0);
  });

  it('does not charge a stale buy-and-equip and checks owned items, slot compatibility and revisions', async () => {
    const { store, service, grant, initialize, buy } = createFixture();
    await service.execute('teacher', grant());
    await service.execute('student', initialize());
    await expect(service.execute('student', buy('meadow', true, 9))).rejects.toMatchObject({
      code: PetWorldFailure.STALE,
    });
    expect(store.wallets.get('student')?.balance).toBe(100n);
    expect(store.inventory.size).toBe(0);
    await service.execute('student', buy('meadow', true));
    expect(store.worlds.get('student')?.backdropItemId).toBe('meadow');
    const equip: PetWorldCommand = {
      kind: PetWorldCommandKind.EQUIP_ITEM,
      requestId: randomUUID(),
      expectedWorldRevision: 1,
      slot: PetEquipmentSlot.BACKDROP,
      itemId: 'starry-sky',
    };
    await expect(service.execute('student', equip)).rejects.toMatchObject({
      code: PetWorldFailure.FORBIDDEN,
    });
    await expect(
      service.execute('student', {
        kind: PetWorldCommandKind.PLACE_ITEM,
        requestId: randomUUID(),
        expectedWorldRevision: 1,
        slot: PetHomeSlot.GARDEN,
        itemId: 'meadow',
      }),
    ).rejects.toMatchObject({ code: PetWorldFailure.INCOMPATIBLE_ITEM });
    await service.execute('student', { ...equip, requestId: randomUUID(), itemId: null });
    expect(store.worlds.get('student')?.backdropItemId).toBeNull();
    expect(store.inventory.size).toBe(1);
    expect(store.entries.size).toBe(2);
  });

  it('requires sufficient points and initializes zero without a credit', async () => {
    const { store, service, initialize, buy } = createFixture();
    await service.execute('student', initialize());
    await expect(service.execute('student', buy())).rejects.toMatchObject({
      code: PetWorldFailure.INSUFFICIENT_POINTS,
    });
    expect(store.wallets.get('student')?.balance).toBe(0n);
    expect(store.entries.size).toBe(0);
    expect(store.purchases.size).toBe(0);
  });

  it('reverses the exact grant once after unenrollment and excludes voided moments from coverage', async () => {
    const { store, service, grant } = createFixture();
    const awarded = await service.execute('teacher', grant());
    if (awarded.kind !== 'granted' || !awarded.recognitions[0]) {
      throw new Error('Award fixture missing.');
    }
    store.enrollments.delete(`${PetWorldFixtureIds.CLASS}:student`);
    const correction: PetWorldMutationCommand = {
      kind: PetWorldCommandKind.REVERSE_GRANT,
      requestId: randomUUID(),
      recognitionId: awarded.recognitions[0].id,
      reason: 'Selected the wrong student.',
    };
    expect(await service.execute('teacher', correction)).toMatchObject({
      kind: 'corrected',
      correction: { kind: PetCorrectionKind.REVERSED },
    });
    expect(store.wallets.get('student')?.balance).toBe(0n);
    await expect(
      service.execute('teacher', { ...correction, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: PetWorldFailure.REVERSAL_UNAVAILABLE });
    const coverage = await service.execute('teacher', {
      kind: PetWorldCommandKind.CLASS_RECOGNITION,
      classId: PetWorldFixtureIds.CLASS,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    });
    expect(coverage).toMatchObject({ coverage: { classroomMoments: 0, recognizedStudents: 0 } });
    expect(JSON.stringify(coverage)).not.toContain('balance');
  });

  it('allows a final recognition-only void after spending without confiscating or later debiting', async () => {
    const { store, service, grant, initialize, buy } = createFixture();
    const awarded = await service.execute('teacher', grant());
    if (awarded.kind !== 'granted' || !awarded.recognitions[0]) {
      throw new Error('Award fixture missing.');
    }
    await service.execute('student', initialize());
    await service.execute('student', buy());
    const command = {
      kind: PetWorldCommandKind.REVERSE_GRANT,
      requestId: randomUUID(),
      recognitionId: awarded.recognitions[0].id,
      reason: 'Wrong recipient.',
    } as const;
    await expect(service.execute('teacher', command)).rejects.toMatchObject({
      code: PetWorldFailure.INSUFFICIENT_POINTS,
    });
    expect(store.recognitions.get(command.recognitionId)?.correction).toBeNull();
    await service.execute('teacher', { ...command, kind: PetWorldCommandKind.VOID_RECOGNITION });
    const receipt = await service.execute('teacher', {
      kind: PetWorldCommandKind.COMMAND_RESULT,
      requestId: command.requestId,
    });
    expect(JSON.stringify(receipt)).not.toContain(command.reason);
    await expect(
      service.execute('teacher', { ...command, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: PetWorldFailure.REVERSAL_UNAVAILABLE });
    expect(store.wallets.get('student')?.balance).toBe(80n);
    expect(store.inventory.size).toBe(1);
  });

  it('shares only an explicit class and returns a cosmetic-only visitor projection', async () => {
    const { store, service, initialize } = createFixture();
    await service.execute('student', initialize());
    const visit = {
      kind: PetWorldCommandKind.VISIT_HOME,
      classId: PetWorldFixtureIds.CLASS,
      studentId: 'student',
    } as const;
    await expect(service.execute('partner', visit)).rejects.toMatchObject({
      code: PetWorldFailure.HOME_UNAVAILABLE,
    });
    await service.execute('student', {
      kind: PetWorldCommandKind.SET_HOME_SHARING,
      requestId: randomUUID(),
      classId: PetWorldFixtureIds.CLASS,
      expectedShareRevision: 0,
      enabled: true,
    });
    const result = await service.execute('partner', visit);
    expect(result).toMatchObject({
      kind: 'home',
      home: { displayName: 'Mochi', profile: { activePetId: PetId.CAT } },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /wallet|inventory|recognitions|note|teacherId|requestId/,
    );
    store.enrollments.delete(`${PetWorldFixtureIds.CLASS}:student`);
    await expect(service.execute('partner', visit)).rejects.toMatchObject({
      code: PetWorldFailure.HOME_UNAVAILABLE,
    });
    await expect(service.execute('other-teacher', visit)).rejects.toMatchObject({
      code: PetWorldFailure.FORBIDDEN,
    });
  });

  it('loads a full classroom neighborhood without per-student queries or private recognition reads', async () => {
    const { store, service } = createFixture();
    for (let index = 0; index < 200; index += 1) {
      const studentId = `pupil-${index.toString().padStart(3, '0')}`;
      store.roles.set(studentId, AccountRole.STUDENT);
      store.enrollments.add(`${PetWorldFixtureIds.CLASS}:${studentId}`);
      store.worlds.set(studentId, {
        studentId,
        activePetId: PetId.CAT,
        names: { cat: 'Mochi', fox: 'Maple' },
        backdropItemId: null,
        outfitItemId: null,
        slots: { garden: null, home: null, feature: null },
        revision: 0,
      });
      store.shares.set(`${studentId}:${PetWorldFixtureIds.CLASS}`, {
        studentId,
        classId: PetWorldFixtureIds.CLASS,
        enabled: index < 150,
        revision: 1,
      });
    }
    store.enrollments.delete(`${PetWorldFixtureIds.CLASS}:pupil-000`);
    const listSharedWorlds = vi.spyOn(store, 'listSharedWorlds');
    const countClassroomMoments = vi.spyOn(store, 'countClassroomMoments');
    const readHomeShare = vi.spyOn(store, 'readHomeShare');
    const readWorld = vi.spyOn(store, 'readWorld');
    const listClassRecognitions = vi.spyOn(store, 'listClassRecognitions');
    const neighborhood = await service.execute('teacher', {
      kind: PetWorldCommandKind.CLASS_NEIGHBORHOOD,
      classId: PetWorldFixtureIds.CLASS,
    });
    if (neighborhood.kind !== 'neighborhood') {
      throw new Error('Expected neighborhood projection.');
    }
    expect(neighborhood.homes).toHaveLength(149);
    expect(neighborhood.homes.some((home) => home.studentId === 'pupil-000')).toBe(false);
    expect(neighborhood.homes.some((home) => home.studentId === 'pupil-150')).toBe(false);
    expect(listSharedWorlds).toHaveBeenCalledTimes(1);
    expect(countClassroomMoments).toHaveBeenCalledTimes(1);
    expect(readHomeShare).not.toHaveBeenCalled();
    expect(readWorld).not.toHaveBeenCalled();
    expect(listClassRecognitions).not.toHaveBeenCalled();
    expect(JSON.stringify(neighborhood)).not.toMatch(/wallet|recognitions|note|teacherId/);
  });

  it('binds history cursors to the owner and wallet revision', async () => {
    const { service, grant } = createFixture();
    await service.execute('teacher', grant(['student', 'partner']));
    await service.execute('teacher', grant(['student', 'partner']));
    const page = await service.execute('student', {
      kind: PetWorldCommandKind.OWN_HISTORY,
      limit: 1,
    });
    if (page.kind !== 'history' || !page.nextCursor) {
      throw new Error('Cursor fixture missing.');
    }
    await expect(
      service.execute('partner', {
        kind: PetWorldCommandKind.OWN_HISTORY,
        cursor: page.nextCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: PetWorldFailure.INVALID });
    await service.execute('teacher', grant());
    await expect(
      service.execute('student', {
        kind: PetWorldCommandKind.OWN_HISTORY,
        cursor: page.nextCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: PetWorldFailure.STALE });
  });

  it('invalidates owner history pages on a recognition-only void with unchanged wallet balance', async () => {
    const { store, service, grant } = createFixture();
    const awarded = await service.execute('teacher', grant());
    await service.execute('teacher', grant());
    const page = await service.execute('student', {
      kind: PetWorldCommandKind.OWN_HISTORY,
      limit: 1,
    });
    if (
      awarded.kind !== 'granted' ||
      !awarded.recognitions[0] ||
      page.kind !== 'history' ||
      !page.nextCursor
    ) {
      throw new Error('Missing history fixtures.');
    }
    await service.execute('teacher', {
      kind: PetWorldCommandKind.VOID_RECOGNITION,
      requestId: randomUUID(),
      recognitionId: awarded.recognitions[0].id,
      reason: 'Recognition recorded by mistake.',
    });
    expect(store.wallets.get('student')?.revision).toBe(2);
    await expect(
      service.execute('student', {
        kind: PetWorldCommandKind.OWN_HISTORY,
        cursor: page.nextCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: PetWorldFailure.STALE });
  });

  it('rejects forged wallet claims, duplicate recipients and noncanonical point amounts', () => {
    const { grant } = createFixture();
    const command = grant();
    for (const pointsPerStudent of ['0', '-1', '01', '1.5', '1e3', ' 10', '9223372036854775808']) {
      expect(PetWorldCommandSchema.safeParse({ ...command, pointsPerStudent }).success).toBe(false);
    }
    expect(
      PetWorldCommandSchema.safeParse({ ...command, studentIds: ['student', 'student'] }).success,
    ).toBe(false);
    expect(PetWorldCommandSchema.safeParse({ ...command, teacherId: 'teacher' }).success).toBe(
      false,
    );
    expect(
      PetWorldCommandSchema.safeParse({
        kind: PetWorldCommandKind.INITIALIZE_WORLD,
        requestId: randomUUID(),
        activePetId: PetId.CAT,
        names: { cat: 'Mochi', fox: 'Maple' },
        balance: '100',
      }).success,
    ).toBe(false);
  });
});
