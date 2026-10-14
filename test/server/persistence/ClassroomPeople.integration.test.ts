import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { expect, it } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { ClassroomPeoplePageSchema, ClassroomViewAs } from '#contracts/ClassroomViewAs.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { createPrismaClassroomStore } from '../../../src/server/persistence/PrismaClassroomStore.js';

it('lists both roles with case-insensitive search, bounded stable pages and deleted-user handling', async () => {
  const environment = readServerEnv(process.env);
  const database = createPrismaClassroomStore(environment.DATABASE_URL);
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
  });
  const prefix = randomUUID();
  const people = Array.from({ length: ClassroomViewAs.PAGE_SIZE + 1 }, (_, index) => ({
    id: randomUUID(),
    name: `${prefix} Person ${String(index).padStart(3, '0')}`,
    email: `${prefix}-${String(index)}@example.test`,
    role: index % 2 === 0 ? AccountRole.TEACHER : AccountRole.STUDENT,
  }));
  try {
    await client.user.createMany({ data: people });
    const first = ClassroomPeoplePageSchema.parse(
      await database.store.listClassroomPeople(prefix.toUpperCase(), 0),
    );
    const last = ClassroomPeoplePageSchema.parse(
      await database.store.listClassroomPeople(prefix, ClassroomViewAs.PAGE_SIZE),
    );
    expect(first.people).toEqual(people.slice(0, ClassroomViewAs.PAGE_SIZE));
    expect(first.hasMore).toBe(true);
    expect(last.people).toEqual(people.slice(ClassroomViewAs.PAGE_SIZE));
    expect(last.hasMore).toBe(false);
    const person = people[0];
    if (!person) {
      throw new Error('Missing person fixture.');
    }
    expect(await database.store.readClassroomPerson(person.id)).toEqual(person);
    expect(
      (await database.store.listClassroomPeople(person.email.toUpperCase(), 0)).people,
    ).toEqual([person]);
    await client.user.delete({ where: { id: person.id } });
    expect(await database.store.readClassroomPerson(person.id)).toBeNull();
  } finally {
    await client.user.deleteMany({ where: { id: { in: people.map((person) => person.id) } } });
    await database.close();
    await client.$disconnect();
  }
});
